/** Minimal typed IndexedDB wrapper for the progress queue and offline state. */

const DB_NAME = 'tandemleaf';
const DB_VERSION = 2;

export const STORES = {
  pendingEvents: 'pending-events', // key: eventId
  serverState: 'server-state', // key: bookId
  downloads: 'downloads', // key: bookId
  prefs: 'prefs', // key: string
} as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openIdb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
  return dbPromise;
}

export async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbClear(store: string): Promise<void> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbAll<T>(store: string): Promise<{ key: string; value: T }[]> {
  const db = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const os = tx.objectStore(store);
    const keysReq = os.getAllKeys();
    const valsReq = os.getAll();
    tx.oncomplete = () => {
      const keys = keysReq.result as string[];
      const vals = valsReq.result as T[];
      resolve(keys.map((k, i) => ({ key: k, value: vals[i]! })));
    };
    tx.onerror = () => reject(tx.error);
  });
}
