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

// note: { id, body (html), pinned, deleted, updatedAt (ms), dirty (needs upload) }
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
  bc?.postMessage(list.map(({ id, body, pinned, deleted, updatedAt, dirty }) => ({ id, body, pinned, deleted, updatedAt, dirty })));
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
  decoder.innerHTML = n.body.replace(/<(br|\/div|\/p|\/li|\/h[1-6])\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '');
  const t = decoder.value;
  textCache.set(n.id, [n.body, t]);
  return t;
}
function info(n) {
  const lines = textOf(n).split('\n').map((s) => s.trim()).filter(Boolean);
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
let activeTag = null;
// Deleted notes keep their body for 30 days (the trash); an empty body means permanently deleted.
const TRASH_DAYS = 30;
const hasContent = (n) => !!textOf(n).trim() || n.body.includes('<img');
const inTrash = (n) => n.deleted && hasContent(n);
let trashMode = false;
const visible = () => trashMode
  ? notes.filter(inTrash).sort((a, b) => b.updatedAt - a.updatedAt)
  : notes.filter((n) => !n.deleted).sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));
// what the list shows, in order — also drives arrow-key navigation
function listed(all = visible()) {
  const q = search.value.trim().toLowerCase();
  return all.filter((n) => (!q || textOf(n).toLowerCase().includes(q)) && (!activeTag || tagsOf(n).includes(activeTag)));
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
    return `<li data-id="${n.id}" class="card${n === current ? ' active' : ''}${sel(n)}"><div class="cv">${cover}</div><div class="t">${n.pinned ? PIN : ''}${esc(title)}</div><div class="d">${fmt(n.updatedAt)}</div></li>`;
  };
  const row = mode === 'gallery' ? card : (n) => {
    const { title, preview } = info(n);
    const when = trashMode ? `${Math.max(1, Math.ceil(TRASH_DAYS - (Date.now() - n.updatedAt) / 864e5))}일 남음` : fmt(n.updatedAt);
    const thumb = /<img data-img="([^"]+)"/.exec(n.body);
    return `<li data-id="${n.id}" class="${n === current ? 'active' : ''}${sel(n)}"><div class="sw"><div class="txt"><div class="t">${n.pinned && !trashMode ? PIN : ''}${esc(title)}</div><div class="p"><time>${when}</time>${esc(preview)}</div></div>${thumb ? `<img class="thumb" data-img="${thumb[1]}" alt="">` : ''}</div></li>`;
  };
  const trashCount = notes.filter(inTrash).length;
  $('#trashCount').textContent = trashCount || '';
  $('#emptyTrashBtn').hidden = !trashMode || !trashCount;
  $('#composeBtn').hidden = trashMode;
  $('#noteCount').textContent = trashMode ? '' : `노트 ${all.length}개`;
  if (mode === 'attachments') return renderAttachments(items);
  const pinned = trashMode ? [] : items.filter((n) => n.pinned), rest = items.filter((n) => trashMode || !n.pinned);
  let html = '';
  if (pinned.length) html += '<li class="sec">고정됨</li>' + pinned.map(row).join('');
  let group = '';
  for (const n of rest) {
    const g = trashMode ? '' : groupOf(n.updatedAt);
    if (g !== group) { html += `<li class="sec">${g}</li>`; group = g; }
    html += row(n);
  }
  list.innerHTML = html || `<li class="none">${q ? '검색 결과 없음' : trashMode ? '휴지통이 비어 있습니다' : '노트가 없습니다'}</li>`;
  loadThumbs();
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
      if (href) out.links.push({ n, url: decodeHtml(href[1]), text: label });
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
function renderTags(all) {
  const counts = new Map();
  for (const n of all) for (const t of tagsOf(n)) counts.set(t, (counts.get(t) || 0) + 1);
  if (activeTag && !counts.has(activeTag)) activeTag = null;
  const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
  tagBar.hidden = trashMode || !tags.length;
  tagBar.innerHTML = tags.map(([t, c]) => `<button class="tag${t === activeTag ? ' on' : ''}" data-tag="${esc(t)}">#${esc(t)}<span>${c}</span></button>`).join('');
}
tagBar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]');
  if (!b) return;
  activeTag = activeTag === b.dataset.tag ? null : b.dataset.tag;
  renderList();
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
  } else openTagSheet(ns);
};
// 이동: Breeze uses tags as folders, so moving = adding a tag line to each note.
function openTagSheet(ns) {
  const tags = [...new Set(notes.filter((n) => !n.deleted).flatMap(tagsOf))].sort((a, b) => a.localeCompare(b, 'ko'));
  $('#tagChoices').innerHTML = tags.map((t) => `<button type="button" class="tag" data-pick="${esc(t)}">#${esc(t)}</button>`).join('') || '<p class="hint">아직 태그가 없습니다. 아래에 새로 입력하세요.</p>';
  $('#newTag').value = '';
  const d = $('#tagSheet');
  d.returnValue = '';
  d.onclose = () => {
    if (d.returnValue !== 'ok') return;
    const t = $('#newTag').value.trim().replace(/^#/, '').replace(/[^\p{L}\p{N}_\-/]+/gu, '_');
    if (!/^[\p{L}_]/u.test(t)) { toast('태그는 글자로 시작해야 합니다'); return; }
    let k = 0;
    for (const n of ns) {
      if (tagsOf(n).includes(t)) continue;
      n.body += `<div>#${esc(t)}</div>`;
      touch(n);
      k++;
    }
    flush();
    if (current && ns.includes(current)) setBody(current.body);
    exitSelect();
    toast(`${k}개 노트를 #${t}(으)로 옮겼습니다`);
  };
  d.showModal();
}
$('#tagChoices').onclick = (e) => { const b = e.target.closest('[data-pick]'); if (b) $('#newTag').value = b.dataset.pick; };
$('#tagCancel').onclick = () => $('#tagSheet').close('cancel');

/* ---------------- ⋯ view menu ---------------- */
function markView() { for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('on', b.dataset.view === view); }
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
$('#viewMenu').onclick = (e) => { const b = e.target.closest('[data-view]'); if (!b) return; $('#viewMenu').hidden = true; setView(b.dataset.view); };
document.addEventListener('click', (e) => { if (!e.target.closest('#viewMenu, #viewBtn')) $('#viewMenu').hidden = true; });
search.addEventListener('input', renderListSoon);

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
  syncPin();
  $('#noteDate').textContent = n ? new Date(n.updatedAt).toLocaleString('ko-KR', { dateStyle: 'long', timeStyle: 'short' }) : '';
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
  const editable = !!current && !current.deleted;
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
// 완료 (touch): put the keyboard away
$('#doneBtn').onclick = () => editor.blur();
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
  const n = { id: crypto.randomUUID(), body: '', pinned: false, deleted: false, updatedAt: Date.now(), dirty: false };
  addNote(n); unsaved.add(n.id);
  search.value = '';
  open(n, { focus: true });
}

function setTrash(on) {
  if (current) leave(current);
  current = null;
  trashMode = on;
  activeTag = null;
  search.value = '';
  $('#sideTitle').textContent = on ? '휴지통' : '노트';
  $('#trashLabel').textContent = on ? '‹ 모든 노트' : '휴지통';
  $('#trashCount').hidden = on;
  if (single()) showList();
  else open(visible()[0]);
}
$('#trashBtn').onclick = () => setTrash(!trashMode);
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
  if (selecting) exitSelect(true);
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

editor.addEventListener('input', () => {
  if (!current) return;
  for (const img of editor.querySelectorAll('img:not([data-img])')) if (img.src) adoptImage(img);
  const f = editor.firstChild;
  if (f && f.nodeType === 3 && getSelection().anchorNode === f) document.execCommand('formatBlock', false, '<div>');
  current.body = editor.innerHTML.replace(/<img\b[^>]*?data-img="([^"]+)"[^>]*>/g, '<img data-img="$1">');
  touch(current);
  highlightSoon();
});
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
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
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
  const link = e.target.closest('a[href]');
  if (link) { e.preventDefault(); window.open(link.href, '_blank', 'noopener'); }
});

function setBody(html) {
  editor.innerHTML = html || (current ? '<div><br></div>' : '');
  hydrate();
  highlightTags();
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
  if (!li || e.clientX - li.getBoundingClientRect().left > 26) return;
  e.preventDefault();
  li.classList.toggle('done');
  editor.dispatchEvent(new Event('input'));
});
editor.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !mobile.matches) { e.preventDefault(); editor.blur(); list.focus(); return; }
  if (e.key === 'Enter') setTimeout(() => { const li = elAt()?.closest('ul.checklist > li'); if (li && !li.textContent) li.classList.remove('done'); });
});

const elAt = () => { const n = getSelection().anchorNode; return n && (n.nodeType === 1 ? n : n.parentElement); };
const ulAt = () => elAt()?.closest('#editor ul');
const changed = () => editor.dispatchEvent(new Event('input'));

const cmds = {
  bold: () => document.execCommand('bold'),
  heading: () => document.execCommand('formatBlock', false, elAt()?.closest('#editor h2') ? '<div>' : '<h2>'),
  list: () => {
    const ul = ulAt();
    if (ul?.classList.contains('checklist')) { ul.classList.remove('checklist'); changed(); }
    else document.execCommand('insertUnorderedList');
  },
  check: () => {
    let ul = ulAt();
    if (ul) { ul.classList.toggle('checklist'); changed(); return; }
    document.execCommand('insertUnorderedList');
    ulAt()?.classList.add('checklist');
    changed();
  },
  pin: () => { current.pinned = !current.pinned; syncPin(); touch(current); renderList(); },
  del: () => removeNote(current),
  new: () => newNote(),
  photo: () => photoInput.click(),
  file: () => fileInput.click(),
};
for (const b of document.querySelectorAll('[data-cmd]')) {
  b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the caret in the editor
  b.addEventListener('click', () => {
    if (!current) return;
    const c = b.dataset.cmd;
    if (!['pin', 'del', 'photo', 'file', 'new'].includes(c) && !editor.contains(getSelection().anchorNode)) { editor.focus(); caretEnd(); }
    cmds[c]();
  });
}

addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newNote(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'l' && current) { e.preventDefault(); cmds.check(); }
  else if (mod && e.key.toLowerCase() === 'f' && !e.shiftKey) { e.preventDefault(); if (single()) showList(); search.focus(); }
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

  async function push() {
    const dirty = notes.filter((n) => n.dirty && !unsaved.has(n.id));
    if (!dirty.length) return;
    const snap = dirty.map((n) => [n, n.updatedAt]);
    for (let i = 0; i < dirty.length; i += 200) {
      const rows = dirty.slice(i, i + 200).map((n) => ({
        id: n.id, user_id: user.id, body: n.body, pinned: n.pinned, deleted: n.deleted, updated_at: new Date(n.updatedAt).toISOString(),
      }));
      const { error } = await sb.from('notes').upsert(rows);
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
      const { data, error } = await sb.from('notes').select('id,body,pinned,deleted,updated_at,synced_at')
        .gt('synced_at', since).order('synced_at').limit(500);
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
const VERSION = 'v12';
$('#appVersion').textContent = `Breeze 노트 ${VERSION}`;
$('#syncBtn').onclick = () => { $('#authMsg').textContent = ''; sync.ui(); $('#settings').showModal(); };
$('#loginBtn').onclick = sync.login;
$('#signupBtn').onclick = sync.signup;
$('#logoutBtn').onclick = sync.logout;
$('#syncNow').onclick = sync.now;
$('#exportBtn').onclick = () => {
  const data = notes.filter((n) => !n.deleted).map(({ id, body, pinned, updatedAt }) => ({ id, body, pinned, updatedAt }));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'breeze', version: 1, notes: data }, null, 1)], { type: 'application/json' }));
  a.download = `breeze-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const { notes: incoming } = JSON.parse(await f.text());
    let count = 0;
    for (const r of incoming) {
      if (!r.id || typeof r.body !== 'string') continue;
      const n = index.get(r.id);
      if (n && n.updatedAt >= r.updatedAt) continue;
      const fresh = { id: r.id, body: r.body, pinned: !!r.pinned, deleted: false, updatedAt: r.updatedAt || Date.now(), dirty: true };
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
  if (!confirm(`애플 노트 ${incoming.length}개를 가져올까요?\n\n사진 ${photos}개(압축), 파일 ${others}개\n업로드 예상 용량: 약 ${fmtSize(est)} (무료 한도 1GB)\n\n폴더 이름은 #태그로 바뀝니다.`)) return;

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
    if (r.folder && !['Notes', '메모'].includes(r.folder)) body += `<div>#${esc(r.folder.trim().replace(/[^\p{L}\p{N}_\-/]+/gu, '_'))}</div>`;

    const n = { id, body, pinned: false, deleted: false, updatedAt: r.modified, dirty: true };
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

/* ---------------- boot ---------------- */
(async () => {
  (await idb.all()).forEach(addNote);
  const expired = notes.filter((n) => inTrash(n) && Date.now() - n.updatedAt > TRASH_DAYS * 864e5);
  expired.forEach(purge);
  if (expired.length) flush();
  if (soloId) {
    app.classList.add('solo');
    const n = index.get(soloId);
    open(n && !n.deleted ? n : null, { push: false });
    document.title = n ? info(n).title : 'Breeze 노트';
  } else if (!single()) open(visible()[0], { push: false });
  else renderList();
  sync.init();
  requestAnimationFrame(() => app.classList.add('ready')); // enable transitions after first paint
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
