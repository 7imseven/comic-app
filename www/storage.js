// storage.js — 存储适配器（Capacitor Filesystem + Web IndexedDB 兼容）
window.__storageReady = (async function() {

const DATA_CHUNK = 16 * 1024 * 1024;
const IS_NATIVE = typeof Capacitor !== 'undefined' && Capacitor.isNativePlatform();

let USE_FS = false;
if (IS_NATIVE) {
  try { const m = await import('@capacitor/filesystem'); USE_FS = !!m.Filesystem; } catch(e) {}
}
const fs = USE_FS ? (await import('@capacitor/filesystem')).Filesystem : null;

// ========== 元数据读写 ==========

function openMetaDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ComicVaultNative', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = reject;
  });
}

async function readMeta() {
  if (USE_FS) {
    try {
      const r = await fs.readFile({ path: 'comics.json', directory: 'Data' });
      return JSON.parse(r.data);
    } catch { return []; }
  }
  // Web fallback: IndexedDB
  return new Promise((resolve, reject) => {
    openMetaDB().then(db => {
      const tx = db.transaction('meta', 'readonly');
      const r = tx.objectStore('meta').getAll();
      r.onsuccess = () => { resolve(r.result); db.close(); };
      r.onerror = reject;
    }).catch(reject);
  });
}

async function writeMeta(list) {
  if (USE_FS) {
    await fs.writeFile({ path: 'comics.json', data: JSON.stringify(list), directory: 'Data' });
    return;
  }
  // Web fallback
  return new Promise((resolve, reject) => {
    openMetaDB().then(db => {
      const tx = db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      store.clear();
      list.forEach(item => store.add(item));
      tx.oncomplete = () => { resolve(); db.close(); };
      tx.onerror = reject;
    }).catch(reject);
  });
}

// ========== 数据块读写 ==========

function chunkPath(comicId, index) { return 'data/' + comicId + '/' + index; }

async function writeChunk(comicId, index, blob) {
  const buf = await blob.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  if (USE_FS) {
    await fs.writeFile({ path: chunkPath(comicId, index), data: base64, directory: 'Data', recursive: true });
  } else {
    return new Promise((resolve, reject) => {
      openMetaDB().then(db => {
        const tx = db.transaction('chunks', 'readwrite');
        tx.objectStore('chunks').put({ key: comicId + '_' + index, data: blob });
        tx.oncomplete = () => { resolve(); db.close(); };
        tx.onerror = reject;
      }).catch(reject);
    });
  }
}

async function readChunk(comicId, index) {
  if (USE_FS) {
    const r = await fs.readFile({ path: chunkPath(comicId, index), directory: 'Data' });
    const binary = atob(r.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes]);
  }
  return new Promise((resolve, reject) => {
    openMetaDB().then(db => {
      const tx = db.transaction('chunks', 'readonly');
      const r = tx.objectStore('chunks').get(comicId + '_' + index);
      r.onsuccess = () => { resolve(r.result ? r.result.data : null); db.close(); };
      r.onerror = reject;
    }).catch(reject);
  });
}

async function deleteChunks(comicId, count) {
  if (USE_FS) {
    for (let i = 0; i < count; i++) {
      try { await fs.deleteFile({ path: chunkPath(comicId, i), directory: 'Data' }); } catch {}
    }
  }
}

// ========== 封面 ==========

async function writeCover(comicId, blob) {
  if (!blob) return;
  const buf = await blob.arrayBuffer();
  const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  if (USE_FS) {
    await fs.writeFile({ path: 'covers/' + comicId, data: base64, directory: 'Data', recursive: true });
  }
}

async function readCover(comicId) {
  if (USE_FS) {
    try {
      const r = await fs.readFile({ path: 'covers/' + comicId, directory: 'Data' });
      const binary = atob(r.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes]);
    } catch { return null; }
  }
  return null;
}

// ========== 公共 API ==========

let nextId = 1;

return {
  async init() {
    const list = await readMeta();
    nextId = list.reduce((max, c) => Math.max(max, c.id + 1), 1);
  },

  async saveComic(name, file, coverBlob) {
    const list = await readMeta();
    const id = nextId++;
    const chunkCount = Math.ceil(file.size / DATA_CHUNK);

    // 写数据块
    for (let i = 0; i < chunkCount; i++) {
      await writeChunk(id, i, file.slice(i * DATA_CHUNK, Math.min((i + 1) * DATA_CHUNK, file.size)));
    }
    // 写封面
    await writeCover(id, coverBlob);

    const meta = { id, name, cover: !!coverBlob, addedAt: Date.now(), progress: 0, dataSize: file.size, chunkCount };
    list.push(meta);
    await writeMeta(list);
    return id;
  },

  async getAllComics() {
    return await readMeta();
  },

  async getComicData(comicId, chunkCount) {
    const parts = [];
    for (let i = 0; i < chunkCount; i++) {
      parts.push(await readChunk(comicId, i));
    }
    return new Blob(parts);
  },

  async getComicCover(comicId) {
    return await readCover(comicId);
  },

  async saveCover(comicId, coverBlob) {
    await writeCover(comicId, coverBlob);
    const list = await readMeta();
    const c = list.find(x => x.id === comicId);
    if (c) { c.cover = true; await writeMeta(list); }
  },

  async updateProgress(id, progress) {
    const list = await readMeta();
    const c = list.find(x => x.id === id);
    if (c) c.progress = progress;
    await writeMeta(list);
  },

  async deleteComic(id) {
    const list = await readMeta();
    const c = list.find(x => x.id === id);
    await deleteChunks(id, c ? c.chunkCount : 0);
    await writeMeta(list.filter(x => x.id !== id));
  },

  // 导出：读取所有块，组装成 Blob
  async getComicChunks(comicId, chunkCount) {
    const parts = [];
    for (let i = 0; i < chunkCount; i++) {
      parts.push(await readChunk(comicId, i));
    }
    return parts;
  }
};

})();
