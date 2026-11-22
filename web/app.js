'use strict';

/* ======================================================================
   Datenmodell
   Bericht: { id, title, date (JJJJ-MM-TT), place, people, notes, created, updated, items: [Unterpunkt] }
   Unterpunkt: { id, title, text, attachments: [{ id, kind: 'photo'|'audio', type, created, duration? }] }
   Die Foto-/Audiodaten selbst liegen getrennt im Store "files" (Schlüssel = Anhang-id).
   ====================================================================== */

const APP_VERSION = '1.16 (22.11.2026)';
const DB_NAME = 'notizen';
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 3);
      req.onupgradeneeded = e => {
        const db = req.result;
        const tx = req.transaction;
        if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('reports')) {
          const reports = db.createObjectStore('reports', { keyPath: 'id' });
          // Bisherige Notizen (Version 1/2) als Berichte übernehmen
          if (e.oldVersion > 0) {
            tx.objectStore('notes').openCursor().onsuccess = ev => {
              const cur = ev.target.result;
              if (!cur) return;
              reports.put(noteToReport(cur.value));
              cur.continue();
            };
          }
        }
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

const dbAllReports = () => dbTx('reports', 'readonly', tx => tx.objectStore('reports').getAll());
const dbPutReports = list => dbTx('reports', 'readwrite', tx => list.forEach(r => tx.objectStore('reports').put(r)));
const dbGetFile = id => dbTx('files', 'readonly', tx => tx.objectStore('files').get(id));
const dbPutFiles = list => dbTx('files', 'readwrite', tx => list.forEach(f => tx.objectStore('files').put(f)));
const dbDeleteFiles = ids => dbTx('files', 'readwrite', tx => ids.forEach(id => tx.objectStore('files').delete(id)));
const dbDeleteReport = (id, fileIds) => dbTx(['reports', 'files'], 'readwrite', tx => {
  tx.objectStore('reports').delete(id);
  fileIds.forEach(f => tx.objectStore('files').delete(f));
});

/** Alle Berichte im Speicher, nach id. */
const reports = new Map();

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function isoDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const normAtts = list => Array.isArray(list)
  ? list.filter(a => a && a.id && (a.kind === 'photo' || a.kind === 'audio')).map(a => ({ ...a, id: String(a.id) }))
  : [];

function normalizeItem(i) {
  return {
    id: String(i.id || newId()),
    title: String(i.title || ''),
    text: String(i.text || ''),
    attachments: normAtts(i.attachments),
  };
}

function normalize(r) {
  const created = Number(r.created) || Date.now();
  return {
    id: String(r.id || newId()),
    title: String(r.title || ''),
    date: /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') ? r.date : isoDate(created),
    place: String(r.place || ''),
    people: String(r.people || ''),
    notes: String(r.notes || ''),
    attachments: normAtts(r.attachments),   // Fotos/Sprachnotizen direkt zu den Notizen des Berichts
    created,
    updated: Number(r.updated) || created,
    items: Array.isArray(r.items) ? r.items.map(normalizeItem) : [],
    ...(Number.isFinite(Number(r.order)) && r.order !== null && r.order !== '' ? { order: Number(r.order) } : {}),
  };
}

/** Alte Notiz (Version 1/2) → Bericht mit einem Unterpunkt */
function noteToReport(n) {
  const created = Number(n.created) || Date.now();
  return normalize({
    id: n.id,
    title: n.title || '',
    date: isoDate(created),
    notes: '',
    created,
    updated: n.updated,
    items: [{ id: newId(), title: '', text: n.content || '', attachments: n.attachments || [] }],
  });
}

const clone = r => normalize(JSON.parse(JSON.stringify(r)));
const allAttachments = r => [...(r.attachments || []), ...r.items.flatMap(i => i.attachments)];
const newItem = () => ({ id: newId(), title: '', text: '', attachments: [] });

let persistRequested = false;
function requestPersistence() {
  // Bittet den Browser, die Daten nicht automatisch zu löschen, wenn der Speicher knapp wird.
  if (persistRequested) return;
  persistRequested = true;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

async function saveReport(r) {
  r.updated = Date.now();
  requestPersistence();
  await dbPutReports([r]);
  reports.set(r.id, clone(r));
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
const longDateFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function formatStamp(ms) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Heute, ' + timeFmt.format(d);
  if (same(d, yesterday)) return 'Gestern, ' + timeFmt.format(d);
  return dateFmt.format(d) + ', ' + timeFmt.format(d);
}

const parseIso = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const formatDay = s => dateFmt.format(parseIso(s));
const formatLongDay = s => longDateFmt.format(parseIso(s));

function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}

const countOf = (r, kind) => allAttachments(r).filter(a => a.kind === kind).length;

function displayTitle(r) {
  const t = r.title.trim();
  if (t) return t;
  const first = r.items.map(i => i.title.trim() || i.text.trim().split('\n')[0].trim()).find(Boolean);
  return first || 'Bericht ohne Titel';
}

function itemLabel(item, index) {
  return `${index + 1}. ${item.title.trim() || 'Unterpunkt'}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function highlight(text, query) {
  const safe = escapeHtml(text);
  if (!query) return safe;
  const re = new RegExp(escapeHtml(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return safe.replace(re, m => `<mark>${m}</mark>`);
}

function safeFileName(name) {
  return (name.replace(/[\\/:*?"<>|\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Bericht');
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

function attachmentFileName(r, itemIndex, att, attIndex) {
  const label = att.kind === 'photo' ? 'Foto' : 'Sprachnotiz';
  const where = itemIndex < 0 ? 'Notizen' : `Punkt ${itemIndex + 1}`;
  return `${safeFileName(displayTitle(r))} - ${where} ${label} ${attIndex + 1}.${extFor(att.type)}`;
}

function reportFileName(r) {
  return `Bericht ${r.date} ${safeFileName(displayTitle(r))}.html`;
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

function autogrow(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

/* ======================================================================
   Liste
   ====================================================================== */

function matches(r, q) {
  if (!q) return true;
  const hay = [r.title, r.place, r.people, r.notes, ...r.items.flatMap(i => [i.title, i.text]),
    ...allAttachments(r).map(a => a.comment || '')].join('\n').toLowerCase();
  return hay.includes(q);
}

/** Reihenfolge der Übersicht: eigene Sortierung (order), sonst nach Datum */
const byOrder = (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) ||
  b.date.localeCompare(a.date) || b.updated - a.updated;

/** Berichte ohne Position (ältere, importierte) bekommen eine – neue/importierte oben, nach Datum. */
async function ensureOrder() {
  const all = [...reports.values()];
  const missing = all.filter(r => !Number.isFinite(r.order))
    .sort((a, b) => b.date.localeCompare(a.date) || b.updated - a.updated);
  if (!missing.length) return;
  const hasOrdered = all.some(r => Number.isFinite(r.order));
  const min = Math.min(0, ...all.filter(r => Number.isFinite(r.order)).map(r => r.order));
  missing.forEach((r, i) => { r.order = hasOrdered ? min - missing.length + i : i; });
  await dbPutReports(missing).catch(() => {});
}

const topOrder = () => Math.min(0, ...[...reports.values()].filter(r => Number.isFinite(r.order)).map(r => r.order)) - 1;

function renderList() {
  const query = $('#search').value.trim();
  const q = query.toLowerCase();
  const list = [...reports.values()]
    .filter(r => matches(r, q))
    .sort(byOrder);

  $('#reports').innerHTML = list.map(r => {
    const photo = allAttachments(r).find(a => a.kind === 'photo');
    const p = countOf(r, 'photo');
    const a = countOf(r, 'audio');
    const n = r.items.length;
    const meta = [n === 1 ? '1 Unterpunkt' : `${n} Unterpunkte`, p ? `📷 ${p}` : '', a ? `🎤 ${a}` : ''].filter(Boolean).join(' · ');
    const preview = (r.notes.trim() || r.items.map(i => i.text.trim()).find(Boolean) || '').replace(/\s+/g, ' ');
    return `<li class="note-wrap" data-id="${escapeHtml(r.id)}">
     <div class="swipe-bg" aria-hidden="true"><span>🗑 Löschen</span><span>Löschen 🗑</span></div>
     <div class="note" data-id="${escapeHtml(r.id)}" tabindex="0">
      <div class="note-row">
        <div>
          <h2>${highlight(displayTitle(r), query)}</h2>
          <time>${formatDay(r.date)}${r.place.trim() ? ` · <span class="place">📍 ${highlight(r.place.trim(), query)}</span>` : ''}</time>
          ${preview ? `<p>${highlight(preview.slice(0, 300), query)}</p>` : ''}
          <span class="badges">${meta}</span>
        </div>
        ${photo ? `<img class="note-thumb" data-file="${escapeHtml(photo.id)}" alt="">` : ''}
      </div>
     </div>
    </li>`;
  }).join('');

  document.querySelectorAll('#reports img[data-file]').forEach(async img => {
    const url = await fileUrl(img.dataset.file).catch(() => null);
    if (url) img.src = url;
  });

  const hint = $('#list-hint');
  hint.hidden = list.length === 0;
  hint.textContent = query
    ? 'Zum Löschen zur Seite wischen.'
    : 'Gedrückt halten und ziehen = verschieben · zur Seite wischen = löschen';

  const empty = $('#empty');
  empty.hidden = list.length > 0;
  empty.textContent = query
    ? 'Keine Treffer.'
    : 'Noch keine Berichte.\nTippe auf „+“, um einen anzulegen.';
}

$('#reports').addEventListener('click', e => {
  const card = e.target.closest('.note');
  if (!card) return;
  if (suppressClick) { suppressClick = false; return; } // war Wischen/Ziehen, kein Antippen
  openReport(card.dataset.id);
});

/* ---------- Gesten in der Übersicht: gedrückt halten + ziehen = verschieben, wischen = löschen ---------- */

const LONG_PRESS_MS = 450;
let gesture = null;       // { wrap, card, id, x0, y0, mode: 'pending'|'swipe'|'drag'|'scroll', timer, ... }
let suppressClick = false;

$('#reports').addEventListener('contextmenu', e => { if (e.target.closest('.note')) e.preventDefault(); });

$('#reports').addEventListener('pointerdown', e => {
  suppressClick = false; // neue Berührung → ein folgender Klick ist echtes Antippen
  const card = e.target.closest('.note');
  if (!card || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const wrap = card.closest('.note-wrap');
  gesture = { wrap, card, id: card.dataset.id, x0: e.clientX, y0: e.clientY, mode: 'pending', pid: e.pointerId };
  gesture.timer = setTimeout(() => startDrag(e.clientY), LONG_PRESS_MS);
});

function startDrag(y) {
  if (!gesture || gesture.mode !== 'pending') return;
  if ($('#search').value.trim()) {
    toast('Verschieben geht nur ohne Suchbegriff.');
    gesture.mode = 'scroll';
    suppressClick = true; // Loslassen soll den Bericht nicht öffnen
    return;
  }
  gesture.mode = 'drag';
  const rect = gesture.wrap.getBoundingClientRect();
  gesture.offset = y - rect.top;
  gesture.wrap.classList.add('dragging');
  try { gesture.card.setPointerCapture(gesture.pid); } catch { /* egal */ }
  if (navigator.vibrate) navigator.vibrate(25);
}

// Während des Ziehens das Scrollen der Seite verhindern
$('#reports').addEventListener('touchmove', e => {
  if (gesture && (gesture.mode === 'drag' || gesture.mode === 'swipe')) e.preventDefault();
}, { passive: false });

window.addEventListener('pointermove', e => {
  if (!gesture || e.pointerId !== gesture.pid) return;
  const dx = e.clientX - gesture.x0;
  const dy = e.clientY - gesture.y0;

  if (gesture.mode === 'pending') {
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      clearTimeout(gesture.timer);
      gesture.mode = 'swipe';
      gesture.wrap.classList.add('swiping');
      try { gesture.card.setPointerCapture(gesture.pid); } catch { /* egal */ }
    } else if (Math.abs(dy) > 10) {
      clearTimeout(gesture.timer);
      gesture.mode = 'scroll'; // normales Scrollen
      return;
    } else {
      return;
    }
  }

  if (gesture.mode === 'swipe') {
    gesture.dx = dx;
    gesture.card.style.transform = `translateX(${dx}px)`;
    const w = gesture.wrap.offsetWidth;
    gesture.wrap.querySelector('.swipe-bg').style.opacity = String(Math.min(1, Math.abs(dx) / (w * 0.35)));
    gesture.wrap.classList.toggle('swipe-left', dx < 0);
  } else if (gesture.mode === 'drag') {
    dragMove(e.clientY);
  }
});

function dragMove(y) {
  const wrap = gesture.wrap;
  const desiredTop = y - gesture.offset;
  wrap.style.transform = '';
  let prev = wrap.previousElementSibling;
  let next = wrap.nextElementSibling;
  // an Nachbarn vorbei → in der Liste umstellen
  while (prev && desiredTop < prev.getBoundingClientRect().top + prev.offsetHeight / 2) {
    wrap.parentNode.insertBefore(wrap, prev);
    prev = wrap.previousElementSibling;
  }
  while (next && desiredTop + wrap.offsetHeight > next.getBoundingClientRect().top + next.offsetHeight / 2) {
    wrap.parentNode.insertBefore(next, wrap);
    next = wrap.nextElementSibling;
  }
  const natural = wrap.getBoundingClientRect().top;
  wrap.style.transform = `translateY(${desiredTop - natural}px)`;
  // am Rand automatisch scrollen
  if (y < 90) window.scrollBy(0, -12);
  else if (y > window.innerHeight - 90) window.scrollBy(0, 12);
}

async function endGesture(e, cancelled) {
  if (!gesture || (e && e.pointerId !== gesture.pid)) return;
  const g = gesture;
  gesture = null;
  clearTimeout(g.timer);

  if (g.mode === 'swipe') {
    suppressClick = true;
    const w = g.wrap.offsetWidth;
    if (!cancelled && Math.abs(g.dx || 0) > w * 0.33) {
      g.card.style.transition = 'transform .18s ease-out';
      g.card.style.transform = `translateX(${(g.dx > 0 ? 1 : -1) * (w + 40)}px)`;
      g.wrap.style.transition = 'opacity .18s';
      g.wrap.style.opacity = '0';
      setTimeout(async () => { await removeReport(g.id); renderList(); }, 180);
    } else {
      g.card.style.transition = 'transform .18s ease-out';
      g.card.style.transform = '';
      setTimeout(() => { g.card.style.transition = ''; g.wrap.classList.remove('swiping', 'swipe-left'); g.wrap.querySelector('.swipe-bg').style.opacity = ''; }, 200);
    }
  } else if (g.mode === 'drag') {
    suppressClick = true;
    g.wrap.classList.remove('dragging');
    g.wrap.style.transform = '';
    await saveListOrder();
  }
}
window.addEventListener('pointerup', e => endGesture(e, false));
window.addEventListener('pointercancel', e => {
  // Browser übernimmt (z. B. Scrollen) – beim Ziehen trotzdem die neue Reihenfolge behalten
  if (gesture && gesture.mode === 'pending') { clearTimeout(gesture.timer); gesture = null; return; }
  endGesture(e, true);
});

/** Reihenfolge aus der Übersicht übernehmen und speichern (ohne „zuletzt geändert“ zu verändern). */
async function saveListOrder() {
  const ids = [...document.querySelectorAll('#reports .note-wrap')].map(li => li.dataset.id);
  const changed = [];
  ids.forEach((id, i) => {
    const r = reports.get(id);
    if (r && r.order !== i) { r.order = i; changed.push(r); }
  });
  if (changed.length) {
    try { await dbPutReports(changed); } catch (err) { toast('Reihenfolge nicht gespeichert: ' + err.message); }
  }
}

/** Löscht einen gespeicherten Bericht samt Anhängen und bietet „Rückgängig“ an. */
async function removeReport(id) {
  const removed = reports.get(id);
  if (!removed) return;
  const removedFiles = [];
  for (const a of allAttachments(removed)) {
    const rec = await dbGetFile(a.id);
    if (rec) removedFiles.push(rec);
  }
  await dbDeleteReport(removed.id, allAttachments(removed).map(a => a.id));
  reports.delete(removed.id);
  allAttachments(removed).forEach(a => forgetUrl(a.id));
  toast('Bericht gelöscht', 'Rückgängig', async () => {
    await dbPutFiles(removedFiles);
    await dbPutReports([removed]);
    reports.set(removed.id, removed);
    renderList();
  });
}
$('#reports').addEventListener('keydown', e => {
  const li = e.target.closest('.note');
  if (li && e.key === 'Enter') openReport(li.dataset.id);
});
$('#search').addEventListener('input', renderList);
$('#add-btn').addEventListener('click', () => openReport(null));

/* ======================================================================
   Bericht bearbeiten
   ====================================================================== */

let current = null;      // Bericht, der gerade bearbeitet wird (Arbeitskopie)
let saveTimer = null;
let saving = Promise.resolve();

function openReport(id) {
  location.hash = id ? '#/b/' + encodeURIComponent(id) : '#/neu';
}

function showEditor(id) {
  const existing = id && reports.get(id);
  current = existing
    ? clone(existing)
    : normalize({ id: newId(), date: isoDate(Date.now()), items: [newItem()] });

  $('#r-title').value = current.title;
  $('#r-date').value = current.date;
  $('#r-place').value = current.place;
  $('#r-people').value = current.people;
  $('#r-notes').value = current.notes;
  $('#edit-heading').textContent = existing ? 'Bericht' : 'Neuer Bericht';
  updateStamp();
  renderItems();
  renderAttachments(REPORT);
  applyHeadFold();

  $('#list-view').hidden = true;
  $('#edit-view').hidden = false;
  window.scrollTo(0, 0);
  autogrow($('#r-notes'));
  autogrow($('#r-people'));
  if (!existing) $('#r-title').focus();
}

function updateStamp() {
  $('#r-updated').textContent = reports.has(current.id) ? 'Zuletzt geändert: ' + formatStamp(current.updated) : '';
}

/** Besitzer von Anhängen: ein Unterpunkt (id) oder die Notizen des Berichts (REPORT) */
const REPORT = '__report';
const findItem = id => (id === REPORT ? current : current.items.find(i => i.id === id));
const itemEl = id => (id === REPORT ? $('#report-head') : document.querySelector(`.item[data-id="${CSS.escape(id)}"]`));

function renderItems() {
  $('#items').innerHTML = current.items.map((item, idx) => `
    <section class="item" data-id="${escapeHtml(item.id)}">
      <div class="item-head">
        <button type="button" class="fold-btn" aria-label="Unterpunkt ${idx + 1} ein-/ausklappen">▾</button>
        <span class="num">${idx + 1}</span>
        <input class="item-title" placeholder="Unterpunkt ${idx + 1}" autocomplete="off" enterkeyhint="next">
        <button type="button" class="item-menu-btn" aria-label="Aktionen für Unterpunkt ${idx + 1}">⋮</button>
      </div>
      <div class="item-summary"></div>
      <div class="item-body">
        <textarea class="item-text autogrow" rows="2" placeholder="Text …"></textarea>
        <div class="photos" hidden></div>
        <div class="audios" hidden></div>
        <div class="item-tools">
          <button type="button" class="tool-btn" data-act="camera"><span aria-hidden="true">📷</span> Foto</button>
          <button type="button" class="tool-btn" data-act="gallery"><span aria-hidden="true">🖼</span> Galerie</button>
          <button type="button" class="tool-btn" data-act="record"><span aria-hidden="true">🎤</span> Sprache</button>
        </div>
      </div>
    </section>`).join('');

  current.items.forEach(item => {
    const el = itemEl(item.id);
    el.querySelector('.item-title').value = item.title;
    const ta = el.querySelector('.item-text');
    ta.value = item.text;
    renderAttachments(item.id);
    applyFold(item.id);
    requestAnimationFrame(() => autogrow(ta));
  });
  updateFoldAll();
  if (recorder && recTarget) {
    const el = itemEl(recTarget);
    if (el) el.classList.add('recording-target');
  }
}

function renderAttachments(itemId) {
  const item = findItem(itemId);
  const el = itemEl(itemId);
  if (!item || !el) return;
  const photos = item.attachments.filter(a => a.kind === 'photo');
  const audios = item.attachments.filter(a => a.kind === 'audio');

  const photoBox = el.querySelector('.photos');
  photoBox.hidden = photos.length === 0;
  photoBox.innerHTML = photos.map(a => `<div class="photo">
      <button type="button" data-file="${escapeHtml(a.id)}" aria-label="Foto öffnen"><img alt=""></button>
      ${(a.comment || '').trim() ? `<span class="cap" data-file="${escapeHtml(a.id)}">💬 ${escapeHtml(a.comment.trim())}</span>` : ''}
    </div>`).join('');
  photoBox.querySelectorAll('button').forEach(async btn => {
    const url = await fileUrl(btn.dataset.file).catch(() => null);
    if (url) btn.querySelector('img').src = url;
  });

  const audioBox = el.querySelector('.audios');
  audioBox.hidden = audios.length === 0;
  audioBox.innerHTML = audios.map(a =>
    `<div class="audio" data-file="${escapeHtml(a.id)}">
      <audio controls preload="metadata"></audio>
      ${a.duration ? `<span class="len">${formatDuration(a.duration)}</span>` : ''}
      <button type="button" class="del" aria-label="Sprachnotiz löschen" title="Löschen">🗑</button>
    </div>`).join('');
  audioBox.querySelectorAll('.audio').forEach(async row => {
    const url = await fileUrl(row.dataset.file).catch(() => null);
    if (url) fixDuration(row.querySelector('audio')).src = url;
  });
  updateSummary(itemId);
}

/* ---------- Ein-/Ausklappen (Zustand bleibt auf diesem Gerät gespeichert) ---------- */

const FOLD_KEY = 'collapsedItems';
let collapsed;
try { collapsed = new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')); } catch { collapsed = new Set(); }
function saveFold() {
  try { localStorage.setItem(FOLD_KEY, JSON.stringify([...collapsed].slice(-2000))); } catch { /* egal */ }
}

function updateSummary(itemId) {
  const item = findItem(itemId);
  const el = itemEl(itemId);
  if (!item || !el || !el.querySelector('.item-summary')) return;
  const p = item.attachments.filter(a => a.kind === 'photo').length;
  const a = item.attachments.filter(a => a.kind === 'audio').length;
  const text = item.text.trim().replace(/\s+/g, ' ');
  const parts = [p ? `📷 ${p}` : '', a ? `🎤 ${a}` : '', text].filter(Boolean);
  el.querySelector('.item-summary').textContent = parts.join(' · ') || 'leer – antippen zum Öffnen';
}

function applyFold(itemId) {
  const el = itemEl(itemId);
  if (!el) return;
  const isCollapsed = collapsed.has(itemId);
  el.classList.toggle('collapsed', isCollapsed);
  el.querySelector('.fold-btn').setAttribute('aria-expanded', String(!isCollapsed));
  if (!isCollapsed) autogrow(el.querySelector('.item-text'));
}

/* Titelbereich des Berichts (Zustand pro Bericht auf dem Gerät gespeichert) */
const headKey = () => 'head:' + current.id;

function updateHeadSummary() {
  if (!current) return;
  const notes = current.notes.trim().replace(/\s+/g, ' ');
  const p = countOf(current, 'photo') - current.items.reduce((n, i) => n + i.attachments.filter(a => a.kind === 'photo').length, 0);
  const parts = [
    current.date ? formatDay(current.date) : '',
    current.place.trim() ? '📍 ' + current.place.trim() : '',
    current.people.trim() ? '👥 ' + current.people.trim().replace(/\s*\n+\s*/g, ', ') : '',
    p > 0 ? `📷 ${p}` : '',
    notes,
  ].filter(Boolean);
  $('#head-summary').textContent = parts.join(' · ');
}

function applyHeadFold() {
  const isCollapsed = collapsed.has(headKey());
  $('#report-head').classList.toggle('collapsed', isCollapsed);
  $('#head-fold').setAttribute('aria-expanded', String(!isCollapsed));
  updateHeadSummary();
  if (!isCollapsed) { autogrow($('#r-notes')); autogrow($('#r-people')); }
}

function setHeadFold(collapse) {
  if (collapse) collapsed.add(headKey()); else collapsed.delete(headKey());
  saveFold();
  applyHeadFold();
}

$('#head-fold').addEventListener('click', () => setHeadFold(!collapsed.has(headKey())));
$('#head-summary').addEventListener('click', () => setHeadFold(false));

function setFold(itemId, collapse) {
  if (collapse) collapsed.add(itemId); else collapsed.delete(itemId);
  saveFold();
  applyFold(itemId);
  updateFoldAll();
}

/** Überschrift „Unterpunkte“: Pfeil und Anzahl aktualisieren */
function updateFoldAll() {
  if (!current) return;
  const n = current.items.length;
  const allCollapsed = n > 0 && current.items.every(i => collapsed.has(i.id));
  const btn = $('#fold-all');
  btn.setAttribute('aria-expanded', String(!allCollapsed));
  btn.title = allCollapsed ? 'Alle Unterpunkte ausklappen' : 'Alle Unterpunkte einklappen';
  $('#item-count').textContent = n ? `(${n})` : '';
}

function setFoldAll(collapse) {
  current.items.forEach(i => { if (collapse) collapsed.add(i.id); else collapsed.delete(i.id); });
  saveFold();
  current.items.forEach(i => applyFold(i.id));
  updateFoldAll();
}

$('.section-title').addEventListener('click', () => {
  if (!current || !current.items.length) return;
  // Ist mindestens einer offen → alle einklappen, sonst alle ausklappen
  setFoldAll(current.items.some(i => !collapsed.has(i.id)));
});

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

function isEmptyReport(r) {
  return !r.title.trim() && !r.notes.trim() && !r.place.trim() && !r.people.trim() && r.attachments.length === 0 &&
    r.items.every(i => !i.title.trim() && !i.text.trim() && i.attachments.length === 0);
}

/** Speichert die Arbeitskopie (force = auch ohne Textänderung, z. B. nach Anhängen/Umsortieren). */
function flushSave(force = false) {
  clearTimeout(saveTimer);
  saveTimer = null;
  saving = saving.then(() => doSave(force)).catch(err => toast('Speichern fehlgeschlagen: ' + err.message));
  return saving;
}

let dirty = false;

async function doSave(force) {
  if (!current) return;
  const stored = reports.has(current.id);
  if (!stored && isEmptyReport(current)) return; // leeren neuen Bericht nicht speichern
  if (!force && !dirty && stored) return;
  dirty = false;
  if (!stored && !Number.isFinite(current.order)) current.order = topOrder(); // neuer Bericht oben
  await saveReport(current);
  current.updated = reports.get(current.id).updated;
  $('#edit-heading').textContent = 'Bericht';
  updateStamp();
  // Neuer Bericht hat jetzt eine feste Adresse (ohne zusätzlichen Verlaufseintrag)
  if (location.hash === '#/neu') history.replaceState(history.state, '', '#/b/' + encodeURIComponent(current.id));
}

function scheduleSave() {
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flushSave(), 400);
}

$('#r-title').addEventListener('input', e => { current.title = e.target.value; scheduleSave(); });
$('#r-date').addEventListener('change', e => {
  if (!e.target.value) { e.target.value = current.date; return; }
  current.date = e.target.value;
  scheduleSave();
});
$('#r-place').addEventListener('input', e => { current.place = e.target.value; scheduleSave(); });
$('#r-place').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#r-people').focus(); }
});
$('#r-people').addEventListener('input', e => { current.people = e.target.value; autogrow(e.target); scheduleSave(); });
$('#r-notes').addEventListener('input', e => { current.notes = e.target.value; autogrow(e.target); scheduleSave(); });
$('#r-title').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#r-notes').focus(); }
});

$('#items').addEventListener('input', e => {
  const el = e.target.closest('.item');
  if (!el) return;
  const item = findItem(el.dataset.id);
  if (e.target.classList.contains('item-title')) item.title = e.target.value;
  if (e.target.classList.contains('item-text')) { item.text = e.target.value; autogrow(e.target); updateSummary(item.id); }
  scheduleSave();
});
$('#items').addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('item-title')) {
    e.preventDefault();
    e.target.closest('.item').querySelector('.item-text').focus();
  }
});

$('#add-item').addEventListener('click', () => {
  const item = newItem();
  current.items.push(item);
  collapsed.delete(item.id);
  renderItems();
  dirty = true;
  flushSave(true);
  const el = itemEl(item.id);
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.querySelector('.item-title').focus();
});

/* ---------- Unterpunkt-Menü ---------- */

let menuItemId = null;

$('#edit-view .editor').addEventListener('click', async e => {
  const el = e.target.closest('.item, .report-head');
  if (!el) return;
  const id = el.dataset.id;

  if (e.target.closest('.fold-btn')) {
    if (id === REPORT) return; // Titelbereich hat einen eigenen Handler
    setFold(id, !collapsed.has(id));
    return;
  }
  if (e.target.closest('.item-summary')) {
    setFold(id, false);
    el.querySelector('.item-text').focus();
    return;
  }

  if (e.target.closest('.item-menu-btn')) {
    e.stopPropagation();
    menuItemId = id;
    const idx = current.items.findIndex(i => i.id === id);
    const menu = $('#item-menu');
    menu.querySelector('[data-action="item-up"]').hidden = idx === 0;
    menu.querySelector('[data-action="item-down"]').hidden = idx === current.items.length - 1;
    const rect = e.target.closest('.item-menu-btn').getBoundingClientRect();
    toggleMenu(menu, true);
    const top = Math.min(rect.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
    menu.style.top = Math.max(8, top) + 'px';
    return;
  }

  const act = e.target.closest('[data-act]');
  if (act && (act.dataset.act === 'camera' || act.dataset.act === 'gallery')) {
    // „Foto“ öffnet direkt die Kamera, „Galerie“ die Bildauswahl (mehrere möglich)
    photoTarget = id;
    const input = act.dataset.act === 'camera' ? $('#camera-file') : $('#photo-file');
    input.value = '';
    input.click();
    return;
  }
  if (act && act.dataset.act === 'record') {
    startRecording(id);
    return;
  }

  const photoBtn = e.target.closest('.photos [data-file]');
  if (photoBtn) {
    openViewer(id, photoBtn.dataset.file);
    return;
  }

  const del = e.target.closest('.audio .del');
  if (del) {
    if (!confirm('Diese Sprachnotiz löschen?')) return;
    await removeAttachment(id, del.closest('.audio').dataset.file);
    toast('Sprachnotiz gelöscht');
  }
});

function moveItem(id, delta) {
  const idx = current.items.findIndex(i => i.id === id);
  const to = idx + delta;
  if (idx < 0 || to < 0 || to >= current.items.length) return;
  const [item] = current.items.splice(idx, 1);
  current.items.splice(to, 0, item);
  renderItems();
  flushSave(true);
  itemEl(id).scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteItem(id) {
  const idx = current.items.findIndex(i => i.id === id);
  const item = current.items[idx];
  if (!item) return;
  const hasContent = item.title.trim() || item.text.trim() || item.attachments.length;
  if (hasContent && !confirm(`Unterpunkt ${idx + 1} mit allen Fotos und Sprachnotizen löschen?`)) return;
  if (recorder && recTarget === id) await stopRecording(false);
  current.items.splice(idx, 1);
  renderItems();
  await flushSave(true);
  const ids = item.attachments.map(a => a.id);
  if (ids.length) await dbDeleteFiles(ids);
  ids.forEach(forgetUrl);
  toast('Unterpunkt gelöscht');
}

/* ---------- Anhänge ---------- */

async function addAttachments(itemId, list) {
  // list: [{ kind, blob, duration? }]
  const item = current && findItem(itemId);
  if (!item) return false;
  const metas = list.map(it => ({
    id: newId(),
    kind: it.kind,
    type: it.blob.type || (it.kind === 'photo' ? 'image/jpeg' : 'audio/webm'),
    created: Date.now(),
    ...(it.duration ? { duration: it.duration } : {}),
  }));
  try {
    await dbPutFiles(metas.map((m, i) => ({ id: m.id, blob: list[i].blob })));
  } catch (err) {
    toast('Anhang konnte nicht gespeichert werden: ' + err.message);
    return false;
  }
  item.attachments.push(...metas);
  renderAttachments(itemId);
  await flushSave(true);
  return true;
}

async function removeAttachment(itemId, fileId) {
  const item = findItem(itemId);
  if (!item) return;
  item.attachments = item.attachments.filter(a => a.id !== fileId);
  await flushSave(true);
  await dbDeleteFiles([fileId]);
  forgetUrl(fileId);
  renderAttachments(itemId);
}

/* ---------- Fotos ---------- */

const MAX_PHOTO_SIDE = 1920;
let photoTarget = null;

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

async function onPhotosChosen(e) {
  const files = [...e.target.files].filter(f => f.type.startsWith('image/') || !f.type);
  const target = photoTarget;
  if (!files.length || !current || !target) return;
  toast(files.length === 1 ? 'Foto wird gespeichert …' : `${files.length} Fotos werden gespeichert …`);
  const list = [];
  for (const f of files) list.push({ kind: 'photo', blob: await shrinkPhoto(f) });
  if (await addAttachments(target, list)) {
    toast(files.length === 1 ? 'Foto hinzugefügt' : `${files.length} Fotos hinzugefügt`);
  }
}
$('#photo-file').addEventListener('change', onPhotosChosen);
$('#camera-file').addEventListener('change', onPhotosChosen);

let viewer = null; // { itemId, fileId }

const viewerAtt = () => {
  const item = viewer && findItem(viewer.itemId);
  return item ? item.attachments.find(a => a.id === viewer.fileId) : null;
};

async function openViewer(itemId, fileId) {
  viewer = { itemId, fileId, changed: false };
  const att = viewerAtt();
  $('#viewer-comment').value = (att && att.comment) || '';
  $('#viewer-img').src = (await fileUrl(fileId)) || '';
  $('#viewer').hidden = false;
  autogrow($('#viewer-comment')); // erst nach dem Einblenden messen, sonst wird das Feld zu flach
  history.pushState({ ...(history.state || {}), viewer: true }, ''); // Zurück-Taste schließt die Ansicht
}

function hideViewer() {
  const v = viewer;
  $('#viewer').hidden = true;
  $('#viewer-img').removeAttribute('src');
  $('#viewer-comment').blur();
  viewer = null;
  if (v && v.changed && current) {
    renderAttachments(v.itemId);   // Kommentar unter dem Vorschaubild aktualisieren
    flushSave(true);
  }
}

$('#viewer-comment').addEventListener('input', e => {
  const att = viewerAtt();
  if (!att) return;
  att.comment = e.target.value;
  viewer.changed = true;
  autogrow(e.target);
  scheduleSave();
});
function closeViewer() {
  if ($('#viewer').hidden) return;
  if (history.state && history.state.viewer) history.back(); // löst popstate → hideViewer aus
  else hideViewer();
}
window.addEventListener('popstate', () => { if (!$('#viewer').hidden) hideViewer(); });

$('#viewer-close').addEventListener('click', closeViewer);
$('#viewer-img').addEventListener('click', closeViewer);

async function viewerFile() {
  if (!viewer) return null;
  const itemIndex = current.items.findIndex(i => i.id === viewer.itemId);
  const item = findItem(viewer.itemId);
  if (!item) return null;
  const photos = item.attachments.filter(a => a.kind === 'photo');
  const att = photos.find(a => a.id === viewer.fileId);
  const rec = await dbGetFile(viewer.fileId);
  if (!rec || !att) return null;
  const name = attachmentFileName(current, itemIndex, att, photos.indexOf(att));
  return new File([rec.blob], name, { type: rec.blob.type });
}

$('#viewer-share').addEventListener('click', async () => {
  const file = await viewerFile();
  const att = viewerAtt();
  if (file) await shareFiles([file], '', ((att && att.comment) || '').trim());
});

$('#viewer-save').addEventListener('click', async () => {
  const file = await viewerFile();
  if (!file) return;
  downloadBlob(file.name, file);
  toast('Foto gespeichert (Ordner „Downloads“)');
});

$('#viewer-delete').addEventListener('click', async () => {
  if (!viewer || !confirm('Dieses Foto löschen?')) return;
  const { itemId, fileId } = viewer;
  closeViewer();
  await removeAttachment(itemId, fileId);
  toast('Foto gelöscht');
});

/* ---------- Sprachnotizen ---------- */

let recorder = null;
let recTarget = null;
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

async function startRecording(itemId) {
  if (recorder) return toast('Es läuft schon eine Aufnahme.');
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
  recTarget = itemId;
  recChunks = [];
  recDiscard = false;
  recorder.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const duration = (Date.now() - recStart) / 1000;
    const blob = new Blob(recChunks, { type: recorder.mimeType || type || 'audio/webm' });
    const target = recTarget;
    recorder = null;
    recTarget = null;
    clearInterval(recTimer);
    $('#recording').hidden = true;
    document.querySelectorAll('.recording-target').forEach(el => el.classList.remove('recording-target'));
    if (!recDiscard && blob.size > 0 && current && findItem(target)) {
      if (await addAttachments(target, [{ kind: 'audio', blob, duration }])) {
        toast('Sprachnotiz gespeichert (' + formatDuration(duration) + ')');
      }
    }
    const done = recDone;
    recDone = null;
    if (done) done();
  };
  recorder.start(1000);
  recStart = Date.now();
  const idx = current.items.findIndex(i => i.id === itemId);
  $('#rec-label').textContent = 'Aufnahme für ' + (itemId === REPORT ? 'Notizen' : itemLabel(current.items[idx], idx));
  $('#rec-time').textContent = '0:00';
  $('#recording').hidden = false;
  if (itemId !== REPORT) setFold(itemId, false);
  itemEl(itemId).classList.add('recording-target');
  recTimer = setInterval(() => {
    const sec = (Date.now() - recStart) / 1000;
    $('#rec-time').textContent = formatDuration(sec);
    if (sec >= MAX_RECORD_SECONDS) stopRecording(true);
  }, 250);
}

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

/* ---------- Schließen / Verlassen ---------- */

async function closeEditor() {
  if (recorder) await stopRecording(true);
  await flushSave();
  // Zurück zur Liste – über den Verlauf, damit die Zurück-Taste von Android passt
  if (history.state && history.state.fromList) history.back();
  else location.hash = '';
}

$('#back-btn').addEventListener('click', closeEditor);

// Beim Verlassen oder Wechseln der App sofort speichern
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) return;
  if (recorder) stopRecording(true);
  flushSave();
});
window.addEventListener('pagehide', () => flushSave());

/* ======================================================================
   Export eines ganzen Berichts (eine HTML-Datei mit eingebetteten Fotos/Audio)
   ====================================================================== */

/** Fotos und Sprachnotizen als HTML (Daten eingebettet) */
async function mediaHtml(attachments, forPrint) {
  const photos = [];
  const audios = [];
  for (const a of attachments) {
    const rec = await dbGetFile(a.id);
    if (!rec) continue;
    const data = await blobToDataUrl(rec.blob);
    if (a.kind === 'photo') {
      const cap = (a.comment || '').trim();
      photos.push(`<figure><img src="${data}" alt="${cap ? escapeHtml(cap) : 'Foto'}">` +
        (cap ? `<figcaption>${escapeHtml(cap)}</figcaption>` : '') + '</figure>');
    }
    else {
      const len = a.duration ? ` (${formatDuration(a.duration)})` : '';
      audios.push(`<div class="audio"><span>🎤 Sprachnotiz ${audios.length + 1}${len}</span>` +
        (forPrint ? '' : `<audio controls src="${data}"></audio>`) + '</div>');
    }
  }
  return (photos.length ? `<div class="photos">${photos.join('')}</div>` : '') + audios.join('');
}

async function buildReportHtml(r, { forPrint = false } = {}) {
  const parts = [];
  const headMedia = await mediaHtml(r.attachments, forPrint);
  for (const [idx, item] of r.items.entries()) {
    const title = item.title.trim() || `Unterpunkt ${idx + 1}`;
    parts.push(`<section class="item">
      <h2><span class="num">${idx + 1}</span> ${escapeHtml(title)}</h2>
      ${item.text.trim() ? `<div class="text">${escapeHtml(item.text.trim())}</div>` : ''}
      ${await mediaHtml(item.attachments, forPrint)}
    </section>`);
  }

  const title = displayTitle(r);
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} – ${formatDay(r.date)}${r.place.trim() ? ' – ' + escapeHtml(r.place.trim()) : ''}</title>
<style>
  body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #1c1c22; margin: 0; background: #fff; }
  main { max-width: 820px; margin: 0 auto; padding: 24px 20px 40px; }
  header { border-bottom: 3px solid #3949ab; padding-bottom: 12px; margin-bottom: 18px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .date { color: #555; }
  .head-media { margin: 0 0 20px; }
  .people { margin: 0 0 14px; }
  .notes { white-space: pre-wrap; background: #f3f4fa; border-left: 4px solid #3949ab; padding: 10px 14px; margin: 0 0 20px; border-radius: 4px; }
  .item { margin: 0 0 22px; padding-bottom: 16px; border-bottom: 1px solid #ddd; break-inside: avoid-page; }
  .item:last-of-type { border-bottom: 0; }
  h2 { font-size: 18px; margin: 0 0 8px; display: flex; align-items: center; gap: 10px; }
  .num { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 50%; background: #3949ab; color: #fff; font-size: 14px; flex: none; }
  .text { white-space: pre-wrap; margin: 0 0 10px; }
  .photos { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 0 0 10px; }
  figure { margin: 0; break-inside: avoid; }
  figure img { width: 100%; height: auto; display: block; border-radius: 4px; }
  figcaption { font-size: 13px; color: #444; margin-top: 4px; white-space: pre-wrap; }
  .audio { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 4px 0; color: #444; }
  .audio audio { max-width: 100%; }
  footer { color: #888; font-size: 12px; margin-top: 24px; }
  @media print {
    main { padding: 0; max-width: none; }
    .item { break-inside: auto; }
    h2 { break-after: avoid; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <div class="date">${formatLongDay(r.date)}${r.place.trim() ? ` · 📍 ${escapeHtml(r.place.trim())}` : ''}</div>
  </header>
  ${r.people.trim() ? `<div class="people"><strong>Teilnehmer:</strong> ${escapeHtml(r.people.trim().replace(/\s*\n+\s*/g, ', '))}</div>` : ''}
  ${r.notes.trim() ? `<div class="notes">${escapeHtml(r.notes.trim())}</div>` : ''}
  ${headMedia ? `<div class="head-media">${headMedia}</div>` : ''}
  ${parts.join('\n')}
  <footer>Erstellt am ${dateFmt.format(new Date())}, ${timeFmt.format(new Date())} · ${r.items.length} Unterpunkt${r.items.length === 1 ? '' : 'e'}</footer>
</main>
${forPrint ? '<script>window.addEventListener("load", () => setTimeout(() => window.print(), 300));<\/script>' : ''}
</body>
</html>`;
}

async function reportFile(r) {
  const html = await buildReportHtml(r);
  return new File([html], reportFileName(r), { type: 'text/html' });
}

async function shareFiles(files, title, text) {
  const data = { title: title || undefined, text: text || undefined };
  if (files.length && navigator.canShare && navigator.canShare({ files })) {
    data.files = files;
  } else if (files.length) {
    // Teilen von Dateien geht hier nicht → Datei speichern
    files.forEach(f => downloadBlob(f.name, f));
    toast('Teilen nicht möglich – Datei wurde gespeichert (Ordner „Downloads“)');
    return;
  }
  if (!navigator.share) return toast('Teilen wird von diesem Browser nicht unterstützt.');
  try {
    await navigator.share(data);
  } catch (err) {
    if (err.name !== 'AbortError') toast('Teilen nicht möglich: ' + err.message);
  }
}

async function shareReport() {
  await flushSave();
  if (isEmptyReport(current)) return toast('Der Bericht ist leer.');
  toast('Bericht wird erstellt …');
  const file = await reportFile(current);
  await shareFiles([file], displayTitle(current), `Bericht: ${displayTitle(current)} (${formatDay(current.date)})`);
}

$('#share-btn').addEventListener('click', shareReport);

/* ======================================================================
   Menüs
   ====================================================================== */

function toggleMenu(menu, show) {
  document.querySelectorAll('.menu').forEach(m => { if (m !== menu) m.hidden = true; });
  menu.hidden = show === undefined ? !menu.hidden : !show;
  if (menu !== $('#item-menu')) menu.style.top = '';
}

$('#menu-btn').addEventListener('click', async e => {
  e.stopPropagation();
  const last = localStorage.getItem('lastBackup');
  const info = 'Letzte Sicherung: ' + (last ? formatStamp(Number(last)) : 'noch nie') + '\nBerichte: ' + reports.size +
    '\nApp-Version ' + APP_VERSION;
  toggleMenu($('#main-menu'));
  $('#backup-info').textContent = info;
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage } = await navigator.storage.estimate();
      if (usage) $('#backup-info').textContent = info + '\nBelegt: ' + (usage / 1048576).toFixed(1).replace('.', ',') + ' MB';
    } catch { /* egal */ }
  }
});
$('#report-menu-btn').addEventListener('click', e => {
  e.stopPropagation();
  toggleMenu($('#report-menu'));
});
document.addEventListener('click', e => {
  if (!e.target.closest('.menu')) document.querySelectorAll('.menu').forEach(m => { m.hidden = true; });
});
window.addEventListener('scroll', () => { $('#item-menu').hidden = true; }, { passive: true });

document.querySelectorAll('.menu').forEach(menu => menu.addEventListener('click', e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  menu.hidden = true;
  actions[btn.dataset.action]();
}));

const actions = {
  async 'export-all'() {
    toast('Sicherung wird erstellt …');
    const { json, base, count, missing } = await buildBackup();
    const where = await saveWithChoice(json, base, count, missing);
    if (!where) return;
    backupDone(count, missing, where);
  },

  'onedrive-setup'() { openOneDriveSetup(); },

  import() {
    $('#import-file').value = '';
    $('#import-file').click();
  },

  async 'export-html'() {
    await flushSave();
    if (isEmptyReport(current)) return toast('Der Bericht ist leer.');
    toast('Bericht wird erstellt …');
    const file = await reportFile(current);
    downloadBlob(file.name, file);
    toast('Bericht gespeichert (Ordner „Downloads“)');
  },

  'share-report': shareReport,

  async print() {
    await flushSave();
    if (isEmptyReport(current)) return toast('Der Bericht ist leer.');
    const win = window.open('', '_blank'); // sofort öffnen, sonst blockiert der Browser das Fenster
    const html = await buildReportHtml(current, { forPrint: true });
    if (!win) {
      toast('Druckansicht wurde blockiert – bitte Pop-ups erlauben.');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  },

  async 'delete-report'() {
    if (!confirm('Diesen Bericht mit allen Unterpunkten, Fotos und Sprachnotizen löschen?')) return;
    if (recorder) await stopRecording(false);
    clearTimeout(saveTimer);
    await saving;
    const id = current.id;
    const stored = reports.has(id);
    if (!stored && allAttachments(current).length) await dbDeleteFiles(allAttachments(current).map(a => a.id));
    current = null;
    if (stored) await removeReport(id);
    await closeEditor();
  },

  'item-up'() { moveItem(menuItemId, -1); },
  'item-down'() { moveItem(menuItemId, 1); },
  'item-delete'() { deleteItem(menuItemId); },
};

/* ---------- Sicherung erstellen ---------- */

async function buildBackup() {
  const list = [...reports.values()].sort(byOrder);
  const out = [];
  let missing = 0;
  const withData = async atts => {
    const res = [];
    for (const a of atts) {
      const rec = await dbGetFile(a.id);
      if (rec) res.push({ ...a, data: await blobToDataUrl(rec.blob) });
      else missing++;
    }
    return res;
  };
  for (const r of list) {
    const items = [];
    for (const item of r.items) items.push({ ...item, attachments: await withData(item.attachments) });
    out.push({ ...r, attachments: await withData(r.attachments), items });
  }
  const data = { app: 'berichte', version: 3, exported: new Date().toISOString(), reports: out };
  const now = new Date();
  const stamp = `${isoDate(now)}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
  return { json: JSON.stringify(data), base: `berichte-sicherung-${stamp}`, count: list.length, missing };
}

function backupDone(count, missing, where) {
  localStorage.setItem('lastBackup', String(Date.now()));
  toast(`${count} ${count === 1 ? 'Bericht' : 'Berichte'} gesichert (${where})` + (missing ? ` – ${missing} Anhänge fehlten` : ''));
}

/* ---------- Sicherung: fragen, wo sie gespeichert werden soll ---------- */

/**
 * Zeigt die Auswahl (Speicherort wählen / Teilen / Downloads) und speichert dort.
 * Gibt eine Beschreibung des Ziels zurück oder null bei Abbruch.
 * Hinweis: Android lässt beim Teilen keine .json-Dateien zu – dort wird die Sicherung als .txt geteilt
 * (der Import erkennt Sicherungen am Inhalt).
 */
async function saveWithChoice(json, base, count, missing) {
  const jsonFile = new File([json], base + '.json', { type: 'application/json' });
  const txtFile = new File([json], base + '.txt', { type: 'text/plain' });
  const canPick = typeof window.showSaveFilePicker === 'function';
  const canShare = !!(navigator.canShare && navigator.share && navigator.canShare({ files: [txtFile] }));

  const dlg = $('#save-dialog');
  const bytes = jsonFile.size;
  const size = bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1048576).toFixed(1).replace('.', ',') + ' MB';
  $('#save-info').textContent = `${count} Bericht${count === 1 ? '' : 'e'}, ${size} – wohin soll die Sicherung?`;
  dlg.querySelector('[data-save="picker"]').hidden = !canPick;
  dlg.querySelector('[data-save="share"]').hidden = !canShare;

  for (;;) {
    const choice = await new Promise(resolve => {
      const onClick = e => {
        const b = e.target.closest('button[data-save]');
        if (!b) return;
        cleanup();
        resolve(b.dataset.save);
      };
      const onCancel = () => { cleanup(); resolve('cancel'); };
      const cleanup = () => {
        dlg.removeEventListener('click', onClick);
        dlg.removeEventListener('cancel', onCancel);
        if (dlg.open) dlg.close();
      };
      dlg.addEventListener('click', onClick);
      dlg.addEventListener('cancel', onCancel);
      dlg.showModal();
    });

    try {
      if (choice === 'cancel') return null;
      if (choice === 'onedrive') {
        const res = await oneDriveBackup(jsonFile);
        if (res === 'redirect' || res === 'setup') return null; // geht nach der Anmeldung automatisch weiter
        return res;
      }
      if (choice === 'download') {
        downloadBlob(jsonFile.name, jsonFile);
        return 'Ordner „Downloads“';
      }
      if (choice === 'picker') {
        const handle = await window.showSaveFilePicker({
          suggestedName: jsonFile.name,
          types: [{ description: 'Berichte-Sicherung', accept: { 'application/json': ['.json'] } }],
        });
        const w = await handle.createWritable();
        await w.write(jsonFile);
        await w.close();
        return '„' + handle.name + '“';
      }
      if (choice === 'share') {
        await navigator.share({ files: [txtFile], title: 'Berichte-Sicherung' });
        return 'geteilt als „' + txtFile.name + '“';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') continue; // Auswahl abgebrochen → nochmal fragen
      toast('Speichern nicht möglich: ' + (err && err.message ? err.message : err));
    }
  }
}

/* ======================================================================
   OneDrive (Microsoft Graph) – Anmeldung per OAuth 2.0 mit PKCE, ohne Zusatzbibliothek
   ====================================================================== */

const OD_SCOPES = 'Files.ReadWrite offline_access';
const odCfg = () => {
  try { return JSON.parse(localStorage.getItem('odConfig') || '{}'); } catch { return {}; }
};
const odRedirect = () => location.origin + location.pathname;   // z. B. https://gt4371.github.io/MyNotes/
const odAuthority = () => `https://login.microsoftonline.com/${encodeURIComponent((odCfg().tenant || 'common').trim())}/oauth2/v2.0`;
const odFolder = () => (odCfg().folder || 'Berichte-Sicherungen').replace(/^[/\s]+|[/\s]+$/g, '') || 'Berichte-Sicherungen';

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(n = 48) {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

function odTokens() {
  try { return JSON.parse(localStorage.getItem('odTokens') || 'null'); } catch { return null; }
}
function odSaveTokens(t) {
  const prev = odTokens() || {};
  localStorage.setItem('odTokens', JSON.stringify({
    access: t.access_token,
    refresh: t.refresh_token || prev.refresh,
    expires: Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60000,
  }));
}

/** Leitet zur Microsoft-Anmeldung weiter; nach der Rückkehr läuft die Sicherung automatisch weiter. */
async function odLogin() {
  const verifier = randomString(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomString(16);
  sessionStorage.setItem('odAuth', JSON.stringify({ verifier, state }));
  localStorage.setItem('odPending', String(Date.now()));
  const params = new URLSearchParams({
    client_id: odCfg().clientId.trim(),
    response_type: 'code',
    redirect_uri: odRedirect(),
    response_mode: 'query',
    scope: OD_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  location.assign(`${odAuthority()}/authorize?${params}`);
}

async function odTokenRequest(body) {
  const res = await fetch(`${odAuthority()}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: odCfg().clientId.trim(), scope: OD_SCOPES, ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ? data.error_description.split('\r\n')[0] : 'Anmeldung fehlgeschlagen (' + res.status + ')');
  }
  odSaveTokens(data);
  return data.access_token;
}

/** Gültiges Zugriffstoken oder null (dann ist eine neue Anmeldung nötig). */
async function odAccessToken() {
  const t = odTokens();
  if (!t) return null;
  if (t.access && t.expires > Date.now()) return t.access;
  if (!t.refresh) return null;
  try {
    return await odTokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, redirect_uri: odRedirect() });
  } catch {
    localStorage.removeItem('odTokens');
    return null;
  }
}

/** Rückkehr von der Microsoft-Anmeldung (…?code=…&state=…) verarbeiten. */
async function odHandleRedirect() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  const saved = JSON.parse(sessionStorage.getItem('odAuth') || 'null');
  sessionStorage.removeItem('odAuth');
  history.replaceState(history.state, '', odRedirect() + location.hash); // Code aus der Adresse entfernen
  if (q.has('error')) {
    localStorage.removeItem('odPending');
    toast('OneDrive-Anmeldung abgebrochen: ' + (q.get('error_description') || q.get('error')).split('\n')[0]);
    return true;
  }
  if (!saved || saved.state !== q.get('state')) {
    localStorage.removeItem('odPending');
    toast('OneDrive-Anmeldung ungültig – bitte nochmal versuchen.');
    return true;
  }
  try {
    await odTokenRequest({ grant_type: 'authorization_code', code: q.get('code'), code_verifier: saved.verifier, redirect_uri: odRedirect() });
  } catch (err) {
    localStorage.removeItem('odPending');
    toast('OneDrive: ' + err.message);
    return true;
  }
  // Sicherung, die vor der Anmeldung angefordert wurde, jetzt hochladen
  const pending = Number(localStorage.getItem('odPending') || 0);
  localStorage.removeItem('odPending');
  if (pending && Date.now() - pending < 30 * 60000) {
    toast('Angemeldet – Sicherung wird nach OneDrive hochgeladen …');
    const { json, base, count, missing } = await buildBackup();
    const res = await oneDriveBackup(new File([json], base + '.json', { type: 'application/json' }));
    if (res && res !== 'redirect' && res !== 'setup') backupDone(count, missing, res);
  } else {
    toast('Bei OneDrive angemeldet');
  }
  return true;
}

/** Lädt die Datei in den OneDrive-Ordner. Rückgabe: Beschreibung, 'redirect' (Anmeldung läuft) oder 'setup'. */
async function oneDriveBackup(file) {
  if (!odCfg().clientId) {
    openOneDriveSetup('Bitte zuerst die Anwendungs-ID eintragen.');
    return 'setup';
  }
  if (!navigator.onLine) throw new Error('Keine Internetverbindung');
  const token = await odAccessToken();
  if (!token) {
    toast('Weiterleitung zur Microsoft-Anmeldung …');
    await odLogin();
    return 'redirect';
  }
  toast('Sicherung wird nach OneDrive hochgeladen …');
  const path = `${odFolder()}/${file.name}`.split('/').map(encodeURIComponent).join('/');
  const sess = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/${path}:/createUploadSession`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'rename' } }),
  });
  if (sess.status === 401) {
    localStorage.removeItem('odTokens');
    await odLogin();
    return 'redirect';
  }
  const sessData = await sess.json().catch(() => ({}));
  if (!sess.ok || !sessData.uploadUrl) {
    throw new Error((sessData.error && sessData.error.message) || 'OneDrive antwortet mit Fehler ' + sess.status);
  }
  const CHUNK = 320 * 1024 * 12; // ~3,75 MB, Vielfaches von 320 KiB (Vorgabe von OneDrive)
  let item = null;
  for (let start = 0; start < file.size; start += CHUNK) {
    const end = Math.min(start + CHUNK, file.size);
    const res = await fetch(sessData.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes ${start}-${end - 1}/${file.size}` },
      body: file.slice(start, end),
    });
    if (!res.ok) throw new Error('Hochladen fehlgeschlagen (' + res.status + ')');
    if (res.status === 200 || res.status === 201) item = await res.json().catch(() => null);
  }
  const name = (item && item.name) || file.name;
  return `OneDrive: ${odFolder()}/${name}`;
}

function openOneDriveSetup(hint) {
  const dlg = $('#od-dialog');
  const cfg = odCfg();
  $('#od-client').value = cfg.clientId || '';
  $('#od-tenant').value = cfg.tenant && cfg.tenant !== 'common' ? cfg.tenant : '';
  $('#od-folder').value = cfg.folder || '';
  const signedIn = !!odTokens();
  $('#od-status').textContent = (hint ? hint + ' ' : '') +
    (cfg.clientId ? (signedIn ? 'Status: angemeldet.' : 'Status: eingerichtet, noch nicht angemeldet.') : 'Status: nicht eingerichtet.') +
    ' Umleitungs-URI für die Registrierung: ' + odRedirect();
  dlg.querySelector('[data-od="logout"]').hidden = !signedIn;
  dlg.showModal();
}

$('#od-dialog').addEventListener('click', e => {
  const b = e.target.closest('button[data-od]');
  if (!b) return;
  const dlg = $('#od-dialog');
  if (b.dataset.od === 'save') {
    const clientId = $('#od-client').value.trim();
    if (clientId && !/^[0-9a-f-]{36}$/i.test(clientId)) {
      $('#od-status').textContent = 'Die Anwendungs-ID hat das Format 1a2b3c4d-1234-… (36 Zeichen).';
      return;
    }
    const old = odCfg();
    const cfg = { clientId, tenant: $('#od-tenant').value.trim() || 'common', folder: $('#od-folder').value.trim() };
    localStorage.setItem('odConfig', JSON.stringify(cfg));
    if (old.clientId !== cfg.clientId || (old.tenant || 'common') !== cfg.tenant) localStorage.removeItem('odTokens');
    dlg.close();
    toast(clientId ? 'OneDrive eingerichtet' : 'OneDrive-Einstellungen gelöscht');
  } else if (b.dataset.od === 'logout') {
    localStorage.removeItem('odTokens');
    dlg.close();
    toast('Von OneDrive abgemeldet');
  } else {
    dlg.close();
  }
});

/* ---------- Import ---------- */

/** Wandelt einen Eintrag aus einer Sicherung in einen Bericht; Anhänge-Daten werden gesammelt. */
async function importEntry(raw, fileRecs) {
  const isOldNote = !Array.isArray(raw.items) && ('content' in raw || 'attachments' in raw);
  const base = isOldNote
    ? { ...noteToReport({ ...raw, attachments: [] }), items: [{ id: newId(), title: '', text: raw.content || '', attachments: raw.attachments || [] }] }
    : raw;
  const r = normalize({ ...base, attachments: [], items: [] });
  const takeAtts = async (list, target) => {
    for (const a of (Array.isArray(list) ? list : [])) {
      if (!a || !a.data || (a.kind !== 'photo' && a.kind !== 'audio')) continue;
      try {
        const blob = await dataUrlToBlob(a.data);
        const { data, ...meta } = a;
        meta.id = String(meta.id || newId());
        fileRecs.push({ id: meta.id, blob });
        target.push(meta);
      } catch { /* defekter Anhang – überspringen */ }
    }
  };
  if (!isOldNote) await takeAtts(base.attachments, r.attachments);
  for (const rawItem of (Array.isArray(base.items) ? base.items : [])) {
    const item = normalizeItem({ ...rawItem, attachments: [] });
    await takeAtts(rawItem.attachments, item.attachments);
    r.items.push(item);
  }
  return r;
}

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
        list = Array.isArray(data) ? data : data && (data.reports || data.notes);
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
        const existing = raw.id && reports.get(String(raw.id));
        if (existing && existing.updated >= (Number(raw.updated) || 0)) { skipped++; continue; }
        const fileRecs = [];
        const r = await importEntry(raw, fileRecs);
        try {
          if (fileRecs.length) await dbPutFiles(fileRecs);
          await dbPutReports([r]);
        } catch (err) {
          toast('Import abgebrochen: ' + err.message);
          renderList();
          return;
        }
        if (existing) {
          // Anhänge, die in der neueren Fassung fehlen, aufräumen
          const keep = new Set(allAttachments(r).map(a => a.id));
          const old = allAttachments(existing).map(a => a.id).filter(id => !keep.has(id));
          if (old.length) await dbDeleteFiles(old);
          allAttachments(existing).forEach(a => forgetUrl(a.id));
          updated++;
        } else {
          added++;
        }
        reports.set(r.id, r);
      }
    } else {
      // Textdatei → neuer Bericht, Dateiname als Titel
      const now = Date.now();
      const r = normalize({
        id: newId(), title: file.name.replace(/\.txt$/i, ''), date: isoDate(now), created: now, updated: now,
        items: [{ title: '', text: text.trimEnd() }],
      });
      await dbPutReports([r]);
      reports.set(r.id, r);
      added++;
    }
  }

  requestPersistence();
  await ensureOrder();
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
  const match = hash.match(/^#\/b\/(.+)$/);

  if (hash === '#/neu' || match) {
    const id = match ? decodeURIComponent(match[1]) : null;
    if (current && current.id === id) return; // schon offen (z. B. nach replaceState)
    if (id && !reports.has(id)) { location.hash = ''; return; }
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

// Merkt sich, dass der Bericht aus der Liste geöffnet wurde (für „Zurück“)
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
    for (const r of await dbAllReports()) reports.set(r.id, normalize(r));
    await ensureOrder();
  } catch (err) {
    toast('Speicher nicht verfügbar: ' + err.message);
  }
  await route();
  odHandleRedirect().catch(err => toast('OneDrive: ' + err.message));
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
