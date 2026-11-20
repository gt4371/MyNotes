'use strict';

/* ---------- Speicher (IndexedDB) ---------- */

const DB_NAME = 'notizen';
const STORE = 'notes';
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function dbTx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const dbAll = () => dbTx('readonly', s => s.getAll());
const dbPut = note => dbTx('readwrite', s => s.put(note));
const dbPutMany = notes => dbTx('readwrite', s => notes.forEach(n => s.put(n)));
const dbDelete = id => dbTx('readwrite', s => s.delete(id));

/** Alle Notizen im Speicher, nach id. */
const notes = new Map();

function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

let persistRequested = false;
function requestPersistence() {
  // Bittet den Browser, die Daten nicht automatisch zu löschen, wenn der Speicher knapp wird.
  if (persistRequested) return;
  persistRequested = true;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

async function saveNote(note) {
  note.updated = Date.now();
  notes.set(note.id, { ...note });
  requestPersistence();
  await dbPut(note);
}

async function deleteNote(id) {
  notes.delete(id);
  await dbDelete(id);
}

/* ---------- Hilfsfunktionen ---------- */

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

function displayTitle(note) {
  const title = note.title.trim();
  if (title) return title;
  const first = note.content.trim().split('\n')[0].trim();
  return first || '(ohne Titel)';
}

function previewText(note) {
  const content = note.content.trim();
  const body = note.title.trim() ? content : content.split('\n').slice(1).join(' ');
  return body.replace(/\s+/g, ' ').trim();
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
  return [note.title.trim(), note.content.trim()].filter(Boolean).join('\n\n');
}

function safeFileName(name) {
  return (name.replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 60) || 'Notiz');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function download(filename, text, type) {
  const blob = new Blob([text], { type: type + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

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
  toastTimer = setTimeout(() => { el.hidden = true; }, actionLabel ? 6000 : 2500);
}

/* ---------- Liste ---------- */

function renderList() {
  const query = $('#search').value.trim();
  const q = query.toLowerCase();
  const list = [...notes.values()]
    .filter(n => !q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
    .sort((a, b) => b.updated - a.updated);

  $('#notes').innerHTML = list.map(n => {
    const preview = previewText(n);
    return `<li class="note" data-id="${escapeHtml(n.id)}" tabindex="0">
      <h2>${highlight(displayTitle(n), query)}</h2>
      ${preview ? `<p>${highlight(preview.slice(0, 300), query)}</p>` : ''}
      <time>${formatDate(n.updated)}</time>
    </li>`;
  }).join('');

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

/* ---------- Bearbeiten ---------- */

let current = null;      // Notiz, die gerade bearbeitet wird
let saveTimer = null;

function openNote(id) {
  location.hash = id ? '#/n/' + encodeURIComponent(id) : '#/neu';
}

function showEditor(id) {
  const existing = id && notes.get(id);
  current = existing
    ? { ...existing }
    : { id: newId(), title: '', content: '', created: Date.now(), updated: Date.now() };

  $('#title').value = current.title;
  $('#content').value = current.content;
  $('#edit-heading').textContent = existing ? 'Notiz' : 'Neue Notiz';
  updateDateLine();

  $('#list-view').hidden = true;
  $('#edit-view').hidden = false;
  window.scrollTo(0, 0);
  if (!existing) $('#content').focus();
}

function updateDateLine() {
  $('#date').textContent = notes.has(current.id) ? 'Zuletzt geändert: ' + formatDate(current.updated) : '';
}

async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!current) return;
  const title = $('#title').value;
  const content = $('#content').value;
  const stored = notes.get(current.id);

  if (!stored && !title.trim() && !content.trim()) return; // leere neue Notiz nicht speichern
  if (stored && stored.title === title && stored.content === content) return;

  current.title = title;
  current.content = content;
  try {
    await saveNote(current);
    current = { ...notes.get(current.id) };
    $('#edit-heading').textContent = 'Notiz';
    updateDateLine();
    // Neue Notiz hat jetzt eine feste Adresse (ohne zusätzlichen Verlaufseintrag)
    if (location.hash === '#/neu') history.replaceState(history.state, '', '#/n/' + encodeURIComponent(current.id));
  } catch (err) {
    toast('Speichern fehlgeschlagen: ' + err.message);
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

$('#title').addEventListener('input', scheduleSave);
$('#content').addEventListener('input', scheduleSave);
$('#title').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('#content').focus(); }
});

async function closeEditor() {
  await flushSave();
  // Zurück zur Liste – über den Verlauf, damit die Zurück-Taste von Android passt
  if (history.state && history.state.fromList) history.back();
  else location.hash = '';
}

$('#back-btn').addEventListener('click', closeEditor);

$('#share-btn').addEventListener('click', async () => {
  await flushSave();
  const text = noteAsText({ title: $('#title').value, content: $('#content').value });
  if (!text) return toast('Die Notiz ist leer.');
  if (navigator.share) {
    try { await navigator.share({ title: $('#title').value.trim() || undefined, text }); } catch { /* abgebrochen */ }
  } else if (navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    toast('In die Zwischenablage kopiert');
  }
});

// Beim Verlassen oder Wechseln der App sofort speichern
document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });
window.addEventListener('pagehide', flushSave);

/* ---------- Menüs ---------- */

function toggleMenu(menu, show) {
  document.querySelectorAll('.menu').forEach(m => { if (m !== menu) m.hidden = true; });
  menu.hidden = show === undefined ? !menu.hidden : !show;
}

$('#menu-btn').addEventListener('click', e => {
  e.stopPropagation();
  const last = localStorage.getItem('lastBackup');
  $('#backup-info').textContent = 'Letzte Sicherung: ' + (last ? formatDate(Number(last)) : 'noch nie') +
    '\nNotizen: ' + notes.size;
  toggleMenu($('#main-menu'));
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
  'export-all'() {
    const data = {
      app: 'notizen',
      version: 1,
      exported: new Date().toISOString(),
      notes: [...notes.values()].sort((a, b) => b.updated - a.updated),
    };
    download(`notizen-sicherung-${today()}.json`, JSON.stringify(data, null, 2), 'application/json');
    localStorage.setItem('lastBackup', String(Date.now()));
    toast(`${notes.size} Notizen exportiert (Ordner „Downloads“)`);
  },

  'export-all-txt'() {
    const list = [...notes.values()].sort((a, b) => b.updated - a.updated);
    const text = list.map(n => `${displayTitle(n)}\n${formatDate(n.updated)}\n\n${n.content.trim()}`)
      .join('\n\n' + '─'.repeat(30) + '\n\n');
    download(`notizen-${today()}.txt`, text + '\n', 'text/plain');
    toast('Textdatei gespeichert (Ordner „Downloads“)');
  },

  import() {
    $('#import-file').value = '';
    $('#import-file').click();
  },

  async 'save-txt'() {
    await flushSave();
    const note = { title: $('#title').value, content: $('#content').value };
    const text = noteAsText(note);
    if (!text) return toast('Die Notiz ist leer.');
    download(safeFileName(displayTitle(note)) + '.txt', text + '\n', 'text/plain');
    toast('Gespeichert (Ordner „Downloads“)');
  },

  async delete() {
    if (!confirm('Diese Notiz löschen?')) return;
    clearTimeout(saveTimer);
    const removed = notes.get(current.id);
    const wasNew = !removed;
    if (removed) await deleteNote(removed.id);
    current = null;
    await closeEditor();
    if (!wasNew) {
      toast('Notiz gelöscht', 'Rückgängig', async () => {
        notes.set(removed.id, removed);
        await dbPut(removed);
        renderList();
      });
    }
  },
};

$('#import-file').addEventListener('change', async e => {
  const files = [...e.target.files];
  let added = 0, updated = 0, skipped = 0;
  const toSave = [];

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
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') { skipped++; continue; }
        const n = {
          id: String(raw.id || newId()),
          title: String(raw.title || ''),
          content: String(raw.content || ''),
          created: Number(raw.created) || Date.now(),
          updated: Number(raw.updated) || Date.now(),
        };
        const existing = notes.get(n.id);
        if (existing && existing.updated >= n.updated) { skipped++; continue; }
        existing ? updated++ : added++;
        notes.set(n.id, n);
        toSave.push(n);
      }
    } else {
      // Textdatei → neue Notiz, Dateiname als Titel
      const now = Date.now();
      const n = { id: newId(), title: file.name.replace(/\.txt$/i, ''), content: text.trimEnd(), created: now, updated: now };
      notes.set(n.id, n);
      toSave.push(n);
      added++;
    }
  }

  if (toSave.length) {
    requestPersistence();
    await dbPutMany(toSave);
  }
  renderList();
  const parts = [];
  if (added) parts.push(`${added} neu`);
  if (updated) parts.push(`${updated} aktualisiert`);
  if (skipped) parts.push(`${skipped} übersprungen (schon vorhanden)`);
  toast('Import: ' + (parts.join(', ') || 'nichts gefunden'));
});

/* ---------- Navigation ---------- */

async function route() {
  document.querySelectorAll('.menu').forEach(m => { m.hidden = true; });
  const hash = location.hash;
  const match = hash.match(/^#\/n\/(.+)$/);

  if (hash === '#/neu' || match) {
    const id = match ? decodeURIComponent(match[1]) : null;
    if (current && current.id === id) return; // schon offen (z. B. nach replaceState)
    if (id && !notes.has(id)) { location.hash = ''; return; }
    showEditor(id);
  } else {
    if (current) await flushSave();
    current = null;
    $('#edit-view').hidden = true;
    $('#list-view').hidden = false;
    renderList();
  }
}

// Merkt sich, dass der Editor aus der Liste geöffnet wurde (für „Zurück“)
window.addEventListener('hashchange', e => {
  const fromList = !new URL(e.oldURL).hash || new URL(e.oldURL).hash === '#';
  if (fromList && location.hash) history.replaceState({ fromList: true }, '');
  route();
});

/* ---------- Start ---------- */

(async function init() {
  try {
    for (const n of await dbAll()) notes.set(n.id, n);
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
