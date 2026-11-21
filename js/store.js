// Local storage for pro references and saved sessions (IndexedDB, in this
// browser only). Falls back to memory if IndexedDB is unavailable, e.g. in a
// private window.

const DB_NAME = 'stroke-match';
const STORES = ['refs', 'sessions'];
let dbPromise = null;
const memory = { refs: new Map(), sessions: new Map() };
let persistent = true;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch { persistent = false; resolve(null); return; }
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { persistent = false; resolve(null); };
      req.onblocked = () => { persistent = false; resolve(null); };
    });
  }
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
  });
}

export const isPersistent = async () => { await open(); return persistent; };

export async function getAll(store) {
  const db = await open();
  if (!db) return [...memory[store].values()];
  return tx(db, store, 'readonly', (s) => s.getAll());
}

export async function put(store, obj) {
  const db = await open();
  if (!db) { memory[store].set(obj.id, obj); return; }
  await tx(db, store, 'readwrite', (s) => s.put(obj));
}

export async function remove(store, id) {
  const db = await open();
  if (!db) { memory[store].delete(id); return; }
  await tx(db, store, 'readwrite', (s) => s.delete(id));
}

export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// Ask the browser not to evict the library under storage pressure.
export async function requestPersistence() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}

// ---------- export / import ----------
const blobToDataURL = (b) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(b);
});
const dataURLToBlob = async (u) => (await fetch(u)).blob();

export async function exportAll() {
  const refs = await getAll('refs');
  const sessions = await getAll('sessions');
  const enc = async (o) => {
    const out = { ...o };
    if (o.images) out.images = await Promise.all(o.images.map(blobToDataURL));
    if (o.thumb) out.thumb = await blobToDataURL(o.thumb);
    return out;
  };
  return {
    app: 'stroke-match', version: 1, exportedAt: new Date().toISOString(),
    refs: await Promise.all(refs.map(enc)),
    sessions: await Promise.all(sessions.map(enc)),
  };
}

export async function importAll(data) {
  if (!data || data.app !== 'stroke-match') throw new Error('This file is not a Stroke Match export.');
  const dec = async (o) => {
    const out = { ...o };
    if (o.images) out.images = await Promise.all(o.images.map(dataURLToBlob));
    if (o.thumb) out.thumb = await dataURLToBlob(o.thumb);
    return out;
  };
  let refs = 0, sessions = 0;
  for (const r of data.refs || []) { await put('refs', await dec(r)); refs++; }
  for (const s of data.sessions || []) { await put('sessions', await dec(s)); sessions++; }
  return { refs, sessions };
}
