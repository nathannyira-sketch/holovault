// Stockage local (IndexedDB) : les données restent sur l'appareil.
const DB_NAME = 'holovault';
const VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cards')) db.createObjectStore('cards', { keyPath: 'uid' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  all: () => tx('cards', 'readonly', s => s.getAll()),
  get: uid => tx('cards', 'readonly', s => s.get(uid)),
  put: card => tx('cards', 'readwrite', s => s.put(card)),
  putMany: cards => tx('cards', 'readwrite', s => { cards.forEach(c => s.put(c)); }),
  del: uid => tx('cards', 'readwrite', s => s.delete(uid)),
  clear: () => tx('cards', 'readwrite', s => s.clear()),
  getMeta: key => tx('meta', 'readonly', s => s.get(key)),
  setMeta: (key, value) => tx('meta', 'readwrite', s => s.put(value, key)),
};
