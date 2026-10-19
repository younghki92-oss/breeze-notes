// Breeze 노트 — local-first notes with optional Supabase sync.
// Notes live in IndexedDB; the UI never waits on the network.

const $ = (s) => document.querySelector(s);
const app = $('#app'), pane = $('#editorPane'), list = $('#list'), editor = $('#editor'), search = $('#search');
// Single-pane phone layout only on small touch screens (Galaxy folded). Mac windows always get list | note, like Apple Notes.
const mobile = matchMedia('(max-width: 599px) and (pointer: coarse), (max-width: 419px)');
const soloId = new URLSearchParams(location.search).get('note');
// List view (⋯ menu): 'list' | 'gallery' | 'attachments'. Gallery and attachments use the whole window,
// opening a note on top of it (like the phone), so they share the single-pane navigation.
let view = 'list', attTab = 'photos';
try { view = localStorage.getItem('breeze.view') || 'list'; } catch {}
const single = () => mobile.matches || (view !== 'list' && !soloId); // set when a note is opened in its own window

/* ---------------- storage ---------------- */
const idb = (() => {
  let dbp;
  const open = () => (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('breeze', 2);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'id' }); // { id, blob, uploaded }
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    all: () => tx('notes', 'readonly', (s) => s.getAll()),
    putMany: (ns) => ns.length && tx('notes', 'readwrite', (s) => { ns.forEach((n) => s.put(n)); }),
    get: (k) => tx('meta', 'readonly', (s) => s.get(k)),
    set: (k, v) => tx('meta', 'readwrite', (s) => { s.put(v, k); }),
    img: (id) => tx('images', 'readonly', (s) => s.get(id)),
    putImg: (r) => tx('images', 'readwrite', (s) => { s.put(r); }),
    allImgs: () => tx('images', 'readonly', (s) => s.getAll()),
  };
})();

// note: { id, body (html), pinned, deleted, folder (folder id or null = 노트), createdAt, editedAt,
//         updatedAt (ms, the sync version — bumps on any change), dirty (needs upload) }
// editedAt only moves when the text changes, so moving or pinning a note doesn't reorder the list.
const edited = (n) => n.editedAt || n.updatedAt;
const created = (n) => n.createdAt || n.editedAt || n.updatedAt;
// One hidden record carries folders and smart folders, so they sync like any note.
const SETTINGS_ID = '00000000-0000-4000-8000-00000b4ee2e0';
const isMeta = (n) => n.id === SETTINGS_ID;
let notes = [];
const index = new Map();
const unsaved = new Set(); // freshly created, never typed into — not persisted yet
let current = null;

function addNote(n) { notes.push(n); index.set(n.id, n); }
function dropNote(n) { notes.splice(notes.indexOf(n), 1); index.delete(n.id); unsaved.delete(n.id); }

let saveT;
function touch(n) {
  n.updatedAt = Math.max(Date.now(), n.updatedAt + 1);
  n.dirty = true;
  unsaved.delete(n.id);
  clearTimeout(saveT);
  saveT = setTimeout(flush, 300);
  renderListSoon();
}
// Other Breeze windows (a note opened by double-click) hear about every save, so both stay in step.
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('breeze-notes') : null;
async function persist(list) {
  if (!list.length) return;
  await idb.putMany(list);
  bc?.postMessage(list.map(({ id, body, pinned, deleted, folder, createdAt, editedAt, updatedAt, dirty }) => ({ id, body, pinned, deleted, folder, createdAt, editedAt, updatedAt, dirty })));
}
bc?.addEventListener('message', ({ data }) => {
  let changed = false;
  for (const r of data) {
    let n = index.get(r.id);
    if (n && n.updatedAt >= r.updatedAt) continue;
    if (!n) { n = { id: r.id }; addNote(n); }
    Object.assign(n, r);
    unsaved.delete(n.id);
    changed = true;
    if (isMeta(n)) settingsChanged();
    if (n === current) {
      if (n.deleted && soloId) window.close();
      else if (document.activeElement !== editor) { setBody(n.body); syncPin(); }
    }
  }
  if (changed) renderListSoon();
});
async function flush() {
  clearTimeout(saveT);
  await persist(notes.filter((n) => n.dirty && !unsaved.has(n.id)));
  sync.schedule(1200);
}

/* ---------------- text helpers ---------------- */
const decoder = document.createElement('textarea');
const textCache = new Map();
function textOf(n) {
  const c = textCache.get(n.id);
  if (c && c[0] === n.body) return c[1];
  decoder.innerHTML = n.body.replace(/<(br|\/div|\/p|\/li|\/h[1-6]|\/pre)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '');
  const t = decoder.value;
  textCache.set(n.id, [n.body, t]);
  return t;
}
function info(n) {
  const lines = textOf(n).split('\n').map((s) => s.trim()).filter(Boolean);
  if (isLocked(n)) return { title: lines[0] || '잠긴 노트', preview: '🔒 잠김' };
  return { title: lines[0] || (n.body.includes('<img') ? '사진' : '새로운 노트'), preview: lines.slice(1).join(' ').slice(0, 140) || '추가 텍스트 없음' };
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmt(ms) {
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return '어제';
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}. ${d.getDate()}.` : `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}
// #태그: a hash at the start of a word, Korean included. Must start with a letter, so "#1" or "#3" in numbered notes aren't tags.
const TAG_RE = /(?:^|[\s(])#([\p{L}_][\p{L}\p{N}_\-/]*)/gu;
const tagCache = new Map();
function tagsOf(n) {
  const t = textOf(n), c = tagCache.get(n.id);
  if (c && c[0] === t) return c[1];
  const tags = [...new Set([...t.matchAll(TAG_RE)].map((m) => m[1]))];
  tagCache.set(n.id, [t, tags]);
  return tags;
}
// inc: notes must have these tags (any or all of them) · exc: notes must not · untagged: notes with no tags
const tagSel = { inc: [], exc: [], mode: 'any', untagged: false };
const tagFilterOn = () => tagSel.inc.length || tagSel.exc.length || tagSel.untagged;
function matchesTags(n) {
  const ts = tagsOf(n);
  if (tagSel.untagged && ts.length) return false;
  if (tagSel.exc.some((t) => ts.includes(t))) return false;
  if (!tagSel.inc.length) return true;
  return tagSel.mode === 'all' ? tagSel.inc.every((t) => ts.includes(t)) : tagSel.inc.some((t) => ts.includes(t));
}
function clearTagSel() { tagSel.inc = []; tagSel.exc = []; tagSel.untagged = false; }
// Deleted notes keep their body for 30 days (the trash); an empty body means permanently deleted.
const TRASH_DAYS = 30;
const hasContent = (n) => !!textOf(n).trim() || n.body.includes('<img');
const inTrash = (n) => n.deleted && !isMeta(n) && hasContent(n);
const live = () => notes.filter((n) => !n.deleted && !isMeta(n));

/* ---------------- folders · smart folders · sort ---------------- */
// settings (synced in the SETTINGS_ID record): { folders: [{ id, name }], smart: [{ id, name, rules }], lock: { salt, check } }
let settings = { folders: [], smart: [] };
const folderById = (id) => settings.folders.find((f) => f.id === id);
const smartById = (id) => settings.smart.find((f) => f.id === id);
const folderOf = (n) => (n.folder && folderById(n.folder) ? n.folder : null); // a note in a deleted folder lands in 노트
// scope: { type: 'all' } · { type: 'folder', id (null = 노트) } · { type: 'smart', id } · { type: 'trash' }
let scope = { type: 'all' };
try { scope = JSON.parse(localStorage.getItem('breeze.scope')) || scope; } catch {}
let trashMode = scope.type === 'trash';
let sortBy = 'edited', groupDates = true; // ⋯ menu: 편집일 · 생성일 · 제목, 날짜별로 그룹화
try { sortBy = localStorage.getItem('breeze.sort') || 'edited'; groupDates = localStorage.getItem('breeze.group') !== '0'; } catch {}
const sortDate = (n) => (sortBy === 'created' ? created(n) : edited(n));
function scopeName(sc = scope) {
  if (sc.type === 'trash') return '최근 삭제된 항목';
  if (sc.type === 'folder') return sc.id ? folderById(sc.id)?.name || '노트' : '노트';
  if (sc.type === 'smart') return smartById(sc.id)?.name || '스마트 폴더';
  return '모든 노트';
}
function inScope(n, sc = scope) {
  if (sc.type === 'folder') return folderOf(n) === sc.id;
  if (sc.type === 'smart') { const f = smartById(sc.id); return !f || matchesSmart(n, f.rules); }
  return true;
}
function byOrder(a, b) {
  if (sortBy === 'title') return info(a).title.localeCompare(info(b).title, 'ko');
  return sortDate(b) - sortDate(a);
}
// a search looks through every note, like Apple Notes (the trash searches only the trash)
const visible = () => trashMode
  ? notes.filter(inTrash).sort((a, b) => b.updatedAt - a.updatedAt)
  : live().filter((n) => search.value.trim() || inScope(n)).sort((a, b) => (b.pinned - a.pinned) || byOrder(a, b));

// smart folder rules — every filter left blank is ignored
const DAY = 864e5;
function startOfToday() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }
function smartTests(r) {
  const t = [];
  if (r.tags?.length || r.untagged) t.push((n) => {
    const ts = tagsOf(n);
    if (r.untagged && !ts.length) return true;
    if (!r.tags?.length) return false;
    return r.tagMode === 'all' ? r.tags.every((x) => ts.includes(x)) : r.tags.some((x) => ts.includes(x));
  });
  if (r.date) {
    const days = +r.date, at = (n) => (r.dateField === 'created' ? created(n) : edited(n));
    if (days === 1) t.push((n) => at(n) >= startOfToday());
    else if (days > 0) t.push((n) => at(n) >= startOfToday() - (days - 1) * DAY);
    else t.push((n) => at(n) < Date.now() + days * DAY);
  }
  if (r.check) t.push((n) => {
    const items = n.body.match(/<li\b[^>]*>/g) && n.body.includes('checklist') ? checklistItems(n) : [];
    if (r.check === 'none') return !items.length;
    if (!items.length) return false;
    if (r.check === 'done') return items.every(Boolean);
    if (r.check === 'undone') return items.some((d) => !d);
    return true;
  });
  if (r.att) t.push((n) => {
    const photo = n.body.includes('<img'), file = n.body.includes('data-file='), link = /<a\b(?![^>]*(?:data-file|note-link))[^>]*href=/.test(n.body);
    return { any: photo || file || link, photo, file, link, none: !photo && !file && !link }[r.att];
  });
  if (r.folder !== undefined && r.folder !== '') t.push((n) => folderOf(n) === (r.folder || null));
  if (r.pinned) t.push((n) => n.pinned);
  return t;
}
// true/false for each checklist item (done or not)
const checkDoc = document.createElement('template');
function checklistItems(n) {
  checkDoc.innerHTML = n.body;
  return [...checkDoc.content.querySelectorAll('ul.checklist > li')].filter((li) => li.textContent.trim()).map((li) => li.classList.contains('done'));
}
function matchesSmart(n, r) {
  const t = smartTests(r);
  if (!t.length) return true;
  return r.match === 'any' ? t.some((f) => f(n)) : t.every((f) => f(n));
}

function loadSettings() {
  const m = index.get(SETTINGS_ID);
  try { const v = m && JSON.parse(m.body); settings = { ...v, folders: v?.folders || [], smart: v?.smart || [] }; } catch {}
}
function saveSettings() {
  let m = index.get(SETTINGS_ID);
  if (!m) { m = { id: SETTINGS_ID, body: '', pinned: false, deleted: false, updatedAt: 0, dirty: false }; addNote(m); }
  m.body = JSON.stringify(settings);
  touch(m);
  flush();
  renderFolders();
}
// another device or window changed the folders
function settingsChanged() {
  loadSettings();
  if ((scope.type === 'folder' && scope.id && !folderById(scope.id)) || (scope.type === 'smart' && !smartById(scope.id))) setScope({ type: 'folder', id: null });
  else { renderFolders(); renderListSoon(); }
}
const sameScope = (a, b) => a.type === b.type && (a.id ?? null) === (b.id ?? null);
function setScope(sc, { toList = true } = {}) {
  if (current) leave(current);
  current = null;
  scope = sc;
  trashMode = sc.type === 'trash';
  try { localStorage.setItem('breeze.scope', JSON.stringify(sc)); } catch {}
  clearTagSel();
  search.value = '';
  exitSelect();
  markScope();
  list.scrollTop = 0;
  if (single()) { if (toList) hideFolders(); showList(); }
  else open(visible()[0]);
  renderFolders();
}
function markScope() {
  $('#sideTitle').textContent = scopeName();
  $('#backLabel').textContent = scopeName();
  document.title = soloId ? document.title : scope.type === 'all' ? 'Breeze 노트' : `${scopeName()} — Breeze`;
}

const FOLDER_ICO = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
const SMART_ICO = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M8 10.5h8M9.5 13.5h5M11 16.5h2"/></svg>';
const ALL_ICO = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z"/><path d="M9 9h6M9 13h6M9 17h3"/></svg>';
const TRASH_ICO = '<svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
const folderList = $('#folderList');
const byName = (a, b) => a.name.localeCompare(b.name, 'ko');
function renderFolders() {
  const ns = live(), counts = new Map();
  for (const n of ns) { const f = folderOf(n); counts.set(f, (counts.get(f) || 0) + 1); }
  const row = (sc, ico, name, count, extra = '') => {
    const on = sameScope(sc, scope) ? ' on' : '';
    return `<li class="fl${on}" data-scope='${esc(JSON.stringify(sc))}'${extra}>${ico}<span class="nm">${esc(name)}</span><span class="ct">${count || ''}</span></li>`;
  };
  let html = row({ type: 'all' }, ALL_ICO, '모든 노트', ns.length);
  html += row({ type: 'folder', id: null }, FOLDER_ICO, '노트', counts.get(null), ' data-drop=""');
  for (const f of [...settings.folders].sort(byName)) html += row({ type: 'folder', id: f.id }, FOLDER_ICO, f.name, counts.get(f.id), ` data-drop="${f.id}" data-menu="folder"`);
  if (settings.smart.length) {
    html += '<li class="fl-sec">스마트 폴더</li>';
    for (const f of [...settings.smart].sort(byName)) html += row({ type: 'smart', id: f.id }, SMART_ICO, f.name, ns.filter((n) => matchesSmart(n, f.rules)).length, ' data-menu="smart"');
  }
  html += '<li class="fl-gap"></li>' + row({ type: 'trash' }, TRASH_ICO, '최근 삭제된 항목', notes.filter(inTrash).length);
  folderList.innerHTML = html;
}
folderList.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-scope]');
  if (!li) return;
  const sc = JSON.parse(li.dataset.scope);
  if (sameScope(sc, scope) && !single()) return;
  setScope(sc);
});
// right-click / long-press a folder: rename · delete (smart folders: edit too)
const folderMenu = $('#folderMenu');
let folderMenuFor = null;
folderList.addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li[data-menu]');
  e.preventDefault();
  if (!li) return;
  folderMenuFor = JSON.parse(li.dataset.scope);
  folderMenu.querySelector('[data-fm=edit]').hidden = folderMenuFor.type !== 'smart';
  folderMenu.hidden = false;
  const m = folderMenu.getBoundingClientRect();
  folderMenu.style.left = `${Math.max(8, Math.min(innerWidth - m.width - 8, e.clientX))}px`;
  folderMenu.style.top = `${Math.max(8, Math.min(innerHeight - m.height - 8, e.clientY + 4))}px`;
});
document.addEventListener('pointerdown', (e) => { if (!folderMenu.hidden && !e.target.closest('#folderMenu')) folderMenu.hidden = true; });
folderMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fm]');
  const sc = folderMenuFor;
  if (!b || !sc) return;
  folderMenu.hidden = true;
  const item = sc.type === 'smart' ? smartById(sc.id) : folderById(sc.id);
  if (!item) return;
  if (b.dataset.fm === 'edit') editSmart(item);
  else if (b.dataset.fm === 'rename') {
    const nw = (prompt('새 이름', item.name) || '').trim();
    if (!nw || nw === item.name) return;
    item.name = nw;
    saveSettings();
    markScope();
  } else if (sc.type === 'smart') {
    if (!confirm(`'${item.name}' 스마트 폴더를 삭제할까요? 노트는 그대로 남습니다.`)) return;
    settings.smart = settings.smart.filter((f) => f !== item);
    saveSettings();
    if (sameScope(sc, scope)) setScope({ type: 'all' }, { toList: false });
  } else {
    const inside = live().filter((n) => n.folder === item.id);
    if (!confirm(`'${item.name}' 폴더를 삭제할까요?${inside.length ? `\n안에 있는 노트 ${inside.length}개는 최근 삭제된 항목으로 이동합니다.` : ''}`)) return;
    inside.forEach((n) => { n.deleted = true; touch(n); });
    settings.folders = settings.folders.filter((f) => f !== item);
    saveSettings();
    if (sameScope(sc, scope)) setScope({ type: 'folder', id: null }, { toList: false });
    else renderList();
    if (inside.length) toast(`노트 ${inside.length}개를 최근 삭제된 항목으로 옮겼습니다`);
  }
});
// smart folder editor: the count below updates as rules change
let smartEditing = null, smartPick = [];
function smartRulesFromForm() {
  return {
    match: $('#smartMatch').value, tags: [...smartPick], tagMode: $('#smartTagMode').value, untagged: $('#smartUntagged').checked,
    dateField: $('#smartDateField').value, date: $('#smartDate').value, check: $('#smartCheck').value, att: $('#smartAtt').value,
    folder: $('#smartFolder').value === '*' ? '' : $('#smartFolder').value === '' ? null : $('#smartFolder').value, pinned: $('#smartPinned').checked,
  };
}
function smartCount() {
  const r = smartRulesFromForm();
  $('#smartCount').textContent = smartTests(r).length ? `지금 ${live().filter((n) => matchesSmart(n, r)).length}개 노트가 해당됩니다` : '조건을 하나 이상 고르세요';
}
function renderSmartTags() {
  const tags = [...new Set([...live().flatMap(tagsOf), ...smartPick])].sort((a, b) => a.localeCompare(b, 'ko'));
  $('#smartTags').innerHTML = tags.map((t) => `<button type="button" class="tag${smartPick.includes(t) ? ' on' : ''}" data-st="${esc(t)}">#${esc(t)}</button>`).join('') || '<span class="hint">아직 태그가 없습니다</span>';
}
function editSmart(item, preset) {
  smartEditing = item;
  const r = item?.rules || preset || {};
  smartPick = [...(r.tags || [])];
  $('#smartTitle').textContent = item ? '스마트 폴더 편집' : '새로운 스마트 폴더';
  $('#smartName').value = item?.name || '';
  $('#smartMatch').value = r.match || 'all';
  $('#smartTagMode').value = r.tagMode || 'any';
  $('#smartUntagged').checked = !!r.untagged;
  $('#smartDateField').value = r.dateField || 'edited';
  $('#smartDate').value = r.date || '';
  $('#smartCheck').value = r.check || '';
  $('#smartAtt').value = r.att || '';
  $('#smartFolder').innerHTML = '<option value="*">모든 폴더</option><option value="">노트</option>' + [...settings.folders].sort(byName).map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
  $('#smartFolder').value = r.folder === undefined || r.folder === '' ? '*' : r.folder || '';
  $('#smartPinned').checked = !!r.pinned;
  renderSmartTags();
  smartCount();
  const d = $('#smartSheet');
  d.returnValue = '';
  d.showModal();
  if (!item) $('#smartName').focus();
}
$('#smartTags').onclick = (e) => {
  const b = e.target.closest('[data-st]');
  if (!b) return;
  const t = b.dataset.st;
  smartPick = smartPick.includes(t) ? smartPick.filter((x) => x !== t) : [...smartPick, t];
  b.classList.toggle('on', smartPick.includes(t));
  smartCount();
};
$('#smartSheet').addEventListener('change', smartCount);
$('#smartSheet').addEventListener('close', () => {
  const d = $('#smartSheet');
  if (d.returnValue !== 'ok') return;
  const rules = smartRulesFromForm();
  if (!smartTests(rules).length) return toast('조건이 없어 스마트 폴더를 만들지 않았습니다');
  const name = $('#smartName').value.trim() || '스마트 폴더';
  if (smartEditing) Object.assign(smartEditing, { name, rules });
  else { smartEditing = { id: crypto.randomUUID(), name, rules }; settings.smart.push(smartEditing); }
  saveSettings();
  setScope({ type: 'smart', id: smartEditing.id });
});
function newFolder() {
  const name = (prompt('새로운 폴더 이름', '새로운 폴더') || '').trim();
  if (!name) return null;
  const f = { id: crypto.randomUUID(), name };
  settings.folders.push(f);
  saveSettings();
  return f;
}
$('#newFolderBtn').onclick = () => { const f = newFolder(); if (f) setScope({ type: 'folder', id: f.id }); };
$('#newSmartBtn').onclick = () => editSmart(null);
// drag notes from the list onto a folder to move them
folderList.addEventListener('dragover', (e) => {
  const li = e.target.closest('li[data-drop]');
  if (!li || !e.dataTransfer.types.includes('text/x-breeze-note')) return;
  e.preventDefault();
  for (const x of folderList.querySelectorAll('.drop')) x.classList.remove('drop');
  li.classList.add('drop');
});
folderList.addEventListener('dragleave', (e) => e.target.closest?.('li[data-drop]')?.classList.remove('drop'));
folderList.addEventListener('drop', (e) => {
  const li = e.target.closest('li[data-drop]');
  if (!li) return;
  e.preventDefault();
  li.classList.remove('drop');
  const ids = e.dataTransfer.getData('text/x-breeze-note').split(',');
  moveNotes(ids.map((id) => index.get(id)).filter(Boolean), li.dataset.drop || null);
});
function moveNotes(ns, folder) {
  ns = ns.filter((n) => folderOf(n) !== folder);
  if (!ns.length) return;
  ns.forEach((n) => { n.folder = folder; touch(n); });
  flush();
  if (current && ns.includes(current) && !inScope(current) && !single()) open(visible()[0]);
  renderList();
  renderFolders();
  toast(`${ns.length}개를 '${folder ? folderById(folder).name : '노트'}' 폴더로 옮겼습니다`);
}

// phone / gallery: the folder list is its own screen (‹ 폴더). Mac: a column that can be hidden.
let foldersOpen = innerWidth >= 1000;
try { const v = localStorage.getItem('breeze.folders'); if (v !== null) foldersOpen = v === '1'; } catch {}
app.classList.toggle('folders-open', foldersOpen);
function showFolders() {
  if (current) leave(current);
  app.classList.add('show-folders');
  renderFolders();
  if (touchUI) history.pushState({ folders: 1 }, '');
}
function hideFolders() {
  if (!app.classList.contains('show-folders')) return;
  app.classList.remove('show-folders');
  if (history.state?.folders) history.back();
}
$('#foldersBtn').onclick = () => {
  if (single()) return showFolders();
  foldersOpen = !app.classList.contains('folders-open');
  app.classList.toggle('folders-open', foldersOpen);
  try { localStorage.setItem('breeze.folders', foldersOpen ? '1' : '0'); } catch {}
  renderFolders();
};
// what the list shows, in order — also drives arrow-key navigation
function listed(all = visible()) {
  const q = search.value.trim().toLowerCase();
  return all.filter((n) => (!q || textOf(n).toLowerCase().includes(q)) && (!tagFilterOn() || matchesTags(n)));
}

/* ---------------- list ---------------- */
const PIN = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="margin-right:4px;color:var(--accent)"><path d="M9 3h6l-1 6 3 3v2h-4v8h-2v-8H7v-2l3-3Z"/></svg>';
function renderList() {
  openRow = null;
  const q = search.value.trim();
  const all = visible();
  renderTags(all);
  const items = listed(all);
  const mode = trashMode ? 'list' : view;
  list.className = mode === 'list' ? '' : mode;
  const sel = (n) => (selected.has(n.id) ? ' sel' : '');
  const card = (n) => {
    const { title } = info(n);
    const thumb = /<img data-img="([^"]+)"/.exec(n.body);
    const cover = thumb ? `<img class="thumb" data-img="${thumb[1]}" alt="">` : `<div class="snip">${esc(textOf(n).trim().slice(0, 240))}</div>`;
    return `<li data-id="${n.id}" class="card${n === current ? ' active' : ''}${sel(n)}"><div class="cv">${cover}</div><div class="t">${n.pinned ? PIN : ''}${esc(title)}</div><div class="d">${fmt(sortDate(n))}</div></li>`;
  };
  const row = mode === 'gallery' ? card : (n) => {
    const { title, preview } = info(n);
    const when = trashMode ? `${Math.max(1, Math.ceil(TRASH_DAYS - (Date.now() - n.updatedAt) / 864e5))}일 남음` : fmt(sortDate(n));
    const where = scope.type !== 'folder' && !trashMode && folderOf(n) ? `<span class="in-folder">${esc(folderById(n.folder).name)}</span>` : '';
    const thumb = /<img data-img="([^"]+)"/.exec(n.body);
    return `<li data-id="${n.id}" class="${n === current ? 'active' : ''}${sel(n)}"${touchUI ? '' : ' draggable="true"'}><div class="sw"><div class="txt"><div class="t">${n.pinned && !trashMode ? PIN : ''}${esc(title)}</div><div class="p"><time>${when}</time>${esc(preview)}</div>${where}</div>${thumb ? `<img class="thumb" data-img="${thumb[1]}" alt="">` : ''}</div></li>`;
  };
  const trashCount = notes.filter(inTrash).length;
  $('#emptyTrashBtn').hidden = !trashMode || !trashCount;
  $('#composeBtn').hidden = trashMode;
  $('#noteCount').textContent = trashMode ? '' : `노트 ${all.length}개`;
  $('#sideCount').textContent = trashMode ? `${trashCount}개의 노트` : `${all.length}개의 노트`;
  if (mode === 'attachments') return renderAttachments(items);
  const pinned = trashMode ? [] : items.filter((n) => n.pinned), rest = items.filter((n) => trashMode || !n.pinned);
  let html = '';
  if (pinned.length) html += '<li class="sec">고정됨</li>' + pinned.map(row).join('');
  let group = '';
  for (const n of rest) {
    const g = trashMode || !groupDates || sortBy === 'title' ? (pinned.length && !trashMode ? '노트' : '') : groupOf(sortDate(n));
    if (g !== group) { if (g) html += `<li class="sec">${g}</li>`; group = g; }
    html += row(n);
  }
  list.innerHTML = html || `<li class="none">${q ? '검색 결과 없음' : trashMode ? '최근 삭제된 항목이 없습니다' : '노트가 없습니다'}</li>`;
  loadThumbs();
  if (app.classList.contains('folders-open') || app.classList.contains('show-folders')) renderFolders();
}
function loadThumbs() {
  for (const img of list.querySelectorAll('img.thumb')) {
    const url = imgUrls.get(img.dataset.img);
    url ? (img.src = url) : thumbObserver.observe(img);
  }
}

/* ---------------- attachments view (사진 · 링크 · 문서 · 오디오) ---------------- */
const ATT_TABS = [['photos', '사진'], ['links', '링크'], ['docs', '문서'], ['audio', '오디오']];
const AUDIO_EXT = /\.(m4a|mp3|wav|aac|ogg|caf|amr|flac)$/i;
const decodeHtml = (s) => { decoder.innerHTML = s; return decoder.value; };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
function attachmentsOf(list) {
  const out = { photos: [], links: [], docs: [], audio: [] };
  for (const n of list) {
    for (const m of n.body.matchAll(/<img data-img="([^"]+)"/g)) out.photos.push({ n, id: m[1] });
    for (const m of n.body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      const attrs = m[1], label = decodeHtml(m[2].replace(/<[^>]*>/g, ''));
      const file = /data-file="([^"]+)"/.exec(attrs);
      if (file) {
        const name = decodeHtml(/data-name="([^"]*)"/.exec(attrs)?.[1] || label);
        (AUDIO_EXT.test(name) ? out.audio : out.docs).push({ n, id: file[1], name, size: label.split(' · ').pop() });
        continue;
      }
      const href = /href="([^"]+)"/.exec(attrs);
      if (href && !attrs.includes('note-link')) out.links.push({ n, url: decodeHtml(href[1]), text: label });
    }
  }
  return out;
}
function renderAttachments(items) {
  const a = attachmentsOf(items), rows = a[attTab];
  let html = `<li class="att-tabs">${ATT_TABS.map(([k, l]) => `<button data-att-tab="${k}" class="${k === attTab ? 'on' : ''}">${l}<span>${a[k].length}</span></button>`).join('')}</li>`;
  const noteBtn = (n) => `<button class="att-note" data-open="${n.id}" title="${esc(info(n).title)}">노트 ›</button>`;
  if (!rows.length) html += '<li class="none">없습니다</li>';
  else if (attTab === 'photos') html += rows.map((p) => `<li class="att-photo" data-open="${p.n.id}"><img class="thumb" data-img="${p.id}" alt=""></li>`).join('');
  else if (attTab === 'links') html += rows.map((l) => `<li class="att-row" data-url="${esc(l.url)}"><span class="ico">🔗</span><div class="txt"><div class="t">${esc(l.text || l.url)}</div><div class="p">${esc(hostOf(l.url))} · ${esc(info(l.n).title)}</div></div>${noteBtn(l.n)}</li>`).join('');
  else html += rows.map((f) => `<li class="att-row" data-file="${f.id}" data-name="${esc(f.name)}"><span class="ico">${attTab === 'audio' ? '🎵' : '📄'}</span><div class="txt"><div class="t">${esc(f.name)}</div><div class="p">${esc(f.size)} · ${esc(info(f.n).title)}</div></div>${noteBtn(f.n)}</li>`).join('');
  list.className = `attachments${attTab === 'photos' ? ' photos' : ''}`;
  list.innerHTML = html;
  loadThumbs();
}
// Apple Notes-style sections: 오늘, 어제, 지난 7일, 지난 30일, then month (this year) or year.
function groupOf(ms) {
  const now = new Date(), day = 864e5;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ms >= today) return '오늘';
  if (ms >= today - day) return '어제';
  if (ms >= today - 6 * day) return '지난 7일';
  if (ms >= today - 29 * day) return '지난 30일';
  const d = new Date(ms);
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}월` : `${d.getFullYear()}년`;
}
// Thumbnails load only when scrolled into view, so a long list stays fast.
const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    blobUrl(e.target.dataset.img).then((url) => { if (url) e.target.src = url; else e.target.remove(); });
  }
}, { root: list, rootMargin: '300px' });
const tagBar = $('#tags');
let tagCounts = new Map(); // tag → number of notes, also feeds the # suggestions
function renderTags(all) {
  const counts = new Map();
  for (const n of all) for (const t of tagsOf(n)) counts.set(t, (counts.get(t) || 0) + 1);
  tagCounts = counts;
  tagSel.inc = tagSel.inc.filter((t) => counts.has(t));
  tagSel.exc = tagSel.exc.filter((t) => counts.has(t));
  const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
  tagBar.hidden = trashMode || !tags.length;
  const chip = ([t, c]) => {
    const st = tagSel.inc.includes(t) ? ' on' : tagSel.exc.includes(t) ? ' off' : '';
    return `<button class="tag${st}" data-tag="${esc(t)}" title="누르면 선택 · ${touchUI ? '길게 눌러' : '오른쪽 클릭으로'} 제외/이름 바꾸기">#${esc(t)}<span>${c}</span></button>`;
  };
  tagBar.innerHTML =
    (tagSel.inc.length > 1 ? `<button class="tag mode" data-tagmode title="여러 태그를 고를 때의 조건">${tagSel.mode === 'all' ? '모두 포함' : '하나라도'} ▾</button>` : '') +
    tags.map(chip).join('') +
    `<button class="tag untagged${tagSel.untagged ? ' on' : ''}" data-untagged>태그 없음</button>` +
    (tagFilterOn() ? '<button class="tag clear" data-tagclear>해제</button>' : '') +
    (tagSel.inc.length || tagSel.untagged ? '<button class="tag clear" data-tagsave title="지금 고른 태그로 스마트 폴더 만들기">스마트 폴더로</button>' : '');
}
tagBar.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.tagmode !== undefined) tagSel.mode = tagSel.mode === 'all' ? 'any' : 'all';
  else if (b.dataset.untagged !== undefined) { tagSel.untagged = !tagSel.untagged; if (tagSel.untagged) tagSel.inc = []; }
  else if (b.dataset.tagclear !== undefined) clearTagSel();
  else if (b.dataset.tagsave !== undefined) return editSmart(null, { tags: [...tagSel.inc], tagMode: tagSel.mode, untagged: tagSel.untagged });
  else if (b.dataset.tag) {
    const t = b.dataset.tag;
    if (e.altKey) return toggleTagExclude(t); // ⌥-click: exclude
    tagSel.exc = tagSel.exc.filter((x) => x !== t);
    tagSel.inc = tagSel.inc.includes(t) ? tagSel.inc.filter((x) => x !== t) : [...tagSel.inc, t];
    if (tagSel.inc.length) tagSel.untagged = false;
  }
  list.scrollTop = 0;
  renderList();
});
function toggleTagExclude(t) {
  tagSel.inc = tagSel.inc.filter((x) => x !== t);
  tagSel.exc = tagSel.exc.includes(t) ? tagSel.exc.filter((x) => x !== t) : [...tagSel.exc, t];
  renderList();
}
// right-click (Mac) / long-press (phone) on a tag: exclude · rename · delete
const tagMenu = $('#tagMenu');
let tagMenuFor = null;
tagBar.addEventListener('contextmenu', (e) => {
  const b = e.target.closest('[data-tag]');
  if (!b) return;
  e.preventDefault();
  tagMenuFor = b.dataset.tag;
  tagMenu.querySelector('[data-tm=exclude]').textContent = tagSel.exc.includes(tagMenuFor) ? '제외 해제' : '이 태그 제외하고 보기';
  tagMenu.hidden = false;
  const r = b.getBoundingClientRect(), m = tagMenu.getBoundingClientRect();
  tagMenu.style.left = `${Math.max(8, Math.min(innerWidth - m.width - 8, r.left))}px`;
  tagMenu.style.top = `${r.bottom + 6}px`;
});
tagMenu.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tm]');
  if (!b || !tagMenuFor) return;
  tagMenu.hidden = true;
  const t = tagMenuFor;
  if (b.dataset.tm === 'exclude') toggleTagExclude(t);
  else if (b.dataset.tm === 'rename') {
    const nw = (prompt(`#${t} 의 새 이름`, t) || '').trim().replace(/^#/, '').replace(/[^\p{L}\p{N}_\-/]+/gu, '_');
    if (!nw || nw === t) return;
    if (!/^[\p{L}_]/u.test(nw)) return toast('태그는 글자로 시작해야 합니다');
    toast(`${retag(t, nw)}개 노트에서 #${t} → #${nw}`);
  } else if (b.dataset.tm === 'delete') {
    if (!confirm(`#${t} 태그를 모든 노트에서 지울까요? 노트 내용은 그대로 남습니다.`)) return;
    toast(`${retag(t, null)}개 노트에서 #${t} 태그를 지웠습니다`);
  }
});
document.addEventListener('pointerdown', (e) => { if (!tagMenu.hidden && !e.target.closest('#tagMenu')) tagMenu.hidden = true; });
// rename (nw) or remove (nw = null) a tag in every note's text
function retag(old, nw) {
  const escRe = old.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  const re = new RegExp(`(^|[\\s(>]|&nbsp;)#${escRe}(?![\\p{L}\\p{N}_\\-/])`, 'gu');
  let k = 0;
  for (const n of notes) {
    if (n.deleted || isMeta(n) || isLocked(n) || !tagsOf(n).includes(old)) continue;
    n.body = n.body.replace(re, nw ? `$1#${nw}` : '$1');
    touch(n);
    k++;
  }
  tagSel.inc = tagSel.inc.map((x) => (x === old ? nw : x)).filter(Boolean);
  tagSel.exc = tagSel.exc.map((x) => (x === old ? nw : x)).filter(Boolean);
  flush();
  if (current) setBody(current.body);
  renderList();
  return k;
}
// drag a note from the list onto a tag to tag it (Apple Notes does the same)
tagBar.addEventListener('dragover', (e) => {
  const b = e.target.closest('[data-tag]');
  if (!b || !e.dataTransfer.types.includes('text/x-breeze-note')) return;
  e.preventDefault();
  for (const x of tagBar.querySelectorAll('.drop')) x.classList.remove('drop');
  b.classList.add('drop');
});
tagBar.addEventListener('dragleave', (e) => e.target.closest?.('[data-tag]')?.classList.remove('drop'));
tagBar.addEventListener('drop', (e) => {
  const b = e.target.closest('[data-tag]');
  if (!b) return;
  e.preventDefault();
  b.classList.remove('drop');
  const ids = e.dataTransfer.getData('text/x-breeze-note').split(',');
  const k = addTag(ids.map((id) => index.get(id)).filter(Boolean), b.dataset.tag);
  toast(k ? `${k}개 노트에 #${b.dataset.tag} 태그를 붙였습니다` : `이미 #${b.dataset.tag} 태그가 붙어 있어요`);
});
list.addEventListener('dragstart', (e) => {
  const li = e.target.closest?.('li[data-id]');
  if (!li) return;
  const ids = selecting && selected.has(li.dataset.id) ? [...selected] : [li.dataset.id];
  e.dataTransfer.setData('text/x-breeze-note', ids.join(','));
  e.dataTransfer.effectAllowed = 'copy';
});
let listRaf = 0;
function renderListSoon() {
  if (single() && app.classList.contains('show-editor')) return; // list is off-screen; showList() re-renders it
  if (!listRaf) listRaf = requestAnimationFrame(() => { listRaf = 0; renderList(); });
}

list.addEventListener('dblclick', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li || mobile.matches) return;
  window.open(`${location.pathname}?note=${li.dataset.id}`, `breeze-${li.dataset.id}`, 'popup,width=640,height=760');
});
let swipedAt = 0;
list.addEventListener('click', (e) => {
  if (eatClick) { eatClick = false; return; } // the tap that ends a long press
  if (Date.now() - swipedAt < 400) return; // the click that ends a swipe
  if (openRow) { closeRow(); return; } // a tap anywhere just closes an open swipe button
  const tab = e.target.closest('[data-att-tab]');
  if (tab) { attTab = tab.dataset.attTab; list.scrollTop = 0; renderList(); return; }
  const toNote = e.target.closest('[data-open]');
  if (toNote) { open(index.get(toNote.dataset.open)); return; }
  const link = e.target.closest('li[data-url]');
  if (link) { window.open(link.dataset.url, '_blank', 'noopener'); return; }
  const file = e.target.closest('li[data-file]');
  if (file) { openFile(file.dataset.file, file.dataset.name); return; }
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  if (selecting) toggleSel(li.dataset.id);
  else open(index.get(li.dataset.id));
});

// Swipe a row (phone): ← shows 삭제, → shows 고정 (in trash: 영구 삭제 / 복구). Nothing happens until the button is tapped.
// Long-press a note: select several, then 이동 · 공유 · 삭제.
const ACT_W = 96, REVEAL = 60;
let sw = null, openRow = null, pressT = 0, eatClick = false;
const swipeLabel = (left, n) => (left ? (trashMode ? '영구 삭제' : '삭제') : (trashMode ? '복구' : n?.pinned ? '고정 해제' : '고정'));
list.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || e.target.closest('.swipe-act')) return;
  eatClick = false; // a new gesture
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  if (!trashMode && !selecting) {
    clearTimeout(pressT);
    pressT = setTimeout(() => { if (sw?.active) return; sw = null; eatClick = true; enterSelect(li.dataset.id); }, 480);
  }
  const inner = li.querySelector('.sw');
  if (inner && !selecting) sw = { li, inner, x: e.clientX, y: e.clientY, dx: 0, active: false, armed: false, id: e.pointerId };
});
list.addEventListener('pointermove', (e) => {
  if (!sw || e.pointerId !== sw.id) return;
  const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(pressT);
  if (!sw.active) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { sw = null; return; }
    if (Math.abs(dx) < 12) return;
    if (openRow && openRow !== sw.li) closeRow();
    sw.active = true;
    try { sw.li.setPointerCapture(e.pointerId); } catch {}
    sw.inner.style.transition = 'none';
  }
  sw.dx = dx;
  const max = sw.li.offsetWidth * 0.45;
  sw.inner.style.transform = `translateX(${Math.max(-max, Math.min(max, dx))}px)`;
  sw.li.dataset.swipe = dx < 0 ? 'left' : 'right';
  sw.li.dataset.label = swipeLabel(dx < 0, index.get(sw.li.dataset.id));
  const armed = Math.abs(dx) > REVEAL;
  if (armed !== sw.armed) { sw.armed = armed; sw.li.classList.toggle('armed', armed); if (armed) navigator.vibrate?.(8); }
});
function endSwipe() {
  clearTimeout(pressT);
  if (!sw) return;
  const { li, inner, active, dx } = sw;
  sw = null;
  if (!active) return;
  swipedAt = Date.now();
  inner.style.transition = '';
  li.classList.remove('armed');
  delete li.dataset.swipe;
  if (Math.abs(dx) < REVEAL) { inner.style.transform = ''; return; }
  closeRow();
  const left = dx < 0, n = index.get(li.dataset.id);
  const b = document.createElement('button');
  b.className = `swipe-act ${left ? 'left' : 'right'}`;
  b.textContent = swipeLabel(left, n);
  b.onclick = (ev) => {
    ev.stopPropagation();
    closeRow();
    if (!n) return;
    if (left) trashMode ? purgeNote(n) : removeNote(n);
    else if (trashMode) restoreNote(n);
    else { n.pinned = !n.pinned; touch(n); syncPin(); renderList(); }
  };
  li.prepend(b);
  inner.style.transform = `translateX(${left ? -ACT_W : ACT_W}px)`;
  openRow = li;
}
function closeRow() {
  if (!openRow) return;
  const r = openRow;
  openRow = null;
  const inner = r.querySelector('.sw');
  if (inner) inner.style.transform = '';
  setTimeout(() => { if (openRow !== r) r.querySelector('.swipe-act')?.remove(); }, 260);
}
list.addEventListener('pointerup', endSwipe);
list.addEventListener('pointercancel', endSwipe);
list.addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li || trashMode) return;
  e.preventDefault(); // no browser menu on long press; right-click on a Mac also starts selecting
  if (!touchUI && !selecting) enterSelect(li.dataset.id);
});

/* ---------------- multi-select: 이동 · 공유 · 삭제 ---------------- */
let selecting = false;
const selected = new Set();
function enterSelect(id) {
  closeRow();
  selecting = true;
  selected.clear();
  if (id) selected.add(id);
  app.classList.add('selecting');
  $('#selBar').hidden = $('#selActions').hidden = false;
  if (touchUI) history.pushState({ select: 1 }, '');
  navigator.vibrate?.(15);
  updateSel();
  renderList();
}
function exitSelect(fromPop) {
  if (!selecting) return;
  selecting = false;
  selected.clear();
  app.classList.remove('selecting');
  $('#selBar').hidden = $('#selActions').hidden = true;
  renderList();
  if (!fromPop && history.state?.select) history.back();
}
function toggleSel(id) {
  selected.has(id) ? selected.delete(id) : selected.add(id);
  list.querySelector(`li[data-id="${id}"]`)?.classList.toggle('sel', selected.has(id));
  updateSel();
}
function updateSel() {
  $('#selCount').textContent = selected.size ? `${selected.size}개 선택됨` : '노트 선택';
  for (const b of document.querySelectorAll('#selActions button')) b.disabled = !selected.size;
}
$('#selDone').onclick = () => exitSelect();
$('#selAll').onclick = () => {
  const ids = listed().map((n) => n.id);
  if (ids.every((id) => selected.has(id))) selected.clear(); else ids.forEach((id) => selected.add(id));
  updateSel();
  renderList();
};
$('#selActions').onclick = async (e) => {
  const b = e.target.closest('[data-sel]');
  if (!b || !selected.size) return;
  const ns = [...selected].map((id) => index.get(id)).filter(Boolean);
  if (b.dataset.sel === 'del') {
    ns.forEach((n) => { n.deleted = true; touch(n); });
    undoStack.push(...ns);
    flush();
    if (ns.includes(current)) { current = null; if (!single()) open(visible()[0]); }
    exitSelect();
    toast(`${ns.length}개를 휴지통으로 옮겼습니다`, '실행 취소', () => {
      ns.forEach((n) => { undoStack.splice(undoStack.indexOf(n), 1); n.deleted = false; touch(n); });
      flush();
      renderList();
    });
  } else if (b.dataset.sel === 'share') {
    const text = ns.map((n) => textOf(n).trim()).join('\n\n———\n\n');
    try {
      if (navigator.share) await navigator.share({ title: ns.length === 1 ? info(ns[0]).title : `노트 ${ns.length}개`, text });
      else { await navigator.clipboard.writeText(text); toast('클립보드에 복사했습니다'); }
    } catch {}
  } else openMoveSheet(ns);
};
function openMoveSheet(ns) {
  const d = $('#moveSheet');
  const here = new Set(ns.map(folderOf));
  const opts = [{ id: null, name: '노트' }, ...[...settings.folders].sort(byName)];
  $('#moveTitle').textContent = `${ns.length}개 노트를 폴더로 이동`;
  $('#moveChoices').innerHTML = opts.map((f) => `<button type="button" data-move="${f.id || ''}"${here.size === 1 && here.has(f.id) ? ' class="here"' : ''}>${FOLDER_ICO}<span>${esc(f.name)}</span></button>`).join('');
  $('#moveChoices').onclick = (e) => {
    const b = e.target.closest('[data-move]');
    if (!b) return;
    d.close();
    moveNotes(ns, b.dataset.move || null);
    exitSelect();
  };
  $('#moveNewFolder').onclick = () => { const f = newFolder(); if (!f) return; d.close(); moveNotes(ns, f.id); exitSelect(); };
  $('#moveToTag').onclick = () => { d.close(); openTagSheet(ns); };
  d.showModal();
}
// add a tag line to notes that don't have the tag yet; returns how many changed
function addTag(ns, t) {
  let k = 0;
  for (const n of ns) {
    if (n.deleted || isLocked(n) || tagsOf(n).includes(t)) continue;
    n.body += `<div>#${esc(t)}</div>`;
    touch(n);
    k++;
  }
  flush();
  if (current && ns.includes(current)) setBody(current.body);
  renderList();
  return k;
}
// 이동: Breeze uses tags as folders, so moving = adding a tag line to each note.
function openTagSheet(ns) {
  const tags = [...new Set(live().flatMap(tagsOf))].sort((a, b) => a.localeCompare(b, 'ko'));
  $('#tagChoices').innerHTML = tags.map((t) => `<button type="button" class="tag" data-pick="${esc(t)}">#${esc(t)}</button>`).join('') || '<p class="hint">아직 태그가 없습니다. 아래에 새로 입력하세요.</p>';
  $('#newTag').value = '';
  const d = $('#tagSheet');
  d.returnValue = '';
  d.onclose = () => {
    if (d.returnValue !== 'ok') return;
    const t = $('#newTag').value.trim().replace(/^#/, '').replace(/[^\p{L}\p{N}_\-/]+/gu, '_');
    if (!/^[\p{L}_]/u.test(t)) { toast('태그는 글자로 시작해야 합니다'); return; }
    const k = addTag(ns, t);
    exitSelect();
    toast(`${k}개 노트에 #${t} 태그를 붙였습니다`);
  };
  d.showModal();
}
$('#tagChoices').onclick = (e) => { const b = e.target.closest('[data-pick]'); if (b) $('#newTag').value = b.dataset.pick; };
$('#tagCancel').onclick = () => $('#tagSheet').close('cancel');

/* ---------------- ⋯ view menu ---------------- */
function markView() {
  for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === view);
  for (const b of document.querySelectorAll('[data-sort]')) b.classList.toggle('on', b.dataset.sort === sortBy);
  const g = $('[data-groupdates]');
  g.classList.toggle('on', groupDates);
  g.disabled = sortBy === 'title';
  $('[data-counts]').classList.toggle('on', showCounts);
}
function setView(v) {
  if (trashMode) setTrash(false);
  exitSelect();
  view = v;
  try { localStorage.setItem('breeze.view', v); } catch {}
  applyLayout();
  if (single()) showList();
  else { app.classList.remove('show-editor'); app.classList.add('show-list'); open(current || visible()[0], { push: false }); }
  list.scrollTop = 0;
  renderList();
}
$('#viewBtn').onclick = (e) => { e.stopPropagation(); markView(); $('#viewMenu').hidden = !$('#viewMenu').hidden; };
$('#viewMenu').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.view) { $('#viewMenu').hidden = true; setView(b.dataset.view); return; }
  if (b.dataset.zoom) return setZoom(zoom + 0.1 * b.dataset.zoom);
  if (b.dataset.counts !== undefined) { setCounts(!showCounts); return markView(); }
  if (b.dataset.sort) sortBy = b.dataset.sort;
  else if (b.dataset.groupdates !== undefined) groupDates = !groupDates;
  else return;
  try { localStorage.setItem('breeze.sort', sortBy); localStorage.setItem('breeze.group', groupDates ? '1' : '0'); } catch {}
  markView();
  renderList();
};
document.addEventListener('click', (e) => { if (!e.target.closest('#viewMenu, #viewBtn')) $('#viewMenu').hidden = true; });
$('#viewMenu').addEventListener('pointerdown', (e) => { if (e.target.closest('[data-zoom]')) e.preventDefault(); });
search.addEventListener('input', () => { renderListSoon(); updateSearchSuggest(); });
const searchSuggest = $('#searchSuggest');
let ssug = { items: [], idx: 0 };
function updateSearchSuggest() {
  const m = /(?:^|\s)#([\p{L}\p{N}_\-/]*)$/u.exec(search.value);
  if (!m || trashMode) { searchSuggest.hidden = true; ssug.items = []; return; }
  const p = m[1].toLowerCase();
  const all = [...tagCounts].filter(([t]) => !tagSel.inc.includes(t)).sort((a, b) => b[1] - a[1]);
  const items = [...all.filter(([t]) => t.toLowerCase().startsWith(p)), ...all.filter(([t]) => !t.toLowerCase().startsWith(p) && t.toLowerCase().includes(p))].slice(0, 8);
  ssug = { items, idx: 0 };
  searchSuggest.hidden = !items.length;
  searchSuggest.innerHTML = '<div class="sg-head">태그로 거르기</div>' + items.map(([t, c], i) => `<button data-i="${i}" class="${i === 0 ? 'on' : ''}">#${esc(t)}<span>${c}</span></button>`).join('');
  const r = search.getBoundingClientRect();
  searchSuggest.style.left = `${r.left}px`;
  searchSuggest.style.top = `${r.bottom + 4}px`;
  searchSuggest.style.minWidth = `${Math.min(r.width, 280)}px`;
}
function pickSearchTag(i) {
  const t = ssug.items[i]?.[0];
  if (!t) return;
  search.value = search.value.replace(/(?:^|\s)#[\p{L}\p{N}_\-/]*$/u, '').trim();
  searchSuggest.hidden = true;
  tagSel.exc = tagSel.exc.filter((x) => x !== t);
  if (!tagSel.inc.includes(t)) tagSel.inc.push(t);
  tagSel.untagged = false;
  list.scrollTop = 0;
  renderList();
}
search.addEventListener('keydown', (e) => {
  if (searchSuggest.hidden || e.isComposing) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopImmediatePropagation();
    ssug.idx = (ssug.idx + (e.key === 'ArrowDown' ? 1 : -1) + ssug.items.length) % ssug.items.length;
    searchSuggest.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === ssug.idx));
  } else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); pickSearchTag(ssug.idx); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); searchSuggest.hidden = true; }
}, true);
search.addEventListener('blur', () => setTimeout(() => { searchSuggest.hidden = true; }, 150));
searchSuggest.addEventListener('pointerdown', (e) => e.preventDefault());
searchSuggest.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) pickSearchTag(+b.dataset.i); });

// Apple Notes-style keyboard: with the list focused, ↑/↓ move between notes, ⌫ trashes, Enter/→ edits.
list.tabIndex = 0;
list.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const order = listed();
  const i = order.indexOf(current);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = i < 0 ? order[0] : order[Math.min(order.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (n && n !== current) open(n);
  } else if ((e.key === 'Backspace' || e.key === 'Delete') && current) {
    e.preventDefault();
    trashMode ? purgeNote(current) : removeNote(current);
  } else if ((e.key === 'Enter' || e.key === 'ArrowRight') && current && !current.deleted) {
    e.preventDefault();
    setReading(false); editor.focus(); caretEnd();
  }
});
function scrollActive() { list.querySelector('li.active')?.scrollIntoView({ block: 'nearest' }); }
search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; renderList(); } });

/* ---------------- open / close ---------------- */
function open(n, { focus = false, push = true } = {}) {
  if (current && current !== n) leave(current);
  current = n || null;
  setBody(n ? n.body : '');
  pane.classList.toggle('none', !n);
  pane.classList.toggle('trashed', !!n?.deleted);
  setReading(readPref && !focus);
  // opened from a list search → jump to the first place the words appear; otherwise keep an open find bar going
  const q = search.value.trim();
  if (n && q && !soloId) openFind(q, { focus: false });
  else if (!findBar.hidden) n && !n.deleted ? runFind() : closeFind();
  syncPin();
  $('#noteDate').textContent = n ? new Date(edited(n)).toLocaleString('ko-KR', { dateStyle: 'long', timeStyle: 'short' }) : '';
  if (n && single() && !app.classList.contains('show-editor')) {
    app.classList.replace('show-list', 'show-editor');
    if (push) history.pushState({ note: n.id }, '');
  }
  renderList();
  scrollActive();
  if (n && focus) { editor.focus(); caretEnd(); }
}
// Reading mode (📖 toggle): notes can't be edited, so tapping never brings up the keyboard.
// It stays on across notes until toggled off.
const touchUI = matchMedia('(pointer: coarse)').matches;
document.documentElement.classList.toggle('touch', touchUI);
let readPref = false;
try { readPref = localStorage.getItem('breeze.reading') === '1'; } catch {}
let reading = false;
function setReading(on) {
  const editable = !!current && !current.deleted && !lockedNow();
  reading = on && editable;
  editor.contentEditable = editable && !reading ? 'true' : 'false';
  pane.classList.toggle('reading', reading);
  $('#readBtn').classList.toggle('on', reading);
  if (reading && document.activeElement === editor) editor.blur();
}
$('#readBtn').onclick = () => {
  readPref = !reading;
  try { localStorage.setItem('breeze.reading', readPref ? '1' : ''); } catch {}
  setReading(readPref);
  toast(readPref ? '읽기 모드: 눌러도 키보드가 뜨지 않습니다' : '읽기 모드를 껐습니다');
};
editor.addEventListener('focus', () => pane.classList.add('editing'));
editor.addEventListener('blur', () => pane.classList.remove('editing'));
function syncPin() { for (const b of document.querySelectorAll('[data-cmd=pin]')) b.classList.toggle('on', !!current?.pinned); }

function showList() {
  if (current) leave(current);
  current = null;
  app.classList.replace('show-editor', 'show-list');
  pane.classList.add('none');
  renderList();
}
// Empty notes vanish when you leave them, like Apple Notes.
function leave(n) {
  if (n.deleted) return;
  if (!hasContent(n)) {
    if (unsaved.has(n.id)) dropNote(n);
    else { n.deleted = true; touch(n); }
  }
  flush();
}
function caretEnd() {
  const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
function newNote() {
  if (trashMode) setTrash(false);
  const now = Date.now();
  const n = { id: crypto.randomUUID(), body: '', pinned: false, deleted: false, folder: scope.type === 'folder' ? scope.id : (scope.type === 'smart' && smartById(scope.id)?.rules.folder) || null, createdAt: now, editedAt: now, updatedAt: now, dirty: false };
  addNote(n); unsaved.add(n.id);
  search.value = '';
  open(n, { focus: true });
}

function setTrash(on) { setScope(on ? { type: 'trash' } : { type: 'all' }); }
$('#emptyTrashBtn').onclick = () => {
  const all = notes.filter(inTrash);
  if (!all.length || !confirm(`휴지통의 노트 ${all.length}개를 영구 삭제할까요? 되돌릴 수 없습니다.`)) return;
  all.forEach(purge);
  flush();
  open(null);
};
$('#restoreBtn').onclick = () => current && restoreNote(current);
$('#purgeBtn').onclick = () => current && purgeNote(current);

$('#newBtn').onclick = newNote;
$('#composeBtn').onclick = newNote;
// Wide screens (Mac, unfolded Fold): hide the list to write full-screen, like iPad.
function setFocusMode(on) { app.classList.toggle('focus', on); try { localStorage.setItem('breeze.focus', on ? '1' : ''); } catch {} }
$('#focusBtn').onclick = () => setFocusMode(!app.classList.contains('focus'));
try { if (localStorage.getItem('breeze.focus')) app.classList.add('focus'); } catch {}
// Keep the bottom bar just above the on-screen keyboard on browsers that don't resize the page for it.
if (window.visualViewport) {
  const fit = () => document.documentElement.style.setProperty('--vvh', `${visualViewport.height}px`);
  visualViewport.addEventListener('resize', fit);
  fit();
}
$('#emptyNew').onclick = newNote;
$('#backBtn').onclick = () => (history.state?.note ? history.back() : showList());
addEventListener('popstate', () => { // Android back button
  if (app.classList.contains('show-folders')) app.classList.remove('show-folders');
  else if (selecting) exitSelect(true);
  else if (app.classList.contains('show-editor')) showList();
});
function applyLayout() {
  app.classList.toggle('phone', mobile.matches);
  app.classList.toggle('single', single());
}
applyLayout();
mobile.addEventListener('change', () => {
  applyLayout();
  app.classList.remove('show-editor', 'show-list');
  app.classList.add(single() && current ? 'show-editor' : 'show-list');
});

/* ---------------- editor ---------------- */
document.execCommand('defaultParagraphSeparator', false, 'div');

/* ---------------- links: pasted or typed URLs become hyperlinks ---------------- */
const HAS_URL = /(?:https?:\/\/|www\.)\S/i;
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"']*[^\s<>"'.,;:!?)\]}]/gi;
const hrefOf = (u) => (/^www\./i.test(u) ? `https://${u}` : u);
function linkifyText(text) {
  return text.split(/\r?\n/).map((line) => {
    let out = '', last = 0;
    for (const m of line.matchAll(URL_RE)) {
      out += esc(line.slice(last, m.index)) + `<a href="${esc(hrefOf(m[0]))}">${esc(m[0])}</a>`;
      last = m.index + m[0].length;
    }
    return out + esc(line.slice(last));
  }).join('<br>');
}
// wrap a URL that ends at `end` inside a text node (called right after a space or Enter is typed)
function linkifyAt(node, end) {
  if (!node || node.nodeType !== 3 || node.parentElement.closest('a')) return;
  const m = /(?:https?:\/\/|www\.)[^\s<>"']+$/i.exec(node.data.slice(0, end));
  if (!m) return;
  const url = m[0].replace(/[.,;:!?)\]}]+$/, '');
  if (url.length < 8) return;
  const r = document.createRange();
  r.setStart(node, m.index);
  r.setEnd(node, m.index + url.length);
  const a = document.createElement('a');
  a.href = hrefOf(url);
  r.surroundContents(a);
}
function lastText(el) {
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let t = null;
  for (let n; (n = w.nextNode());) if (n.data.trim()) t = n;
  return t;
}

// Korean (and other IME) input is composed in place: 'ㄷ' → '다' → '닥'. Changing the line that holds the
// composition (its class, its wrapper) makes the browser commit early and the letters come apart ('ㄷㅏ').
// So while composing, only read the text; anything that touches the DOM waits for compositionend.
function tidyEditor() {
  const f = editor.firstChild;
  if (f && f.nodeType === 3 && getSelection().anchorNode === f) document.execCommand('formatBlock', false, '<div>');
  markTitle();
}
editor.addEventListener('compositionend', () => { if (current) { tidyEditor(); saveEditor(); } });
editor.addEventListener('input', (e) => {
  if (!current) return;
  if (e.isComposing) { saveEditor(); return; }
  if (e.inputType === 'insertText' && /\s/.test(e.data || '')) {
    const sel = getSelection();
    linkifyAt(sel.anchorNode, sel.anchorOffset - e.data.length);
  } else if (e.inputType === 'insertParagraph') {
    const prev = elAt()?.closest('#editor > *, li')?.previousElementSibling;
    const t = prev && lastText(prev);
    if (t) linkifyAt(t, t.data.length);
  }
  for (const img of editor.querySelectorAll('img:not([data-img])')) if (img.src) adoptImage(img);
  tidyEditor();
  saveEditor();
});
function saveEditor() {
  if (lockedNow()) return;
  current.editedAt = Date.now();
  const html = editor.innerHTML
    .replace(/<img\b[^>]*?data-img="([^"]+)"[^>]*>/g, '<img data-img="$1">')
    .replace(/ class="([^"]*)"/g, (_m, c) => { // the title mark is display-only
      const keep = c.split(/\s+/).filter((k) => k && !['title', 'sec-hidden', 'has-hidden'].includes(k));
      return keep.length ? ` class="${keep.join(' ')}"` : '';
    });
  if (isLocked(current)) sealSoon(current, html);
  else { current.body = html; touch(current); }
  highlightSoon();
  if (!findBar.hidden) runFind({ keep: true, scroll: false }); // matches follow the text while typing
}
// Images can arrive as files, as clipboard items (Android keyboards), or as data: URLs inside pasted HTML.
const clipFiles = (dt) => {
  const files = [...(dt?.files || [])];
  return files.length ? files : [...(dt?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
};
editor.addEventListener('paste', async (e) => {
  e.preventDefault();
  const files = clipFiles(e.clipboardData);
  if (files.length) return insertFiles(files);
  const html = e.clipboardData.getData('text/html');
  const srcs = [...html.matchAll(/<img[^>]+src="(data:image\/[^"]+)"/g)].map((m) => m[1]);
  if (srcs.length) {
    const blobs = await Promise.all(srcs.map((u) => fetch(u).then((r) => r.blob()).catch(() => null)));
    return insertFiles(blobs.filter(Boolean).map((b, i) => new File([b], `붙여넣은 이미지 ${i + 1}`, { type: b.type })));
  }
  const text = e.clipboardData.getData('text/plain');
  if (HAS_URL.test(text)) document.execCommand('insertHTML', false, linkifyText(text));
  else document.execCommand('insertText', false, text);
});
editor.addEventListener('beforeinput', (e) => {
  if (!/^insertFrom(Paste|Drop)|insertReplacementText/.test(e.inputType)) return;
  const files = clipFiles(e.dataTransfer);
  if (!files.length) return;
  e.preventDefault();
  insertFiles(files);
});
// Some keyboards insert an <img> directly — store it like any other photo.
async function adoptImage(img) {
  img.dataset.img = 'pending';
  try {
    const blob = await (await fetch(img.src)).blob();
    const id = await storePhoto(new File([blob], 'image', { type: blob.type || 'image/png' }));
    if (!id) throw new Error('unreadable');
    img.dataset.img = id;
    img.src = imgUrls.get(id);
  } catch { img.remove(); }
  changed();
  sync.schedule(800);
}
editor.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
editor.addEventListener('drop', (e) => {
  const files = [...e.dataTransfer.files];
  if (!files.length || !current) return;
  e.preventDefault();
  const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  insertFiles(files);
});
// Attached files open on click; links open in a new tab.
editor.addEventListener('click', (e) => {
  const chip = e.target.closest('a.file');
  if (chip) { e.preventDefault(); openFile(chip.dataset.file, chip.dataset.name); return; }
  const nl = e.target.closest('a.note-link');
  if (nl) {
    e.preventDefault();
    const n = index.get(nl.dataset.note);
    if (!n || n.deleted) return toast('링크된 노트가 삭제되었습니다');
    if (!inScope(n) && !search.value.trim()) setScope({ type: 'folder', id: folderOf(n) }, { toList: false });
    open(n);
    return;
  }
  const link = e.target.closest('a[href]');
  if (link) { e.preventDefault(); window.open(link.href, '_blank', 'noopener'); }
});

function setBody(html) {
  const locked = !!current && isLocked(current) && html === current.body;
  if (locked) {
    const plain = plainFor(current);
    const shut = plain === null;
    pane.classList.toggle('locked', shut);
    $('#lockView').hidden = !shut;
    if (shut) {
      editor.innerHTML = '';
      $('#lockMsg').textContent = '';
      if (lockKit.open()) decryptInto(current);
      else if (!touchUI) setTimeout(() => current && lockedNow() && $('#lockPw').focus());
      return;
    }
    html = plain;
  } else { pane.classList.remove('locked'); $('#lockView').hidden = true; }
  editor.innerHTML = html || (current ? '<div><br></div>' : '');
  markTitle();
  applySections();
  hydrate();
  highlightTags();
  refreshNoteLinks();
}
// The title is the first line that has text — the innermost block holding it, so a note whose
// whole body sits inside one wrapper (common in imported Apple Notes) doesn't turn into one big title.
const BLOCKS = 'div,p,h1,h2,h3,pre,li';
function markTitle() {
  let title = null, firstEmpty = null;
  for (const el of editor.querySelectorAll(BLOCKS)) {
    if (el.querySelector(BLOCKS)) continue;
    if (el.textContent.trim()) { title = el; break; }
    firstEmpty ??= el;
  }
  // an empty note: the first line is already the title, so typing the first letter changes nothing around it
  title ??= firstEmpty;
  // Enter copies the line's class onto the new line, so clear every other mark
  for (const el of editor.querySelectorAll('.title')) if (el !== title) { el.classList.remove('title'); if (!el.className) el.removeAttribute('class'); }
  title?.classList.add('title');
}

// Tags are coloured with the CSS Highlight API, so the editable DOM is never touched.
function highlightTags() {
  if (!window.Highlight || !CSS.highlights) return;
  const ranges = [];
  const walk = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  for (let t; (t = walk.nextNode());) {
    for (const m of t.data.matchAll(TAG_RE)) {
      const r = new Range();
      const start = m.index + m[0].indexOf('#');
      r.setStart(t, start); r.setEnd(t, start + 1 + m[1].length);
      ranges.push(r);
    }
  }
  CSS.highlights.set('tag', new Highlight(...ranges));
}
let hlRaf = 0;
function highlightSoon() { if (!hlRaf) hlRaf = requestAnimationFrame(() => { hlRaf = 0; highlightTags(); }); }

/* ---------------- images ---------------- */
const imgUrls = new Map(); // image id -> object URL
async function blobUrl(id) {
  let url = imgUrls.get(id);
  if (url) return url;
  let rec = await idb.img(id);
  if (!rec) {
    const blob = await sync.download(id);
    if (blob) { rec = { id, blob, uploaded: true }; await idb.putImg(rec); }
  }
  if (!rec) return null;
  url = URL.createObjectURL(rec.blob);
  imgUrls.set(id, url);
  return url;
}
async function hydrate() {
  for (const img of editor.querySelectorAll('img[data-img]')) {
    if (img.getAttribute('src')) continue;
    const url = await blobUrl(img.dataset.img);
    if (url) { img.src = url; img.classList.remove('missing'); } else img.classList.add('missing');
  }
}
// Shrink to at most 1600px and re-encode, so a phone photo becomes ~200KB instead of several MB.
async function compress(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const enc = (type, q) => new Promise((r) => c.toBlob(r, type, q));
  let blob = await enc('image/webp', 0.82);
  if (!blob || blob.type !== 'image/webp') { // Safari can't encode WebP
    g.globalCompositeOperation = 'destination-over'; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    blob = await enc('image/jpeg', 0.85);
  }
  return blob;
}
/* ---------------- files (photos are compressed, everything else is kept as-is) ---------------- */
const MAX_FILE = 50 * 1024 * 1024; // Supabase free-plan upload limit
const isPhoto = (f) => /^image\/(png|jpe?g|gif|webp|heic|heif|bmp|tiff)$/i.test(f.type) || /\.(heic|heif)$/i.test(f.name || '');
const fmtSize = (b) => (b < 1048576 ? `${Math.max(1, Math.round(b / 1024))}KB` : `${(b / 1048576).toFixed(1)}MB`);
const fileChip = (id, name, size) => `<a class="file" data-file="${id}" data-name="${esc(name)}" contenteditable="false">${esc(name)} · ${fmtSize(size)}</a>`;
async function storeBlob(blob) {
  const id = crypto.randomUUID();
  await idb.putImg({ id, blob, uploaded: false });
  return id;
}
async function storePhoto(file) {
  const blob = await compress(file).catch(() => null);
  if (!blob) return null;
  const id = await storeBlob(blob);
  imgUrls.set(id, URL.createObjectURL(blob));
  return id;
}
async function insertFiles(files) {
  if (!current) return;
  if (!editor.contains(getSelection().anchorNode)) { editor.focus(); caretEnd(); }
  for (const f of files) {
    const photoId = isPhoto(f) ? await storePhoto(f) : null; // undecodable photos (e.g. HEIC in Chrome) become plain files
    if (photoId) {
      document.execCommand('insertHTML', false, `<img data-img="${photoId}">`);
    } else if (f.size > MAX_FILE) {
      toast(`${f.name}: 50MB가 넘는 파일은 넣을 수 없습니다`);
    } else {
      document.execCommand('insertHTML', false, fileChip(await storeBlob(f), f.name, f.size) + '&nbsp;');
    }
  }
  hydrate();
  sync.schedule(800);
}
async function openFile(id, name) {
  let blob = (await idb.img(id))?.blob;
  if (!blob) {
    toast('파일을 받는 중…');
    blob = await sync.download(id);
    if (blob) await idb.putImg({ id, blob, uploaded: true });
  }
  if (!blob) return toast('파일을 열 수 없습니다. 동기화 상태를 확인하세요.');
  const url = URL.createObjectURL(new File([blob], name, { type: blob.type }));
  const viewable = /^(application\/pdf|image\/|text\/|audio\/|video\/)/.test(blob.type);
  if (!viewable || !window.open(url, '_blank')) {
    const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
const photoInput = $('#photoInput'), fileInput = $('#fileInput');
photoInput.onchange = () => { insertFiles([...photoInput.files]); photoInput.value = ''; };
fileInput.onchange = () => { insertFiles([...fileInput.files]); fileInput.value = ''; };
// Tap the circle to tick a checklist item.
editor.addEventListener('pointerdown', (e) => {
  const li = e.target.closest?.('ul.checklist > li');
  if (!li || e.clientX - li.getBoundingClientRect().left > parseFloat(getComputedStyle(li).paddingLeft)) return;
  e.preventDefault();
  li.classList.toggle('done');
  if (autoSortChecked) sortChecklist(li.parentElement);
  navigator.vibrate?.(8);
  editor.dispatchEvent(new Event('input'));
});
editor.addEventListener('keydown', (e) => {
  if (e.isComposing) return;
  if (e.key === 'Escape' && !mobile.matches) { e.preventDefault(); editor.blur(); list.focus(); return; }
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Tab' && !mod && !e.altKey) { e.preventDefault(); if (!indent(e.shiftKey ? 'out' : 'in') && !e.shiftKey) document.execCommand('insertText', false, '\t'); return; }
  if (mod && !e.shiftKey && (e.key === ']' || e.key === '[')) { e.preventDefault(); indent(e.key === ']' ? 'in' : 'out'); return; }
  if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && ((e.ctrlKey && e.metaKey) || (e.altKey && e.shiftKey))) { e.preventDefault(); moveLine(e.key === 'ArrowUp' ? -1 : 1); return; }
  if (e.key === 'Enter') setTimeout(() => { const li = elAt()?.closest('ul.checklist > li'); if (li && !li.textContent) li.classList.remove('done'); });
});

const elAt = () => { const n = getSelection().anchorNode; return n && (n.nodeType === 1 ? n : n.parentElement); };
const ulAt = () => elAt()?.closest('#editor ul, #editor ol');
const changed = () => editor.dispatchEvent(new Event('input'));

const cmds = {
  bold: () => document.execCommand('bold'),
  heading: (btn) => openStyleMenu(btn), // Aa: 제목 · 머리말 · 부머리말 · 본문 · 고정폭, B I U S, lists
  list: () => setList('ul'),
  check: () => setList('check'),
  pin: () => { current.pinned = !current.pinned; syncPin(); touch(current); renderList(); },
  del: () => removeNote(current),
  new: () => newNote(),
  photo: () => photoInput.click(),
  file: () => fileInput.click(),
  clip: () => pasteFromClipboard(),
  // ↶ ↷ while typing on a phone or Fold, where there's no ⌘Z
  undo: () => document.execCommand('undo'),
  redo: () => document.execCommand('redo'),
  more: (btn) => openNoteMenu(btn),
};
for (const b of document.querySelectorAll('[data-cmd]')) {
  b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the caret in the editor
  b.addEventListener('click', () => {
    const c = b.dataset.cmd;
    if (!current && c !== 'new') return;
    if (lockedNow() && !['del', 'more', 'pin'].includes(c)) return;
    if (!['pin', 'del', 'photo', 'file', 'new', 'more'].includes(c) && !editor.contains(getSelection().anchorNode)) { editor.focus(); caretEnd(); }
    cmds[c](b);
  });
}


/* ---------------- ⋯ note menu: 이동 · 잠금 · Markdown · 인쇄 ---------------- */
const noteMenu = $('#noteMenu');
function openNoteMenu(btn) {
  if (!noteMenu.hidden) { noteMenu.hidden = true; return; }
  const locked = isLocked(current);
  noteMenu.querySelector('[data-nm=lock]').textContent = locked ? '잠금 제거' : '노트 잠그기';
  noteMenu.querySelector('[data-nm=relock]').hidden = !lockKit.open();
  for (const k of ['move', 'md', 'print']) noteMenu.querySelector(`[data-nm=${k}]`).disabled = !!current.deleted || (k !== 'move' && lockedNow());
  noteMenu.querySelector('[data-nm=lock]').disabled = !!current.deleted;
  noteMenu.hidden = false;
  const r = btn.getBoundingClientRect(), m = noteMenu.getBoundingClientRect();
  noteMenu.style.left = `${Math.max(8, Math.min(innerWidth - m.width - 8, r.right - m.width))}px`;
  noteMenu.style.top = `${r.bottom + m.height + 8 < innerHeight ? r.bottom + 6 : Math.max(8, r.top - m.height - 6)}px`;
}
document.addEventListener('pointerdown', (e) => { if (!noteMenu.hidden && !e.target.closest('#noteMenu, [data-cmd=more]')) noteMenu.hidden = true; });
noteMenu.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-nm]');
  if (!b || !current) return;
  noteMenu.hidden = true;
  const k = b.dataset.nm;
  if (k === 'move') openMoveSheet([current]);
  else if (k === 'md') exportMarkdown(current);
  else if (k === 'print') printNote();
  else if (k === 'relock') { lockKit.forget(); toast('잠긴 노트를 다시 잠갔습니다'); }
  else if (k === 'lock') isLocked(current) ? removeLock(current) : lockNote(current);
});

/* ---------------- note lock (AES-GCM, key from the note password; never leaves the device) ---------------- */
// A locked note's body is <div class="locked" data-lock="iv.ciphertext">title</div>: the title stays readable
// in the list like Apple Notes, everything else is encrypted before it is saved or synced.
// settings.lock = { salt, check } — check is a known text encrypted with the key, to tell a wrong password.
const isLocked = (n) => !!n && n.body.startsWith('<div class="locked"');
const lockKit = (() => {
  let key = null;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function derive(pw, salt) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(salt), iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function seal(text, k = key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    return `${b64(iv)}.${b64(new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(text))))}`;
  }
  async function unseal(s, k = key) {
    const [iv, ct] = s.split('.').map(unb64);
    return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct));
  }
  return {
    open: () => !!key,
    async create(pw) {
      const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
      const k = await derive(pw, salt);
      settings.lock = { salt, check: await seal('breeze-lock', k) };
      saveSettings();
      key = k;
    },
    async unlock(pw) {
      const k = await derive(pw, settings.lock.salt);
      try { if ((await unseal(settings.lock.check, k)) !== 'breeze-lock') return false; } catch { return false; }
      key = k;
      return true;
    },
    seal: (t) => seal(t),
    unseal: (t) => unseal(t),
    forget() {
      key = null;
      plainCache.clear();
      if (current && isLocked(current)) { if (document.activeElement === editor) editor.blur(); setBody(current.body); setReading(readPref); }
    },
  };
})();
// decrypted text of unlocked notes, in memory only (never on the note object, which is written to disk)
const plainCache = new Map(); // id → { body (the encrypted body it came from), plain }
const plainFor = (n) => { const c = plainCache.get(n.id); return c && c.body === n.body ? c.plain : null; };
const lockedNow = () => !!current && isLocked(current) && plainFor(current) === null;
const lockedBody = (title, payload) => `<div class="locked" data-lock="${payload}">${esc(title)}</div>`;
async function decryptInto(n) {
  if (!lockKit.open()) return false;
  const payload = /data-lock="([^"]+)"/.exec(n.body)?.[1];
  try { plainCache.set(n.id, { body: n.body, plain: await lockKit.unseal(payload) }); } catch { return false; }
  if (n === current) { setBody(n.body); setReading(readPref); }
  return true;
}
// edits to an unlocked note: encrypt shortly after typing stops
const sealT = new Map();
function sealSoon(n, plain) {
  plainCache.set(n.id, { body: n.body, plain });
  clearTimeout(sealT.get(n.id));
  sealT.set(n.id, setTimeout(async () => {
    sealT.delete(n.id);
    const c = plainCache.get(n.id);
    if (!c || !lockKit.open()) return;
    tplDoc.innerHTML = c.plain;
    const title = (tplDoc.content.textContent.split('\n').map((x) => x.trim()).find(Boolean) || '잠긴 노트').slice(0, 120);
    const body = lockedBody(firstLine(c.plain) || title, await lockKit.seal(c.plain));
    n.body = body;
    plainCache.set(n.id, { body, plain: c.plain });
    touch(n);
  }, 400));
}
const tplDoc = document.createElement('template');
const firstLine = (html) => info({ id: '_tmp', body: html }).title;
async function askPassword(mode) { // mode: 'create' | 'unlock' → resolves true when the key is ready
  const d = $('#lockSheet');
  $('#lockTitle').textContent = mode === 'create' ? '노트 암호 만들기' : '노트 암호 입력';
  $('#lockHint').hidden = mode !== 'create';
  $('#lockAgainRow').hidden = mode !== 'create';
  $('#lockNew').value = $('#lockAgain').value = '';
  $('#lockNew').autocomplete = mode === 'create' ? 'new-password' : 'current-password';
  $('#lockSheetMsg').textContent = '';
  d.showModal();
  return new Promise((resolve) => {
    $('#lockSheetForm').onsubmit = async (e) => {
      if (e.submitter?.value === 'cancel') return;
      e.preventDefault();
      const pw = $('#lockNew').value;
      if (mode === 'create') {
        if (pw.length < 4) { $('#lockSheetMsg').textContent = '4자 이상으로 정해 주세요'; return; }
        if (pw !== $('#lockAgain').value) { $('#lockSheetMsg').textContent = '두 암호가 다릅니다'; return; }
        await lockKit.create(pw);
      } else if (!(await lockKit.unlock(pw))) { $('#lockSheetMsg').textContent = '암호가 맞지 않습니다'; return; }
      d.onclose = null;
      d.close('ok');
      resolve(true);
    };
    d.onclose = () => resolve(false);
  });
}
async function lockNote(n) {
  if (!lockKit.open() && !(await askPassword(settings.lock ? 'unlock' : 'create'))) return;
  if (n === current) saveEditor();
  const plain = n.body;
  const body = lockedBody(info(n).title, await lockKit.seal(plain));
  n.body = body;
  plainCache.set(n.id, { body, plain });
  touch(n);
  flush();
  if (n === current) setBody(n.body);
  toast('노트를 잠갔습니다. 잠긴 노트 모두 다시 잠그기나 앱을 다시 열면 잠깁니다');
}
async function removeLock(n) {
  if (!lockKit.open() && !(await askPassword('unlock'))) return;
  if (plainFor(n) === null && !(await decryptInto(n))) return toast('노트를 열 수 없습니다');
  clearTimeout(sealT.get(n.id)); sealT.delete(n.id);
  n.body = plainCache.get(n.id).plain;
  plainCache.delete(n.id);
  touch(n);
  flush();
  if (n === current) { setBody(n.body); setReading(readPref); }
  toast('잠금을 제거했습니다');
}
$('#lockForm').onsubmit = async (e) => {
  e.preventDefault();
  if (!current) return;
  if (!settings.lock) return ($('#lockMsg').textContent = '이 기기에 아직 암호 정보가 없습니다. 동기화가 끝난 뒤 다시 시도하세요');
  $('#lockMsg').textContent = '여는 중…';
  if (!(await lockKit.unlock($('#lockPw').value))) { $('#lockMsg').textContent = '암호가 맞지 않습니다'; $('#lockPw').select(); return; }
  $('#lockPw').value = '';
  $('#lockMsg').textContent = '';
  if (!(await decryptInto(current))) $('#lockMsg').textContent = '이 노트를 풀 수 없습니다 (다른 암호로 잠긴 노트일 수 있습니다)';
};
// like Apple Notes: everything locks again after the app has been in the background for a while
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 5 * 60e3 && lockKit.open()) lockKit.forget();
});

/* ---------------- Markdown export / import, print ---------------- */
function htmlToMarkdown(html) {
  tplDoc.innerHTML = html;
  const out = []; // [kind, text]; list items are joined by one newline, everything else by a blank line
  const inline = (node) => {
    let s = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { s += c.data.replace(/ /g, ' '); continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName, inner = () => inline(c);
      if (t === 'BR') s += '\n';
      else if (t === 'B' || t === 'STRONG') { const x = inner(); s += x.trim() ? `**${x}**` : x; }
      else if (t === 'I' || t === 'EM') { const x = inner(); s += x.trim() ? `*${x}*` : x; }
      else if (t === 'S' || t === 'STRIKE' || t === 'DEL') { const x = inner(); s += x.trim() ? `~~${x}~~` : x; }
      else if (t === 'IMG') s += '![사진]()';
      else if (t === 'A' && c.classList.contains('note-link')) s += `[[${c.textContent}]]`;
      else if (t === 'A' && c.classList.contains('file')) s += `📎 ${c.dataset.name || c.textContent}`;
      else if (t === 'A') { const x = inner(), h = c.getAttribute('href') || ''; s += !h || x === h ? x : `[${x}](${h})`; }
      else if (t === 'UL' || t === 'OL') continue; // nested lists are handled by the list walker
      else s += inner();
    }
    return s;
  };
  const list = (ul, depth) => {
    let i = 1;
    for (const li of ul.children) {
      if (li.tagName !== 'LI') continue;
      const mark = ul.tagName === 'OL' ? `${i++}.` : ul.classList.contains('checklist') ? (li.classList.contains('done') ? '- [x]' : '- [ ]') : '-';
      out.push(['li', `${'  '.repeat(depth)}${mark} ${inline(li).trim()}`]);
      for (const sub of li.querySelectorAll(':scope > ul, :scope > ol')) list(sub, depth + 1);
    }
  };
  const block = (el) => {
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { if (c.data.trim()) out.push(['p', c.data.trim()]); continue; }
      if (c.nodeType !== 1) continue;
      const t = c.tagName;
      if (t === 'UL' || t === 'OL') list(c, 0);
      else if (/^H[1-3]$/.test(t)) out.push(['h', `${'#'.repeat(+t[1])} ${inline(c).trim()}`]);
      else if (t === 'PRE') out.push(['p', '```\n' + c.textContent.replace(/\n$/, '') + '\n```']);
      else if (t === 'BLOCKQUOTE' && !c.getAttribute('style')) out.push(['p', inline(c).split('\n').map((l) => `> ${l}`).join('\n')]);
      else if (t === 'TABLE') {
        const rows = [...c.querySelectorAll('tr')].map((tr) => `| ${[...tr.children].map((td) => inline(td).replace(/\n/g, ' ').trim()).join(' | ')} |`);
        if (rows.length) { const n = (rows[0].match(/ \| /g) || []).length + 1; rows.splice(1, 0, `|${' --- |'.repeat(n)}`); out.push(['p', rows.join('\n')]); }
      } else if (c.querySelector('div, p, ul, ol, h1, h2, h3, pre, blockquote, table')) block(c);
      else { const x = inline(c).trim(); out.push(x ? ['p', x] : ['gap', '']); }
    }
  };
  block(tplDoc.content);
  // the first line is the note's title: make it a heading
  const first = out.findIndex(([k]) => k !== 'gap');
  if (first >= 0 && out[first][0] === 'p' && !out[first][1].includes('\n')) out[first] = ['h', `# ${out[first][1].replace(/^\*\*(.*)\*\*$/, '$1')}`];
  let md = '', prev = null;
  for (const [k, t] of out) {
    if (k === 'gap') { prev = 'gap'; continue; }
    if (prev) md += prev === 'li' && k === 'li' ? '\n' : '\n\n';
    md += t;
    prev = k;
  }
  return md.trim() + '\n';
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const safeName = (s) => (s.replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 80) || '노트');
function exportMarkdown(n) {
  if (n === current) saveEditor();
  const html = isLocked(n) ? plainFor(n) : n.body;
  if (html == null) return;
  download(`${safeName(info({ id: '_tmp', body: html }).title)}.md`, htmlToMarkdown(html), 'text/markdown;charset=utf-8');
}
function printNote() {
  if (!current) return;
  setAllSectionsForPrint(true);
  const before = document.title;
  document.title = safeName(info({ id: '_tmp', body: editor.innerHTML }).title); // becomes the PDF's file name
  addEventListener('afterprint', () => { document.title = before; setAllSectionsForPrint(false); }, { once: true });
  window.print();
}
// collapsed sections print open, then fold back
let printOpened = [];
function setAllSectionsForPrint(on) {
  if (on) { printOpened = [...editor.querySelectorAll('.sec-hidden')]; printOpened.forEach((x) => x.classList.remove('sec-hidden')); }
  else { printOpened.forEach((x) => x.classList.add('sec-hidden')); printOpened = []; }
}

function inlineMd(s) {
  s = esc(s);
  const keep = [];
  s = s.replace(/`([^`]+)`/g, (_m, c) => { keep.push(`<span style="font-family:ui-monospace,Menlo,monospace">${c}</span>`); return `\u0000${keep.length - 1}\u0000`; });
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_m, t) => {
    const n = live().find((x) => info(x).title === decodeHtml(t));
    return n ? `<a class="note-link" data-note="${n.id}" href="#note-${n.id}">${t}</a>` : t;
  });
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/(^|[^"=>])((?:https?:\/\/|www\.)[^\s<]*[^\s<.,;:!?)\]}])/g, (_m, p, u) => `${p}<a href="${hrefOf(u)}">${u}</a>`);
  s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_m, a, b) => `<b>${a ?? b}</b>`);
  s = s.replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)|(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, (_m, p1, a, p2, b) => `${p1 ?? p2}<i>${a ?? b}</i>`);
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[+i]);
}
function markdownToHtml(md, plainText) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  if (plainText) return lines.map((l) => (l.trim() ? `<div>${linkifyText(l)}</div>` : '<div><br></div>')).join('');
  let html = '', listKind = null, blank = 0, first = true;
  const closeList = () => { if (listKind) { html += listKind === 'ol' ? '</ol>' : '</ul>'; listKind = null; } };
  const openList = (k) => { if (listKind !== k) { closeList(); html += k === 'ol' ? '<ol>' : k === 'check' ? '<ul class="checklist">' : '<ul>'; listKind = k; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      closeList();
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      html += `<pre>${esc(code.join('\n'))}</pre>`;
      first = false; blank = 0;
      continue;
    }
    if (!l.trim()) { blank++; if (blank === 2) { closeList(); html += '<div><br></div>'; } continue; }
    blank = 0;
    let m;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(l))) {
      closeList();
      html += first && m[1].length === 1 ? `<div>${inlineMd(m[2])}</div>` : `<h${Math.min(3, m[1].length)}>${inlineMd(m[2])}</h${Math.min(3, m[1].length)}>`;
    } else if ((m = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(l))) { openList('check'); html += `<li${m[1] === ' ' ? '' : ' class="done"'}>${inlineMd(m[2])}</li>`; }
    else if ((m = /^\s*[-*+]\s+(.*)$/.exec(l))) { openList('ul'); html += `<li>${inlineMd(m[1])}</li>`; }
    else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(l))) { openList('ol'); html += `<li>${inlineMd(m[1])}</li>`; }
    else if ((m = /^>\s?(.*)$/.exec(l))) { closeList(); html += `<blockquote>${inlineMd(m[1]) || '<br>'}</blockquote>`; }
    else if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(l)) { closeList(); html += '<div>———</div>'; }
    else { closeList(); html += `<div>${inlineMd(l)}</div>`; }
    first = false;
  }
  closeList();
  return html.replace(/<\/blockquote><blockquote>/g, '<br>');
}
async function importMarkdown(files) {
  const folder = scope.type === 'folder' ? scope.id : null;
  let last = null, k = 0;
  for (const f of files) {
    const text = await f.text();
    if (!text.trim()) continue;
    const plain = !/\.(md|markdown)$/i.test(f.name) && f.type !== 'text/markdown';
    let body = markdownToHtml(text, plain);
    // a file without its own title line gets the file name as the title
    const fileTitle = f.name.replace(/\.[^.]+$/, '');
    if (!plain && !/^#\s/.test(text.trimStart())) body = `<div>${esc(fileTitle)}</div>` + body;
    const at = f.lastModified || Date.now();
    last = { id: crypto.randomUUID(), body, pinned: false, deleted: false, folder, createdAt: at, editedAt: at, updatedAt: Date.now(), dirty: true };
    addNote(last);
    k++;
  }
  if (!last) return toast('가져올 내용이 없습니다');
  await flush();
  renderList();
  if ($('#settings').open) $('#settings').close();
  open(last);
  toast(`노트 ${k}개를 가져왔습니다`);
}
$('#mdBtn').onclick = () => $('#mdFiles').click();
$('#mdFiles').onchange = (e) => { importMarkdown([...e.target.files]).catch((err) => toast('가져오기 실패: ' + err.message)); e.target.value = ''; };

/* ---------------- text size (⌘+ / ⌘− / ⌘0) and note counts ---------------- */
let zoom = 1, showCounts = true;
try { zoom = +localStorage.getItem('breeze.zoom') || 1; showCounts = localStorage.getItem('breeze.counts') !== '0'; } catch {}
function setZoom(z) {
  zoom = Math.round(Math.min(2, Math.max(0.7, z)) * 10) / 10;
  document.documentElement.style.setProperty('--zoom', zoom);
  $('#zoomLabel').textContent = `${Math.round(zoom * 100)}%`;
  try { localStorage.setItem('breeze.zoom', String(zoom)); } catch {}
}
function setCounts(on) {
  showCounts = on;
  app.classList.toggle('no-counts', !on);
  try { localStorage.setItem('breeze.counts', on ? '1' : '0'); } catch {}
}
setZoom(zoom);
setCounts(showCounts);

/* ---------------- lists, checklists, indentation (Apple Notes Format menu) ---------------- */
// Chrome's list/block commands keep the text but rebuild the line and drop the cursor at its start.
// The text itself doesn't change, so remember the cursor as "N characters into the note" and put it back.
function keepCaret(fn) {
  const sel = getSelection();
  let at = -1;
  const lineStart = sel.anchorOffset === 0; // at a line start, prefer the next line over the end of the previous one
  if (sel.rangeCount && sel.isCollapsed && editor.contains(sel.anchorNode)) {
    const r = document.createRange();
    r.setStart(editor, 0);
    r.setEnd(sel.anchorNode, sel.anchorOffset);
    at = r.toString().length;
  }
  fn();
  if (at < 0) return;
  const walk = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let left = at, last = null;
  for (let t; (t = walk.nextNode());) {
    last = t;
    if (left < t.length || (left === t.length && !lineStart)) { const r = document.createRange(); r.setStart(t, left); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); return; }
    left -= t.length;
  }
  if (last) { const r = document.createRange(); r.setStart(last, last.length); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); }
}
// kind: 'ul' bullets · 'dash' dashes · 'check' checklist · 'ol' numbers. Choosing the current kind again removes the list.
function setList(kind) { keepCaret(() => setListNow(kind)); changed(); }
function setListNow(kind) {
  const ul = ulAt();
  const curKind = !ul ? null : ul.tagName === 'OL' ? 'ol' : ul.classList.contains('checklist') ? 'check' : ul.classList.contains('dash') ? 'dash' : 'ul';
  if (ul && curKind === kind) { document.execCommand(kind === 'ol' ? 'insertOrderedList' : 'insertUnorderedList'); return; }
  if (ul && (kind === 'ol') !== (ul.tagName === 'OL')) document.execCommand(kind === 'ol' ? 'insertOrderedList' : 'insertUnorderedList');
  else if (!ul) document.execCommand(kind === 'ol' ? 'insertOrderedList' : 'insertUnorderedList');
  const now = ulAt();
  if (now && now.tagName === 'UL') {
    now.classList.toggle('checklist', kind === 'check');
    now.classList.toggle('dash', kind === 'dash');
    if (!now.className) now.removeAttribute('class');
  }
}
function indent(dir) {
  if (!ulAt()) return false; // Tab outside a list stays a normal tab
  keepCaret(() => document.execCommand(dir === 'in' ? 'indent' : 'outdent'));
  // a nested list keeps the look of its parent (checklist circles, dashes)
  const ul = ulAt(), parent = ul?.parentElement?.closest('#editor ul');
  if (ul && parent && ul.tagName === 'UL') for (const c of ['checklist', 'dash']) ul.classList.toggle(c, parent.classList.contains(c));
  changed();
  return true;
}
let autoSortChecked = false;
try { autoSortChecked = localStorage.getItem('breeze.autoSortChecked') === '1'; } catch {}
// checked items sink below unchecked ones, keeping each group's order
function sortChecklist(ul) {
  if (!ul) return;
  const items = [...ul.children].filter((x) => x.tagName === 'LI');
  for (const li of [...items.filter((x) => !x.classList.contains('done')), ...items.filter((x) => x.classList.contains('done'))]) ul.append(li);
}
function checklistOp(op) {
  if (!current) return;
  const here = elAt()?.closest('#editor ul.checklist');
  const lists = here ? [here] : [...editor.querySelectorAll('ul.checklist')]; // in a checklist: that one; otherwise the whole note
  if (!lists.length) { toast('체크리스트가 없습니다'); return; }
  for (const ul of lists) {
    const items = [...ul.children].filter((x) => x.tagName === 'LI');
    if (op === 'all') items.forEach((li) => li.classList.add('done'));
    else if (op === 'none') items.forEach((li) => li.classList.remove('done'));
    else if (op === 'sort') sortChecklist(ul);
    else if (op === 'delete') { items.filter((li) => li.classList.contains('done')).forEach((li) => li.remove()); if (!ul.children.length) ul.remove(); }
  }
  changed();
}

/* ---------------- collapsible sections (title / headings) ---------------- */
// A heading with data-collapsed="1" hides what follows it until the next heading of the same or a higher level.
const HEADING_SEL = '#editor h1, #editor h2, #editor h3, #editor div.title';
const levelOf = (el) => (el.matches('div.title, h1') ? 1 : el.tagName === 'H2' ? 2 : el.tagName === 'H3' ? 3 : 9);
const isHeading = (el) => el?.nodeType === 1 && el.matches(HEADING_SEL);
function applySections() {
  for (const el of editor.querySelectorAll('.sec-hidden')) el.classList.remove('sec-hidden');
  const parents = new Set([...editor.querySelectorAll(HEADING_SEL)].map((h) => h.parentElement));
  for (const parent of parents) {
    let hideLevel = 0; // 0 = not hiding
    for (const el of parent.children) {
      if (isHeading(el) && hideLevel && levelOf(el) <= hideLevel) hideLevel = 0;
      if (hideLevel) { el.classList.add('sec-hidden'); continue; }
      if (isHeading(el) && el.dataset.collapsed) hideLevel = levelOf(el);
    }
  }
  for (const h of editor.querySelectorAll('[data-collapsed]')) {
    if (!isHeading(h)) delete h.dataset.collapsed; // the line stopped being a heading
    else h.classList.toggle('has-hidden', !!h.nextElementSibling?.classList.contains('sec-hidden'));
  }
}
function toggleSection(h, open = !!h.dataset.collapsed) {
  if (open) delete h.dataset.collapsed; else h.dataset.collapsed = '1';
  applySections();
  changed();
}
function setAllSections(collapse) {
  for (const h of editor.querySelectorAll(HEADING_SEL)) {
    const hasBody = h.nextElementSibling && !isHeading(h.nextElementSibling);
    if (collapse && hasBody && !h.matches('div.title')) h.dataset.collapsed = '1'; else delete h.dataset.collapsed;
  }
  applySections();
  changed();
}
// open whatever section hides this node (used by find)
function revealNode(node) {
  let el = node?.nodeType === 1 ? node : node?.parentElement;
  let guard = 0;
  while ((el = el?.closest('.sec-hidden')) && guard++ < 20) {
    let h = el.previousElementSibling;
    while (h && !(isHeading(h) && h.dataset.collapsed)) h = h.previousElementSibling;
    if (!h) break;
    delete h.dataset.collapsed;
    applySections();
  }
}
// click the chevron in the left margin of a heading
editor.addEventListener('pointerdown', (e) => {
  const h = e.target.closest?.(HEADING_SEL);
  if (!h || e.clientX > h.getBoundingClientRect().left + 2) return;
  e.preventDefault();
  toggleSection(h);
});

/* ---------------- tag suggestions: type # and pick an existing tag ---------------- */
const tagSuggest = $('#tagSuggest');
let sugg = { items: [], idx: 0 };
let composing = false;
editor.addEventListener('compositionstart', () => { composing = true; });
editor.addEventListener('compositionend', () => { composing = false; setTimeout(updateTagSuggest); });
// the "#partial" or ">>partial" right before the caret, if any
function tagContext() {
  const sel = getSelection();
  const node = sel.anchorNode;
  if (!sel.isCollapsed || !node || node.nodeType !== 3 || !editor.contains(node) || node.parentElement.closest('a')) return null;
  const before = node.data.slice(0, sel.anchorOffset);
  const l = /(?:>>|》)([^>》\n]{0,40})$/u.exec(before); // >> links to another note (Apple Notes does the same)
  if (l) return { node, start: l.index, end: sel.anchorOffset, partial: l[1], kind: 'link' };
  const m = /(?:^|[\s(])#([\p{L}\p{N}_\-/]*)$/u.exec(before);
  if (!m) return null;
  const start = m.index + m[0].indexOf('#');
  return { node, start, end: sel.anchorOffset, partial: m[1], kind: 'tag' };
}
function noteMatches(q, except) {
  q = q.trim().toLowerCase();
  const ns = live().filter((n) => n !== except && hasContent(n)).sort((a, b) => edited(b) - edited(a));
  if (!q) return ns.slice(0, 8);
  const t = (n) => info(n).title.toLowerCase();
  return [...ns.filter((n) => t(n).startsWith(q)), ...ns.filter((n) => !t(n).startsWith(q) && t(n).includes(q))].slice(0, 8);
}
function updateTagSuggest() {
  const ctx = current && !reading ? tagContext() : null;
  if (!ctx) return hideTagSuggest();
  const p = ctx.partial.toLowerCase();
  let items;
  if (ctx.kind === 'link') {
    items = noteMatches(ctx.partial, current);
    sugg = { items, idx: 0, kind: 'link' };
    tagSuggest.innerHTML = '<div class="sg-head">노트 링크</div>' + (items.map((n, i) => `<button data-i="${i}" class="${i === 0 ? 'on' : ''}">${esc(info(n).title)}<span>${fmt(edited(n))}</span></button>`).join('') || '<div class="sg-none">일치하는 노트가 없습니다</div>');
  } else {
    const all = [...tagCounts].sort((a, b) => b[1] - a[1]);
    items = [...all.filter(([t]) => t.toLowerCase().startsWith(p)), ...all.filter(([t]) => !t.toLowerCase().startsWith(p) && t.toLowerCase().includes(p))]
      .filter(([t]) => t !== ctx.partial).slice(0, 8);
    if (!items.length) return hideTagSuggest();
    sugg = { items, idx: 0, kind: 'tag' };
    tagSuggest.innerHTML = items.map(([t, c], i) => `<button data-i="${i}" class="${i === 0 ? 'on' : ''}">#${esc(t)}<span>${c}</span></button>`).join('');
  }
  tagSuggest.hidden = false;
  const r = document.createRange(); r.setStart(ctx.node, ctx.start); r.setEnd(ctx.node, ctx.end);
  const rect = r.getBoundingClientRect(), box = tagSuggest.getBoundingClientRect();
  const below = rect.bottom + box.height + 8 < (window.visualViewport?.height || innerHeight);
  tagSuggest.style.left = `${Math.max(8, Math.min(innerWidth - box.width - 8, rect.left))}px`;
  tagSuggest.style.top = `${below ? rect.bottom + 4 : rect.top - box.height - 4}px`;
}
function hideTagSuggest() { tagSuggest.hidden = true; sugg = { items: [], idx: 0 }; }
function pickTag(i) {
  const it = sugg.items[i], kind = sugg.kind;
  if (!it) return;
  if (composing) { editor.blur(); editor.focus(); } // end an unfinished Korean syllable before replacing it
  const ctx = tagContext();
  hideTagSuggest();
  if (!ctx) return;
  const r = document.createRange(); r.setStart(ctx.node, ctx.start); r.setEnd(ctx.node, ctx.end);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  if (kind === 'link') insertNoteLink(it);
  else document.execCommand('insertText', false, `#${it[0]} `);
}
// typed as plain text, then made a link — insertHTML would drag inline font styles along. Both steps stay undoable.
function insertNoteLink(n) {
  const title = info(n).title, sel = getSelection();
  document.execCommand('insertText', false, title);
  const end = sel.getRangeAt(0), node = end.startContainer;
  if (node.nodeType !== 3 || end.startOffset < title.length) return;
  const pick = document.createRange();
  pick.setStart(node, end.startOffset - title.length); pick.setEnd(node, end.startOffset);
  sel.removeAllRanges(); sel.addRange(pick);
  document.execCommand('createLink', false, `#note-${n.id}`);
  for (const a of editor.querySelectorAll(`a[href="#note-${n.id}"]:not(.note-link)`)) { a.className = 'note-link'; a.dataset.note = n.id; }
  sel.collapseToEnd();
  document.execCommand('insertText', false, ' ');
  // a space typed right after a link can end up inside it — move it out
  const a = sel.anchorNode?.parentElement?.closest('a.note-link');
  if (a && a.textContent.endsWith(' ')) { a.lastChild.data = a.lastChild.data.slice(0, -1); a.after(' '); sel.collapse(a.nextSibling, 1); }
  saveEditor();
}
// linked notes show their current title; a link to a deleted note is greyed out
function refreshNoteLinks() {
  for (const a of editor.querySelectorAll('a.note-link')) {
    const n = index.get(a.dataset.note), gone = !n || n.deleted;
    a.classList.toggle('gone', gone);
    if (!gone) { const t = info(n).title; if (a.textContent !== t) a.textContent = t; }
  }
}
editor.addEventListener('input', () => setTimeout(updateTagSuggest));
editor.addEventListener('blur', () => setTimeout(() => { if (!tagSuggest.matches(':hover')) hideTagSuggest(); }, 150));
editor.addEventListener('keydown', (e) => {
  if (tagSuggest.hidden || e.isComposing) return;
  if (!sugg.items.length) { if (e.key === 'Escape') hideTagSuggest(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); e.stopImmediatePropagation();
    sugg.idx = (sugg.idx + (e.key === 'ArrowDown' ? 1 : -1) + sugg.items.length) % sugg.items.length;
    tagSuggest.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === sugg.idx));
  } else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); pickTag(sugg.idx); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); hideTagSuggest(); }
}, true);
tagSuggest.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the caret
tagSuggest.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) pickTag(+b.dataset.i); });

/* ---------------- move the current line up / down (⌃⌘↑↓) ---------------- */
function moveLine(dir) {
  let el = elAt()?.closest('li, p, div, h1, h2, h3, pre, blockquote, ul, ol');
  if (!el || !editor.contains(el) || el === editor) return;
  while (el.parentElement !== editor && !el.matches('li') && !(dir < 0 ? el.previousElementSibling : el.nextElementSibling)) el = el.parentElement;
  const other = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
  if (!other) return;
  const sel = getSelection(), r = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
  dir < 0 ? other.before(el) : other.after(el);
  if (r) { sel.removeAllRanges(); sel.addRange(r); }
  markTitle();
  applySections();
  changed();
}

/* ---------------- Aa style menu (like Apple Notes) ---------------- */
// 본문 uses <p> so that choosing it on the first line really turns the automatic title off
const STYLES = { title: 'h1', heading: 'h2', subheading: 'h3', body: 'p', mono: 'pre', quote: 'blockquote' };
const styleMenu = $('#styleMenu');
function currentStyle() {
  const b = elAt()?.closest('#editor h1, #editor h2, #editor h3, #editor pre, #editor blockquote:not([style]), #editor p, #editor div');
  if (!b || b === editor) return 'body';
  if (b.classList.contains('title') && b.tagName === 'DIV') return 'title'; // the automatic first-line title
  return Object.keys(STYLES).find((k) => STYLES[k] === b.tagName.toLowerCase()) || 'body';
}
function applyStyle(name) {
  const tag = STYLES[name];
  if (!tag || !current) return;
  if (!editor.contains(getSelection().anchorNode)) { editor.focus(); caretEnd(); }
  const ul = ulAt();
  if (ul && tag !== 'p') document.execCommand(ul.tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList'); // leave the list first
  // choosing 블록 인용 again turns it back into body text
  keepCaret(() => document.execCommand('formatBlock', false, name === 'quote' && currentStyle() === 'quote' ? '<p>' : `<${tag}>`));
  changed();
}
function openStyleMenu(btn) {
  if (!styleMenu.hidden) { styleMenu.hidden = true; return; }
  const cur = currentStyle();
  for (const b of styleMenu.querySelectorAll('[data-style]')) b.classList.toggle('on', b.dataset.style === cur);
  for (const b of styleMenu.querySelectorAll('[data-inline]')) b.classList.toggle('on', document.queryCommandState(b.dataset.inline));
  $('#autoSortChk').checked = autoSortChecked;
  styleMenu.hidden = false;
  // open beside the Aa button: below it at the top of the screen, above it at the bottom
  const r = btn.getBoundingClientRect(), m = styleMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(innerWidth - m.width - 8, r.right - m.width));
  const top = r.bottom + m.height + 8 < innerHeight ? r.bottom + 6 : r.top - m.height - 6;
  styleMenu.style.left = `${left}px`;
  styleMenu.style.top = `${Math.max(8, top)}px`;
}
for (const b of styleMenu.querySelectorAll('button')) b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
styleMenu.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.style) { applyStyle(b.dataset.style); styleMenu.hidden = true; }
  else if (b.dataset.inline) { document.execCommand(b.dataset.inline); b.classList.toggle('on', document.queryCommandState(b.dataset.inline)); changed(); }
  else if (b.dataset.list) { setList(b.dataset.list); styleMenu.hidden = true; }
  else if (b.dataset.indent) { if (!indent(b.dataset.indent)) toast('들여쓰기는 목록에서 쓸 수 있어요'); }
  else if (b.dataset.hl) highlight(b.dataset.hl);
  else if (b.dataset.chk) { checklistOp(b.dataset.chk); styleMenu.hidden = true; }
  else if (b.dataset.sec) { setAllSections(b.dataset.sec === 'collapse'); styleMenu.hidden = true; }
});
$('#autoSortChk').addEventListener('change', (e) => {
  autoSortChecked = e.target.checked;
  try { localStorage.setItem('breeze.autoSortChecked', autoSortChecked ? '1' : ''); } catch {}
  if (autoSortChecked) checklistOp('sort');
});
// highlight colours (Apple Notes: purple, pink, orange, mint, blue) — translucent so they read in light and dark mode
const HL = { purple: 'rgba(191, 90, 242, .32)', pink: 'rgba(255, 55, 135, .30)', orange: 'rgba(255, 159, 10, .36)', mint: 'rgba(0, 199, 190, .32)', blue: 'rgba(10, 132, 255, .30)' };
function highlight(color) {
  const sel = getSelection();
  if (!sel.rangeCount || sel.isCollapsed || !editor.contains(sel.anchorNode)) { toast('하이라이트할 글자를 먼저 선택하세요'); return; }
  document.execCommand('styleWithCSS', false, true);
  document.execCommand('hiliteColor', false, color === 'none' ? 'transparent' : HL[color]);
  document.execCommand('styleWithCSS', false, false);
  changed();
}
document.addEventListener('pointerdown', (e) => { if (!styleMenu.hidden && !e.target.closest('#styleMenu, [data-cmd=heading]')) styleMenu.hidden = true; });

addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  // Apple Notes shortcuts: ⇧⌘T 제목, ⇧⌘H 머리말, ⇧⌘J 부머리말, ⇧⌘B 본문
  const styleKey = { KeyT: 'title', KeyH: 'heading', KeyJ: 'subheading', KeyB: 'body' }[e.code];
  if (mod && e.shiftKey && styleKey && document.activeElement === editor) { e.preventDefault(); applyStyle(styleKey); return; }
  if (e.key === 'Escape') styleMenu.hidden = true;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newNote(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'l' && current) { e.preventDefault(); cmds.check(); }
  // ⌘F finds inside the open note; ⌥⌘F searches all notes (Apple Notes does the same)
  else if (mod && e.code === 'KeyF' && !e.shiftKey) {
    e.preventDefault();
    const noteOnScreen = current && !current.deleted && !(single() && app.classList.contains('show-list'));
    if (noteOnScreen && !e.altKey) openFind();
    else { if (single()) showList(); search.focus(); }
  }
  else if (mod && !e.altKey && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(zoom + 0.1); }
  else if (mod && !e.altKey && e.key === '-') { e.preventDefault(); setZoom(zoom - 0.1); }
  else if (mod && !e.altKey && e.key === '0') { e.preventDefault(); setZoom(1); }
  else if (mod && e.altKey && e.code === 'KeyS') { e.preventDefault(); setFocusMode(!app.classList.contains('focus')); }
  else if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && undoStack.length && !isTyping()) { e.preventDefault(); undoDelete(); }
});
// inside the editor or a text field ⌘Z keeps its normal meaning
const isTyping = () => { const a = document.activeElement; return a === editor || a?.matches?.('input, textarea'); };

/* ---------------- delete + undo ---------------- */
let toastT;
function toast(msg, btn, fn) {
  $('#toastMsg').textContent = msg;
  $('#toastBtn').textContent = btn || '';
  $('#toastBtn').onclick = () => { $('#toast').hidden = true; fn?.(); };
  $('#toast').hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => ($('#toast').hidden = true), 5000);
}
// After a note leaves the list, select its neighbour so ⌫ can be pressed repeatedly.
function closeAndSelectNext(n) {
  const order = listed(), i = order.indexOf(n);
  const next = order[i + 1] || order[i - 1] || null;
  current = null;
  if (single()) history.state?.note ? history.back() : showList();
  else open(next);
}
const undoStack = []; // notes trashed this session, newest last — ⌘Z brings them back
function removeNote(n) {
  if (soloId) { n.deleted = true; touch(n); flush().then(() => window.close()); return; }
  // leave the editor, otherwise ⌘Z would be taken as "undo typing" in the next note
  if (document.activeElement === editor) editor.blur();
  closeAndSelectNext(n);
  if (!mobile.matches) list.focus();
  n.deleted = true;
  touch(n);
  flush();
  renderList();
  undoStack.push(n);
  toast('휴지통으로 옮겼습니다', touchUI ? '실행 취소' : '실행 취소 ⌘Z', () => undoDelete(n));
}
function undoDelete(n = undoStack.at(-1)) {
  if (!n) return;
  undoStack.splice(undoStack.indexOf(n), 1);
  if (!n.deleted || !hasContent(n)) return; // already restored or purged
  n.deleted = false;
  touch(n);
  flush();
  if (trashMode || single()) renderList(); // phone: the note just reappears in the list
  else { open(n); list.focus(); }
  toast('노트를 복구했습니다');
}
function restoreNote(n) {
  closeAndSelectNext(n);
  n.deleted = false;
  touch(n);
  flush();
  renderList();
  toast('노트를 복구했습니다');
}
function purge(n) { n.body = ''; n.pinned = false; touch(n); }
function purgeNote(n) {
  if (!confirm('이 노트를 영구 삭제할까요? 되돌릴 수 없습니다.')) return;
  closeAndSelectNext(n);
  purge(n);
  flush();
  renderList();
}

/* ---------------- sync (Supabase) ---------------- */
const sync = (() => {
  const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
  let sb = null, sbKey = '', user = null, busy = false, again = false, timer = null, channel = null;
  let state = 'off', lastOk = null, lastErr = '';

  // People often paste the Data API URL (…supabase.co/rest/v1); the client wants just the origin.
  const projectUrl = (s) => { try { return new URL(s.trim()).origin; } catch { return ''; } };
  const cfg = () => {
    try { const c = JSON.parse(localStorage.getItem('breeze.sync')) || {}; return { ...c, url: c.url && projectUrl(c.url) }; }
    catch { return {}; }
  };

  async function client() {
    const { url, key } = cfg();
    if (!url || !key) return null;
    if (sb && sbKey === url + key) return sb;
    unlisten();
    const { createClient } = await import(CDN);
    sb = createClient(url, key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });
    sbKey = url + key;
    sb.auth.onAuthStateChange((_e, s) => {
      user = s?.user || null;
      // supabase-js warns against awaiting its own calls inside this callback
      setTimeout(() => { if (user) { listen(); schedule(0); } else { unlisten(); setState('off'); } ui(); });
    });
    return sb;
  }

  function setState(s, err = '') { state = s; lastErr = err; $('#syncDot').className = 'dot ' + s; $('#syncBtn').title = { off: '동기화 꺼짐', ok: '동기화됨', busy: '동기화 중…', err: '동기화 오류: ' + err }[s]; ui(); }

  function schedule(ms = 1000) { clearTimeout(timer); timer = setTimeout(run, ms); }

  async function run() {
    if (!sb || !user) return;
    if (!navigator.onLine) return setState('off');
    if (busy) { again = true; return; }
    busy = true; setState('busy');
    try {
      await push(); await pull(); lastOk = Date.now();
      // a missing storage bucket must not block note sync, so photos go last and fail separately
      try { await pushImages(); setState('ok'); } catch (e) { console.warn('photo upload failed', e); setState('err', '사진 업로드 실패 — ' + (e.message || e)); }
      if (editor.querySelector('img.missing')) hydrate();
    } catch (e) { console.warn('sync failed', e); setState('err', e.message || String(e)); }
    finally { busy = false; if (again) { again = false; schedule(200); } }
  }

  // the folders / dates columns are added by supabase-folders.sql; until then notes still sync, just without them
  let legacySchema = false;
  const isMissingColumn = (e) => /column|schema cache/i.test(e.message || '') && /(folder|created_at|edited_at)/.test(e.message || '');
  const schemaHint = () => toast('폴더를 기기끼리 맞추려면 supabase-folders.sql을 한 번 실행하세요');
  async function push() {
    const dirty = notes.filter((n) => n.dirty && !unsaved.has(n.id));
    if (!dirty.length) return;
    const snap = dirty.map((n) => [n, n.updatedAt]);
    for (let i = 0; i < dirty.length; i += 200) {
      const rows = dirty.slice(i, i + 200).map((n) => ({
        id: n.id, user_id: user.id, body: n.body, pinned: n.pinned, deleted: n.deleted, updated_at: new Date(n.updatedAt).toISOString(),
        ...(legacySchema ? {} : {
          folder: n.folder ?? null,
          created_at: new Date(created(n)).toISOString(),
          edited_at: new Date(edited(n)).toISOString(),
        }),
      }));
      let { error } = await sb.from('notes').upsert(rows);
      if (error && !legacySchema && isMissingColumn(error)) { legacySchema = true; schemaHint(); i -= 200; continue; }
      if (error) throw error;
    }
    // only clear notes that weren't edited again while uploading
    const done = snap.filter(([n, u]) => n.updatedAt === u).map(([n]) => { n.dirty = false; return n; });
    await idb.putMany(done);
  }

  async function pushImages() {
    for (const r of (await idb.allImgs()).filter((r) => !r.uploaded)) {
      const { error } = await sb.storage.from('images').upload(`${user.id}/${r.id}`, r.blob, { contentType: r.blob.type || 'application/octet-stream', upsert: true });
      if (error) throw error;
      r.uploaded = true;
      await idb.putImg(r);
    }
  }
  async function download(id) {
    if (!sb || !user || !navigator.onLine) return null;
    const { data, error } = await sb.storage.from('images').download(`${user.id}/${id}`);
    return error ? null : data;
  }

  async function pull() {
    const key = 'cursor:' + user.id;
    const cursor = await idb.get(key);
    // re-read a 10s overlap so rows committed out of order aren't missed; applying is idempotent
    let since = cursor ? new Date(Date.parse(cursor) - 10000).toISOString() : '1970-01-01T00:00:00Z';
    for (;;) {
      const cols = legacySchema ? 'id,body,pinned,deleted,updated_at,synced_at' : 'id,body,pinned,deleted,updated_at,synced_at,folder,created_at,edited_at';
      const { data, error } = await sb.from('notes').select(cols).gt('synced_at', since).order('synced_at').limit(500);
      if (error && !legacySchema && isMissingColumn(error)) { legacySchema = true; schemaHint(); continue; }
      if (error) throw error;
      applyRemote(data);
      if (data.length) { since = data.at(-1).synced_at; await idb.set(key, since); }
      if (data.length < 500) break;
    }
  }

  function applyRemote(rows) {
    const changedNotes = [];
    for (const r of rows) {
      const u = Date.parse(r.updated_at);
      let n = index.get(r.id);
      if (n && n.updatedAt >= u) continue; // local copy is same or newer
      if (!n) { n = { id: r.id }; addNote(n); }
      Object.assign(n, { body: r.body, pinned: r.pinned, deleted: r.deleted, updatedAt: u, dirty: false });
      if (!legacySchema) {
        n.folder = r.folder ?? null;
        if (r.created_at) n.createdAt = Date.parse(r.created_at);
        n.editedAt = r.edited_at ? Date.parse(r.edited_at) : u;
      }
      if (isMeta(n)) settingsChanged();
      unsaved.delete(n.id);
      changedNotes.push(n);
      if (n === current) {
        if (n.deleted) single() ? showList() : open(visible()[0]);
        else { setBody(n.body); syncPin(); }
      }
    }
    if (changedNotes.length) { persist(changedNotes); renderList(); }
  }

  function listen() {
    unlisten();
    channel = sb.channel('notes-' + user.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notes', filter: `user_id=eq.${user.id}` }, () => schedule(150))
      .subscribe();
  }
  function unlisten() { if (channel && sb) { sb.removeChannel(channel); channel = null; } }

  function ui() {
    const c = cfg();
    $('#sbUrl').value ||= c.url || '';
    $('#sbKey').value ||= c.key || '';
    $('#authBox').hidden = !!user;
    $('#userBox').hidden = !user;
    $('#cfgBox').hidden = !!user;
    if (user) $('#userEmail').textContent = user.email;
    $('#lastSync').textContent = state === 'err' ? '오류: ' + lastErr : lastOk ? '마지막 동기화: ' + new Date(lastOk).toLocaleTimeString('ko-KR') : '';
  }

  async function auth(kind) {
    const msg = $('#authMsg');
    const url = projectUrl($('#sbUrl').value), key = $('#sbKey').value.trim();
    const email = $('#email').value.trim(), password = $('#pw').value;
    if (!url || !key || !email || !password) { msg.textContent = '모든 칸을 입력하세요.'; return; }
    $('#sbUrl').value = url;
    localStorage.setItem('breeze.sync', JSON.stringify({ url, key }));
    msg.textContent = '연결 중…';
    try {
      await client();
      const res = kind === 'signup' ? await sb.auth.signUp({ email, password }) : await sb.auth.signInWithPassword({ email, password });
      if (res.error) throw res.error;
      $('#pw').value = '';
      msg.textContent = res.data.session ? '로그인되었습니다. 동기화를 시작합니다.' : '확인 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인하세요.';
    } catch (e) { msg.textContent = '실패: ' + (e.message || e); }
  }

  async function init() {
    ui();
    try { await client(); } catch (e) { setState('err', '라이브러리를 불러오지 못했습니다'); }
    addEventListener('online', () => schedule(0));
    addEventListener('offline', () => setState('off'));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(0); else flush(); });
    setInterval(() => { if (document.visibilityState === 'visible') schedule(0); }, 60000);
  }

  return {
    init, schedule, ui, download,
    login: () => auth('login'),
    signup: () => auth('signup'),
    logout: async () => { await sb?.auth.signOut(); $('#authMsg').textContent = '로그아웃했습니다. 노트는 이 기기에 그대로 남아 있습니다.'; },
    now: () => schedule(0),
  };
})();

/* ---------------- settings dialog ---------------- */
const VERSION = 'v28';
$('#appVersion').textContent = `Breeze 노트 ${VERSION}`;
$('#syncBtn').onclick = () => { $('#authMsg').textContent = ''; sync.ui(); $('#settings').showModal(); };
$('#loginBtn').onclick = sync.login;
$('#signupBtn').onclick = sync.signup;
$('#logoutBtn').onclick = sync.logout;
$('#syncNow').onclick = sync.now;
$('#exportBtn').onclick = () => {
  const data = notes.filter((n) => !n.deleted && !isMeta(n)).map(({ id, body, pinned, folder, createdAt, editedAt, updatedAt }) => ({ id, body, pinned, folder, createdAt, editedAt, updatedAt }));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'breeze', version: 1, notes: data, folders: settings.folders, smart: settings.smart }, null, 1)], { type: 'application/json' }));
  a.download = `breeze-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const { notes: incoming, folders = [], smart = [] } = JSON.parse(await f.text());
    // folders and smart folders the backup knows about but this device doesn't
    const addNew = (have, from) => { const ids = new Set(have.map((x) => x.id)); const nw = from.filter((x) => x?.id && x.name && !ids.has(x.id)); have.push(...nw); return nw.length; };
    if (addNew(settings.folders, folders) + addNew(settings.smart, smart)) saveSettings();
    let count = 0;
    for (const r of incoming) {
      if (!r.id || typeof r.body !== 'string') continue;
      const n = index.get(r.id);
      if (n && n.updatedAt >= r.updatedAt) continue;
      const fresh = { id: r.id, body: r.body, pinned: !!r.pinned, deleted: false, folder: r.folder ?? null, createdAt: r.createdAt, editedAt: r.editedAt || r.updatedAt, updatedAt: Date.now(), dirty: true };
      n ? Object.assign(n, fresh) : addNote(fresh);
      count++;
    }
    await flush(); renderList();
    $('#authMsg').textContent = `${count}개 노트를 가져왔습니다.`;
  } catch { $('#authMsg').textContent = '백업 파일을 읽을 수 없습니다.'; }
  e.target.value = '';
};

/* ---------------- Apple Notes import ---------------- */
// Reads the folder written by tools/export-apple-notes.js. Re-importing updates the same notes instead of duplicating.
const KEEP = { DIV: 'div', P: 'div', H1: 'div', H2: 'h2', H3: 'h2', H4: 'h2', B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u', S: 's', STRIKE: 's',
  UL: 'ul', OL: 'ol', LI: 'li', TABLE: 'table', THEAD: 'thead', TBODY: 'tbody', TR: 'tr', TD: 'td', TH: 'th', BR: 'br', A: 'a', IMG: 'img' };
function sanitize(root, imgIds) {
  const out = document.createElement('div');
  const walk = (src, dst) => {
    for (const c of src.childNodes) {
      if (c.nodeType === 3) { dst.append(c.data); continue; }
      if (c.nodeType !== 1 || /^(SCRIPT|STYLE|OBJECT|IFRAME|HEAD)$/.test(c.tagName)) continue;
      const tag = KEEP[c.tagName];
      if (!tag) { walk(c, dst); continue; }
      if (tag === 'img') {
        const id = imgIds.get(c.getAttribute('src'));
        if (id) { const img = document.createElement('img'); img.dataset.img = id; dst.append(img); }
        continue;
      }
      const el = document.createElement(tag);
      if (tag === 'a') {
        const href = c.getAttribute('href') || '';
        if (!/^(https?:|mailto:|tel:)/i.test(href)) { walk(c, dst); continue; }
        el.setAttribute('href', href);
      }
      walk(c, el);
      dst.append(el);
    }
  };
  walk(root, out);
  return out.innerHTML;
}
async function uuidFrom(text) {
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
async function importAppleNotes(fileList) {
  const msg = $('#authMsg');
  const files = new Map([...fileList].map((f) => [f.webkitRelativePath.split('/').slice(1).join('/'), f]));
  const meta = files.get('notes.json');
  if (!meta) { msg.textContent = 'notes.json이 들어 있는 내보내기 폴더(apple-notes-export)를 고르세요.'; return; }
  const { notes: incoming } = JSON.parse(await meta.text());
  let photos = 0, others = 0, est = 0;
  for (const [p, f] of files) {
    if (!p.startsWith('files/')) continue;
    if (isPhoto(f)) { photos++; est += Math.min(f.size, 250 * 1024); } else { others++; est += f.size; }
  }
  if (!confirm(`애플 노트 ${incoming.length}개를 가져올까요?\n\n사진 ${photos}개(압축), 파일 ${others}개\n업로드 예상 용량: 약 ${fmtSize(est)} (무료 한도 1GB)\n\n애플 노트의 폴더는 같은 이름의 폴더로 들어갑니다.`)) return;

  let done = 0, skipped = 0, batch = [];
  for (const r of incoming) {
    msg.textContent = `가져오는 중… ${done + skipped}/${incoming.length}`;
    const id = await uuidFrom('apple:' + r.id);
    const existing = index.get(id);
    if (existing && existing.updatedAt >= r.modified) { skipped++; continue; }

    const doc = new DOMParser().parseFromString(r.body, 'text/html');
    const imgIds = new Map();
    for (const img of doc.querySelectorAll('img')) {
      const src = img.getAttribute('src'), f = files.get(src);
      if (f && !imgIds.has(src)) { const pid = await storePhoto(f); if (pid) imgIds.set(src, pid); }
    }
    let body = sanitize(doc.body, imgIds);
    for (const a of r.attachments) {
      if (a.kind === 'link') { body += `<div><a href="${esc(a.url)}">${esc(a.name || a.url)}</a></div>`; continue; }
      const f = files.get(a.path);
      if (!f) continue;
      const pid = a.kind === 'image' && isPhoto(f) ? await storePhoto(f) : null;
      if (pid) body += `<img data-img="${pid}">`;
      else if (f.size <= MAX_FILE) body += `<div>${fileChip(await storeBlob(f), a.name, f.size)}</div>`;
    }
    const fname = (r.folder || '').trim();
    let folder = existing?.folder ?? null;
    if (!folder && fname && !['Notes', '메모'].includes(fname)) {
      folder = settings.folders.find((f) => f.name === fname)?.id;
      if (!folder) { folder = crypto.randomUUID(); settings.folders.push({ id: folder, name: fname }); saveSettings(); }
    }

    const n = { id, body, pinned: false, deleted: false, folder, createdAt: r.created || r.modified, editedAt: r.modified, updatedAt: Math.max(r.modified, Date.now()), dirty: true };
    existing ? Object.assign(existing, n) : addNote(n);
    batch.push(existing || n);
    if (batch.length >= 25) { await persist(batch); batch = []; renderListSoon(); }
    done++;
  }
  await persist(batch);
  renderList();
  flush();
  msg.textContent = `${done}개를 가져왔습니다${skipped ? ` (이미 최신인 ${skipped}개는 건너뜀)` : ''}. 동기화가 끝날 때까지 앱을 열어 두세요.`;
}
$('#appleBtn').onclick = () => $('#appleDir').click();
$('#appleDir').onchange = (e) => { importAppleNotes(e.target.files).catch((err) => ($('#authMsg').textContent = '가져오기 실패: ' + err.message)); e.target.value = ''; };

/* ---------------- clipboard button & shared items ---------------- */
// Phone keyboards refuse to paste images into web apps, so 📋 reads the clipboard directly (asks permission once).
async function pasteFromClipboard() {
  if (!current) return;
  if (!navigator.clipboard?.read) { toast('이 브라우저는 클립보드 읽기를 지원하지 않습니다'); return; }
  try {
    const files = [];
    let text = '';
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) files.push(new File([await item.getType(type)], '붙여넣은 이미지', { type }));
      else if (item.types.includes('text/plain')) text += await (await item.getType('text/plain')).text();
    }
    if (files.length) await insertFiles(files);
    else if (text) document.execCommand('insertText', false, text);
    else toast('클립보드에 붙여넣을 내용이 없습니다');
  } catch {
    toast('클립보드 접근이 막혀 있습니다. 브라우저의 사이트 설정에서 허용해 주세요');
  }
}
// Items sent from the Android share sheet (sw.js parks them in the 'breeze-inbox' database) become new notes.
function inboxTake() {
  return new Promise((resolve) => {
    const r = indexedDB.open('breeze-inbox', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('items', { autoIncrement: true });
    r.onerror = () => resolve([]);
    r.onsuccess = () => {
      const t = r.result.transaction('items', 'readwrite'), st = t.objectStore('items');
      const all = st.getAll();
      all.onsuccess = () => st.clear();
      t.oncomplete = () => resolve(all.result || []);
      t.onerror = () => resolve([]);
    };
  });
}
async function receiveShared() {
  const items = await inboxTake();
  let last = null;
  for (const it of items) {
    const lines = [it.title, ...String(it.text || '').split('\n')].map((l) => l.trim()).filter(Boolean);
    let body = lines.length ? lines.map((l) => `<div>${esc(l)}</div>`).join('') : '<div>공유한 항목</div>';
    if (it.url && !lines.some((l) => l.includes(it.url))) body += `<div><a href="${esc(it.url)}">${esc(it.url)}</a></div>`;
    for (const f of it.files || []) {
      const pid = isPhoto(f) ? await storePhoto(f) : null;
      if (pid) body += `<img data-img="${pid}">`;
      else if (f.size <= MAX_FILE) body += `<div>${fileChip(await storeBlob(f), f.name || '파일', f.size)}</div>`;
    }
    const at = it.at || Date.now();
    last = { id: crypto.randomUUID(), body, pinned: false, deleted: false, folder: null, createdAt: at, editedAt: at, updatedAt: at, dirty: true };
    addNote(last);
  }
  if (!last) return;
  await flush();
  history.replaceState(null, '', location.pathname); // drop ?shared=1 so a reload doesn't repeat
  open(last);
  toast(items.length > 1 ? `공유한 항목 ${items.length}개를 노트로 만들었습니다` : '공유한 항목을 새 노트로 만들었습니다');
}

/* ---------------- find in note (⌘F / 🔍) ---------------- */
const findBar = $('#findBar'), findInput = $('#findInput');
let findRanges = [], findIdx = -1;
function runFind({ keep = false, scroll = true } = {}) {
  const q = findInput.value.trim().toLowerCase();
  findRanges = [];
  if (q) {
    const walk = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let t; (t = walk.nextNode());) {
      const lower = t.data.toLowerCase();
      for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, i + q.length)) {
        const r = new Range();
        r.setStart(t, i);
        r.setEnd(t, i + q.length);
        findRanges.push(r);
      }
    }
  }
  findIdx = !findRanges.length ? -1 : keep ? Math.min(Math.max(findIdx, 0), findRanges.length - 1) : 0;
  paintFind(scroll);
}
function paintFind(scroll = true) {
  if (window.Highlight && CSS.highlights) {
    CSS.highlights.set('find', new Highlight(...findRanges));
    CSS.highlights.set('find-current', new Highlight(...(findIdx >= 0 ? [findRanges[findIdx]] : [])));
  }
  $('#findCount').textContent = !findInput.value.trim() ? '' : findRanges.length ? `${findIdx + 1}/${findRanges.length}` : '없음';
  const hiddenMatch = scroll && findIdx >= 0 && findRanges[findIdx].startContainer.parentElement?.closest('.sec-hidden');
  if (hiddenMatch) {
    revealNode(findRanges[findIdx].startContainer);
    if (!hiddenMatch.classList.contains('sec-hidden')) return runFind({ keep: true }); // opened: measure again
  }
  if (scroll && findIdx >= 0) {
    // bring the current match to the upper third of the note
    const r = findRanges[findIdx].getBoundingClientRect(), box = editor.getBoundingClientRect();
    if (r.top < box.top + 40 || r.bottom > box.bottom - 40) editor.scrollTop += r.top - box.top - box.height / 3;
  }
}
function stepFind(d) {
  if (!findRanges.length) return;
  findIdx = (findIdx + d + findRanges.length) % findRanges.length;
  paintFind();
}
function openFind(q, { focus = true } = {}) {
  if (!current) return;
  findBar.hidden = false;
  if (q != null) findInput.value = q;
  if (focus) { findInput.focus(); findInput.select(); }
  runFind();
}
function closeFind({ toMatch = false } = {}) {
  const r = findRanges[findIdx];
  findBar.hidden = true;
  $('#replaceRow').hidden = true;
  findRanges = [];
  findIdx = -1;
  CSS.highlights?.delete('find');
  CSS.highlights?.delete('find-current');
  // leave the cursor at the match you were looking at, ready to edit (not in reading mode)
  if (toMatch && r && !reading && current && !current.deleted) {
    editor.focus();
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
}
findInput.addEventListener('input', () => runFind());
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind({ toMatch: true }); }
});
$('#findBtn').onclick = () => (findBar.hidden ? openFind() : closeFind());
$('#findNext').onclick = () => stepFind(1);
$('#findPrev').onclick = () => stepFind(-1);
$('#findClose').onclick = () => closeFind({ toMatch: true });
// 찾기 및 대치
$('#replaceToggle').onclick = () => { const row = $('#replaceRow'); row.hidden = !row.hidden; if (!row.hidden) $('#replaceInput').focus(); };
function replaceRanges(ranges) {
  const text = $('#replaceInput').value;
  for (const r of [...ranges].reverse()) { r.deleteContents(); r.insertNode(document.createTextNode(text)); }
  editor.normalize();
  changed();
  runFind({ keep: true });
  return ranges.length;
}
$('#replaceOne').onclick = () => { if (findIdx >= 0) replaceRanges([findRanges[findIdx]]); else toast('바꿀 내용이 없습니다'); };
$('#replaceAll').onclick = () => { const n = findRanges.length; if (!n) return toast('바꿀 내용이 없습니다'); replaceRanges(findRanges); toast(`${n}개를 바꿨습니다`); };
$('#replaceInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#replaceOne').click(); } else if (e.key === 'Escape') closeFind({ toMatch: true }); });
for (const b of [$('#findNext'), $('#findPrev')]) b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the keyboard up

/* ---------------- boot ---------------- */
(async () => {
  (await idb.all()).forEach(addNote);
  loadSettings();
  if ((scope.type === 'folder' && scope.id && !folderById(scope.id)) || (scope.type === 'smart' && !smartById(scope.id))) scope = { type: 'all' };
  markScope();
  renderFolders();
  const expired = notes.filter((n) => inTrash(n) && Date.now() - n.updatedAt > TRASH_DAYS * 864e5);
  expired.forEach(purge);
  if (expired.length) flush();
  if (soloId) {
    app.classList.add('solo');
    const n = index.get(soloId);
    open(n && !n.deleted ? n : null, { push: false });
    document.title = n ? info(n).title : 'Breeze 노트';
  } else if (new URLSearchParams(location.search).has('new')) {
    history.replaceState(null, '', location.pathname);
    if (single()) renderList();
    newNote();
  } else if (!single()) open(visible()[0], { push: false });
  else renderList();
  sync.init();
  requestAnimationFrame(() => app.classList.add('ready')); // enable transitions after first paint
  receiveShared();
  if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').then((reg) => {
      // look for a new version whenever the app comes back to the foreground
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) toast('새 버전이 준비됐습니다', '새로고침', () => { flush(); location.reload(); });
    });
  }
})();
addEventListener('pagehide', flush);
