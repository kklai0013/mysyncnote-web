import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../js/storage.js';

function notFound() {
  const error = new Error('Not found');
  error.name = 'NotFoundError';
  return error;
}

class FakeFileHandle {
  constructor(name, content = '', modified = 100) {
    this.kind = 'file';
    this.name = name;
    this.content = content;
    this.modified = modified;
  }

  async getFile() {
    const content = this.content;
    return {
      lastModified: this.modified,
      size: content.length,
      text: async () => content
    };
  }

  async createWritable() {
    return {
      write: async value => { this.content = String(value); },
      close: async () => { this.modified += 1; }
    };
  }
}

class FakeDirectoryHandle {
  constructor(name = 'vault') {
    this.kind = 'directory';
    this.name = name;
    this.entries = new Map();
  }

  async getFileHandle(name, options = {}) {
    if (this.entries.has(name)) return this.entries.get(name);
    if (!options.create) throw notFound();
    const handle = new FakeFileHandle(name);
    this.entries.set(name, handle);
    return handle;
  }

  async getDirectoryHandle(name) {
    const handle = this.entries.get(name);
    if (!handle || handle.kind !== 'directory') throw notFound();
    return handle;
  }
}

test('受保護儲存遇到外部刪除時不會偷偷重建空檔案', async () => {
  const root = new FakeDirectoryHandle();
  const vault = new Vault(root);
  vault.nodes.set('story.timeline', {
    kind: 'file',
    name: 'story.timeline',
    path: 'story.timeline',
    parentPath: '',
    handle: new FakeFileHandle('story.timeline', '舊內容', 100),
    lastModified: 100
  });

  await assert.rejects(
    vault.writeText('story.timeline', '本機內容', 100),
    error => error.name === 'ExternalChangeError' && error.externalDeleted === true
  );
  assert.equal(root.entries.has('story.timeline'), false);
});

test('使用者明確選擇保留目前版本時才允許重建檔案', async () => {
  const root = new FakeDirectoryHandle();
  const vault = new Vault(root);
  vault.nodes.set('story.timeline', {
    kind: 'file',
    name: 'story.timeline',
    path: 'story.timeline',
    parentPath: '',
    handle: new FakeFileHandle('story.timeline', '舊內容', 100),
    lastModified: 100
  });

  await vault.writeText('story.timeline', '本機內容', null);
  assert.equal(root.entries.get('story.timeline').content, '本機內容');
});

test('外部修改衝突會保留外部內容而不是覆寫', async () => {
  const root = new FakeDirectoryHandle();
  const external = new FakeFileHandle('story.timeline', 'FolderSync 新內容', 200);
  root.entries.set('story.timeline', external);
  const vault = new Vault(root);
  vault.nodes.set('story.timeline', {
    kind: 'file',
    name: 'story.timeline',
    path: 'story.timeline',
    parentPath: '',
    handle: external,
    lastModified: 100
  });

  await assert.rejects(
    vault.writeText('story.timeline', '本機內容', 100),
    error => error.name === 'ExternalChangeError' && error.externalText === 'FolderSync 新內容'
  );
  assert.equal(external.content, 'FolderSync 新內容');
});
