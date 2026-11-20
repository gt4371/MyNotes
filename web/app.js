'use strict';

/* ======================================================================
   Speicher (IndexedDB)
   - Store "notes": Notizen inkl. Liste ihrer Anhänge (nur Metadaten)
   - Store "files": die eigentlichen Foto-/Audiodaten (Blob), Schlüssel = Anhang-id
   ====================================================================== */

const DB_NAME = 'notizen';
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function dbTx(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const req = fn(tx);
    tx.oncomplete = () => resolve(req && 'result' in req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Speichern abgebrochen (Speicher voll?)'));
  });
}

const dbAllNotes = () => dbTx('notes', 'readonly', tx => tx.objectStore('notes').getAll());
const dbPutNotes = list => dbTx('notes', 'readwrite', tx => list.forEach(n => tx.objectStore('notes').put(n)));
const dbGetFile = id => dbTx('files', 'readonly', tx => tx.objectStore('files').get(id));
const dbPutFiles = list => dbTx('files', 'readwrite', tx => list.forEach(f => tx.objectStore('files').put(f)));
const dbDeleteFiles = ids => dbTx('files', 'readwrite', tx => ids.forEach(id => tx.objectStore('files').delete(id)));
const dbDeleteNote = (id, fileIds) => dbTx(['notes', 'files'], 'readwrite', tx => {
  tx.objectStore('notes').delete(id);
  fileIds.forEach(f => tx.objectStore('files').delete(f));
});

/** Alle Notizen im Speicher, nach id. */
const notes = new Map();

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function normalize(n) {
  return {
    id: String(n.id),
    title: String(n.title || ''),
    content: String(n.content || ''),
    created: Number(n.created) || Date.now(),
    updated: Number(n.updated) || Date.now(),
    attachments: Array.isArray(n.attachments) ? n.attachments.map(a => ({ ...a })) : [],
  };
}

const clone = n => normalize(n);

let persistRequested = false;
function requestPersistence() {
  // Bittet den Browser, die Daten nicht automatisch zu löschen, wenn der Speicher knapp wird.
  if (persistRequested) return;
  persistRequested = true;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

async function saveNote(note) {
  note.updated = Date.now();
  requestPersistence();
  await dbPutNotes([note]);
  notes.set(note.id, clone(note));
}

/** Blob-URLs der Anhänge (für Vorschaubilder und Wiedergabe), nach Anhang-id */
const blobUrls = new Map();
async function fileUrl(id) {
  if (blobUrls.has(id)) return blobUrls.get(id);
  const rec = await dbGetFile(id);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  blobUrls.set(id, url);
  return url;
}
function forgetUrl(id) {
  const url = blobUrls.get(id);
  if (url) URL.revokeObjectURL(url);
  blobUrls.delete(id);
}

/* ======================================================================
   Hilfsfunktionen
   ====================================================================== */

const $ = sel => document.querySelector(sel);

const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

function formatDate(ms) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Heute, ' + timeFmt.format(d);
  if (same(d, yesterday)) return 'Gestern, ' + timeFmt.format(d);
  return dateFmt.format(d) + ', ' + timeFmt.format(d);
}

function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

const countOf = (note, kind) => note.attachments.filter(a => a.kind === kind).length;

function displayTitle(note) {
  const title = note.title.trim();
  if (title) return title;
  const first = note.content.trim().split('\n')[0].trim();
  if (first) return first;
  if (countOf(note, 'photo')) return 'Foto-Notiz';
  if (countOf(note, 'audio')) return 'Sprachnotiz';
  return '(ohne Titel)';
}

function previewText(note) {
  const content = note.content.trim();
  const body = note.title.trim() ? content : content.split('\n').slice(1).join(' ');
  return body.replace(/\s+/g, ' ').trim();
}

function badges(note) {
  const p = countOf(note, 'photo');
  const a = countOf(note, 'audio');
  const parts = [];
  if (p) parts.push(`📷 ${p}`);
  if (a) parts.push(`🎤 ${a}`);
  return parts.join('  ');
}

function attachmentSummary(note) {
  const p = countOf(note, 'photo');
  const a = countOf(note, 'audio');
  const parts = [];
  if (p) parts.push(p === 1 ? '1 Foto' : `${p} Fotos`);
  if (a) parts.push(a === 1 ? '1 Sprachnotiz' : `${a} Sprachnotizen`);
  return parts.join(', ');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function highlight(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const re = new RegExp(escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return safe.replace(re, m => `<mark>${m}</mark>`);
}

function noteAsText(note) {
  const extra = attachmentSummary(note);
  return [note.title.trim(), note.content.trim(), extra && `[Anhänge: ${extra}]`].filter(Boolean).join('\n\n');
}

function safeFileName(name) {
  return (name.replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 60) || 'Notiz');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function extFor(type) {
  if (/jpe?g/.test(type)) return 'jpg';
  if (/png/.test(type)) return 'png';
  if (/webp/.test(type)) return 'webp';
  if (/gif/.test(type)) return 'gif';
  if (/webm/.test(type)) return 'webm';
  if (/ogg/.test(type)) return 'ogg';
  if (/mp4|m4a|aac/.test(type)) return 'm4a';
  if (/mpeg|mp3/.test(type)) return 'mp3';
  return 'bin';
}

function attachmentFileName(note, att, index) {
  const base = safeFileName(displayTitle(note));
  const label = att.kind === 'photo' ? 'Foto' : 'Sprachnotiz';
  return `${base} - ${label} ${index + 1}.${extFor(att.type)}`;
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function download(filename, text, type) {
  downloadBlob(filename, new Blob([text], { type: type + ';charset=utf-8' }));
}

const blobToDataUrl = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

const dataUrlToBlob = url => fetch(url).then(r => r.blob());

let toastTimer = null;
function toast(message, actionLabel, action) {
  const el = $('#toast');
  el.textContent = message;
  if (actionLabel) {
    const btn = document.createElement('button');
    btn.textContent = actionLabel;
    btn.onclick = () => { el.hidden = true; action(); };
    el.appendChild(btn);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, actionLabel ? 6000 : 3000);
}

/* ======================================================================
   Liste
   ====================================================================== */

function renderList() {
  const query = $('#search').value.trim();
  const q = query.toLowerCase();
  const list = [...notes.values()]
    .filter(n => !q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
    .sort((a, b) => b.updated - a.updated);

  $('#notes').innerHTML = list.map(n => {
    const preview = previewText(n);
    const photo = n.attachments.find(a => a.kind === 'photo');
    const b = badges(n);
    return `<li class="note" data-id="${escapeHtml(n.id)}" tabindex="0">
      <div class="note-row">
        <div>
          <h2>${highlight(displayTitle(n), query)}</h2>
          ${preview ? `<p>${highlight(preview.slice(0, 300), query)}</p>` : ''}
          <time>${formatDate(n.updated)}</time>
          ${b ? `<span class="badges">${b}</span>` : ''}
        </div>
        ${photo ? `<img class="note-thumb" data-file="${escapeHtml(photo.id)}" alt="">` : ''}
      </div>
    </li>`;
  }).join('');

  document.querySelectorAll('#notes img[data-file]').forEach(async img => {
    const url = await fileUrl(img.dataset.file).catch(() => null);
    if (url) img.src = url;
  });

  const empty = $('#empty');
  empty.hidden = list.length > 0;
  empty.textContent = query
    ? 'Keine Treffer.'
    : 'Noch keine Notizen.\nTippe auf „+“, um eine anzulegen.';
}

$('#notes').addEventListener('click', e => {
  const li = e.target.closest('.note');
  if (li) openNote(li.dataset.id);
});
$('#notes').addEventListener('keydown', e => {
  const li = e.target.closest('.note');
  if (li && e.key === 'Enter') openNote(li.dataset.id);
});
$('#search').addEventListener('input', renderList);
$('#add-btn').addEventListener('click', () => openNote(null));

/* ======================================================================
   Bearbeiten
   ====================================================================== */

let current = null;      // Notiz, die gerade bearbeitet wird (Arbeitskopie)
let saveTimer = null;
let saving = Promise.resolve();

function openNote(id) {
  location.hash = id ? '#/n/' + encodeURIComponent(id) : '#/neu';
}

function showEditor(id) {
  const existing = id && notes.get(id);
  current = existing
    ? clone(existing)
    : normalize({ id: newId(), title: '', content: '', created: Date.now(), updated: Date.now() });

  $('#title').value = current.title;
  $('#content').value = current.content;
  $('#edit-heading').textContent = existing ? 'Notiz' : 'Neue Notiz';
  updateDateLine();
  renderAttachments();

  $('#list-view').hidden = true;
  $('#edit-view').hidden = false;
  window.scrollTo(0, 0);
  if (!existing) $('#content').focus();
}

function updateDateLine() {
  $('#date').textContent = notes.has(current.id) ? 'Zuletzt geändert: ' + formatDate(current.updated) : '';
}

function renderAttachments() {
  const photos = current.attachments.filter(a => a.kind === 'photo');
  const audios = current.attachments.filter(a => a.kind === 'audio');

  const photoBox = $('#photos');
  photoBox.hidden = photos.length === 0;
  photoBox.innerHTML = photos.map(a =>
    `<button type="button" data-id="${escapeHtml(a.id)}" aria-label="Foto öffnen"><img alt=""></button>`).join('');
  photoBox.querySelectorAll('button').forEach(async btn => {
    const url = await fileUrl(btn.dataset.id).catch(() => null);
    if (url) btn.querySelector('img').src = url;
  });

  const audioBox = $('#audios');
  audioBox.hidden = audios.length === 0;
  audioBox.innerHTML = audios.map(a =>
    `<div class="audio" data-id="${escapeHtml(a.id)}">
      <audio controls preload="metadata"></audio>
      ${a.duration ? `<span class="len">${formatDuration(a.duration)}</span>` : ''}
      <button type="button" class="del" aria-label="Sprachnotiz löschen" title="Löschen">🗑</button>
    </div>`).join('');
  audioBox.querySelectorAll('.audio').forEach(async row => {
    const url = await fileUrl(row.dataset.id).catch(() => null);
    if (url) fixDuration(row.querySelector('audio')).src = url;
  });
}

/** Chrome kennt bei eigenen Aufnahmen die Länge erst nach einmaligem Durchspulen – das hier holt es nach. */
function fixDuration(audio) {
  audio.addEventListener('loadedmetadata', () => {
    if (audio.duration !== Infinity) return;
    audio.addEventListener('timeupdate', function reset() {
      audio.removeEventListener('timeupdate', reset);
      audio.currentTime = 0;
    });
    audio.currentTime = 1e101;
  }, { once: true });
  return audio;
}

const isEmpty = (title, content, note) => !title.trim() && !content.trim() && note.attachments.length === 0;

/** Speichert die Arbeitskopie, wenn sich etwas geändert hat (force = Anhänge geändert). */
function flushSave(force = false) {
  clearTimeout(saveTimer);
  saveTimer = null;
  saving = saving.then(() => doSave(force)).catch(err => toast('Speichern fehlgeschlagen: ' + err.message));
  return saving;
}

async function doSave(force) {
  if (!current) return;
  const title = $('#title').value;
  const content = $('#content').value;
  const stored = notes.get(current.id);

  if (!stored && isEmpty(title, content, current)) return; // leere neue Notiz nicht speichern
  if (!force && stored && stored.title === title && stored.content === content) return;

  current.title = title;
  current.content = content;
  await saveNote(current);
  current = clone(notes.get(current.id));
  $('#edit-heading').textContent = 'Notiz';
  updateDateLine();
  // Neue Notiz hat jetzt eine feste Adresse (ohne zusätzlichen Verlaufseintrag)
  if (location.hash === '#/neu') history.replaceState(history.state, '', '#/n/' + encodeURIComponent(current.id));
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(), 400);
}

$('#title').addEventListener('input', scheduleSave);
$('#content').addEventListener('input', scheduleSave);
$('#title').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#content').focus(); }
});

async function closeEditor() {
  if (recorder) await stopRecording(true);
  await flushSave();
  // Zurück zur Liste – über den Verlauf, damit die Zurück-Taste von Android passt
  if (history.state && history.state.fromList) history.back();
  else location.hash = '';
}

$('#back-btn').addEventListener('click', closeEditor);

async function filesOf(note) {
  const out = [];
  for (const [i, a] of note.attachments.entries()) {
    const rec = await dbGetFile(a.id);
    if (rec) out.push(new File([rec.blob], attachmentFileName(note, a, i), { type: a.type || rec.blob.type }));
  }
  return out;
}

async function shareThings(text, title, files) {
  const data = { text: text || undefined, title: title || undefined };
  if (files.length && navigator.canShare && navigator.canShare({ files })) data.files = files;
  if (navigator.share) {
    try {
      await navigator.share(data);
    } catch (err) {
      if (err.name !== 'AbortError') toast('Teilen nicht möglich: ' + err.message);
    }
  } else if (text && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    toast('Text in die Zwischenablage kopiert');
  } else {
    toast('Teilen wird von diesem Browser nicht unterstützt.');
  }
}

$('#share-btn').addEventListener('click', async () => {
  await flushSave();
  const note = { ...current, title: $('#title').value, content: $('#content').value };
  const text = [note.title.trim(), note.content.trim()].filter(Boolean).join('\n\n');
  if (!text && !note.attachments.length) return toast('Die Notiz ist leer.');
  await shareThings(text, note.title.trim(), await filesOf(note));
});

// Beim Verlassen oder Wechseln der App sofort speichern
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (recorder) stopRecording(true);
  flushSave();
});
window.addEventListener('pagehide', () => flushSave());

/* ---------- Anhänge: gemeinsam ---------- */

async function addAttachments(items) {
  // items: [{ kind, blob, duration? }]
  const metas = items.map(it => ({
    id: newId(),
    kind: it.kind,
    type: it.blob.type || (it.kind === 'photo' ? 'image/jpeg' : 'audio/webm'),
    created: Date.now(),
    ...(it.duration ? { duration: it.duration } : {}),
  }));
  try {
    await dbPutFiles(metas.map((m, i) => ({ id: m.id, blob: items[i].blob })));
  } catch (err) {
    toast('Anhang konnte nicht gespeichert werden: ' + err.message);
    return;
  }
  current.attachments.push(...metas);
  renderAttachments();
  await flushSave(true);
}

async function removeAttachment(id) {
  current.attachments = current.attachments.filter(a => a.id !== id);
  await flushSave(true);
  await dbDeleteFiles([id]);
  forgetUrl(id);
  renderAttachments();
}

/* ---------- Fotos ---------- */

const MAX_PHOTO_SIDE = 1920;

/** Verkleinert ein Foto (spart Speicher) und dreht es richtig; bei Problemen das Original. */
async function shrinkPhoto(file) {
  try {
    if (!/^image\/(jpeg|png|webp|heic|heif)/.test(file.type) || !window.createImageBitmap) return file;
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 600 * 1024) { bmp.close && bmp.close(); return file; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close && bmp.close();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

$('#photo-btn').addEventListener('click', () => {
  $('#photo-file').value = '';
  $('#photo-file').click();
});

$('#photo-file').addEventListener('change', async e => {
  const files = [...e.target.files].filter(f => f.type.startsWith('image/') || !f.type);
  if (!files.length || !current) return;
  toast(files.length === 1 ? 'Foto wird gespeichert …' : `${files.length} Fotos werden gespeichert …`);
  const items = [];
  for (const f of files) items.push({ kind: 'photo', blob: await shrinkPhoto(f) });
  await addAttachments(items);
  toast(files.length === 1 ? 'Foto hinzugefügt' : `${files.length} Fotos hinzugefügt`);
});

let viewerId = null;

$('#photos').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;
  viewerId = btn.dataset.id;
  $('#viewer-img').src = (await fileUrl(viewerId)) || '';
  $('#viewer').hidden = false;
  history.pushState({ ...(history.state || {}), viewer: true }, ''); // Zurück-Taste schließt die Ansicht
});

function hideViewer() {
  $('#viewer').hidden = true;
  $('#viewer-img').removeAttribute('src');
  viewerId = null;
}
function closeViewer() {
  if ($('#viewer').hidden) return;
  if (history.state && history.state.viewer) history.back(); // löst popstate → hideViewer aus
  else hideViewer();
}
window.addEventListener('popstate', () => { if (!$('#viewer').hidden) hideViewer(); });

$('#viewer-close').addEventListener('click', closeViewer);
$('#viewer-img').addEventListener('click', closeViewer);

$('#viewer-share').addEventListener('click', async () => {
  const i = current.attachments.findIndex(a => a.id === viewerId);
  const rec = await dbGetFile(viewerId);
  if (!rec) return;
  const file = new File([rec.blob], attachmentFileName(current, current.attachments[i], i), { type: rec.blob.type });
  await shareThings('', '', [file]);
});

$('#viewer-save').addEventListener('click', async () => {
  const i = current.attachments.findIndex(a => a.id === viewerId);
  const rec = await dbGetFile(viewerId);
  if (!rec) return;
  downloadBlob(attachmentFileName(current, current.attachments[i], i), rec.blob);
  toast('Foto gespeichert (Ordner „Downloads“)');
});

$('#viewer-delete').addEventListener('click', async () => {
  if (!confirm('Dieses Foto löschen?')) return;
  const id = viewerId;
  closeViewer();
  await removeAttachment(id);
  toast('Foto gelöscht');
});

/* ---------- Sprachnotizen ---------- */

let recorder = null;
let recChunks = [];
let recStart = 0;
let recTimer = null;
let recDiscard = false;
let recDone = null;
const MAX_RECORD_SECONDS = 15 * 60;

function pickAudioType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']
    .find(t => MediaRecorder.isTypeSupported(t)) || '';
}

$('#record-btn').addEventListener('click', async () => {
  if (recorder) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    return toast('Aufnehmen wird von diesem Browser nicht unterstützt.');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return toast(err.name === 'NotAllowedError'
      ? 'Kein Zugriff aufs Mikrofon – bitte in den Browser-Einstellungen erlauben.'
      : 'Mikrofon nicht verfügbar: ' + err.message);
  }
  const type = pickAudioType();
  recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  recChunks = [];
  recDiscard = false;
  recorder.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const duration = (Date.now() - recStart) / 1000;
    const blob = new Blob(recChunks, { type: recorder.mimeType || type || 'audio/webm' });
    recorder = null;
    clearInterval(recTimer);
    $('#recording').hidden = true;
    $('#tools').hidden = false;
    if (!recDiscard && blob.size > 0 && current) {
      await addAttachments([{ kind: 'audio', blob, duration }]);
      toast('Sprachnotiz gespeichert (' + formatDuration(duration) + ')');
    }
    const done = recDone;
    recDone = null;
    if (done) done();
  };
  recorder.start(1000);
  recStart = Date.now();
  $('#rec-time').textContent = '0:00';
  $('#tools').hidden = true;
  $('#recording').hidden = false;
  recTimer = setInterval(() => {
    const sec = (Date.now() - recStart) / 1000;
    $('#rec-time').textContent = formatDuration(sec);
    if (sec >= MAX_RECORD_SECONDS) stopRecording(true);
  }, 250);
});

/** Beendet die Aufnahme; keep = speichern, sonst verwerfen. */
function stopRecording(keep) {
  if (!recorder) return Promise.resolve();
  return new Promise(resolve => {
    recDiscard = !keep;
    recDone = resolve;
    if (recorder.state !== 'inactive') recorder.stop();
  });
}

$('#rec-stop').addEventListener('click', () => stopRecording(true));
$('#rec-cancel').addEventListener('click', () => stopRecording(false));

$('#audios').addEventListener('click', async e => {
  const del = e.target.closest('.del');
  if (!del) return;
  if (!confirm('Diese Sprachnotiz löschen?')) return;
  await removeAttachment(del.closest('.audio').dataset.id);
  toast('Sprachnotiz gelöscht');
});

/* ======================================================================
   Menüs
   ====================================================================== */

function toggleMenu(menu, show) {
  document.querySelectorAll('.menu').forEach(m => { if (m !== menu) m.hidden = true; });
  menu.hidden = show === undefined ? !menu.hidden : !show;
}

$('#menu-btn').addEventListener('click', async e => {
  e.stopPropagation();
  const last = localStorage.getItem('lastBackup');
  let info = 'Letzte Sicherung: ' + (last ? formatDate(Number(last)) : 'noch nie') + '\nNotizen: ' + notes.size;
  toggleMenu($('#main-menu'));
  $('#backup-info').textContent = info;
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage } = await navigator.storage.estimate();
      if (usage) $('#backup-info').textContent = info + '\nBelegt: ' + (usage / 1048576).toFixed(1).replace('.', ',') + ' MB';
    } catch { /* egal */ }
  }
});
$('#note-menu-btn').addEventListener('click', e => {
  e.stopPropagation();
  toggleMenu($('#note-menu'));
});
document.addEventListener('click', e => {
  if (!e.target.closest('.menu')) document.querySelectorAll('.menu').forEach(m => { m.hidden = true; });
});

document.querySelectorAll('.menu').forEach(menu => menu.addEventListener('click', e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  menu.hidden = true;
  actions[btn.dataset.action]();
}));

const actions = {
  async 'export-all'() {
    toast('Sicherung wird erstellt …');
    const list = [...notes.values()].sort((a, b) => b.updated - a.updated);
    const out = [];
    let missing = 0;
    for (const n of list) {
      const atts = [];
      for (const a of n.attachments) {
        const rec = await dbGetFile(a.id);
        if (rec) atts.push({ ...a, data: await blobToDataUrl(rec.blob) });
        else missing++;
      }
      out.push({ ...n, attachments: atts });
    }
    const data = { app: 'notizen', version: 2, exported: new Date().toISOString(), notes: out };
    download(`notizen-sicherung-${today()}.json`, JSON.stringify(data), 'application/json');
    localStorage.setItem('lastBackup', String(Date.now()));
    toast(`${notes.size} Notizen exportiert (Ordner „Downloads“)` + (missing ? ` – ${missing} Anhänge fehlten` : ''));
  },

  'export-all-txt'() {
    const list = [...notes.values()].sort((a, b) => b.updated - a.updated);
    const text = list.map(n => {
      const extra = attachmentSummary(n);
      return `${displayTitle(n)}\n${formatDate(n.updated)}\n\n${n.content.trim()}` + (extra ? `\n\n[Anhänge: ${extra}]` : '');
    }).join('\n\n' + '─'.repeat(30) + '\n\n');
    download(`notizen-${today()}.txt`, text + '\n', 'text/plain');
    toast('Textdatei gespeichert (Ordner „Downloads“) – ohne Fotos/Sprachnotizen');
  },

  import() {
    $('#import-file').value = '';
    $('#import-file').click();
  },

  async 'save-txt'() {
    await flushSave();
    const note = { ...current, title: $('#title').value, content: $('#content').value };
    const text = noteAsText(note);
    if (!text) return toast('Die Notiz ist leer.');
    download(safeFileName(displayTitle(note)) + '.txt', text + '\n', 'text/plain');
    toast('Gespeichert (Ordner „Downloads“)');
  },

  async delete() {
    if (!confirm('Diese Notiz löschen?')) return;
    if (recorder) await stopRecording(false);
    clearTimeout(saveTimer);
    await saving;
    const removed = notes.get(current.id);
    let removedFiles = [];
    if (removed) {
      for (const a of removed.attachments) {
        const rec = await dbGetFile(a.id);
        if (rec) removedFiles.push(rec);
      }
      await dbDeleteNote(removed.id, removed.attachments.map(a => a.id));
      notes.delete(removed.id);
      removed.attachments.forEach(a => forgetUrl(a.id));
    } else if (current.attachments.length) {
      await dbDeleteFiles(current.attachments.map(a => a.id));
    }
    current = null;
    await closeEditor();
    if (removed) {
      toast('Notiz gelöscht', 'Rückgängig', async () => {
        await dbPutFiles(removedFiles);
        await dbPutNotes([removed]);
        notes.set(removed.id, removed);
        renderList();
      });
    }
  },
};

$('#import-file').addEventListener('change', async e => {
  const files = [...e.target.files];
  let added = 0, updated = 0, skipped = 0;

  for (const file of files) {
    let text;
    try { text = await file.text(); } catch { skipped++; continue; }

    // Sicherung am Inhalt erkennen (Dateiendung kann beim Herunterladen verloren gehen)
    let list = null;
    if (/^\s*[[{]/.test(text)) {
      try {
        const data = JSON.parse(text);
        list = Array.isArray(data) ? data : data && data.notes;
      } catch { /* doch keine Sicherung */ }
    }
    if (/\.json$/i.test(file.name) && !Array.isArray(list)) {
      toast(`„${file.name}“ ist keine gültige Sicherung.`);
      return;
    }

    if (Array.isArray(list)) {
      if (list.length) toast('Sicherung wird importiert …');
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') { skipped++; continue; }
        const n = normalize({ ...raw, id: raw.id || newId() });
        const existing = notes.get(n.id);
        if (existing && existing.updated >= n.updated) { skipped++; continue; }

        const fileRecs = [];
        n.attachments = [];
        for (const a of (Array.isArray(raw.attachments) ? raw.attachments : [])) {
          if (!a || !a.data || (a.kind !== 'photo' && a.kind !== 'audio')) continue;
          try {
            const blob = await dataUrlToBlob(a.data);
            const { data, ...meta } = a;
            meta.id = String(meta.id || newId());
            fileRecs.push({ id: meta.id, blob });
            n.attachments.push(meta);
          } catch { /* defekter Anhang – überspringen */ }
        }
        try {
          if (fileRecs.length) await dbPutFiles(fileRecs);
          await dbPutNotes([n]);
        } catch (err) {
          toast('Import abgebrochen: ' + err.message);
          renderList();
          return;
        }
        if (existing) {
          // alte Anhänge, die in der neueren Fassung fehlen, aufräumen
          const keep = new Set(n.attachments.map(a => a.id));
          const old = existing.attachments.map(a => a.id).filter(id => !keep.has(id));
          if (old.length) await dbDeleteFiles(old);
          existing.attachments.forEach(a => forgetUrl(a.id));
          updated++;
        } else {
          added++;
        }
        notes.set(n.id, n);
      }
    } else {
      // Textdatei → neue Notiz, Dateiname als Titel
      const now = Date.now();
      const n = normalize({ id: newId(), title: file.name.replace(/\.txt$/i, ''), content: text.trimEnd(), created: now, updated: now });
      await dbPutNotes([n]);
      notes.set(n.id, n);
      added++;
    }
  }

  requestPersistence();
  renderList();
  const parts = [];
  if (added) parts.push(`${added} neu`);
  if (updated) parts.push(`${updated} aktualisiert`);
  if (skipped) parts.push(`${skipped} übersprungen (schon vorhanden)`);
  toast('Import: ' + (parts.join(', ') || 'nichts gefunden'));
});

/* ======================================================================
   Navigation
   ====================================================================== */

async function route() {
  document.querySelectorAll('.menu').forEach(m => { m.hidden = true; });
  hideViewer();
  const hash = location.hash;
  const match = hash.match(/^#\/n\/(.+)$/);

  if (hash === '#/neu' || match) {
    const id = match ? decodeURIComponent(match[1]) : null;
    if (current && current.id === id) return; // schon offen (z. B. nach replaceState)
    if (id && !notes.has(id)) { location.hash = ''; return; }
    showEditor(id);
  } else {
    if (recorder) await stopRecording(true);
    if (current) await flushSave();
    current = null;
    $('#edit-view').hidden = true;
    $('#list-view').hidden = false;
    renderList();
  }
}

// Merkt sich, dass der Editor aus der Liste geöffnet wurde (für „Zurück“)
window.addEventListener('hashchange', e => {
  const oldHash = new URL(e.oldURL).hash;
  if ((!oldHash || oldHash === '#') && location.hash) history.replaceState({ fromList: true }, '');
  route();
});

/* ======================================================================
   Start
   ====================================================================== */

(async function init() {
  try {
    for (const n of await dbAllNotes()) notes.set(n.id, normalize(n));
  } catch (err) {
    toast('Speicher nicht verfügbar: ' + err.message);
  }
  await route();
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
