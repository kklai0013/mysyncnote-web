const DB_NAME = 'mysyncnote-settings';
const DB_STORE = 'handles';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rememberHandle(key, handle) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(handle, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (error) {
    console.warn('無法記住筆記庫', error);
  }
}

async function recalledHandle(key) {
  try {
    const db = await openDb();
    const handle = await new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE).objectStore(DB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

export const rememberVault = handle => rememberHandle('last-vault', handle);
export const recalledVault = () => recalledHandle('last-vault');
export const rememberSettingsFolder = handle => rememberHandle('settings-folder', handle);
export const recalledSettingsFolder = () => recalledHandle('settings-folder');

export function safeName(value, extension = '') {
  let name = String(value || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/[. ]+$/g, '');
  if (!name) name = '未命名';
  if (extension && !name.toLowerCase().endsWith(extension.toLowerCase())) name += extension;
  return name;
}

export function dirname(path) {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

export function basename(path) {
  return path.split('/').filter(Boolean).pop() || '';
}

function join(...parts) {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/^\//, '');
}

async function copyFile(source, targetDir, targetName) {
  const file = await source.getFile();
  const target = await targetDir.getFileHandle(targetName, { create: true });
  const writer = await target.createWritable();
  await writer.write(await file.arrayBuffer());
  await writer.close();
  return target;
}

async function copyDirectory(sourceDir, targetDir) {
  for await (const entry of sourceDir.values()) {
    if (entry.kind === 'file') await copyFile(entry, targetDir, entry.name);
    else {
      const child = await targetDir.getDirectoryHandle(entry.name, { create: true });
      await copyDirectory(entry, child);
    }
  }
}

export class Vault {
  constructor(handle) {
    this.handle = handle;
    this.name = handle.name;
    this.nodes = new Map();
    this.contents = new Map();
  }

  async permission(request = false) {
    if (typeof this.handle.queryPermission !== 'function') return 'granted';
    const options = { mode: 'readwrite' };
    let state = await this.handle.queryPermission(options);
    if (state !== 'granted' && request) state = await this.handle.requestPermission(options);
    return state;
  }

  async scan() {
    this.nodes.clear();
    this.contents.clear();
    const root = { kind: 'directory', name: this.name, path: '', parentPath: '', handle: this.handle, children: [] };
    this.nodes.set('', root);
    await this.#scanDirectory(this.handle, '', root);
    return root;
  }

  async #scanDirectory(handle, parentPath, parentNode) {
    const entries = [];
    for await (const entry of handle.values()) {
      if (entry.name === '.trash') continue;
      entries.push(entry);
    }
    entries.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-Hant', { numeric: true }) : a.kind === 'directory' ? -1 : 1);
    for (const entry of entries) {
      const path = join(parentPath, entry.name);
      const node = { kind: entry.kind, name: entry.name, path, parentPath, handle: entry, children: [] };
      if (entry.kind === 'file') {
        const file = await entry.getFile();
        node.lastModified = file.lastModified;
        node.size = file.size;
        node.ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';
      }
      this.nodes.set(path, node);
      parentNode.children.push(node);
      if (entry.kind === 'directory') await this.#scanDirectory(entry, path, node);
    }
  }

  node(path) { return this.nodes.get(path) || null; }
  markdownNodes() { return [...this.nodes.values()].filter(node => node.kind === 'file' && node.ext === 'md'); }
  canvasNodes() { return [...this.nodes.values()].filter(node => node.kind === 'file' && node.ext === 'canvas'); }

  async directory(path = '') {
    let handle = this.handle;
    for (const part of path.split('/').filter(Boolean)) handle = await handle.getDirectoryHandle(part);
    return handle;
  }

  async readText(path, fresh = false) {
    const node = this.node(path);
    if (!node || node.kind !== 'file') throw new Error(`找不到檔案：${path}`);
    if (!fresh && this.contents.has(path)) return this.contents.get(path);
    const file = await node.handle.getFile();
    const text = await file.text();
    node.lastModified = file.lastModified;
    node.size = file.size;
    this.contents.set(path, text);
    return text;
  }

  async readBlob(path) {
    const node = this.node(path);
    if (!node || node.kind !== 'file') throw new Error(`找不到檔案：${path}`);
    return node.handle.getFile();
  }

  async writeText(path, text, expectedModified = null) {
    const parent = await this.directory(dirname(path));
    const handle = await parent.getFileHandle(basename(path), { create: true });
    const before = await handle.getFile();
    if (expectedModified && before.lastModified !== expectedModified) {
      const error = new Error('這份筆記已被其他程式修改');
      error.name = 'ExternalChangeError';
      error.externalText = await before.text();
      error.externalModified = before.lastModified;
      throw error;
    }
    const writer = await handle.createWritable();
    await writer.write(text);
    await writer.close();
    const after = await handle.getFile();
    this.contents.set(path, text);
    const node = this.node(path);
    if (node) {
      node.handle = handle;
      node.lastModified = after.lastModified;
      node.size = after.size;
    }
    return after.lastModified;
  }

  async uniqueName(parentPath, desired) {
    const dir = await this.directory(parentPath);
    const dot = desired.lastIndexOf('.');
    const stem = dot > 0 ? desired.slice(0, dot) : desired;
    const ext = dot > 0 ? desired.slice(dot) : '';
    let candidate = desired;
    let counter = 2;
    while (true) {
      try {
        await dir.getFileHandle(candidate);
        candidate = `${stem} ${counter++}${ext}`;
      } catch (error) {
        if (error.name === 'NotFoundError') return candidate;
        throw error;
      }
    }
  }

  async createNote(parentPath = '', desired = '未命名筆記.md') {
    const dir = await this.directory(parentPath);
    const name = await this.uniqueName(parentPath, safeName(desired, '.md'));
    const handle = await dir.getFileHandle(name, { create: true });
    const initial = `# ${name.replace(/\.md$/i, '')}\n\n`;
    const writer = await handle.createWritable();
    await writer.write(initial);
    await writer.close();
    await this.scan();
    this.contents.set(join(parentPath, name), initial);
    return this.node(join(parentPath, name));
  }

  async createCanvas(parentPath = '', desired = '未命名.canvas') {
    const dir = await this.directory(parentPath);
    const name = await this.uniqueName(parentPath, safeName(desired, '.canvas'));
    const handle = await dir.getFileHandle(name, { create: true });
    const initial = JSON.stringify({ nodes: [], edges: [] }, null, 2);
    const writer = await handle.createWritable();
    await writer.write(initial);
    await writer.close();
    await this.scan();
    this.contents.set(join(parentPath, name), initial);
    return this.node(join(parentPath, name));
  }

  async createFolder(parentPath = '', desired = '新資料夾') {
    const parent = await this.directory(parentPath);
    let name = safeName(desired);
    let counter = 2;
    while (true) {
      try {
        await parent.getDirectoryHandle(name);
        name = `${safeName(desired)} ${counter++}`;
      } catch (error) {
        if (error.name === 'NotFoundError') break;
        throw error;
      }
    }
    await parent.getDirectoryHandle(name, { create: true });
    await this.scan();
    return this.node(join(parentPath, name));
  }

  async rename(path, newName) {
    const node = this.node(path);
    if (!node || !path) throw new Error('無法重新命名筆記庫根目錄');
    const parent = await this.directory(node.parentPath);
    const name = safeName(newName, node.kind === 'file' && node.ext ? `.${node.ext}` : '');
    const targetPath = join(node.parentPath, name);
    if (targetPath === path) return targetPath;
    if (this.node(targetPath)) throw new Error('同一個位置已經有相同名稱');
    if (node.kind === 'file') await copyFile(node.handle, parent, name);
    else {
      const target = await parent.getDirectoryHandle(name, { create: true });
      await copyDirectory(node.handle, target);
    }
    await parent.removeEntry(node.name, { recursive: true });
    const cached = this.contents.get(path);
    this.contents.delete(path);
    await this.scan();
    if (cached != null) this.contents.set(targetPath, cached);
    return targetPath;
  }

  async move(path, destinationPath) {
    const node = this.node(path);
    const destination = this.node(destinationPath);
    if (!node || !destination || destination.kind !== 'directory') throw new Error('移動目的地必須是資料夾');
    if (!path || destinationPath === node.parentPath) return path;
    if (destinationPath === path || destinationPath.startsWith(`${path}/`)) throw new Error('不能把資料夾移到自己裡面');
    const targetPath = join(destinationPath, node.name);
    if (this.node(targetPath)) throw new Error('目的地已經有相同名稱');
    const targetDir = await this.directory(destinationPath);
    if (node.kind === 'file') await copyFile(node.handle, targetDir, node.name);
    else {
      const created = await targetDir.getDirectoryHandle(node.name, { create: true });
      await copyDirectory(node.handle, created);
    }
    const sourceParent = await this.directory(node.parentPath);
    await sourceParent.removeEntry(node.name, { recursive: true });
    const cached = this.contents.get(path);
    this.contents.delete(path);
    await this.scan();
    if (cached != null) this.contents.set(targetPath, cached);
    return targetPath;
  }

  async remove(path, useTrash = true) {
    const node = this.node(path);
    if (!node || !path) throw new Error('找不到要刪除的項目');
    if (useTrash) {
      const trash = await this.handle.getDirectoryHandle('.trash', { create: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const targetName = `${stamp}__${node.name}`;
      if (node.kind === 'file') await copyFile(node.handle, trash, targetName);
      else {
        const target = await trash.getDirectoryHandle(targetName, { create: true });
        await copyDirectory(node.handle, target);
      }
    }
    const parent = await this.directory(node.parentPath);
    await parent.removeEntry(node.name, { recursive: true });
    for (const key of [...this.contents.keys()]) if (key === path || key.startsWith(`${path}/`)) this.contents.delete(key);
    await this.scan();
  }

  async importFiles(parentPath, files) {
    const target = await this.directory(parentPath);
    const imported = [];
    for (const file of files) {
      const name = await this.uniqueName(parentPath, safeName(file.name));
      const handle = await target.getFileHandle(name, { create: true });
      const writer = await handle.createWritable();
      await writer.write(file);
      await writer.close();
      imported.push(join(parentPath, name));
    }
    await this.scan();
    return imported;
  }
}
