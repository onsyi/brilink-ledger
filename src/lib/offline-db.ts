const DB_NAME = "brilink-ledger";
const DB_VERSION = 1;
const STORE_NAME = "pending-sync";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "id" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
    });
  }
  return dbPromise;
}

export type PendingRecord = {
  id: string;
  table: string;
  payload: Record<string, unknown>;
  createdAt: string;
  retries: number;
};

function runTx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const req = fn(tx.objectStore(STORE_NAME));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

function runTxComplete(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => void,
): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        fn(tx.objectStore(STORE_NAME));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export async function addPending(record: PendingRecord): Promise<void> {
  return runTxComplete("readwrite", (store) => store.put(record));
}

export async function getAllPending(): Promise<PendingRecord[]> {
  return runTx("readonly", (store) => store.getAll());
}

export async function removePending(id: string): Promise<void> {
  return runTxComplete("readwrite", (store) => store.delete(id));
}

export async function clearPending(): Promise<void> {
  return runTxComplete("readwrite", (store) => store.clear());
}

export async function incrementRetry(id: string): Promise<void> {
  return openDB().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          const record = getReq.result;
          if (record) {
            record.retries = (record.retries ?? 0) + 1;
            store.put(record);
          }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

export function isOnline(): boolean {
  return navigator.onLine;
}
