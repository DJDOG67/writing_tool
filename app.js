'use strict';

/* ---------- 저장소 (IndexedDB) ---------- */
const DB_NAME = 'yeobaek';
const DB_VERSION = 1;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('works', { keyPath: 'id' });
      const v = d.createObjectStore('versions', { keyPath: 'id' });
      v.createIndex('workId', 'workId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

const store = {
  allWorks: () => tx('works', 'readonly', s => s.getAll()),
  getWork: id => tx('works', 'readonly', s => s.get(id)),
  putWork: w => tx('works', 'readwrite', s => s.put(w)),
  deleteWork: async id => {
    const vs = await store.versionsOf(id);
    await tx('versions', 'readwrite', s => vs.forEach(v => s.delete(v.id)));
    await tx('works', 'readwrite', s => s.delete(id));
  },
  versionsOf: id => tx('versions', 'readonly', s => s.index('workId').getAll(id)),
  allVersions: () => tx('versions', 'readonly', s => s.getAll()),
  putVersion: v => tx('versions', 'readwrite', s => s.put(v)),
  deleteVersion: id => tx('versions', 'readwrite', s => s.delete(id)),
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- 분량 계산 ---------- */
// 200자 원고지(20칸 × 10줄) 기준.
// 문단마다 새 줄에서 시작하고 첫 칸은 들여쓰기로 비운다. 빈 줄은 세지 않는다.
// 문장부호 배치 같은 세부 규칙은 무시한 근사치다.
function measure(text) {
  const chars = [...text.replace(/\n/g, '')].length;
  const charsNoSpace = [...text.replace(/\s/g, '')].length;
  let lines = 0;
  for (const para of text.split('\n')) {
    const t = para.trim();
    if (!t) continue;
    lines += Math.ceil((1 + [...t].length) / 20);
  }
  const sheets = lines / 10;
  return { chars, charsNoSpace, sheets };
}

const fmt = n => n.toLocaleString('ko-KR');
const fmtSheets = s => (s === 0 ? '0' : s < 10 ? s.toFixed(1) : String(Math.ceil(s)));

function fmtDate(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------- 화면 요소 ---------- */
const $ = id => document.getElementById(id);
const editor = $('editor');
const titleInput = $('title');
const countEl = $('count');
const savedEl = $('saved');

let current = null;      // 지금 쓰는 원고
let saveTimer = null;
let dirty = false;

function updateCount() {
  const m = measure(editor.value);
  countEl.textContent = `${fmt(m.chars)}자 · 원고지 ${fmtSheets(m.sheets)}매`;
  countEl.title = `공백 포함 ${fmt(m.chars)}자 / 공백 제외 ${fmt(m.charsNoSpace)}자 / 200자 원고지 약 ${m.sheets.toFixed(1)}매`;
}

function scheduleSave() {
  dirty = true;
  savedEl.textContent = '';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!current || !dirty) return;
  current.text = editor.value;
  current.title = titleInput.value.trim();
  current.updatedAt = Date.now();
  try {
    await store.putWork(current);
    dirty = false;
    savedEl.textContent = '저장됨';
  } catch (e) {
    savedEl.textContent = '저장 실패';
    console.error(e);
  }
}

async function openWork(work) {
  await saveNow();
  current = work;
  editor.value = work.text;
  titleInput.value = work.title;
  updateCount();
  savedEl.textContent = '';
  try { localStorage.setItem('yeobaek:last', work.id); } catch (_) {}
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
}

async function newWork() {
  const w = { id: uid(), title: '', text: '', createdAt: Date.now(), updatedAt: Date.now() };
  await store.putWork(w);
  await openWork(w);
}

/* ---------- 쓰는 동안 도구 숨기기 ---------- */
editor.addEventListener('input', () => {
  document.body.classList.add('typing');
  updateCount();
  scheduleSave();
});
titleInput.addEventListener('input', scheduleSave);
let lastMove = 0;
document.addEventListener('mousemove', e => {
  // 미세한 손 떨림에는 반응하지 않음
  if (Math.abs(e.movementX) + Math.abs(e.movementY) < 4) return;
  const now = Date.now();
  if (now - lastMove < 50) return;
  lastMove = now;
  document.body.classList.remove('typing');
});

window.addEventListener('beforeunload', () => { if (dirty) saveNow(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

/* ---------- 패널 ---------- */
const panels = { library: $('panel-library'), versions: $('panel-versions') };

function togglePanel(name) {
  const p = panels[name];
  const willOpen = p.hidden;
  Object.values(panels).forEach(x => { x.hidden = true; });
  if (willOpen) {
    p.hidden = false;
    if (name === 'library') renderLibrary();
    if (name === 'versions') renderVersions();
  } else {
    editor.focus();
  }
}

document.querySelectorAll('[data-close]').forEach(b =>
  b.addEventListener('click', () => { b.closest('.panel').hidden = true; editor.focus(); }));

$('btn-library').addEventListener('click', () => togglePanel('library'));
$('btn-versions').addEventListener('click', () => togglePanel('versions'));

async function renderLibrary() {
  await saveNow();
  const list = $('work-list');
  const works = (await store.allWorks()).sort((a, b) => b.updatedAt - a.updatedAt);
  list.replaceChildren();
  for (const w of works) {
    const m = measure(w.text);
    const li = document.createElement('li');
    if (current && w.id === current.id) li.classList.add('current');
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'main';
    main.innerHTML = '<span class="name"></span><span class="sub"></span>';
    main.querySelector('.name').textContent = w.title || '제목 없음';
    main.querySelector('.sub').textContent = `원고지 ${fmtSheets(m.sheets)}매 · ${fmtDate(w.updatedAt)}`;
    main.addEventListener('click', async () => { await openWork(w); panels.library.hidden = true; });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'link danger';
    del.textContent = '삭제';
    del.addEventListener('click', async () => {
      const ok = await confirmBox(`「${w.title || '제목 없음'}」과 모든 판 기록을 삭제할까요? 되돌릴 수 없습니다.`);
      if (!ok) return;
      await store.deleteWork(w.id);
      if (current && current.id === w.id) {
        current = null;
        const rest = (await store.allWorks()).sort((a, b) => b.updatedAt - a.updatedAt);
        if (rest.length) await openWork(rest[0]); else await newWork();
      }
      renderLibrary();
    });
    li.append(main, del);
    list.append(li);
  }
}

$('btn-new').addEventListener('click', async () => { await newWork(); panels.library.hidden = true; });

/* ---------- 판 (버전) ---------- */
const dlgSnap = $('dlg-snapshot');
const dlgVer = $('dlg-version');
let viewing = null;

async function openSnapshotDialog() {
  if (!current) return;
  await saveNow();
  const n = (await store.versionsOf(current.id)).length;
  $('snapshot-label').value = n === 0 ? '초고' : `${n}차 퇴고`;
  dlgSnap.showModal();
  $('snapshot-label').select();
}

$('btn-snapshot').addEventListener('click', openSnapshotDialog);

$('form-snapshot').addEventListener('submit', async e => {
  e.preventDefault();
  const label = $('snapshot-label').value.trim() || fmtDate(Date.now());
  await store.putVersion({ id: uid(), workId: current.id, label, text: editor.value, createdAt: Date.now() });
  dlgSnap.close();
  savedEl.textContent = `「${label}」 저장됨`;
  if (!panels.versions.hidden) renderVersions();
  editor.focus();
});

async function renderVersions() {
  const list = $('version-list');
  list.replaceChildren();
  if (!current) return;
  const vs = (await store.versionsOf(current.id)).sort((a, b) => b.createdAt - a.createdAt);
  if (!vs.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '아직 저장한 판이 없습니다.';
    list.append(li);
    return;
  }
  for (const v of vs) {
    const m = measure(v.text);
    const li = document.createElement('li');
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'main';
    main.innerHTML = '<span class="name"></span><span class="sub"></span>';
    main.querySelector('.name').textContent = v.label;
    main.querySelector('.sub').textContent = `${fmtDate(v.createdAt)} · 원고지 ${fmtSheets(m.sheets)}매`;
    main.addEventListener('click', () => showVersion(v));
    li.append(main);
    list.append(li);
  }
}

function showVersion(v) {
  viewing = v;
  const m = measure(v.text);
  $('version-title').textContent = v.label;
  $('version-meta').textContent = `${fmtDate(v.createdAt)} · ${fmt(m.chars)}자`;
  $('version-text').textContent = v.text || '(빈 원고)';
  dlgVer.showModal();
}

$('btn-version-restore').addEventListener('click', async () => {
  if (!viewing) return;
  const ok = await confirmBox('지금 원고를 이 판으로 바꿉니다. 바꾸기 전 원고는 「되돌리기 전」이라는 판으로 남겨 둘게요.');
  if (!ok) return;
  await store.putVersion({ id: uid(), workId: current.id, label: '되돌리기 전', text: editor.value, createdAt: Date.now() });
  editor.value = viewing.text;
  updateCount();
  scheduleSave();
  await saveNow();
  dlgVer.close();
  renderVersions();
  editor.focus();
});

$('btn-version-delete').addEventListener('click', async () => {
  if (!viewing) return;
  const ok = await confirmBox(`「${viewing.label}」 판을 삭제할까요?`);
  if (!ok) return;
  await store.deleteVersion(viewing.id);
  dlgVer.close();
  renderVersions();
});

/* ---------- 확인 상자 ---------- */
const dlgConfirm = $('dlg-confirm');
function confirmBox(text) {
  return new Promise(resolve => {
    $('confirm-text').textContent = text;
    const ok = $('btn-confirm-ok');
    const done = val => {
      ok.removeEventListener('click', onOk);
      dlgConfirm.removeEventListener('close', onClose);
      if (dlgConfirm.open) dlgConfirm.close();
      resolve(val);
    };
    const onOk = () => done(true);
    const onClose = () => done(false);
    ok.addEventListener('click', onOk);
    dlgConfirm.addEventListener('close', onClose);
    dlgConfirm.showModal();
  });
}

document.querySelectorAll('[data-cancel]').forEach(b =>
  b.addEventListener('click', () => b.closest('dialog').close()));

/* ---------- 내보내기 · 백업 ---------- */
function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const safeName = s => (s || '제목 없음').replace(/[\\/:*?"<>|]/g, '_');

$('btn-export').addEventListener('click', async () => {
  await saveNow();
  const title = titleInput.value.trim();
  const body = title ? `${title}\n\n${editor.value}` : editor.value;
  download(`${safeName(title)}.txt`, body, 'text/plain;charset=utf-8');
});

$('btn-backup').addEventListener('click', async () => {
  await saveNow();
  const data = { app: 'yeobaek', version: 1, exportedAt: Date.now(),
    works: await store.allWorks(), versions: await store.allVersions() };
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  download(`여백-백업-${stamp}.json`, JSON.stringify(data), 'application/json');
});

$('file-restore').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
    if (data.app !== 'yeobaek' || !Array.isArray(data.works)) throw new Error('형식');
  } catch (_) {
    await confirmBox('여백 백업 파일이 아닙니다. 「전체 백업 받기」로 만든 .json 파일을 골라 주세요.');
    return;
  }
  const ok = await confirmBox(`원고 ${data.works.length}편을 불러옵니다. 같은 원고가 있으면 백업의 내용으로 바뀝니다.`);
  if (!ok) return;
  for (const w of data.works) await store.putWork(w);
  for (const v of data.versions || []) await store.putVersion(v);
  if (current) {
    const fresh = await store.getWork(current.id);
    if (fresh) { dirty = false; await openWork(fresh); }
  }
  renderLibrary();
});

/* ---------- 단축키 ---------- */
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); openSnapshotDialog(); }
  if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
    Object.values(panels).forEach(p => { p.hidden = true; });
    editor.focus();
  }
  // 탭 키로 포커스가 빠져나가지 않게: 본문에서는 무시
  if (e.key === 'Tab' && document.activeElement === editor) e.preventDefault();
});

/* ---------- 시작 ---------- */
(async function start() {
  try {
    db = await openDB();
  } catch (e) {
    savedEl.textContent = '저장소를 열 수 없음';
    console.error(e);
    return;
  }
  const works = (await store.allWorks()).sort((a, b) => b.updatedAt - a.updatedAt);
  let last = null;
  try { last = localStorage.getItem('yeobaek:last'); } catch (_) {}
  const pick = works.find(w => w.id === last) || works[0];
  if (pick) await openWork(pick); else await newWork();
})();
