/**
 * storage.js — Axis Storage System
 * Place in src/ alongside index.html
 *
 * Directory layout on disk:
 *   %APPDATA%\Axis\
 *   ├── data.json          item + category data (image refs, not base64)
 *   ├── settings.json      theme / statMax / viewMode preferences
 *   ├── images\            one JPEG per item image
 *   └── backups\           ZIP snapshots, auto-pruned to 10 most recent
 *
 * How images work:
 *   IN MEMORY  → item.img = "data:image/jpeg;base64,..."  (unchanged)
 *   ON DISK    → item.img = "img_abc123.jpg"              (filename only)
 *   On load    → filenames are expanded back to base64
 *   On save    → base64 strings are written as files, replaced with names
 *
 * Requires (in capabilities/default.json):
 *   "fs:allow-read-file", "fs:allow-write-file",
 *   "fs:allow-read-text-file", "fs:allow-write-text-file",
 *   "fs:allow-exists", "fs:allow-mkdir",
 *   "fs:allow-read-dir", "fs:allow-remove",
 *   "fs:scope-appdata-recursive",
 *   "dialog:allow-open", "dialog:allow-save"   (optional — enables native dialogs)
 */

const AxisStorage = (() => {

  // ── Internal state ────────────────────────────────────────────────────────
  let _dataDir    = null;  // %APPDATA%\Axis
  let _imagesDir  = null;  // %APPDATA%\Axis\images
  let _backupsDir = null;  // %APPDATA%\Axis\backups
  let _ready      = false;
  const MAX_BACKUPS = 10;

  // ── Tauri API shortcuts ───────────────────────────────────────────────────
  const fs   = () => window.__TAURI__?.fs;
  const path = () => window.__TAURI__?.path;
  const dlg  = () => window.__TAURI__?.dialog;
  const isTauri = () => !!window.__TAURI__?.fs;

  // ── Path helpers ──────────────────────────────────────────────────────────
  async function join(...parts) {
    // Use Tauri's path.join if available, fallback to manual join
    if (path()?.join) return await path().join(...parts);
    return parts.join('\\');
  }

  async function ensureDir(dir) {
    if (!await fs().exists(dir)) {
      await fs().mkdir(dir, { recursive: true });
    }
  }

  // ── INIT ─────────────────────────────────────────────────────────────────
  /**
   * Create directory structure on first run.
   * Call once before any other method.
   * Safe to call multiple times (idempotent).
   */
  async function init() {
    if (!isTauri()) { _ready = true; return false; }
    try {
      const appData = await path().appDataDir();
      _dataDir    = await join(appData, 'Axis');
      _imagesDir  = await join(_dataDir, 'images');
      _backupsDir = await join(_dataDir, 'backups');
      await ensureDir(_dataDir);
      await ensureDir(_imagesDir);
      await ensureDir(_backupsDir);
      _ready = true;
      return true;
    } catch(e) {
      console.error('[AxisStorage] init failed:', e);
      _ready = true;
      return false;
    }
  }

  // ── IMAGE HELPERS ─────────────────────────────────────────────────────────

  /**
   * Save a base64 data URL as a JPEG file.
   * Returns the filename (e.g. "img_abc123.jpg").
   * If not in Tauri, returns the original base64 string unchanged.
   */
  async function saveImage(base64DataUrl, itemId) {
    if (!isTauri() || !base64DataUrl?.startsWith('data:')) return base64DataUrl;
    try {
      const filename = `img_${itemId}.jpg`;
      const filePath = await join(_imagesDir, filename);
      // Strip data URL header to get raw base64
      const b64 = base64DataUrl.split(',')[1];
      // Decode base64 → Uint8Array
      const binary = atob(b64);
      const bytes  = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      await fs().writeFile(filePath, bytes);
      return filename;
    } catch(e) {
      console.error('[AxisStorage] saveImage failed:', e);
      return base64DataUrl; // fallback: keep base64
    }
  }

  /**
   * Load a stored image file and return a base64 data URL.
   * If input looks like a data URL already, return it as-is.
   * If not in Tauri, return the value unchanged.
   */
  async function loadImage(filename) {
    if (!isTauri() || !filename || filename.startsWith('data:')) return filename;
    try {
      const filePath = await join(_imagesDir, filename);
      if (!await fs().exists(filePath)) return null;
      const bytes  = await fs().readFile(filePath);
      // Encode Uint8Array → base64
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return 'data:image/jpeg;base64,' + btoa(binary);
    } catch(e) {
      console.error('[AxisStorage] loadImage failed:', e);
      return null;
    }
  }

  /**
   * Delete an image file if it exists.
   */
  async function deleteImage(filename) {
    if (!isTauri() || !filename || filename.startsWith('data:')) return;
    try {
      const filePath = await join(_imagesDir, filename);
      if (await fs().exists(filePath)) await fs().remove(filePath);
    } catch(e) { /* silent — file may already be gone */ }
  }

  // ── SAVE ──────────────────────────────────────────────────────────────────
  /**
   * Persist items + categories to disk.
   * Images that are still base64 get written as files automatically.
   * Returns true on success.
   */
  async function saveData(items, categories) {
    if (!isTauri()) {
      // Browser fallback — use localStorage
      try {
        localStorage.setItem('axis', JSON.stringify({ items, categories }));
        return true;
      } catch(e) { return false; }
    }
    try {
      // Shallow-copy items so we don't mutate the live array
      const serializable = await Promise.all(items.map(async item => {
        const copy = { ...item };
        if (copy.img?.startsWith('data:')) {
          // Write image to disk, replace with filename
          copy.img = await saveImage(copy.img, copy.id);
        }
        return copy;
      }));
      const json = JSON.stringify({ items: serializable, categories }, null, 2);
      await fs().writeTextFile(await join(_dataDir, 'data.json'), json);
      return true;
    } catch(e) {
      console.error('[AxisStorage] saveData failed:', e);
      return false;
    }
  }

  // ── LOAD ──────────────────────────────────────────────────────────────────
  /**
   * Load items + categories from disk.
   * Image filenames are expanded back to base64 data URLs.
   * Returns { items, categories } or null on failure.
   */
  async function loadData() {
    if (!isTauri()) {
      // Browser fallback — use localStorage
      try {
        const raw = localStorage.getItem('axis');
        if (!raw) return null;
        const d = JSON.parse(raw);
        return { items: d.items || [], categories: d.categories || [] };
      } catch(e) { return null; }
    }
    try {
      const filePath = await join(_dataDir, 'data.json');
      if (!await fs().exists(filePath)) return null;
      const d = JSON.parse(await fs().readTextFile(filePath));
      const items = await Promise.all((d.items || []).map(async item => {
        if (item.img && !item.img.startsWith('data:')) {
          item.img = await loadImage(item.img) || item.img;
        }
        return item;
      }));
      return { items, categories: d.categories || [] };
    } catch(e) {
      console.error('[AxisStorage] loadData failed:', e);
      return null;
    }
  }

  // ── SETTINGS ──────────────────────────────────────────────────────────────
  /**
   * Save app settings (theme, statMax, viewMode) to settings.json.
   * Falls back to localStorage in browser.
   */
  async function saveSettings(settings) {
    if (!isTauri()) {
      try {
        Object.entries(settings).forEach(([k, v]) =>
          localStorage.setItem(`axis_${k}`, String(v))
        );
        return true;
      } catch(e) { return false; }
    }
    try {
      await fs().writeTextFile(
        await join(_dataDir, 'settings.json'),
        JSON.stringify(settings, null, 2)
      );
      return true;
    } catch(e) {
      console.error('[AxisStorage] saveSettings failed:', e);
      return false;
    }
  }

  /**
   * Load app settings. Returns object with defaults on failure.
   */
  async function loadSettings() {
    const defaults = { theme: 'dark', statMax: 10, viewMode: 'grid' };
    if (!isTauri()) {
      try {
        return {
          theme:    localStorage.getItem('axis_theme')   || defaults.theme,
          statMax:  parseInt(localStorage.getItem('axis_statmax')) || defaults.statMax,
          viewMode: localStorage.getItem('axis_view')    || defaults.viewMode,
        };
      } catch(e) { return defaults; }
    }
    try {
      const filePath = await join(_dataDir, 'settings.json');
      if (!await fs().exists(filePath)) return defaults;
      return { ...defaults, ...JSON.parse(await fs().readTextFile(filePath)) };
    } catch(e) { return defaults; }
  }

  // ── BACKUPS ───────────────────────────────────────────────────────────────
  /**
   * Create a ZIP backup of current data + all images.
   * Saved to backups\ as YYYY-MM-DD_HH-MM-SS.zip.
   * Auto-prunes to MAX_BACKUPS most recent.
   */
  async function createBackup(items, categories) {
    if (!isTauri()) return false;
    try {
      const entries = [];

      // Serialise data with filename refs (same as saveData)
      const serializable = await Promise.all(items.map(async item => {
        const copy = { ...item };
        if (copy.img?.startsWith('data:')) {
          copy.img = await saveImage(copy.img, copy.id);
        }
        return copy;
      }));
      entries.push({
        name: 'data.json',
        data: new TextEncoder().encode(JSON.stringify({ items: serializable, categories }, null, 2))
      });

      // Include every referenced image file
      const referenced = new Set(
        serializable.map(i => i.img).filter(img => img && !img.startsWith('data:'))
      );
      for (const filename of referenced) {
        try {
          const filePath = await join(_imagesDir, filename);
          if (await fs().exists(filePath)) {
            const bytes = await fs().readFile(filePath);
            entries.push({ name: `images/${filename}`, data: bytes });
          }
        } catch(e) { /* skip missing image */ }
      }

      const zipBytes  = buildZip(entries);
      const timestamp = new Date().toISOString()
        .replace('T', '_').replace(/:/g, '-').slice(0, 19);
      const backupPath = await join(_backupsDir, `${timestamp}.zip`);
      await fs().writeFile(backupPath, zipBytes);

      await pruneBackups();
      return true;
    } catch(e) {
      console.error('[AxisStorage] createBackup failed:', e);
      return false;
    }
  }

  /**
   * Delete oldest backups, keeping only MAX_BACKUPS most recent.
   */
  async function pruneBackups() {
    if (!isTauri()) return;
    try {
      const entries = await fs().readDir(_backupsDir);
      const zips = entries
        .filter(e => e.name?.endsWith('.zip'))
        .sort((a, b) => b.name.localeCompare(a.name)); // newest first
      for (const old of zips.slice(MAX_BACKUPS)) {
        await fs().remove(await join(_backupsDir, old.name));
      }
    } catch(e) { /* silent */ }
  }

  /**
   * List all backups. Returns array of { name, date } sorted newest first.
   */
  async function listBackups() {
    if (!isTauri()) return [];
    try {
      const entries = await fs().readDir(_backupsDir);
      return entries
        .filter(e => e.name?.endsWith('.zip'))
        .map(e => ({ name: e.name, label: e.name.replace('.zip', '').replace('_', ' ') }))
        .sort((a, b) => b.name.localeCompare(a.name));
    } catch(e) { return []; }
  }

  // ── IMPORT ────────────────────────────────────────────────────────────────
  /**
   * Open native file dialog and import .json or .zip.
   * Returns { items, categories } or null if cancelled / failed.
   * Falls back to triggering the hidden #import-input if dialog unavailable.
   */
  async function importFile() {
    // Try native dialog first
    if (isTauri() && dlg()?.open) {
      try {
        const selected = await dlg().open({
          title: 'Import Axis data',
          filters: [{ name: 'Axis files', extensions: ['json', 'zip'] }],
          multiple: false,
        });
        if (!selected) return null; // user cancelled
        const filePath = typeof selected === 'string' ? selected : selected[0];
        if (filePath.endsWith('.zip')) {
          return await _readZipFile(filePath);
        } else {
          const raw = await fs().readTextFile(filePath);
          return _parseJSON(raw);
        }
      } catch(e) {
        console.error('[AxisStorage] importFile (dialog) failed:', e);
      }
    }
    // Fallback: trigger the browser file input (handled by index.html)
    return 'use-file-input';
  }

  /**
   * Read a ZIP file from disk and extract data.json + images.
   * Writes extracted images to the images directory.
   * Returns { items, categories } or null.
   */
  async function _readZipFile(filePath) {
    try {
      const bytes = await fs().readFile(filePath);
      const entries = parseZip(bytes);
      let data = null;
      const imageEntries = [];
      for (const entry of entries) {
        if (entry.name === 'data.json') {
          data = _parseJSON(new TextDecoder().decode(entry.data));
        } else if (entry.name.startsWith('images/')) {
          imageEntries.push(entry);
        }
      }
      if (!data) return null;
      // Write extracted images to images dir
      for (const img of imageEntries) {
        const filename = img.name.replace('images/', '');
        const dest = await join(_imagesDir, filename);
        await fs().writeFile(dest, img.data);
      }
      // Expand image refs to base64 for in-memory use
      const items = await Promise.all((data.items || []).map(async item => {
        if (item.img && !item.img.startsWith('data:')) {
          item.img = await loadImage(item.img) || item.img;
        }
        return item;
      }));
      return { items, categories: data.categories || [] };
    } catch(e) {
      console.error('[AxisStorage] _readZipFile failed:', e);
      return null;
    }
  }

  function _parseJSON(text) {
    try {
      const d = JSON.parse(text);
      const items = d.items || (Array.isArray(d) ? d : null);
      if (!items) return null;
      return { items, categories: d.categories || [] };
    } catch(e) { return null; }
  }

  // ── EXPORT ────────────────────────────────────────────────────────────────
  /**
   * Export as JSON via native save dialog.
   * Returns true on success, false on cancel/error.
   */
  async function exportJSON(items, categories) {
    const data = JSON.stringify({ items, categories }, null, 2);
    if (isTauri() && dlg()?.save) {
      try {
        const savePath = await dlg().save({
          title: 'Export Axis data',
          defaultPath: 'axis.json',
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (!savePath) return false;
        await fs().writeTextFile(savePath, data);
        return true;
      } catch(e) {
        console.error('[AxisStorage] exportJSON failed:', e);
        return false;
      }
    }
    // Browser fallback
    _browserDownload(new Blob([data], { type: 'application/json' }), 'axis.json');
    return true;
  }

  /**
   * Export as ZIP (data + images) via native save dialog.
   * Returns true on success, false on cancel/error.
   */
  async function exportZip(items, categories) {
    try {
      const entries = [];

      // Serialise — inline base64 stays as-is in the ZIP's data.json
      // so the ZIP is fully self-contained even without the images dir
      entries.push({
        name: 'data.json',
        data: new TextEncoder().encode(JSON.stringify({ items, categories }, null, 2))
      });

      // Include images
      for (const item of items) {
        if (!item.img) continue;
        if (item.img.startsWith('data:')) {
          // In-memory base64 — encode directly into ZIP
          const b64    = item.img.split(',')[1];
          const binary = atob(b64);
          const bytes  = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          entries.push({ name: `images/img_${item.id}.jpg`, data: bytes });
        } else if (isTauri()) {
          // File on disk — read and bundle
          try {
            const filePath = await join(_imagesDir, item.img);
            if (await fs().exists(filePath)) {
              const bytes = await fs().readFile(filePath);
              entries.push({ name: `images/${item.img}`, data: bytes });
            }
          } catch(e) { /* skip missing */ }
        }
      }

      const zipBytes = buildZip(entries);

      if (isTauri() && dlg()?.save) {
        const savePath = await dlg().save({
          title: 'Export Axis data',
          defaultPath: 'axis_export.zip',
          filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
        });
        if (!savePath) return false;
        await fs().writeFile(savePath, zipBytes);
        return true;
      }
      // Browser fallback
      _browserDownload(new Blob([zipBytes], { type: 'application/zip' }), 'axis_export.zip');
      return true;
    } catch(e) {
      console.error('[AxisStorage] exportZip failed:', e);
      return false;
    }
  }

  function _browserDownload(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ── MIGRATION ─────────────────────────────────────────────────────────────
  /**
   * One-time migration from localStorage base64 to file-based storage.
   * Called automatically on first init if data.json doesn't exist yet.
   * Returns true if migration happened, false if skipped.
   */
  async function migrateFromLocalStorage() {
    if (!isTauri()) return false;
    try {
      const dataPath = await join(_dataDir, 'data.json');
      if (await fs().exists(dataPath)) return false; // already migrated

      const raw = localStorage.getItem('axis');
      if (!raw) return false;

      const d = JSON.parse(raw);
      if (!d?.items) return false;

      console.log('[AxisStorage] Migrating from localStorage...');
      await saveData(d.items, d.categories || []);
      console.log('[AxisStorage] Migration complete.');
      return true;
    } catch(e) {
      console.error('[AxisStorage] Migration failed:', e);
      return false;
    }
  }

  // ── ZIP BUILDER ───────────────────────────────────────────────────────────
  // Pure-JS ZIP writer (stored, no compression). Shared with index.html logic.
  // Entries: array of { name: string, data: Uint8Array | string }

  function buildZip(entries) {
    const enc = new TextEncoder();
    const cd = [], parts = [];
    let off = 0;
    entries.forEach(e => {
      const nb  = enc.encode(e.name);
      const db  = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
      const crc = crc32(db);
      const lh  = _localHeader(nb, db.length, crc);
      cd.push({ nb, size: db.length, crc, off });
      parts.push(lh, db);
      off += lh.length + db.length;
    });
    const cdParts = cd.map(e => _cdEntry(e.nb, e.size, e.crc, e.off));
    const cdSize  = cdParts.reduce((a, b) => a + b.length, 0);
    return _concat([...parts, ...cdParts, _eocd(cd.length, cdSize, off)]);
  }

  function _localHeader(nb, sz, crc) {
    const b = new Uint8Array(30 + nb.length), v = new DataView(b.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true);
    v.setUint32(14, crc, true); v.setUint32(18, sz, true);
    v.setUint32(22, sz, true); v.setUint16(26, nb.length, true);
    b.set(nb, 30); return b;
  }
  function _cdEntry(nb, sz, crc, off) {
    const b = new Uint8Array(46 + nb.length), v = new DataView(b.buffer);
    v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true);
    v.setUint16(6, 20, true); v.setUint32(16, crc, true);
    v.setUint32(20, sz, true); v.setUint32(24, sz, true);
    v.setUint16(28, nb.length, true); v.setUint32(42, off, true);
    b.set(nb, 46); return b;
  }
  function _eocd(cnt, cds, cdo) {
    const b = new Uint8Array(22), v = new DataView(b.buffer);
    v.setUint32(0, 0x06054b50, true); v.setUint16(8, cnt, true);
    v.setUint16(10, cnt, true); v.setUint32(12, cds, true);
    v.setUint32(16, cdo, true); return b;
  }
  function _concat(arrs) {
    const t = arrs.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(t); let o = 0;
    arrs.forEach(a => { out.set(a, o); o += a.length; }); return out;
  }
  function crc32(data) {
    const tbl = crc32._t || (crc32._t = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c;
      }
      return t;
    })());
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = tbl[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // ── ZIP READER ────────────────────────────────────────────────────────────
  // Reads stored (method=0) and deflated (method=8) ZIP entries.

  function parseZip(bytes) {
    const view    = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = [];
    let i = 0;
    while (i < bytes.length - 4) {
      const sig = view.getUint32(i, true);
      if (sig !== 0x04034b50) { i++; continue; } // scan for local file header
      const method      = view.getUint16(i + 8,  true);
      const cmpSize     = view.getUint32(i + 18, true);
      const uncmpSize   = view.getUint32(i + 22, true);
      const nameLen     = view.getUint16(i + 26, true);
      const extraLen    = view.getUint16(i + 28, true);
      const nameBytes   = bytes.slice(i + 30, i + 30 + nameLen);
      const name        = new TextDecoder().decode(nameBytes);
      const dataStart   = i + 30 + nameLen + extraLen;
      const compData    = bytes.slice(dataStart, dataStart + cmpSize);
      let data;
      if (method === 0) {
        data = compData; // stored
      } else if (method === 8) {
        // deflate — use DecompressionStream if available
        data = null; // resolved below
      } else {
        i = dataStart + cmpSize; continue; // unsupported method, skip
      }
      entries.push({ name, data: data || compData, method, uncmpSize });
      i = dataStart + cmpSize;
    }
    return entries;
  }

  /**
   * Decompress any deflated entries in a parsed ZIP result.
   * Call after parseZip() if you expect compressed entries.
   */
  async function decompressZip(entries) {
    return Promise.all(entries.map(async entry => {
      if (entry.method !== 8 || !entry.data) return entry;
      try {
        const ds     = new DecompressionStream('deflate-raw');
        const writer = ds.writable.getWriter();
        const reader = ds.readable.getReader();
        writer.write(entry.data); writer.close();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break; chunks.push(value);
        }
        const total = chunks.reduce((a, b) => a + b.length, 0);
        const out   = new Uint8Array(total); let off = 0;
        for (const chunk of chunks) { out.set(chunk, off); off += chunk.length; }
        return { ...entry, data: out };
      } catch(e) {
        console.warn('[AxisStorage] deflate decompress failed for', entry.name, e);
        return entry;
      }
    }));
  }

  // ── PUBLIC API ────────────────────────────────────────────────────────────
  return {
    init,
    saveData,
    loadData,
    saveSettings,
    loadSettings,
    saveImage,
    loadImage,
    deleteImage,
    createBackup,
    listBackups,
    importFile,
    exportJSON,
    exportZip,
    migrateFromLocalStorage,
    // expose ZIP utils so index.html can use them too
    buildZip,
    parseZip,
    decompressZip,
    get isReady() { return _ready; },
    get isTauri() { return isTauri(); },
  };
})();
