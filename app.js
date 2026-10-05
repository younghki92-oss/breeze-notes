// Breeze 노트 — local-first notes with optional Supabase sync.
// Notes live in IndexedDB; the UI never waits on the network.

const $ = (s) => document.querySelector(s);
const app = $('#app'), pane = $('#editorPane'), list = $('#list'), editor = $('#editor'), search = $('#search');
const mobile = matchMedia('(max-width: 767px)');

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
async function flush() {
  clearTimeout(saveT);
  await idb.putMany(notes.filter((n) => n.dirty && !unsaved.has(n.id)));
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
// #태그: a hash at the start of a word, Korean included.
const TAG_RE = /(?:^|[\s(])#([\p{L}\p{N}_][\p{L}\p{N}_\-/]*)/gu;
const tagCache = new Map();
function tagsOf(n) {
  const t = textOf(n), c = tagCache.get(n.id);
  if (c && c[0] === t) return c[1];
  const tags = [...new Set([...t.matchAll(TAG_RE)].map((m) => m[1]))];
  tagCache.set(n.id, [t, tags]);
  return tags;
}
let activeTag = null;
const visible = () => notes.filter((n) => !n.deleted).sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt));

/* ---------------- list ---------------- */
const PIN = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" style="margin-right:4px;color:var(--accent)"><path d="M9 3h6l-1 6 3 3v2h-4v8h-2v-8H7v-2l3-3Z"/></svg>';
function renderList() {
  const q = search.value.trim().toLowerCase();
  const all = visible();
  renderTags(all);
  const items = all.filter((n) => (!q || textOf(n).toLowerCase().includes(q)) && (!activeTag || tagsOf(n).includes(activeTag)));
  const row = (n) => {
    const { title, preview } = info(n);
    return `<li data-id="${n.id}" class="${n === current ? 'active' : ''}"><div class="t">${n.pinned ? PIN : ''}${esc(title)}</div><div class="p"><time>${fmt(n.updatedAt)}</time>${esc(preview)}</div></li>`;
  };
  const pinned = items.filter((n) => n.pinned), rest = items.filter((n) => !n.pinned);
  let html = '';
  if (pinned.length) html += '<li class="sec">고정됨</li>' + pinned.map(row).join('') + (rest.length ? '<li class="sec">노트</li>' : '');
  html += rest.map(row).join('');
  list.innerHTML = html || `<li class="none">${q ? '검색 결과 없음' : '노트가 없습니다'}</li>`;
}
const tagBar = $('#tags');
function renderTags(all) {
  const counts = new Map();
  for (const n of all) for (const t of tagsOf(n)) counts.set(t, (counts.get(t) || 0) + 1);
  if (activeTag && !counts.has(activeTag)) activeTag = null;
  const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
  tagBar.hidden = !tags.length;
  tagBar.innerHTML = tags.map(([t, c]) => `<button class="tag${t === activeTag ? ' on' : ''}" data-tag="${esc(t)}">#${esc(t)}<span>${c}</span></button>`).join('');
}
tagBar.addEventListener('click', (e) => {
  const b = e.target.closest('[data-tag]');
  if (!b) return;
  activeTag = activeTag === b.dataset.tag ? null : b.dataset.tag;
  renderList();
});
let listRaf = 0;
function renderListSoon() { if (!listRaf) listRaf = requestAnimationFrame(() => { listRaf = 0; renderList(); }); }

list.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) open(index.get(li.dataset.id));
});
search.addEventListener('input', renderListSoon);
search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; renderList(); } });

/* ---------------- open / close ---------------- */
function open(n, { focus = false, push = true } = {}) {
  if (current && current !== n) leave(current);
  current = n || null;
  setBody(n ? n.body : '');
  editor.contentEditable = n ? 'true' : 'false';
  pane.classList.toggle('none', !n);
  $('#pinBtn').classList.toggle('on', !!n?.pinned);
  if (n && mobile.matches && app.className !== 'show-editor') {
    app.className = 'show-editor';
    if (push) history.pushState({ note: n.id }, '');
  }
  renderList();
  if (n && focus) { editor.focus(); caretEnd(); }
}
function showList() {
  if (current) leave(current);
  current = null;
  app.className = 'show-list';
  pane.classList.add('none');
  renderList();
}
// Empty notes vanish when you leave them, like Apple Notes.
function leave(n) {
  if (n.deleted) return;
  if (!textOf(n).trim() && !n.body.includes('<img')) {
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
  const n = { id: crypto.randomUUID(), body: '', pinned: false, deleted: false, updatedAt: Date.now(), dirty: false };
  addNote(n); unsaved.add(n.id);
  search.value = '';
  open(n, { focus: true });
}

$('#newBtn').onclick = newNote;
$('#emptyNew').onclick = newNote;
$('#backBtn').onclick = () => (history.state?.note ? history.back() : showList());
addEventListener('popstate', () => { if (app.className === 'show-editor') showList(); }); // Android back button
mobile.addEventListener('change', () => { app.className = mobile.matches && current ? 'show-editor' : 'show-list'; });

/* ---------------- editor ---------------- */
document.execCommand('defaultParagraphSeparator', false, 'div');

editor.addEventListener('input', () => {
  if (!current) return;
  const f = editor.firstChild;
  if (f && f.nodeType === 3 && getSelection().anchorNode === f) document.execCommand('formatBlock', false, '<div>');
  current.body = editor.innerHTML.replace(/<img\b[^>]*?data-img="([^"]+)"[^>]*>/g, '<img data-img="$1">');
  touch(current);
  highlightSoon();
});
editor.addEventListener('paste', (e) => {
  e.preventDefault();
  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) return insertImages(files);
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});
editor.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
editor.addEventListener('drop', (e) => {
  const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
  if (!files.length || !current) return;
  e.preventDefault();
  const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);
  if (r) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  insertImages(files);
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
async function hydrate() {
  for (const img of editor.querySelectorAll('img[data-img]')) {
    const id = img.dataset.img;
    if (img.getAttribute('src')) continue;
    let url = imgUrls.get(id);
    if (!url) {
      let rec = await idb.img(id);
      if (!rec) {
        const blob = await sync.download(id);
        if (blob) { rec = { id, blob, uploaded: true }; await idb.putImg(rec); }
      }
      if (rec) { url = URL.createObjectURL(rec.blob); imgUrls.set(id, url); }
    }
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
async function insertImages(files) {
  if (!current) return;
  if (!editor.contains(getSelection().anchorNode)) { editor.focus(); caretEnd(); }
  for (const f of files) {
    const blob = await compress(f).catch(() => null);
    if (!blob) { toast('사진을 읽을 수 없습니다'); continue; }
    const id = crypto.randomUUID();
    await idb.putImg({ id, blob, uploaded: false });
    imgUrls.set(id, URL.createObjectURL(blob));
    document.execCommand('insertHTML', false, `<img data-img="${id}">`);
  }
  hydrate();
  sync.schedule(800);
}
const photoInput = $('#photoInput');
photoInput.onchange = () => { insertImages([...photoInput.files]); photoInput.value = ''; };
// Tap the circle to tick a checklist item.
editor.addEventListener('pointerdown', (e) => {
  const li = e.target.closest?.('ul.checklist > li');
  if (!li || e.clientX - li.getBoundingClientRect().left > 26) return;
  e.preventDefault();
  li.classList.toggle('done');
  editor.dispatchEvent(new Event('input'));
});
editor.addEventListener('keydown', (e) => {
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
  pin: () => { current.pinned = !current.pinned; $('#pinBtn').classList.toggle('on', current.pinned); touch(current); renderList(); },
  del: () => removeNote(current),
  photo: () => photoInput.click(),
};
for (const b of document.querySelectorAll('[data-cmd]')) {
  b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the caret in the editor
  b.addEventListener('click', () => {
    if (!current) return;
    const c = b.dataset.cmd;
    if (!['pin', 'del', 'photo'].includes(c) && !editor.contains(getSelection().anchorNode)) { editor.focus(); caretEnd(); }
    cmds[c]();
  });
}

addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newNote(); }
  else if (mod && e.shiftKey && e.key.toLowerCase() === 'l' && current) { e.preventDefault(); cmds.check(); }
  else if (mod && e.key.toLowerCase() === 'f' && !e.shiftKey) { e.preventDefault(); if (mobile.matches) showList(); search.focus(); }
});

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
function removeNote(n) {
  n.deleted = true;
  touch(n);
  flush();
  if (mobile.matches) { current = null; history.state?.note ? history.back() : showList(); }
  else { current = null; open(visible()[0]); }
  toast('노트를 삭제했습니다', '실행 취소', () => { n.deleted = false; touch(n); open(n); });
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
      const { error } = await sb.storage.from('images').upload(`${user.id}/${r.id}`, r.blob, { contentType: r.blob.type, upsert: true });
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
        if (n.deleted) mobile.matches ? showList() : open(visible()[0]);
        else { setBody(n.body); $('#pinBtn').classList.toggle('on', n.pinned); }
      }
    }
    if (changedNotes.length) { idb.putMany(changedNotes); renderList(); }
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

/* ---------------- boot ---------------- */
(async () => {
  (await idb.all()).forEach(addNote);
  if (!mobile.matches) open(visible()[0], { push: false });
  else renderList();
  sync.init();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
addEventListener('pagehide', flush);
