// WebRec: IndexedDB による録画スクリプトの永続化レイヤー。
// background(service worker) と manager.html(管理ページ)の両方から import して使う。

const DB_NAME = 'webrec-db';
const DB_VERSION = 3;
const STORE = 'recordings';
const FILE_STORE = 'files'; // アップロード用のファイル本体（録画とは別に保持する）
const RUN_STORE = 'runs'; // 再生の実行ログ（いつ何が起きたかを後から追えるように）

// 実行ログはためすぎると容量を食うので、この件数を超えた古いものから消す
const MAX_RUNS = 100;

let dbPromise = null;

// DB のバージョンを上げるときは、他のタブが古いバージョンで開いたままだと
// upgrade が blocked になり、open が永久に返らない。
// 返らないまま待つと再生ごと止まってしまうため、必ず時間で見切る。
const OPEN_TIMEOUT_MS = 8000;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let blocked = false;
    const timer = setTimeout(() => {
      reject(
        new Error(
          blocked
            ? 'IndexedDB の更新が他のタブに邪魔されています。WebRec の管理画面を開いている他のタブを閉じてから、もう一度お試しください。'
            : 'IndexedDB を開けませんでした'
        )
      );
    }, OPEN_TIMEOUT_MS);
    const settle = (fn, value) => {
      clearTimeout(timer);
      fn(value);
    };
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onblocked = () => {
      blocked = true; // 他の接続が閉じれば onsuccess が来る。来なければ上のタイマーで諦める
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(RUN_STORE)) {
        const runs = db.createObjectStore(RUN_STORE, { keyPath: 'id' });
        runs.createIndex('startedAt', 'startedAt', { unique: false });
      }
    };
    req.onsuccess = () => settle(resolve, req.result);
    req.onerror = () => settle(reject, req.error);
  });
  // 失敗したら次の呼び出しでやり直せるようにする（一度きりの失敗を引きずらない）
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

async function withStore(mode, fn, storeName = STORE) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    Promise.resolve(fn(store))
      .then((r) => {
        result = r;
      })
      .catch((err) => {
        try {
          tx.abort();
        } catch (_) {
          /* noop */
        }
        reject(err);
      });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveRecording(rec) {
  return withStore('readwrite', (store) => reqToPromise(store.put(rec)));
}

export async function getRecording(id) {
  return withStore('readonly', (store) => reqToPromise(store.get(id)));
}

export async function deleteRecording(id) {
  return withStore('readwrite', (store) => reqToPromise(store.delete(id)));
}

export async function updateRecording(id, patch) {
  return withStore('readwrite', async (store) => {
    const existing = await reqToPromise(store.get(id));
    if (!existing) throw new Error('recording not found: ' + id);
    const updated = { ...existing, ...patch, updatedAt: Date.now() };
    await reqToPromise(store.put(updated));
    return updated;
  });
}

export async function getAllRecordings() {
  const list = await withStore('readonly', (store) => reqToPromise(store.getAll()));
  return list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// --- アップロード用ファイル ---
// 録画本体に巨大な dataUrl を持たせると、記録中の chrome.storage.session が
// 容量を超えてセッションごと失われるため、ファイルは別ストアに逃がしている。

export async function saveFile(file) {
  return withStore('readwrite', (store) => reqToPromise(store.put(file)), FILE_STORE);
}

export async function getFile(id) {
  return withStore('readonly', (store) => reqToPromise(store.get(id)), FILE_STORE);
}

export async function deleteFile(id) {
  return withStore('readwrite', (store) => reqToPromise(store.delete(id)), FILE_STORE);
}

// 録画が参照しているファイルIDを集める
export function collectFileIds(rec) {
  const ids = [];
  for (const step of rec.steps || []) {
    for (const f of step.files || []) {
      if (f && f.fileId) ids.push(f.fileId);
    }
  }
  return ids;
}

// 録画を消すときは、そこでしか使っていないファイルも一緒に片付ける
export async function deleteRecordingWithFiles(id) {
  const rec = await getRecording(id);
  if (rec) {
    const mine = new Set(collectFileIds(rec));
    if (mine.size) {
      const others = (await getAllRecordings()).filter((r) => r.id !== id);
      for (const other of others) {
        for (const usedId of collectFileIds(other)) mine.delete(usedId);
      }
      for (const fileId of mine) await deleteFile(fileId);
    }
  }
  await deleteRecording(id);
}

// --- 実行ログ ---
// 再生 1 回ぶんを 1 レコードとして残す。再生中も逐次上書きするので、
// 途中で Service Worker が止まっても、そこまでの経過は残る。

export async function saveRun(run) {
  return withStore('readwrite', (store) => reqToPromise(store.put(run)), RUN_STORE);
}

export async function getRun(id) {
  return withStore('readonly', (store) => reqToPromise(store.get(id)), RUN_STORE);
}

export async function deleteRun(id) {
  return withStore('readwrite', (store) => reqToPromise(store.delete(id)), RUN_STORE);
}

export async function getAllRuns() {
  const list = await withStore('readonly', (store) => reqToPromise(store.getAll()), RUN_STORE);
  return list.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

export async function clearRuns() {
  return withStore('readwrite', (store) => reqToPromise(store.clear()), RUN_STORE);
}

// 古い実行ログを間引く（新しいものから MAX_RUNS 件だけ残す）
export async function pruneRuns() {
  const all = await getAllRuns();
  for (const run of all.slice(MAX_RUNS)) {
    await deleteRun(run.id);
  }
  return Math.max(0, all.length - MAX_RUNS);
}
