import { Vault, rememberVault, recalledVault, rememberSettingsFolder, recalledSettingsFolder, safeName, dirname, basename } from './storage.js?v=19';
import { renderMarkdown, extractHeadings, extractTags, extractLinks, buildIndex, noteStem, replaceWikiTarget, parseFrontmatter } from './markdown.js';
import { GraphView } from './graph.js';
import { CanvasView } from './canvas.js?v=17';
import { LiveMarkdownEditor } from './live-editor.js';
import { createEmptyTimeline } from './timeline.js?v=24';
import { TimelineView } from './timeline-daw.js?v=25';

const $ = id => document.getElementById(id);
const app = $('app');
const LAYOUT_VERSION = 3;
const DEFAULT_SHORTCUTS = { save: 'Ctrl+S', close: 'Ctrl+W', command: 'Ctrl+P', search: 'Ctrl+K', newNote: 'Ctrl+N', graph: 'Ctrl+G', rename: 'F2', toggleLeft: 'Ctrl+B', split: 'Ctrl+\\', timelineNewEvent: 'E', timelineNewTrack: 'T', timelineNewGroup: 'G' };
const LEGACY_TIMELINE_SHORTCUTS = { timelineNewEvent: 'Ctrl+Enter', timelineNewTrack: 'Ctrl+Shift+Enter', timelineNewGroup: 'Ctrl+Alt+Enter' };
const SHORTCUT_LABELS = { save: '立即儲存', close: '關閉目前筆記或 Canvas', command: '命令面板', search: '搜尋筆記庫', newNote: '新增筆記', graph: '顯示／關閉關聯圖譜', rename: '重新命名選取項目', toggleLeft: '顯示／收起左側欄', split: '將目前筆記分割到新窗格', timelineNewEvent: '時間線：新增事件', timelineNewTrack: '時間線：新增軌道', timelineNewGroup: '時間線：新增軌道資料夾' };
function migrateShortcutDefaults(shortcuts = {}) {
  const migrated = { ...DEFAULT_SHORTCUTS, ...shortcuts };
  for (const [key, oldValue] of Object.entries(LEGACY_TIMELINE_SHORTCUTS)) {
    if (shortcuts[key] == null || shortcuts[key] === oldValue) migrated[key] = DEFAULT_SHORTCUTS[key];
  }
  return migrated;
}
const settings = Object.assign({ attachmentFolder: 'attachments', trashMode: 'trash', updateLinks: true, autoSave: true, settingsFileName: 'mysyncnote-settings.json', shortcuts: { ...DEFAULT_SHORTCUTS } }, JSON.parse(localStorage.getItem('mysyncnote-preferences') || '{}'));
settings.shortcuts = migrateShortcutDefaults(settings.shortcuts);
for (const key of Object.keys(DEFAULT_SHORTCUTS)) if (typeof settings.shortcuts[key] !== 'string') settings.shortcuts[key] = '';
localStorage.setItem('mysyncnote-preferences', JSON.stringify(settings));
let vault = null;
let rememberedHandle = null;
let settingsFolderHandle = null;
let index = null;
let selectedPath = '';
let inlineRenamePath = '';
let fileClipboard = null;
let currentPath = '';
let currentType = '';
let loadedModified = null;
let dirty = false;
let editRevision = 0;
let currentCanvasValid = true;
let currentTimelineValid = true;
let autoSaveTimer = null;
let saveChain = Promise.resolve();
let saveGeneration = 0;
let openGeneration = 0;
let fileOperationDepth = 0;
let indexingTimer = null;
let rightPanel = 'outline';
let viewMode = localStorage.getItem('mysyncnote-view') || 'live';
let currentView = 'welcome';
let graphDocked = false;
let tabs = [];
let secondaryGroupStates = [];
const secondaryPanes = new Map();
let paneLayoutReady = false;
let paneLayoutTree = null;
let paneParking = null;
let activePaneSlot = null;
let pendingLayoutModel = null;
let history = [];
let historyIndex = -1;
let objectUrls = [];
const expanded = new Set(JSON.parse(localStorage.getItem('mysyncnote-expanded') || '[]'));

function persistSettings() {
  localStorage.setItem('mysyncnote-preferences', JSON.stringify(settings));
  localStorage.setItem('mysyncnote-expanded', JSON.stringify([...expanded]));
  updateShortcutHints();
  scheduleSettingsFileWrite();
}

function vaultStateKey() { return vault ? `mysyncnote-vault-state:${vault.name}` : ''; }
function readVaultState() {
  try { return JSON.parse(localStorage.getItem(vaultStateKey()) || '{}'); } catch { return {}; }
}
function persistVaultState() {
  if (!vault) return;
  const secondaryGroups = [...secondaryPanes.values()].map(pane => ({ id: pane.id, path: pane.path, tabs: pane.tabs, mode: pane.mode }));
  localStorage.setItem(vaultStateKey(), JSON.stringify({ layoutVersion: LAYOUT_VERSION, currentPath, selectedPath, tabs, secondaryGroups, graphDocked, viewMode, layout: serializePaneLayout() }));
}

let settingsWriteTimer = null;
function scheduleSettingsFileWrite() {
  clearTimeout(settingsWriteTimer);
  if (settingsFolderHandle) settingsWriteTimer = setTimeout(writeSettingsFile, 350);
}

async function writeSettingsFile() {
  if (!settingsFolderHandle) return;
  try {
    if (await settingsFolderHandle.queryPermission({ mode: 'readwrite' }) !== 'granted') return;
    const name = safeName(settings.settingsFileName || 'mysyncnote-settings.json', '.json');
    const file = await settingsFolderHandle.getFileHandle(name, { create: true });
    const writer = await file.createWritable();
    await writer.write(JSON.stringify({ version: 1, ...settings }, null, 2));
    await writer.close();
    $('settingsFileLocation').textContent = `${settingsFolderHandle.name}/${name}`;
  } catch (error) { toast(`設定檔無法儲存：${error.message}`, true); }
}

async function loadSettingsFile(handle) {
  try {
    if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') return false;
    const name = safeName(settings.settingsFileName || 'mysyncnote-settings.json', '.json');
    const fileHandle = await handle.getFileHandle(name);
    const incoming = JSON.parse(await (await fileHandle.getFile()).text());
    Object.assign(settings, incoming, { shortcuts: migrateShortcutDefaults(incoming.shortcuts) });
    for (const key of Object.keys(DEFAULT_SHORTCUTS)) if (typeof settings.shortcuts[key] !== 'string') settings.shortcuts[key] = '';
    localStorage.setItem('mysyncnote-preferences', JSON.stringify(settings));
    settingsFolderHandle = handle;
    updateShortcutHints();
    $('settingsFileLocation').textContent = `${handle.name}/${name}`;
    return true;
  } catch (error) {
    if (error.name !== 'NotFoundError') console.warn('設定檔讀取失敗', error);
    return false;
  }
}

async function chooseSettingsFolder() {
  if (!window.showDirectoryPicker) return toast('這個瀏覽器不能選擇設定檔資料夾', true);
  beginFileOperation('正在選擇設定檔資料夾…');
  try {
    const handle = await showDirectoryPicker({ mode: 'readwrite' });
    settingsFolderHandle = handle;
    await rememberSettingsFolder(handle);
    await writeSettingsFile();
    toast(`設定檔會儲存在「${handle.name}」`);
  } catch (error) {
    if (error.name !== 'AbortError') toast(error.message, true);
  } finally {
    endFileOperation();
  }
}

function toast(message, error = false) {
  const element = $('toast');
  element.textContent = message;
  element.className = `toast${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), error ? 6000 : 3200);
}

function beginFileOperation(message = '正在安全處理檔案…') {
  if (fileOperationDepth === 0) {
    $('contextMenu').classList.add('hidden');
    openGeneration += 1;
    setPrimaryLoading(false);
    for (const pane of secondaryPanes.values()) {
      pane.openGeneration += 1;
      pane.element.inert = false;
      pane.element.classList.remove('loading');
    }
  }
  fileOperationDepth += 1;
  $('fileOperationMessage').textContent = message;
  $('fileOperationOverlay').classList.remove('hidden');
  app.inert = true;
  app.setAttribute('aria-busy', 'true');
}

function endFileOperation() {
  fileOperationDepth = Math.max(0, fileOperationDepth - 1);
  if (fileOperationDepth) return;
  app.inert = false;
  app.removeAttribute('aria-busy');
  $('fileOperationOverlay').classList.add('hidden');
}

function setPrimaryLoading(loading) {
  const body = document.querySelector('.primary-editor-group .editor-group-body');
  if (!body) return;
  body.inert = loading;
  body.classList.toggle('loading', loading);
}

function setSaveState(text, error = false) {
  $('saveState').textContent = text;
  $('saveState').classList.toggle('error', error);
  $('canvasState').textContent = text;
  $('timelineState').textContent = text;
}

function updateWelcome() {
  const opened = Boolean(vault);
  $('welcomeTitle').textContent = opened ? '沒有開啟的筆記' : '你的 Markdown 筆記庫';
  $('welcomeMessage').innerHTML = opened ? '從左側選擇筆記、Canvas 或時間線，或建立一篇新筆記。' : '直接開啟電腦或手機上的資料夾。筆記保持為一般的 <code>.md</code>、附件、<code>.canvas</code> 和 <code>.timeline</code> 檔案。';
  $('welcomeOpen').textContent = opened ? '新增筆記' : '開啟筆記庫';
  $('welcomeOpen').onclick = () => opened ? createNote() : openVaultPicker();
}

function primaryViewForType(type = currentType) {
  if (type === 'canvas') return 'canvas';
  if (type === 'timeline') return 'timeline';
  return currentPath ? 'note' : 'welcome';
}

function showView(name) {
  if (name === 'graph') {
    graphDocked = true;
    name = currentPath ? primaryViewForType() : 'graph';
  }
  currentView = name;
  const workspaceVisible = name !== 'welcome' || graphDocked || secondaryPanes.size > 0;
  $('welcome').classList.toggle('hidden', workspaceVisible);
  $('workspaceDock').classList.toggle('hidden', !workspaceVisible);
  $('noteWorkspace').classList.toggle('hidden', name !== 'note');
  $('canvasWorkspace').classList.toggle('hidden', name !== 'canvas');
  $('timelineWorkspace').classList.toggle('hidden', name !== 'timeline');
  $('graphWorkspace').classList.toggle('hidden', !graphDocked);
  const activePath = activeDocumentPath();
  $('splitCurrent').disabled = !activePath || vault?.node(activePath)?.ext !== 'md';
  updateWelcome();
}

function hideMobilePanels() {
  app.classList.remove('left-open', 'right-open');
}

function initPaneLayout() {
  if (paneLayoutReady) return;
  const dock = $('workspaceDock');
  paneParking = document.createElement('div'); paneParking.className = 'pane-parking hidden';
  const graphWorkspace = $('graphWorkspace');
  const primary = createPaneSlot('primary');
  const primaryGroup = document.createElement('section'); primaryGroup.className = 'editor-group primary-editor-group dock-pane'; primaryGroup.dataset.groupId = 'primary';
  const primaryBody = document.createElement('div'); primaryBody.className = 'editor-group-body';
  $('tabs').classList.add('group-tabs'); primaryBody.append($('noteWorkspace'), $('canvasWorkspace'), $('timelineWorkspace')); primaryGroup.append($('tabs'), primaryBody); primary.append(primaryGroup);
  paneParking.append(graphWorkspace);
  paneLayoutTree = primary;
  dock.innerHTML = '';
  dock.append(paneLayoutTree, paneParking);
  activePaneSlot = primary; primary.classList.add('active-pane-slot');
  paneLayoutReady = true;
}

function createPaneSlot(key) {
  const slot = document.createElement('div');
  slot.className = 'pane-slot'; slot.dataset.paneKey = key;
  slot.addEventListener('pointerdown', () => setActivePaneSlot(slot));
  slot.addEventListener('dragover', event => {
    const types = [...event.dataTransfer.types];
    if (!types.includes('text/mysyncnote-path') && !types.includes('text/mysyncnote-pane') && !types.includes('text/mysyncnote-tab')) return;
    event.preventDefault();
    const rect = slot.getBoundingClientRect(), x = (event.clientX - rect.left) / rect.width, y = (event.clientY - rect.top) / rect.height;
    const edge = .22;
    const direction = x < edge ? 'left' : x > 1 - edge ? 'right' : y < edge ? 'top' : y > 1 - edge ? 'bottom' : 'center';
    slot.dataset.dropDirection = direction;
  });
  slot.addEventListener('dragleave', event => { if (!slot.contains(event.relatedTarget)) delete slot.dataset.dropDirection; });
  slot.addEventListener('drop', async event => {
    event.preventDefault(); event.stopPropagation();
    const direction = slot.dataset.dropDirection || 'right'; delete slot.dataset.dropDirection;
    const paneId = event.dataTransfer.getData('text/mysyncnote-pane');
    const tabData = event.dataTransfer.getData('text/mysyncnote-tab');
    const filePath = event.dataTransfer.getData('text/mysyncnote-path');
    if (paneId && secondaryPanes.has(paneId) && direction !== 'center') movePaneSlot(secondaryPanes.get(paneId).element.closest('.pane-slot'), slot, direction);
    else if (tabData) {
      try { await placeDraggedTab(JSON.parse(tabData), slot, direction); } catch (error) { toast(error.message, true); }
    } else if (filePath) {
      if (direction === 'center') await openPathInSlot(filePath, slot);
      else await addSecondaryPane(filePath, direction, slot);
    }
  });
  return slot;
}

function setActivePaneSlot(slot) {
  if (!slot?.classList.contains('pane-slot')) return;
  if (activePaneSlot !== slot) { activePaneSlot?.classList.remove('active-pane-slot'); activePaneSlot = slot; slot.classList.add('active-pane-slot'); }
  const pane = secondaryPaneForSlot(slot);
  const path = pane?.path || (slot.dataset.paneKey === 'primary' ? currentPath : '');
  if (path) { const changed = selectedPath !== path; selectedPath = path; $('breadcrumbs').textContent = path; $('splitCurrent').disabled = vault?.node(path)?.ext !== 'md'; if (changed) renderTree(); }
}

function makeSplit(orientation, children) {
  const split = document.createElement('div'); split.className = `pane-split ${orientation}`;
  children.forEach(child => split.append(child)); refreshSplitters(split); return split;
}

function refreshSplitters(split) {
  split.querySelectorAll(':scope > .pane-resizer').forEach(item => item.remove());
  const children = [...split.children];
  for (let i = children.length - 1; i > 0; i--) {
    const resizer = document.createElement('div'); resizer.className = 'pane-resizer';
    split.insertBefore(resizer, children[i]);
    resizer.addEventListener('pointerdown', event => {
      event.preventDefault(); resizer.setPointerCapture(event.pointerId);
      const before = resizer.previousElementSibling, after = resizer.nextElementSibling;
      const a = before.getBoundingClientRect(), b = after.getBoundingClientRect();
      const start = split.classList.contains('horizontal') ? event.clientX : event.clientY;
      const sizeA = split.classList.contains('horizontal') ? a.width : a.height, sizeB = split.classList.contains('horizontal') ? b.width : b.height;
      const move = moveEvent => {
        const now = split.classList.contains('horizontal') ? moveEvent.clientX : moveEvent.clientY, delta = now - start;
        before.style.flex = `0 0 ${Math.max(180, sizeA + delta)}px`; after.style.flex = `0 0 ${Math.max(180, sizeB - delta)}px`;
      };
      const up = () => { resizer.removeEventListener('pointermove', move); resizer.removeEventListener('pointerup', up); persistVaultState(); };
      resizer.addEventListener('pointermove', move); resizer.addEventListener('pointerup', up);
    });
  }
}

function insertPane(element, key, direction = 'right', targetSlot = activePaneSlot) {
  initPaneLayout();
  const existing = element.closest('.pane-slot');
  if (existing && existing !== targetSlot) { movePaneSlot(existing, targetSlot, direction); return existing; }
  if (existing) return existing;
  const slot = createPaneSlot(key); slot.append(element);
  targetSlot ||= paneLayoutTree.querySelector?.('.pane-slot') || paneLayoutTree;
  const orientation = direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical';
  const before = direction === 'left' || direction === 'top';
  const parent = targetSlot.parentElement;
  if (parent?.classList.contains('pane-split') && parent.classList.contains(orientation)) {
    parent.insertBefore(slot, before ? targetSlot : targetSlot.nextSibling); refreshSplitters(parent);
  } else {
    const split = document.createElement('div'); split.className = `pane-split ${orientation}`;
    if (targetSlot === paneLayoutTree) { $('workspaceDock').replaceChild(split, paneLayoutTree); paneLayoutTree = split; }
    else parent.replaceChild(split, targetSlot);
    (before ? [slot, targetSlot] : [targetSlot, slot]).forEach(child => split.append(child)); refreshSplitters(split);
  }
  setActivePaneSlot(slot); persistVaultState(); return slot;
}

function movePaneSlot(source, target, direction) {
  if (!source || !target || source === target || source.contains(target)) return;
  detachPaneSlot(source, false);
  const orientation = direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical', before = direction === 'left' || direction === 'top';
  const parent = target.parentElement;
  if (parent?.classList.contains('pane-split') && parent.classList.contains(orientation)) { parent.insertBefore(source, before ? target : target.nextSibling); refreshSplitters(parent); }
  else {
    const split = document.createElement('div'); split.className = `pane-split ${orientation}`;
    if (target === paneLayoutTree) { $('workspaceDock').replaceChild(split, paneLayoutTree); paneLayoutTree = split; }
    else parent.replaceChild(split, target);
    (before ? [source, target] : [target, source]).forEach(child => split.append(child)); refreshSplitters(split);
  }
  setActivePaneSlot(source); persistVaultState();
}

function detachPaneSlot(slot, parkContents = true) {
  if (!slot || slot.dataset.paneKey === 'primary') return;
  const wasActive = activePaneSlot === slot;
  const parent = slot.parentElement;
  if (parkContents) while (slot.firstChild) paneParking.append(slot.firstChild);
  slot.remove();
  if (parent?.classList.contains('pane-split')) {
    const children = [...parent.children].filter(child => !child.classList.contains('pane-resizer'));
    if (children.length === 1) {
      const only = children[0], grand = parent.parentElement;
      only.style.flex = ''; only.style.flexBasis = '';
      if (parent === paneLayoutTree) { $('workspaceDock').replaceChild(only, parent); paneLayoutTree = only; }
      else grand.replaceChild(only, parent);
    } else refreshSplitters(parent);
  }
  if (wasActive || !activePaneSlot?.isConnected) {
    activePaneSlot = null;
    setActivePaneSlot(document.querySelector('.pane-slot[data-pane-key="primary"]') || paneLayoutTree.querySelector?.('.pane-slot') || paneLayoutTree);
  }
  if (paneLayoutTree?.classList.contains('pane-slot')) { paneLayoutTree.style.flex = ''; paneLayoutTree.style.flexBasis = ''; }
  persistVaultState();
}

function serializePaneLayout(node = paneLayoutTree) {
  if (!paneLayoutReady || !node) return null;
  if (node.classList.contains('pane-slot')) return { type: 'pane', key: node.dataset.paneKey, size: node.style.flexBasis || '' };
  return { type: 'split', orientation: node.classList.contains('vertical') ? 'vertical' : 'horizontal', children: [...node.children].filter(child => !child.classList.contains('pane-resizer')).map(serializePaneLayout) };
}

function restorePaneLayout(model) {
  if (!model || !paneLayoutReady) return;
  const primaryGroup = document.querySelector('.primary-editor-group');
  const elements = new Map([['primary', [primaryGroup]], ['graph', [$('graphWorkspace')]]]);
  secondaryPanes.forEach(pane => elements.set(`group:${pane.id}`, [pane.element]));
  for (const [key, list] of elements) if (key !== 'primary') list.forEach(element => paneParking.append(element));
  const build = item => {
    if (item.type === 'pane') {
      if (item.key === 'graph' && !graphDocked) return null;
      const list = elements.get(item.key); if (!list) return null;
      const slot = createPaneSlot(item.key); list.forEach(element => slot.append(element)); if (item.size) slot.style.flexBasis = item.size; elements.delete(item.key); return slot;
    }
    const children = (item.children || []).map(build).filter(Boolean); return children.length > 1 ? makeSplit(item.orientation || 'horizontal', children) : children[0] || null;
  };
  let tree = build(model);
  if (!tree) {
    tree = createPaneSlot('primary');
    (elements.get('primary') || [primaryGroup]).forEach(element => tree.append(element));
    elements.delete('primary');
  }
  if (!tree.querySelector?.('[data-pane-key="primary"]') && tree.dataset.paneKey !== 'primary') {
    const primary = createPaneSlot('primary');
    (elements.get('primary') || [primaryGroup]).forEach(element => primary.append(element));
    elements.delete('primary'); paneLayoutTree = makeSplit('horizontal', [primary, tree]);
  } else paneLayoutTree = tree;
  const old = [...$('workspaceDock').children].find(child => child !== paneParking);
  if (old) $('workspaceDock').replaceChild(paneLayoutTree, old); else $('workspaceDock').insertBefore(paneLayoutTree, paneParking);
  for (const [key, list] of elements) {
    if (key === 'primary') continue;
    if (key === 'graph' && !graphDocked) { list.forEach(element => paneParking.append(element)); continue; }
    const slot = createPaneSlot(key); list.forEach(element => slot.append(element));
    const tree = paneLayoutTree, split = document.createElement('div'); split.className = 'pane-split horizontal';
    $('workspaceDock').replaceChild(split, tree); split.append(tree, slot); refreshSplitters(split); paneLayoutTree = split;
  }
  setActivePaneSlot(paneLayoutTree.querySelector?.('.pane-slot') || paneLayoutTree);
  if (paneLayoutTree?.classList.contains('pane-slot')) { paneLayoutTree.style.flex = ''; paneLayoutTree.style.flexBasis = ''; }
}

async function ask(title, value = '', help = '') {
  $('dialogTitle').textContent = title;
  $('dialogHelp').textContent = help;
  $('dialogInput').value = value;
  $('inputDialog').showModal();
  setTimeout(() => { $('dialogInput').focus(); $('dialogInput').select(); }, 0);
  const result = await new Promise(resolve => $('inputDialog').addEventListener('close', () => resolve($('inputDialog').returnValue), { once: true }));
  return result === 'default' ? $('dialogInput').value.trim() : null;
}

async function confirmAction(title, message, okText = '確認', danger = true) {
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('confirmExtra').innerHTML = '';
  $('confirmOk').textContent = okText;
  $('confirmOk').className = danger ? 'danger' : 'primary';
  $('confirmDialog').showModal();
  const result = await new Promise(resolve => $('confirmDialog').addEventListener('close', () => resolve($('confirmDialog').returnValue), { once: true }));
  return result === 'default';
}

async function chooseFromList(title, items, getLabel = item => item, placeholder = '搜尋…') {
  $('commandSearch').placeholder = placeholder;
  $('commandSearch').value = '';
  $('commandDialog').showModal();
  const render = () => {
    const query = $('commandSearch').value.toLowerCase();
    $('commandResults').innerHTML = '';
    for (const item of items.filter(candidate => getLabel(candidate).toLowerCase().includes(query)).slice(0, 80)) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'command-result';
      button.innerHTML = '<span>›</span><span></span>';
      button.lastChild.textContent = getLabel(item) || '筆記庫根目錄';
      button.onclick = () => { $('commandDialog').returnValue = JSON.stringify(item); $('commandDialog').close(); };
      $('commandResults').append(button);
    }
    if (!$('commandResults').children.length) $('commandResults').innerHTML = `<div class="panel-empty">${title}：找不到符合項目</div>`;
  };
  render();
  setTimeout(() => $('commandSearch').focus(), 0);
  const listener = () => render();
  $('commandSearch').addEventListener('input', listener);
  const result = await new Promise(resolve => $('commandDialog').addEventListener('close', () => resolve($('commandDialog').returnValue), { once: true }));
  $('commandSearch').removeEventListener('input', listener);
  try { return result ? JSON.parse(result) : null; } catch { return null; }
}

function selectedFolder() {
  const selected = vault?.node(selectedPath);
  if (selected?.kind === 'directory') return selected.path;
  if (selected?.kind === 'file') return selected.parentPath;
  const activePath = activeDocumentPath();
  if (activePath) return dirname(activePath);
  return '';
}

async function openVaultPicker() {
  if (!window.showDirectoryPicker) {
    toast('這個瀏覽器不能直接開啟資料夾。請使用最新版 Chrome 或 Edge，並從 HTTPS 網址開啟。', true);
    return;
  }
  beginFileOperation('正在選擇筆記庫…');
  try {
    let handle;
    if (rememberedHandle) {
      const permission = await rememberedHandle.requestPermission({ mode: 'readwrite' });
      if (permission === 'granted') handle = rememberedHandle;
    }
    if (!handle) handle = await showDirectoryPicker({ mode: 'readwrite' });
    await loadVault(handle);
    await rememberVault(handle);
    rememberedHandle = null;
  } catch (error) {
    if (error.name !== 'AbortError') toast(`${error.name}: ${error.message}`, true);
  } finally {
    endFileOperation();
  }
}

async function loadVault(handle) {
  beginFileOperation(`正在開啟「${handle.name}」…`);
  try {
    if (dirty || [...secondaryPanes.values()].some(pane => pane.dirty)) {
      await saveAllPanes();
      if (dirty || [...secondaryPanes.values()].some(pane => pane.dirty)) throw new Error('仍有內容尚未儲存；請先處理衝突，再更換筆記庫');
    }
    const nextVault = new Vault(handle);
    if (await nextVault.permission(true) !== 'granted') throw new Error('沒有筆記庫的讀寫權限');
    $('vaultState').textContent = '正在讀取…';
    await nextVault.scan();
    saveGeneration += 1;
    openGeneration += 1;
    clearTimeout(autoSaveTimer);
    fileClipboard = null;
    inlineRenamePath = '';
    currentPath = '';
    currentType = '';
    loadedModified = null;
    dirty = false;
    editRevision = 0;
    currentCanvasValid = true;
    currentTimelineValid = true;
    tabs = [];
    history = [];
    historyIndex = -1;
    vault = nextVault;
    $('vaultName').textContent = vault.name;
    $('vaultState').textContent = '本機筆記庫';
    $('openVaultText').textContent = '更換筆記庫';
    $('settingsVault').textContent = vault.name;
    localStorage.setItem('mysyncnote-vault-name', vault.name);
    await rebuildIndex();
    const previous = readVaultState();
    if (['live', 'edit', 'split', 'read'].includes(previous.viewMode)) {
      viewMode = previous.viewMode;
      localStorage.setItem('mysyncnote-view', viewMode);
    }
    selectedPath = vault.node(previous.selectedPath) && !isHiddenAppFile(vault.node(previous.selectedPath)) ? previous.selectedPath : '';
    tabs = (previous.tabs || []).filter(path => vault.node(path));
    secondaryGroupStates = (previous.secondaryGroups || (previous.secondaryPanePaths || []).map((path, index) => ({ id: `legacy-${index}`, path, tabs: [path], mode: 'live' })))
      .map((group, index) => ({ id: String(group.id || `group-${index}`), path: group.path, tabs: (group.tabs || [group.path]).filter(path => vault.node(path)?.ext === 'md'), mode: ['live', 'edit', 'split', 'read'].includes(group.mode) ? group.mode : 'live' }))
      .filter(group => group.tabs.length && vault.node(group.path)?.ext === 'md');
    graphDocked = Boolean(previous.graphDocked);
    pendingLayoutModel = previous.layoutVersion === LAYOUT_VERSION ? previous.layout || null : null;
    if (selectedPath) for (let path = selectedPath; path; path = dirname(path)) expanded.add(path);
    renderTree();
    if (vault.node(previous.currentPath)?.kind === 'file') {
      await openPath(previous.currentPath, false, true);
    } else if (tabs.length) {
      await openPath(tabs[0], false, true);
    } else {
      const candidates = [...vault.markdownNodes(), ...vault.canvasNodes(), ...vault.timelineNodes()];
      const first = candidates[0];
      if (first) await openPath(first.path, true, true);
      else showView('welcome');
    }
    await restoreSecondaryPanes();
    if (pendingLayoutModel) restorePaneLayout(pendingLayoutModel);
    else if (graphDocked && !$('graphWorkspace').closest('.pane-slot')) insertPane($('graphWorkspace'), 'graph', 'right', activePaneSlot);
    showView(currentView);
    persistVaultState();
    renderTabs();
    toast(`已開啟筆記庫「${vault.name}」`);
  } finally {
    setPrimaryLoading(false);
    endFileOperation();
  }
}

async function rebuildIndex() {
  if (!vault) return;
  const entries = [];
  for (const node of vault.markdownNodes()) {
    try { entries.push({ path: node.path, content: await vault.readText(node.path), modified: node.lastModified }); }
    catch (error) { console.warn('索引失敗', node.path, error); }
  }
  index = buildIndex(entries);
  if (currentType === 'timeline') timelineView.setNotes(index.entries);
  renderRightPanel();
}

function scheduleIndex() {
  clearTimeout(indexingTimer);
  indexingTimer = setTimeout(rebuildIndex, 450);
}

function treeMatches(node, query) {
  if (isHiddenAppFile(node)) return false;
  if (!query) return true;
  if (node.path.toLowerCase().includes(query)) return true;
  if (node.kind === 'file' && node.ext === 'md') {
    const secondary = [...secondaryPanes.values()].find(pane => pane.path === node.path);
    const draft = node.path === currentPath ? $('editor').value : secondary?.editor.value;
    return String(draft ?? index?.byPath.get(node.path)?.content ?? '').toLowerCase().includes(query);
  }
  return node.children?.some(child => treeMatches(child, query));
}

function isHiddenAppFile(node) {
  if (!node || node.kind !== 'file') return false;
  const name = node.name.toLowerCase();
  return name === 'mysyncnote-settings.json' || name === safeName(settings.settingsFileName || 'mysyncnote-settings.json', '.json').toLowerCase();
}

function renderTree() {
  const tree = $('fileTree');
  tree.innerHTML = '';
  if (!vault) { tree.innerHTML = '<div class="panel-empty">開啟筆記庫後會在這裡顯示資料夾與筆記</div>'; return; }
  const query = $('fileSearch').value.trim().toLowerCase();
  const root = vault.node('');
  for (const node of root.children) appendTreeNode(node, tree, 0, query);
  if (!tree.children.length) tree.innerHTML = `<div class="panel-empty">${query ? '找不到符合的筆記' : '這個筆記庫目前是空的'}</div>`;
}

function appendTreeNode(node, parent, depth, query) {
  if (isHiddenAppFile(node)) return;
  if (!treeMatches(node, query)) return;
  const row = document.createElement('div');
  const isRenaming = inlineRenamePath === node.path;
  const isCut = fileClipboard?.mode === 'cut' && fileClipboard.path === node.path;
  row.className = `tree-row${node.path === selectedPath ? ' active' : ''}${isCut ? ' cut' : ''}`;
  row.style.paddingLeft = `${6 + depth * 16}px`;
  row.dataset.path = node.path; row.draggable = !isRenaming; row.setAttribute('role', 'treeitem');
  if (node.kind === 'directory') row.setAttribute('aria-expanded', String(expanded.has(node.path) || Boolean(query)));
  const toggle = document.createElement('span'); toggle.className = 'tree-toggle';
  toggle.textContent = node.kind === 'directory' ? (expanded.has(node.path) || query ? '▾' : '▸') : '';
  const icon = document.createElement('span'); icon.className = `tree-icon${node.kind === 'directory' ? ' folder-icon' : ''}`;
  icon.textContent = node.kind === 'directory' ? '' : node.ext === 'canvas' ? '◇' : node.ext === 'timeline' ? '⌁' : node.ext === 'md' ? '▤' : '·';
  const label = document.createElement(isRenaming ? 'input' : 'span');
  label.className = isRenaming ? 'tree-rename-input' : 'tree-label';
  const editableName = node.kind === 'file' && node.ext ? node.name.slice(0, -(node.ext.length + 1)) : node.name;
  if (isRenaming) {
    label.value = editableName;
    label.setAttribute('aria-label', `重新命名 ${node.name}`);
    let finished = false;
    const finish = commit => {
      if (finished) return;
      finished = true;
      const value = label.value;
      inlineRenamePath = '';
      if (commit) renamePath(node.path, value).then(target => { if (!target) renderTree(); });
      else renderTree();
    };
    label.onpointerdown = label.onclick = label.ondblclick = event => event.stopPropagation();
    label.onkeydown = event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    };
    label.onblur = () => finish(true);
  } else label.textContent = node.name.replace(/\.(md|canvas|timeline)$/i, '');
  row.append(toggle, icon, label);
  row.onclick = async event => {
    event.stopPropagation(); selectedPath = node.path;
    if (node.kind === 'directory') {
      expanded.has(node.path) ? expanded.delete(node.path) : expanded.add(node.path);
      persistSettings(); renderTree();
    } else await openPath(node.path);
    persistVaultState();
    hideMobilePanels();
  };
  row.ondblclick = event => { event.preventDefault(); event.stopPropagation(); beginInlineRename(node.path); };
  row.oncontextmenu = event => { event.preventDefault(); selectedPath = node.path; persistVaultState(); renderTree(); showNodeMenu(node, event.clientX, event.clientY); };
  let longPress;
  row.addEventListener('pointerdown', event => { if (event.pointerType !== 'mouse') longPress = setTimeout(() => showNodeMenu(node, event.clientX, event.clientY), 600); });
  ['pointerup', 'pointercancel', 'pointermove'].forEach(type => row.addEventListener(type, () => clearTimeout(longPress)));
  row.ondragstart = event => { event.dataTransfer.setData('text/mysyncnote-path', node.path); event.dataTransfer.effectAllowed = 'move'; };
  if (node.kind === 'directory') {
    row.ondragover = event => { event.preventDefault(); row.classList.add('drop-target'); };
    row.ondragleave = () => row.classList.remove('drop-target');
    row.ondrop = async event => {
      event.preventDefault(); row.classList.remove('drop-target');
      const source = event.dataTransfer.getData('text/mysyncnote-path');
      if (!source || source === node.path) return;
      await movePath(source, node.path);
    };
  }
  parent.append(row);
  if (node.kind === 'directory' && (expanded.has(node.path) || query)) for (const child of node.children) appendTreeNode(child, parent, depth + 1, query);
}

function showMenu(items, x, y) {
  const menu = $('contextMenu'); menu.innerHTML = '';
  for (const item of items) {
    if (item === 'separator') { const hr = document.createElement('hr'); hr.style.borderColor = 'var(--line)'; menu.append(hr); continue; }
    const button = document.createElement('button'); button.className = item.danger ? 'menu-danger' : '';
    button.innerHTML = `<span></span>${item.shortcut ? `<small>${item.shortcut}</small>` : ''}`; button.firstChild.textContent = item.label;
    button.onclick = () => { menu.classList.add('hidden'); item.action(); };
    menu.append(button);
  }
  menu.classList.remove('hidden');
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - rect.width - 8)}px`; menu.style.top = `${Math.min(y, innerHeight - rect.height - 8)}px`;
}

function showNodeMenu(node, x, y) {
  const items = [];
  if (node.kind === 'directory') items.push(
    { label: '在這裡新增筆記', action: () => createNote(node.path) },
    { label: '新增子資料夾', action: () => createFolder(node.path) },
    { label: '在這裡新增 Canvas', action: () => createCanvas(node.path) },
    { label: '在這裡新增時間線', action: () => createTimeline(node.path) }, 'separator'
  );
  else items.push({ label: '開啟', action: () => openPath(node.path) }, 'separator');
  items.push(
    { label: '重新命名', shortcut: settings.shortcuts.rename, action: () => renamePath(node.path) },
    { label: '複製', shortcut: 'Ctrl+C', action: () => setFileClipboard('copy', node.path) },
    { label: '剪下', shortcut: 'Ctrl+X', action: () => setFileClipboard('cut', node.path) },
    ...(fileClipboard ? [{ label: '貼上', shortcut: 'Ctrl+V', action: () => pasteFileClipboard(node.kind === 'directory' ? node.path : node.parentPath) }] : []),
    { label: '移動到…', action: () => chooseMoveDestination(node.path) },
    { label: '在檔案總管中顯示', action: () => { expanded.add(node.parentPath); selectedPath = node.path; renderTree(); } },
    'separator', { label: '刪除', shortcut: 'Delete', danger: true, action: () => deletePath(node.path) }
  );
  showMenu(items, x, y);
}

async function createNote(parentPath = selectedFolder()) {
  if (!vault) return openVaultPicker();
  const value = await ask('新增筆記', '未命名筆記', `建立位置：${parentPath || '筆記庫根目錄'}`);
  if (!value) return;
  beginFileOperation('正在建立筆記…');
  try {
    const node = await vault.createNote(parentPath, value);
    expanded.add(parentPath); selectedPath = node.path; await rebuildIndex(); renderTree(); await openPath(node.path); requestAnimationFrame(() => { $('documentTitle').focus(); $('documentTitle').select(); });
  } catch (error) { toast(error.message, true); }
  finally { endFileOperation(); }
}

async function createFolder(parentPath = selectedFolder()) {
  if (!vault) return openVaultPicker();
  const value = await ask('新增資料夾', '新資料夾', `建立位置：${parentPath || '筆記庫根目錄'}`);
  if (!value) return;
  beginFileOperation('正在建立資料夾…');
  try { const node = await vault.createFolder(parentPath, value); expanded.add(parentPath); expanded.add(node.path); selectedPath = node.path; renderTree(); }
  catch (error) { toast(error.message, true); }
  finally { endFileOperation(); }
}

async function createCanvas(parentPath = selectedFolder()) {
  if (!vault) return openVaultPicker();
  const value = await ask('新增 Canvas', '未命名 Canvas', `建立位置：${parentPath || '筆記庫根目錄'}`);
  if (!value) return;
  beginFileOperation('正在建立 Canvas…');
  try { const node = await vault.createCanvas(parentPath, value); expanded.add(parentPath); selectedPath = node.path; renderTree(); await openPath(node.path); }
  catch (error) { toast(error.message, true); }
  finally { endFileOperation(); }
}

async function createTimeline(parentPath = selectedFolder()) {
  if (!vault) return openVaultPicker();
  const value = await ask('新增時間線', '未命名時間線', `建立位置：${parentPath || '筆記庫根目錄'}`);
  if (!value) return;
  beginFileOperation('正在建立時間線…');
  try {
    const initial = `${JSON.stringify(createEmptyTimeline(value), null, 2)}\n`;
    const node = await vault.createTimeline(parentPath, value, initial);
    expanded.add(parentPath); selectedPath = node.path; renderTree(); await openPath(node.path);
    requestAnimationFrame(() => { $('timelineTitle').focus(); $('timelineTitle').select(); });
  } catch (error) { toast(error.message, true); }
  finally { endFileOperation(); }
}

function beginInlineRename(path) {
  if (!vault?.node(path)) return;
  selectedPath = path;
  inlineRenamePath = path;
  for (let parent = dirname(path); parent; parent = dirname(parent)) expanded.add(parent);
  renderTree();
  persistVaultState();
  requestAnimationFrame(() => {
    const row = [...document.querySelectorAll('.tree-row')].find(item => item.dataset.path === path);
    const input = row?.querySelector('.tree-rename-input');
    input?.focus();
    input?.select();
  });
}

async function renamePath(path, explicitName = null) {
  if (!vault) return;
  const node = vault.node(path); if (!node) return;
  if (explicitName == null) { beginInlineRename(path); return null; }
  const extension = node.kind === 'file' && node.ext ? `.${node.ext}` : '';
  const value = String(explicitName).trim();
  if (!value || safeName(value, extension) === node.name) return null;
  const oldStem = noteStem(node.name), newName = safeName(value, extension), newStem = noteStem(newName);
  let operationStarted = false;
  beginFileOperation(`正在重新命名「${node.name}」…`);
  operationStarted = true;
  try {
    if (node.kind === 'file' && node.ext === 'md' && settings.updateLinks) {
      await saveAllPanes();
      if (dirty || [...secondaryPanes.values()].some(pane => pane.dirty)) {
        toast('仍有內容尚未儲存；請先處理衝突，再重新命名', true);
        return null;
      }
    }
    if ((node.kind === 'directory' || node.ext === 'md') && dirty && currentType === 'timeline') { await saveCurrent(); if (dirty) return null; }
    if (!await flushDirtyWithin(path)) return null;
    const target = await vault.rename(path, newName);
    const linkUpdate = node.kind === 'file' && node.ext === 'md' && settings.updateLinks
      ? await updateLinksAfterRename(oldStem, newStem, path, target)
      : { skipped: 0 };
    tabs = tabs.map(tab => tab === path ? target : tab.startsWith(`${path}/`) ? `${target}${tab.slice(path.length)}` : tab);
    remapSecondaryPath(path, target);
    remapFileClipboardPath(path, target);
    remapExpandedPaths(path, target);
    if (currentPath === path || currentPath.startsWith(`${path}/`)) currentPath = `${target}${currentPath.slice(path.length)}`;
    selectedPath = target;
    if (node.kind === 'directory' || node.ext === 'md') await updateTimelineReferences(path, target);
    await rebuildIndex(); renderTree(); renderTabs();
    if (currentType === 'md') { renderPreview(); renderRightPanel(); }
    for (const pane of secondaryPanes.values()) pane.render();
    if (currentPath) {
      if (currentType === 'md') $('documentTitle').value = noteStem(currentPath);
      else if (currentType === 'canvas') $('canvasTitle').textContent = basename(currentPath).replace(/\.canvas$/i, '');
      else if (currentType === 'timeline') $('timelineTitle').value = basename(currentPath).replace(/\.timeline$/i, '');
      $('breadcrumbs').textContent = currentPath; loadedModified = vault.node(currentPath)?.lastModified;
      if (currentType === 'timeline') timelineView.setDocumentIdentity(`${vault.name}:${currentPath}`, basename(currentPath).replace(/\.timeline$/i, ''));
    }
    persistVaultState();
    toast(linkUpdate.skipped
      ? `已重新命名為「${basename(target)}」；${linkUpdate.skipped} 份外部變更的筆記未更新連結`
      : `已重新命名為「${basename(target)}」`, Boolean(linkUpdate.skipped));
    return target;
  } catch (error) { toast(error.message, true); return null; }
  finally { if (operationStarted) endFileOperation(); }
}

function setFileClipboard(mode, path) {
  const node = vault?.node(path); if (!node) return;
  fileClipboard = { mode, path, name: node.name, kind: node.kind };
  selectedPath = path;
  renderTree();
  toast(`${mode === 'cut' ? '已剪下' : '已複製'}「${node.name}」；請選擇目的資料夾後貼上`);
}

function remapFileClipboardPath(source, target) {
  if (!fileClipboard) return;
  if (fileClipboard.path === source || fileClipboard.path.startsWith(`${source}/`)) fileClipboard.path = `${target}${fileClipboard.path.slice(source.length)}`;
}

function remapExpandedPaths(source, target) {
  for (const path of [...expanded]) {
    if (path !== source && !path.startsWith(`${source}/`)) continue;
    expanded.delete(path);
    expanded.add(`${target}${path.slice(source.length)}`);
  }
  persistSettings();
}

function pathContains(root, candidate) {
  return Boolean(candidate) && (candidate === root || candidate.startsWith(`${root}/`));
}

async function flushDirtyWithin(path) {
  if (dirty && pathContains(path, currentPath)) {
    await saveCurrent();
    if (dirty) return false;
  }
  for (const pane of secondaryPanes.values()) {
    if (!pane.dirty || !pathContains(path, pane.path)) continue;
    await pane.save();
    if (pane.dirty) return false;
  }
  return true;
}

async function pasteFileClipboard(destination = selectedFolder()) {
  if (!vault || !fileClipboard) return;
  const source = vault.node(fileClipboard.path);
  const targetFolder = vault.node(destination || '');
  if (!source) { fileClipboard = null; renderTree(); return toast('原始項目已不存在', true); }
  if (!targetFolder || targetFolder.kind !== 'directory') return toast('請先選擇目的資料夾', true);
  if (!await flushDirtyWithin(source.path)) return toast('請先處理尚未儲存的內容', true);
  if (fileClipboard.mode === 'cut') {
    const target = await movePath(source.path, destination);
    if (target) { fileClipboard = null; renderTree(); }
    return;
  }
  try {
    const target = await vault.copy(source.path, destination);
    selectedPath = target;
    expanded.add(destination);
    if (vault.node(target)?.kind === 'directory') expanded.add(target);
    await rebuildIndex();
    renderTree();
    persistVaultState();
    toast(`已貼上「${basename(target)}」`);
  } catch (error) { toast(error.message, true); }
}

async function updateLinksAfterRename(oldStem, newStem, renamedFrom, renamedTo) {
  let skipped = 0;
  for (const node of vault.markdownNodes()) {
    try {
      const content = await vault.readText(node.path, true);
      const expectedModified = node.lastModified;
      const replaced = replaceWikiTarget(content, oldStem, newStem);
      if (replaced === content) continue;
      const modified = await vault.writeText(node.path, replaced, expectedModified);
      const openPath = node.path === renamedTo ? renamedFrom : node.path;
      if (currentType === 'md' && currentPath === openPath && !dirty) {
        $('editor').value = replaced;
        liveEditor.setValue(replaced);
        loadedModified = modified;
      }
      for (const pane of secondaryPanes.values()) {
        if (pane.path !== openPath || pane.dirty) continue;
        pane.editor.value = replaced;
        pane.live.setValue(replaced);
        pane.modified = modified;
        pane.state.textContent = '已同步';
      }
    } catch (error) {
      skipped += 1;
      console.warn('Markdown 連結更新失敗', node.path, error);
    }
  }
  return { skipped };
}

function remapReferencePath(value, source, target) {
  if (value === source) return target;
  return value.startsWith(`${source}/`) ? `${target}${value.slice(source.length)}` : value;
}

async function updateTimelineReferences(source, target) {
  let changedCurrent = false;
  let skipped = 0;
  for (const node of vault.timelineNodes()) {
    try {
      const text = await vault.readText(node.path, true);
      const data = JSON.parse(text);
      const version = Number(data?.version ?? 1);
      if (data?.format !== 'mysyncnote-timeline' || !Number.isFinite(version) || version > 1) throw new Error('格式未知或版本較新，為避免破壞已跳過');
      let changed = false;
      for (const event of Array.isArray(data.events) ? data.events : []) {
        if (Array.isArray(event.notePaths)) {
          const remapped = event.notePaths.map(path => typeof path === 'string' ? remapReferencePath(path, source, target) : path);
          if (JSON.stringify(remapped) !== JSON.stringify(event.notePaths)) { event.notePaths = remapped; changed = true; }
        }
        if (typeof event.notePath === 'string') {
          const remapped = remapReferencePath(event.notePath, source, target);
          if (remapped !== event.notePath) { event.notePath = remapped; changed = true; }
        }
      }
      if (!changed) continue;
      const content = `${JSON.stringify(data, null, 2)}\n`;
      const modified = await vault.writeText(node.path, content, node.lastModified);
      if (node.path === currentPath && currentType === 'timeline') {
        timelineView.load(content, { key: `${vault.name}:${currentPath}`, title: basename(currentPath).replace(/\.timeline$/i, '') });
        timelineView.setNotes(index?.entries || []);
        loadedModified = modified;
        changedCurrent = true;
      }
    } catch (error) {
      skipped += 1;
      console.warn('Timeline 筆記連結更新失敗', node.path, error);
    }
  }
  if (changedCurrent) setTimelineReady(true);
  if (skipped) toast(`${skipped} 份 Timeline 無法更新筆記路徑，原檔未被覆蓋`, true);
}

async function chooseMoveDestination(path) {
  const folders = [...vault.nodes.values()].filter(node => node.kind === 'directory' && node.path !== path && !node.path.startsWith(`${path}/`)).map(node => node.path);
  const destination = await chooseFromList('移動到', folders, item => item || '筆記庫根目錄', '選擇目的資料夾…');
  if (destination == null) return;
  await movePath(path, destination);
}

async function movePath(path, destination) {
  let operationStarted = false;
  const sourceName = vault.node(path)?.name || basename(path);
  beginFileOperation(`正在移動「${sourceName}」…`);
  operationStarted = true;
  try {
    const sourceNode = vault.node(path);
    if ((sourceNode?.kind === 'directory' || sourceNode?.ext === 'md') && dirty && currentType === 'timeline') { await saveCurrent(); if (dirty) return null; }
    if (!await flushDirtyWithin(path)) return null;
    const target = await vault.move(path, destination);
    tabs = tabs.map(tab => tab === path ? target : tab.startsWith(`${path}/`) ? `${target}${tab.slice(path.length)}` : tab);
    remapSecondaryPath(path, target);
    remapFileClipboardPath(path, target);
    remapExpandedPaths(path, target);
    if (currentPath === path || currentPath.startsWith(`${path}/`)) currentPath = `${target}${currentPath.slice(path.length)}`;
    if (sourceNode?.kind === 'directory' || sourceNode?.ext === 'md') await updateTimelineReferences(path, target);
    selectedPath = target; expanded.add(destination); await rebuildIndex(); renderTree(); renderTabs();
    if (currentPath) {
      loadedModified = vault.node(currentPath)?.lastModified;
      $('breadcrumbs').textContent = currentPath;
      if (currentType === 'md') $('documentTitle').value = noteStem(currentPath);
      else if (currentType === 'canvas') $('canvasTitle').textContent = basename(currentPath).replace(/\.canvas$/i, '');
      else if (currentType === 'timeline') {
        $('timelineTitle').value = basename(currentPath).replace(/\.timeline$/i, '');
        timelineView.setDocumentIdentity(`${vault.name}:${currentPath}`, basename(currentPath).replace(/\.timeline$/i, ''));
      }
    }
    persistVaultState();
    toast(`已移動到「${destination || vault.name}」`);
    return target;
  } catch (error) { toast(error.message, true); return null; }
  finally { if (operationStarted) endFileOperation(); }
}

async function deletePath(path) {
  const node = vault?.node(path); if (!node) return;
  if (!await confirmAction(`刪除「${node.name}」？`, settings.trashMode === 'trash' ? '項目會移到筆記庫的 .trash 資料夾。' : '這會直接永久刪除，無法復原。', '刪除')) return;
  let operationStarted = false;
  beginFileOperation(`正在刪除「${node.name}」…`);
  operationStarted = true;
  try {
    const deletingCurrent = currentPath === path || currentPath.startsWith(`${path}/`);
    const affectedPanes = [...secondaryPanes.values()].filter(pane => pane.path === path || pane.path.startsWith(`${path}/`));
    if (deletingCurrent) {
      clearTimeout(autoSaveTimer);
      await saveChain.catch(() => {});
    }
    for (const pane of affectedPanes) clearTimeout(pane.timer);
    await Promise.all(affectedPanes.map(pane => pane.savePromise).filter(Boolean));
    await vault.remove(path, settings.trashMode === 'trash');
    if (deletingCurrent) saveGeneration += 1;
    if (deletingCurrent) {
      clearTimeout(autoSaveTimer);
      currentPath = '';
      currentType = '';
      loadedModified = null;
      dirty = false;
      editRevision = 0;
      currentCanvasValid = true;
      currentTimelineValid = true;
    }
    if (fileClipboard && pathContains(path, fileClipboard.path)) fileClipboard = null;
    for (const pane of [...secondaryPanes.values()]) {
      const removedActive = pane.path === path || pane.path.startsWith(`${path}/`);
      pane.tabs = pane.tabs.filter(tabPath => tabPath !== path && !tabPath.startsWith(`${path}/`));
      if (removedActive) {
        pane.openGeneration += 1;
        clearTimeout(pane.timer);
        pane.path = '';
        pane.modified = null;
        pane.dirty = false;
        pane.revision = 0;
      }
      if (!pane.tabs.length) await closeSecondaryPane(pane, false);
      else if (removedActive) await openPathInSecondaryPane(pane, pane.tabs[0], false);
      else renderSecondaryTabs(pane);
    }
    tabs = tabs.filter(tab => tab !== path && !tab.startsWith(`${path}/`));
    if (deletingCurrent) {
      const next = tabs[0];
      if (next) await openPath(next, false, true);
      else { $('breadcrumbs').textContent = vault.name; showView('welcome'); }
    }
    selectedPath = ''; await rebuildIndex(); renderTree(); renderTabs(); toast('已刪除');
  } catch (error) { toast(error.message, true); }
  finally { if (operationStarted) endFileOperation(); }
}

function canvasViewStateKey(path) { return vault ? `mysyncnote-canvas-view:${vault.name}:${path}` : ''; }
function readCanvasViewState(path) {
  try { return JSON.parse(localStorage.getItem(canvasViewStateKey(path)) || 'null'); } catch { return null; }
}
function writeCanvasViewState(path, state) {
  if (!vault || !path) return;
  localStorage.setItem(canvasViewStateKey(path), JSON.stringify(state));
  $('canvasZoomLabel').textContent = `${Math.round((state.scale || 1) * 100)}%`;
}
function setCanvasReady(ready, message = '') {
  currentCanvasValid = ready;
  $('canvasError').classList.toggle('hidden', ready);
  $('canvasError').textContent = ready ? '' : `${message}\n\n為了避免覆蓋原檔案，這個 Canvas 已停用編輯與自動儲存。`;
  for (const id of ['canvasAddText', 'canvasAddNote', 'canvasAddLink', 'canvasAddGroup', 'canvasUndo', 'canvasRedo', 'canvasZoomOut', 'canvasZoomReset', 'canvasZoomIn', 'canvasFit']) $(id).disabled = !ready;
}

function setTimelineReady(ready, message = '') {
  currentTimelineValid = ready;
  $('timelineError').classList.toggle('hidden', ready);
  $('timelineError').textContent = ready ? '' : `${message}\n\n為了避免覆蓋原檔案，這份 Timeline 已停用編輯與自動儲存。`;
  $('timelineWorkspace').querySelectorAll('button, input, select, textarea').forEach(control => {
    if (control.id !== 'closeTimeline') control.disabled = !ready;
  });
  if (ready) timelineView.activate();
}

function currentDocumentReady() {
  if (currentType === 'canvas') return currentCanvasValid;
  if (currentType === 'timeline') return currentTimelineValid;
  return true;
}

async function openPath(path, addHistory = true, forcePrimary = false) {
  if (!vault) return;
  const node = vault.node(path); if (!node || node.kind !== 'file') return;
  const activePane = !forcePrimary ? activeSecondaryPane() : null;
  if (activePane && node.ext === 'md') return openPathInSecondaryPane(activePane, path);
  const token = ++openGeneration;
  const primarySlot = document.querySelector('.pane-slot[data-pane-key="primary"]');
  if (primarySlot) setActivePaneSlot(primarySlot);
  setPrimaryLoading(true);
  try {
    if (dirty) {
      await saveCurrent();
      if (token !== openGeneration || dirty) return;
    }
    if (!['md', 'canvas', 'timeline'].includes(node.ext)) {
      const blob = await vault.readBlob(path);
      if (token === openGeneration) window.open(URL.createObjectURL(blob), '_blank');
      return;
    }
    const content = await vault.readText(path, true);
    if (token !== openGeneration) return;
    const latestNode = vault.node(path);
    if (!latestNode || latestNode.kind !== 'file') return;

    selectedPath = path;
    currentPath = path;
    currentType = latestNode.ext;
    loadedModified = latestNode.lastModified ?? null;
    dirty = false;
    editRevision = 0;
    currentCanvasValid = true;
    currentTimelineValid = true;
    if (!tabs.includes(path)) tabs.push(path);
    persistVaultState();
    if (addHistory && history[historyIndex] !== path) { history = history.slice(0, historyIndex + 1); history.push(path); historyIndex = history.length - 1; }

    if (latestNode.ext === 'md') {
      $('editor').value = content; liveEditor.setValue(content); $('wikiSuggest').classList.add('hidden'); $('documentTitle').value = noteStem(path); showView('note'); applyViewMode(); renderPreview(); renderRightPanel();
    } else if (latestNode.ext === 'canvas') {
      $('canvasTitle').textContent = basename(path).replace(/\.canvas$/i, ''); showView('canvas');
      try {
        canvasView.load(content, { key: path, view: readCanvasViewState(path) }); setCanvasReady(true);
        $('canvasZoomLabel').textContent = `${Math.round(canvasView.viewState().scale * 100)}%`;
        requestAnimationFrame(() => canvasView.activate());
      } catch (error) { setCanvasReady(false, error.message); toast(error.message, true); }
    } else {
      $('timelineTitle').value = basename(path).replace(/\.timeline$/i, '');
      app.classList.add('right-collapsed');
      app.classList.remove('right-open');
      showView('timeline');
      try {
        timelineView.load(content, { key: `${vault.name}:${path}`, title: basename(path).replace(/\.timeline$/i, '') });
        timelineView.setNotes(index?.entries || []);
        setTimelineReady(true);
        requestAnimationFrame(() => { timelineView.activate(); $('timelineWorkspace').focus({ preventScroll: true }); });
      } catch (error) {
        setTimelineReady(false, error.message);
        toast(error.message, true);
      }
      renderRightPanel();
    }
    $('breadcrumbs').textContent = path;
    setSaveState(currentDocumentReady() ? '已儲存' : '無法編輯', !currentDocumentReady());
    renderTree();
    renderTabs();
    updateHistoryButtons();
    hideMobilePanels();
  } catch (error) {
    if (token === openGeneration) toast(`無法開啟「${path}」：${error.message}`, true);
  } finally {
    if (token === openGeneration) setPrimaryLoading(false);
  }
}

function renderTabs() {
  const container = $('tabs'); container.innerHTML = '';
  const primarySlot = container.closest('.pane-slot');
  for (const path of tabs) {
    if (!vault?.node(path)) continue;
    const tab = document.createElement('button'); tab.className = `tab${path === currentPath ? ' active' : ''}`; tab.role = 'tab';
    const extension = vault.node(path)?.ext;
    const icon = extension === 'canvas' ? '◇' : extension === 'timeline' ? '⌁' : '▤';
    tab.draggable = true;
    tab.innerHTML = `<span>${icon}</span><span class="tab-label"></span><span class="tab-close">×</span>`;
    tab.querySelector('.tab-label').textContent = basename(path).replace(/\.(md|canvas|timeline)$/i, '');
    tab.onclick = event => { setActivePaneSlot(primarySlot); if (event.target.closest('.tab-close')) closeTab(path); else openPath(path, true, true); };
    tab.oncontextmenu = event => {
      if (extension !== 'md') return;
      event.preventDefault();
      showMenu([
        { label: '向右分割', action: () => addSecondaryPane(path, 'right', primarySlot) },
        { label: '向下分割', action: () => addSecondaryPane(path, 'bottom', primarySlot) },
        { label: '向左分割', action: () => addSecondaryPane(path, 'left', primarySlot) },
        { label: '向上分割', action: () => addSecondaryPane(path, 'top', primarySlot) }
      ], event.clientX, event.clientY);
    };
    tab.ondragstart = event => { event.dataTransfer.setData('text/mysyncnote-tab', JSON.stringify({ source: 'primary', path })); event.dataTransfer.effectAllowed = 'copyMove'; };
    tab.ondragover = event => { if ([...event.dataTransfer.types].includes('text/mysyncnote-tab')) event.preventDefault(); };
    tab.ondrop = async event => {
      let source; try { source = JSON.parse(event.dataTransfer.getData('text/mysyncnote-tab')); } catch { return; }
      if (!source?.path || source.path === path) return;
      event.preventDefault(); event.stopPropagation();
      if (!tabs.includes(source.path)) tabs.splice(tabs.indexOf(path), 0, source.path);
      else { tabs = tabs.filter(item => item !== source.path); tabs.splice(tabs.indexOf(path), 0, source.path); }
      await openPath(source.path, true, true);
      if (source.source === 'secondary') await closeSecondaryTab(secondaryPanes.get(source.groupId), source.path);
      persistVaultState(); renderTabs();
    };
    container.append(tab);
  }
}

function secondaryPaneForSlot(slot) {
  const key = slot?.dataset.paneKey || '';
  return key.startsWith('group:') ? secondaryPanes.get(key.slice(6)) || null : null;
}

function activeSecondaryPane() { return secondaryPaneForSlot(activePaneSlot); }
function activeDocumentPath() { return activeSecondaryPane()?.path || currentPath; }
function newGroupId() { return crypto.randomUUID ? crypto.randomUUID() : `group-${Date.now()}-${Math.random().toString(36).slice(2)}`; }

async function openPathInSlot(path, slot) {
  const pane = secondaryPaneForSlot(slot);
  if (pane && vault?.node(path)?.ext === 'md') return openPathInSecondaryPane(pane, path);
  return openPath(path, true, true);
}

async function placeDraggedTab(info, targetSlot, direction) {
  if (!info?.path || !vault?.node(info.path)) return;
  const sourcePane = info.source === 'secondary' ? secondaryPanes.get(info.groupId) : null;
  if (direction === 'center') {
    const targetPane = secondaryPaneForSlot(targetSlot);
    if (targetPane) {
      if (targetPane === sourcePane) { setActivePaneSlot(targetSlot); return; }
      await openPathInSecondaryPane(targetPane, info.path);
    } else await openPath(info.path, true, true);
    if (sourcePane && sourcePane !== targetPane) await closeSecondaryTab(sourcePane, info.path);
    return;
  }
  if (vault.node(info.path)?.ext !== 'md') return toast('目前只有 Markdown 筆記可以加入分割群組；時間線仍保留在主要分頁', true);
  const created = await addSecondaryPane(info.path, direction, targetSlot);
  if (created && sourcePane && sourcePane !== created) await closeSecondaryTab(sourcePane, info.path);
}

function renderSecondaryTabs(pane) {
  const container = pane.tabsElement; container.innerHTML = '';
  pane.tabs = pane.tabs.filter(path => vault?.node(path)?.ext === 'md');
  for (const path of pane.tabs) {
    const tab = document.createElement('button'); tab.className = `tab${path === pane.path ? ' active' : ''}`; tab.role = 'tab'; tab.draggable = true;
    tab.innerHTML = '<span>▤</span><span class="tab-label"></span><span class="tab-close">×</span>';
    tab.querySelector('.tab-label').textContent = noteStem(path);
    tab.onclick = event => { setActivePaneSlot(pane.element.closest('.pane-slot')); if (event.target.closest('.tab-close')) closeSecondaryTab(pane, path); else openPathInSecondaryPane(pane, path, false); };
    tab.oncontextmenu = event => { event.preventDefault(); showMenu([
      { label: '向右分割', action: () => addSecondaryPane(path, 'right', pane.element.closest('.pane-slot')) },
      { label: '向下分割', action: () => addSecondaryPane(path, 'bottom', pane.element.closest('.pane-slot')) },
      { label: '向左分割', action: () => addSecondaryPane(path, 'left', pane.element.closest('.pane-slot')) },
      { label: '向上分割', action: () => addSecondaryPane(path, 'top', pane.element.closest('.pane-slot')) }
    ], event.clientX, event.clientY); };
    tab.ondragstart = event => { event.stopPropagation(); event.dataTransfer.setData('text/mysyncnote-tab', JSON.stringify({ source: 'secondary', groupId: pane.id, path })); event.dataTransfer.effectAllowed = 'copyMove'; };
    tab.ondragover = event => { if ([...event.dataTransfer.types].includes('text/mysyncnote-tab')) event.preventDefault(); };
    tab.ondrop = event => {
      let source; try { source = JSON.parse(event.dataTransfer.getData('text/mysyncnote-tab')); } catch { return; }
      if (source.groupId !== pane.id || source.path === path || !pane.tabs.includes(source.path)) return;
      event.preventDefault(); event.stopPropagation(); pane.tabs = pane.tabs.filter(item => item !== source.path); pane.tabs.splice(pane.tabs.indexOf(path), 0, source.path); renderSecondaryTabs(pane); persistSecondaryOrder();
    };
    container.append(tab);
  }
}

async function addSecondaryPane(path, direction = 'right', targetSlot = activePaneSlot, options = {}) {
  if (!vault || vault.node(path)?.ext !== 'md') return toast('目前只有 Markdown 筆記可以加入分割群組', true);
  const node = vault.node(path);
  const savedTabs = [...new Set((options.tabs || [path]).filter(item => vault.node(item)?.ext === 'md'))];
  if (!savedTabs.includes(path)) savedTabs.push(path);
  const pane = { id: String(options.id || newGroupId()), path, tabs: savedTabs, modified: node.lastModified, dirty: false, revision: 0, timer: null, mode: options.mode || 'live', objectUrls: [], openGeneration: 0, savePromise: null };
  const element = document.createElement('section');
  element.className = 'dock-pane secondary-note-pane editor-group'; element.dataset.groupId = pane.id;
  element.innerHTML = `<div class="tabs group-tabs secondary-group-tabs" role="tablist"></div><header class="document-header secondary-pane-document-header"><div class="document-title-row secondary-pane-drag" draggable="true"><span class="tree-icon">▤</span><span class="secondary-pane-title"></span><span class="secondary-pane-state">已儲存</span><button class="pane-primary icon-btn" title="移到主要群組">↗</button><button class="pane-close icon-btn" title="關閉目前分頁">×</button></div><div class="editor-toolbar secondary-editor-toolbar"><button data-pane-history="undo" title="復原（Ctrl+Z）" aria-label="復原">↶</button><button data-pane-history="redo" title="重做（Ctrl+Y）" aria-label="重做">↷</button><span class="tool-separator"></span><button data-pane-format="heading" title="標題">H</button><button data-pane-format="bold" title="粗體"><b>B</b></button><button data-pane-format="italic" title="斜體"><i>I</i></button><button data-pane-format="strike" title="刪除線"><s>S</s></button><button data-pane-format="highlight" title="醒目標記">螢</button><span class="tool-separator"></span><button data-pane-format="link" title="連結">鏈</button><button data-pane-format="wikilink" title="Wiki 連結">[[]]</button><button data-pane-format="code" title="程式碼">&lt;/&gt;</button><button data-pane-format="quote" title="引用">❝</button><button data-pane-format="list" title="清單">☷</button><button data-pane-format="task" title="待辦事項">☑</button><span class="tool-spacer"></span><div class="view-switch pane-view-switch"><button data-pane-view="live" class="active">混合</button><button data-pane-view="edit">原始碼</button><button data-pane-view="split">並排</button><button data-pane-view="read">閱讀</button></div></div></header><div class="secondary-pane-body live"><textarea class="secondary-pane-editor" spellcheck="true"></textarea><div class="secondary-pane-live live-editor"></div><article class="secondary-pane-preview markdown-body"></article><div class="secondary-wiki-suggest suggestions hidden"></div></div>`;
  pane.element = element; pane.tabsElement = element.querySelector('.secondary-group-tabs'); pane.editor = element.querySelector('.secondary-pane-editor'); pane.preview = element.querySelector('.secondary-pane-preview'); pane.state = element.querySelector('.secondary-pane-state'); pane.body = element.querySelector('.secondary-pane-body'); pane.suggest = element.querySelector('.secondary-wiki-suggest');
  element.querySelector('.secondary-pane-title').textContent = noteStem(path);
  pane.render = () => {
    pane.objectUrls.forEach(URL.revokeObjectURL); pane.objectUrls = [];
    pane.preview.innerHTML = renderMarkdown(pane.editor.value, { resolveWiki: target => index?.resolve(target, pane.path) });
    pane.preview.querySelectorAll('[data-wikilink]').forEach(link => link.onclick = () => { const target = index?.resolve(link.dataset.wikilink, pane.path); if (target) openPathInSecondaryPane(pane, target.path); });
    pane.preview.querySelectorAll('[data-file-link]').forEach(link => link.onclick = () => { const target = resolveAsset(link.dataset.fileLink, pane.path); if (target?.ext === 'md') openPathInSecondaryPane(pane, target.path); else if (target) openPath(target.path); });
    pane.preview.querySelectorAll('[data-tag]').forEach(tag => tag.onclick = () => searchTag(tag.dataset.tag));
    pane.preview.querySelectorAll('[data-vault-image]').forEach(async image => { const asset = resolveAsset(image.dataset.vaultImage, pane.path); if (!asset) return; const url = URL.createObjectURL(await vault.readBlob(asset.path)); pane.objectUrls.push(url); image.src = url; });
  };
  pane.save = () => {
    if (!pane.dirty) return pane.savePromise || Promise.resolve();
    clearTimeout(pane.timer);
    const revision = pane.revision, text = pane.editor.value, pathAtStart = pane.path;
    const previous = pane.savePromise || Promise.resolve();
    const job = previous.catch(() => {}).then(async () => {
      if (pane.path !== pathAtStart && !vault.node(pathAtStart)) return;
      pane.state.textContent = '正在儲存…';
      try {
        const expected = pane.path === pathAtStart ? pane.modified : vault.node(pathAtStart)?.lastModified;
        const modified = await vault.writeText(pathAtStart, text, expected);
        if (pane.path === pathAtStart) {
          pane.modified = modified;
          pane.dirty = pane.revision !== revision;
          pane.state.textContent = pane.dirty ? '尚未儲存' : '已儲存';
        }
        scheduleIndex();
        if (pathAtStart === currentPath && !dirty) { $('editor').value = text; liveEditor.setValue(text); loadedModified = modified; renderPreview(); }
        for (const mirror of secondaryPanes.values()) if (mirror !== pane && mirror.path === pathAtStart && !mirror.dirty) { mirror.editor.value = text; mirror.live.setValue(text); mirror.modified = modified; mirror.state.textContent = '已同步'; mirror.render(); }
      } catch (error) {
        try {
          pane.state.textContent = '外部版本衝突';
          if (error.name === 'ExternalChangeError' && await confirmAction('這個窗格偵測到外部修改', `「${pathAtStart}」已被 FolderSync 或另一個窗格修改。要用這個窗格的內容覆蓋嗎？`, '保留這個窗格', true)) {
            const modified = await vault.writeText(pathAtStart, text, null);
            if (pane.path === pathAtStart) {
              pane.modified = modified;
              pane.dirty = pane.revision !== revision;
              pane.state.textContent = pane.dirty ? '尚未儲存' : '已儲存';
            }
            scheduleIndex();
          } else toast(`「${pathAtStart}」尚未儲存`, true);
        } catch (saveError) {
          if (pane.path === pathAtStart) {
            pane.dirty = true;
            pane.state.textContent = '儲存失敗';
          }
          toast(saveError.message || `「${pathAtStart}」尚未儲存`, true);
        }
      }
    });
    const tracked = job.finally(() => { if (pane.savePromise === tracked) pane.savePromise = null; });
    pane.savePromise = tracked;
    return tracked;
  };
  pane.markDirty = () => { pane.revision += 1; pane.dirty = true; pane.state.textContent = '尚未儲存'; if (pane.mode === 'split' || pane.mode === 'read') pane.render(); clearTimeout(pane.timer); if (settings.autoSave) pane.timer = setTimeout(pane.save, 800); };
  pane.live = new LiveMarkdownEditor(element.querySelector('.secondary-pane-live'), {
    onChange: source => { pane.editor.value = source; pane.markDirty(); }, onCursor: () => updatePaneWikiSuggest(pane),
    onLink: target => { const resolved = index?.resolve(target, pane.path); if (resolved) openPathInSecondaryPane(pane, resolved.path); },
    onFileLink: target => { if (/^https?:\/\//i.test(target)) window.open(target, '_blank', 'noopener'); else { const resolved = resolveAsset(target, pane.path); if (resolved?.ext === 'md') openPathInSecondaryPane(pane, resolved.path); } },
    onTag: searchTag,
    onPasteFiles: files => importAttachments(files, liveSurface(pane.live))
  });
  pane.editor.oninput = () => { pane.markDirty(); updatePaneWikiSuggest(pane); };
  pane.editor.onkeyup = () => updatePaneWikiSuggest(pane); pane.editor.onclick = () => updatePaneWikiSuggest(pane);
  pane.editor.onkeydown = event => { if (eventMatchesShortcut(event, settings.shortcuts.save)) { event.preventDefault(); event.stopPropagation(); pane.save(); } };
  pane.setMode = mode => { pane.mode = mode; pane.body.className = `secondary-pane-body ${mode}`; element.querySelectorAll('[data-pane-view]').forEach(button => button.classList.toggle('active', button.dataset.paneView === mode)); if (mode === 'live') pane.live.setValue(pane.editor.value, pane.live.value() !== pane.editor.value); else pane.render(); pane.suggest.classList.add('hidden'); persistSecondaryOrder(); };
  element.querySelectorAll('[data-pane-view]').forEach(button => button.onclick = () => pane.setMode(button.dataset.paneView));
  element.querySelectorAll('[data-pane-history]').forEach(button => button.onclick = () => runEditorHistory(button.dataset.paneHistory, pane.mode, pane.live, pane.editor));
  element.querySelectorAll('[data-pane-format]').forEach(button => button.onclick = () => applyFormat(button.dataset.paneFormat, pane.mode === 'live' ? liveSurface(pane.live) : textareaSurface(pane.editor, pane.markDirty)));
  element.querySelector('.pane-primary').onclick = async () => { const moving = pane.path; await openPath(moving, true, true); if (currentPath === moving) await closeSecondaryTab(pane, moving); };
  element.querySelector('.pane-close').onclick = () => closeSecondaryTab(pane, pane.path);
  const header = element.querySelector('.secondary-pane-drag');
  header.ondragstart = event => { event.dataTransfer.setData('text/mysyncnote-pane', pane.id); event.dataTransfer.effectAllowed = 'move'; };
  secondaryPanes.set(pane.id, pane);
  insertPane(element, `group:${pane.id}`, direction, targetSlot);
  await openPathInSecondaryPane(pane, path, false); pane.setMode(pane.mode); persistSecondaryOrder();
  showView(currentView === 'welcome' ? primaryViewForType() : currentView);
  return pane;
}

async function openPathInSecondaryPane(pane, path, addTab = true) {
  const node = vault?.node(path); if (!pane || !node || node.ext !== 'md') return;
  const token = ++pane.openGeneration;
  pane.element.inert = true;
  pane.element.classList.add('loading');
  pane.state.textContent = '讀取中…';
  try {
    if (pane.dirty) {
      await pane.save();
      if (token !== pane.openGeneration || pane.dirty) return;
    }
    const content = await vault.readText(path, true);
    if (token !== pane.openGeneration) return;
    const latestNode = vault.node(path);
    if (!latestNode || latestNode.ext !== 'md') return;
    if (addTab && !pane.tabs.includes(path)) pane.tabs.push(path);
    pane.path = path; pane.modified = latestNode.lastModified; pane.dirty = false; pane.revision = 0; pane.editor.value = content; pane.live.setValue(content); pane.state.textContent = '已儲存'; pane.suggest.classList.add('hidden');
    pane.element.querySelector('.secondary-pane-title').textContent = noteStem(path);
    selectedPath = path; for (let parent = dirname(path); parent; parent = dirname(parent)) expanded.add(parent);
    setActivePaneSlot(pane.element.closest('.pane-slot')); pane.render(); renderSecondaryTabs(pane); renderTree(); persistSecondaryOrder();
  } catch (error) {
    if (token === pane.openGeneration) {
      pane.state.textContent = '讀取失敗';
      toast(`無法開啟「${path}」：${error.message}`, true);
    }
  } finally {
    if (token === pane.openGeneration) {
      pane.element.inert = false;
      pane.element.classList.remove('loading');
    }
  }
}

async function closeSecondaryTab(pane, path, save = true) {
  if (!pane || !pane.tabs.includes(path)) return;
  if (save && pane.path === path && pane.dirty) { await pane.save(); if (pane.dirty) return; }
  const index = pane.tabs.indexOf(path); pane.tabs = pane.tabs.filter(item => item !== path);
  if (!pane.tabs.length) return closeSecondaryPane(pane, false);
  if (pane.path === path) await openPathInSecondaryPane(pane, pane.tabs[Math.min(index, pane.tabs.length - 1)], false);
  else { renderSecondaryTabs(pane); persistSecondaryOrder(); }
}

async function closeSecondaryPane(paneOrId, save = true) {
  const pane = typeof paneOrId === 'string' ? secondaryPanes.get(paneOrId) : paneOrId; if (!pane) return;
  if (save && pane.dirty) { await pane.save(); if (pane.dirty) return; }
  const slot = pane.element.closest('.pane-slot');
  pane.openGeneration += 1;
  clearTimeout(pane.timer); pane.objectUrls.forEach(URL.revokeObjectURL); pane.element.remove(); secondaryPanes.delete(pane.id); if (slot) detachPaneSlot(slot, false); persistSecondaryOrder();
  if (!currentPath && !graphDocked && !secondaryPanes.size) showView('welcome');
}

function persistSecondaryOrder() {
  secondaryGroupStates = [...$('workspaceDock').querySelectorAll('.secondary-note-pane')].map(element => { const pane = secondaryPanes.get(element.dataset.groupId); return pane ? { id: pane.id, path: pane.path, tabs: [...pane.tabs], mode: pane.mode } : null; }).filter(Boolean);
  persistVaultState();
}

async function restoreSecondaryPanes() {
  const states = [...secondaryGroupStates];
  for (const pane of [...secondaryPanes.values()]) await closeSecondaryPane(pane, false);
  secondaryGroupStates = [];
  for (const state of states) await addSecondaryPane(state.path, 'right', activePaneSlot, state);
}

function remapSecondaryPath(oldPath, newPath) {
  for (const pane of secondaryPanes.values()) {
    pane.tabs = pane.tabs.map(path => path === oldPath || path.startsWith(`${oldPath}/`) ? `${newPath}${path.slice(oldPath.length)}` : path);
    if (pane.path === oldPath || pane.path.startsWith(`${oldPath}/`)) pane.path = `${newPath}${pane.path.slice(oldPath.length)}`;
    pane.element.querySelector('.secondary-pane-title').textContent = noteStem(pane.path); renderSecondaryTabs(pane);
  }
  persistSecondaryOrder();
}

async function splitCurrentNote(direction = 'right') {
  const path = activeDocumentPath();
  if (!path || vault?.node(path)?.ext !== 'md') return toast('請先開啟一篇 Markdown 筆記');
  await addSecondaryPane(path, direction, activePaneSlot);
}

async function closeTab(path) {
  if (path === currentPath && dirty) { await saveCurrent(); if (dirty) return; }
  const indexOf = tabs.indexOf(path); tabs = tabs.filter(tab => tab !== path); persistVaultState();
  if (path === currentPath) {
    const next = tabs[Math.min(indexOf, tabs.length - 1)];
    if (next) await openPath(next, false, true);
    else if (secondaryPanes.size) {
      const pane = secondaryPanes.values().next().value, promotePath = pane.path, promoteTabs = [...pane.tabs];
      if (pane.dirty) await pane.save(); await closeSecondaryPane(pane, false); tabs = promoteTabs; await openPath(promotePath, false, true);
    } else {
      currentPath = ''; currentType = ''; loadedModified = null; dirty = false; editRevision = 0; currentCanvasValid = true; currentTimelineValid = true;
      $('breadcrumbs').textContent = vault?.name || '尚未開啟筆記庫'; renderRightPanel(); showView('welcome');
    }
  }
  renderTabs();
}

function updateHistoryButtons() { $('goBack').disabled = historyIndex <= 0; $('goForward').disabled = historyIndex < 0 || historyIndex >= history.length - 1; }

function applyViewMode() {
  $('editorArea').className = `editor-area mode-${viewMode}`;
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === viewMode));
  if (viewMode === 'live') liveEditor.setValue($('editor').value, liveEditor.value() !== $('editor').value);
  else $('wikiSuggest').classList.add('hidden');
}

function scheduleSave() {
  editRevision += 1; dirty = true; setSaveState('尚未儲存');
  clearTimeout(autoSaveTimer);
  if (settings.autoSave && vault) autoSaveTimer = setTimeout(() => saveCurrent(true), 800);
}

async function saveCurrent(silent = false) {
  if (!vault || !currentPath || !dirty) return;
  if (currentType === 'canvas' && !currentCanvasValid) return toast('Canvas 格式錯誤，為避免覆蓋原檔案，未執行儲存。', true);
  if (currentType === 'timeline' && !currentTimelineValid) return toast('Timeline 格式錯誤，為避免覆蓋原檔案，未執行儲存。', true);
  clearTimeout(autoSaveTimer);
  const pathAtStart = currentPath, typeAtStart = currentType, revisionAtStart = editRevision, generationAtStart = saveGeneration;
  const text = typeAtStart === 'canvas' ? canvasView.json() : typeAtStart === 'timeline' ? timelineView.json() : $('editor').value;
  setSaveState('正在儲存…');
  saveChain = saveChain.catch(() => {}).then(async () => {
    if (generationAtStart !== saveGeneration) return;
    try {
      const expected = currentPath === pathAtStart ? loadedModified : vault.node(pathAtStart)?.lastModified;
      const modified = await vault.writeText(pathAtStart, text, expected);
      if (currentPath === pathAtStart) {
        loadedModified = modified; dirty = editRevision !== revisionAtStart;
        setSaveState(dirty ? '尚未儲存' : '已儲存');
      }
      const mirrors = typeAtStart === 'md' ? [...secondaryPanes.values()].filter(pane => pane.path === pathAtStart && !pane.dirty) : [];
      for (const mirror of mirrors) { mirror.editor.value = text; mirror.live.setValue(text); mirror.modified = modified; mirror.state.textContent = '已同步'; }
      if (typeAtStart === 'md') scheduleIndex();
      if (!silent) toast('已儲存');
    } catch (error) {
      try {
        if (error.name === 'ExternalChangeError') await resolveConflict(pathAtStart, text, error, revisionAtStart);
        else throw error;
      } catch (saveError) {
        if (currentPath === pathAtStart) {
          dirty = true;
          setSaveState('儲存失敗', true);
        }
        toast(saveError.message || '儲存失敗，內容仍保留在畫面中', true);
      }
    }
  });
  return saveChain;
}

async function resolveConflict(path, localText, error, revisionAtStart = editRevision) {
  const type = vault.node(path)?.ext || currentType;
  $('confirmTitle').textContent = '偵測到外部修改';
  $('confirmMessage').textContent = error.externalDeleted
    ? 'FolderSync 或其他程式已經刪除這份筆記。你可以用目前內容重新建立，或接受外部刪除。'
    : 'FolderSync 或其他程式已經修改這份筆記。請選擇要保留哪個版本。';
  $('confirmOk').textContent = '保留目前版本'; $('confirmOk').className = 'danger';
  $('confirmExtra').innerHTML = error.externalDeleted
    ? '<div class="dialog-actions" style="justify-content:flex-start"><button type="button" data-choice="external">接受外部刪除</button></div>'
    : '<div class="dialog-actions" style="justify-content:flex-start"><button type="button" data-choice="external">載入外部版本</button><button type="button" data-choice="both">兩份都保留</button></div>';
  $('confirmDialog').showModal();
  $('confirmExtra').querySelectorAll('button').forEach(button => button.onclick = () => { $('confirmDialog').returnValue = button.dataset.choice; $('confirmDialog').close(); });
  const choice = await new Promise(resolve => $('confirmDialog').addEventListener('close', () => resolve($('confirmDialog').returnValue), { once: true }));
  if (choice === 'default') {
    loadedModified = await vault.writeText(path, localText, null);
    dirty = editRevision !== revisionAtStart;
    setSaveState(dirty ? '尚未儲存' : '已儲存');
    toast('已保留目前版本');
  } else if (choice === 'external') {
    if (error.externalDeleted) {
      beginFileOperation('正在套用 FolderSync 的刪除…');
      try {
      saveGeneration += 1;
      clearTimeout(autoSaveTimer);
      tabs = tabs.filter(tab => tab !== path);
      currentPath = '';
      currentType = '';
      loadedModified = null;
      dirty = false;
      editRevision = 0;
      currentCanvasValid = true;
      currentTimelineValid = true;
      vault.contents.delete(path);
      const affectedPanes = [...secondaryPanes.values()].filter(pane => pane.path === path || pane.tabs.includes(path));
      for (const pane of affectedPanes) {
        clearTimeout(pane.timer);
        pane.tabs = pane.tabs.filter(tab => tab !== path);
        if (pane.path === path) {
          pane.openGeneration += 1;
          pane.path = '';
          pane.modified = null;
          pane.dirty = false;
          pane.revision = 0;
        }
      }
      await vault.scan();
      await rebuildIndex();
      for (const pane of affectedPanes) {
        if (!pane.tabs.length) await closeSecondaryPane(pane, false);
        else if (!pane.path) await openPathInSecondaryPane(pane, pane.tabs[0], false);
        else renderSecondaryTabs(pane);
      }
      renderTree();
      renderTabs();
      const next = tabs.find(tab => vault.node(tab));
      if (next) await openPath(next, false, true);
      else {
        $('breadcrumbs').textContent = vault.name;
        showView('welcome');
        setSaveState('已接受外部刪除');
      }
      toast('已接受 FolderSync 的刪除');
      return;
      } finally {
        endFileOperation();
      }
    }
    saveGeneration += 1;
    clearTimeout(autoSaveTimer);
    if (type === 'canvas') {
      try { canvasView.load(error.externalText, { key: path, view: readCanvasViewState(path) }); setCanvasReady(true); }
      catch (loadError) { setCanvasReady(false, loadError.message); }
    } else if (type === 'timeline') {
      try { timelineView.load(error.externalText, { key: `${vault.name}:${path}`, title: basename(path).replace(/\.timeline$/i, '') }); timelineView.setNotes(index?.entries || []); setTimelineReady(true); }
      catch (loadError) { setTimelineReady(false, loadError.message); }
    } else { $('editor').value = error.externalText; liveEditor.setValue(error.externalText); renderPreview(); }
    vault.contents.set(path, error.externalText); loadedModified = error.externalModified; dirty = false; editRevision = 0; setSaveState(currentDocumentReady() ? '已載入外部版本' : '無法編輯', !currentDocumentReady());
  } else if (choice === 'both') {
    beginFileOperation('正在安全保留兩個版本…');
    try {
    const latestLocalText = currentPath === path
      ? type === 'canvas'
        ? canvasView.json()
        : type === 'timeline'
          ? timelineView.json()
          : $('editor').value
      : localText;
    const folder = dirname(path), stem = basename(path).replace(/\.[^.]+$/, ''); const desired = `${stem}（衝突 ${new Date().toLocaleString('zh-TW').replace(/[/:]/g, '-')}）.${type}`;
    const name = await vault.uniqueName(folder, desired); await vault.writeText(`${folder ? `${folder}/` : ''}${name}`, latestLocalText);
    saveGeneration += 1;
    clearTimeout(autoSaveTimer);
    if (type === 'canvas') {
      try { canvasView.load(error.externalText, { key: path, view: readCanvasViewState(path) }); setCanvasReady(true); }
      catch (loadError) { setCanvasReady(false, loadError.message); }
    } else if (type === 'timeline') {
      try { timelineView.load(error.externalText, { key: `${vault.name}:${path}`, title: basename(path).replace(/\.timeline$/i, '') }); timelineView.setNotes(index?.entries || []); setTimelineReady(true); }
      catch (loadError) { setTimelineReady(false, loadError.message); }
    } else { $('editor').value = error.externalText; liveEditor.setValue(error.externalText); renderPreview(); }
    vault.contents.set(path, error.externalText); loadedModified = error.externalModified; dirty = false; editRevision = 0; await vault.scan(); await rebuildIndex(); renderTree(); setSaveState(currentDocumentReady() ? '已保留兩份' : '無法編輯', !currentDocumentReady()); toast(`目前內容另存為「${name}」`);
    } finally {
      endFileOperation();
    }
  } else setSaveState('尚未儲存', true);
}

function renderPreview() {
  if (currentType !== 'md') return;
  for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls = [];
  const source = $('editor').value;
  const context = {
    resolveWiki: target => index?.resolve(target, currentPath),
    embedWiki: target => {
      const resolved = index?.resolve(target, currentPath);
      if (resolved) return { html: `<strong>${noteStem(resolved.path)}</strong><p>${renderMarkdown(resolved.content, { resolveWiki: t => index?.resolve(t, resolved.path) })}</p>` };
      const asset = resolveAsset(target);
      if (asset) return { type: 'image', path: asset.path };
      return null;
    }
  };
  $('preview').innerHTML = renderMarkdown(source, context);
  $('preview').querySelectorAll('[data-wikilink]').forEach(link => link.addEventListener('click', async () => {
    const target = index?.resolve(link.dataset.wikilink, currentPath);
    if (target) { await openPath(target.path); if (link.dataset.heading) requestAnimationFrame(() => document.getElementById(link.dataset.heading.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-'))?.scrollIntoView()); }
    else if (await confirmAction('建立缺少的筆記？', `「${link.dataset.wikilink}」目前不存在。`, '建立', false)) { const parent = selectedFolder(); const node = await vault.createNote(parent, link.dataset.wikilink); await rebuildIndex(); renderTree(); await openPath(node.path); }
  }));
  $('preview').querySelectorAll('[data-file-link]').forEach(link => link.addEventListener('click', () => { const node = resolveAsset(link.dataset.fileLink); if (node) openPath(node.path); }));
  $('preview').querySelectorAll('[data-vault-image]').forEach(async image => {
    const node = resolveAsset(image.dataset.vaultImage); if (!node) return;
    try { const blob = await vault.readBlob(node.path); const url = URL.createObjectURL(blob); objectUrls.push(url); image.src = url; } catch { image.alt += '（無法讀取）'; }
  });
  $('preview').querySelectorAll('[data-tag]').forEach(tag => tag.addEventListener('click', () => searchTag(tag.dataset.tag)));
}

function resolveAsset(target, fromPath = currentPath) {
  const clean = decodeURIComponent(target).replace(/\\/g, '/');
  const relative = `${dirname(fromPath)}/${clean}`.replace(/^\//, '');
  return vault?.node(relative) || vault?.node(clean) || [...(vault?.nodes.values() || [])].find(node => node.kind === 'file' && node.name.toLowerCase() === basename(clean).toLowerCase());
}

function renderRightPanel() {
  const panel = $('rightPanel'); panel.innerHTML = '';
  if (!currentPath || currentType !== 'md') { panel.innerHTML = '<div class="panel-empty">開啟 Markdown 筆記後顯示資訊</div>'; return; }
  const source = $('editor').value;
  if (rightPanel === 'outline') {
    const headings = extractHeadings(source);
    if (!headings.length) panel.innerHTML = '<div class="panel-empty">這篇筆記沒有標題</div>';
    headings.forEach(heading => { const button = document.createElement('button'); button.className = `outline-item level-${Math.min(heading.level, 3)}`; button.textContent = heading.text; button.onclick = () => { const lines = $('editor').value.split('\n'); const offset = lines.slice(0, heading.line).join('\n').length + (heading.line ? 1 : 0); if (viewMode === 'live') { liveEditor.focus(); liveEditor.setSelectionRange(offset, offset + lines[heading.line].length); } else { $('editor').focus(); $('editor').setSelectionRange(offset, offset + lines[heading.line].length); } }; panel.append(button); });
  } else if (rightPanel === 'backlinks') {
    const links = index?.backlinks.get(currentPath) || [];
    if (!links.length) panel.innerHTML = '<div class="panel-empty">目前沒有其他筆記連到這裡</div>';
    links.forEach(item => appendPanelLink(panel, item.source, noteStem(item.source)));
    const unlinked = findUnlinkedMentions();
    if (unlinked.length) { const title = document.createElement('div'); title.className = 'panel-section-title'; title.textContent = '未連結提及'; panel.append(title); unlinked.forEach(path => appendPanelLink(panel, path, noteStem(path))); }
  } else if (rightPanel === 'links') {
    const links = extractLinks(source);
    const wiki = links.filter(link => link.type !== 'external'); const external = links.filter(link => link.type === 'external');
    const title1 = document.createElement('div'); title1.className = 'panel-section-title'; title1.textContent = '筆記連結'; panel.append(title1);
    wiki.forEach(link => { const target = index?.resolve(link.target, currentPath); appendPanelLink(panel, target?.path, link.target, !target); });
    const title2 = document.createElement('div'); title2.className = 'panel-section-title'; title2.textContent = '網頁連結'; panel.append(title2);
    external.forEach(link => { const a = document.createElement('a'); a.className = 'link-item'; a.href = link.target; a.target = '_blank'; a.rel = 'noopener'; a.textContent = link.label || link.target; panel.append(a); });
    if (!links.length) panel.innerHTML = '<div class="panel-empty">這篇筆記沒有連結</div>';
  } else {
    const front = parseFrontmatter(source).properties;
    const tags = extractTags(source);
    const rows = { ...front, tags: tags.join(', ') || '—', path: currentPath, modified: new Date(vault.node(currentPath)?.lastModified || Date.now()).toLocaleString('zh-TW') };
    Object.entries(rows).forEach(([key, value]) => { const row = document.createElement('div'); row.className = 'property-row'; row.innerHTML = '<b></b><span></span>'; row.firstChild.textContent = key; row.lastChild.textContent = Array.isArray(value) ? value.join(', ') : value; panel.append(row); });
  }
}

function appendPanelLink(panel, path, label, broken = false) {
  const button = document.createElement('button'); button.className = `link-item${broken ? ' broken-link' : ''}`; button.textContent = label;
  button.onclick = () => path && openPath(path); panel.append(button);
}

function findUnlinkedMentions() {
  if (!index) return [];
  const stem = noteStem(currentPath).toLowerCase();
  return index.entries.filter(entry => entry.path !== currentPath && entry.content.toLowerCase().includes(stem) && !entry.links.some(link => link.target.toLowerCase() === stem)).map(entry => entry.path);
}

function textareaSurface(editor, notify = () => editor.dispatchEvent(new Event('input'))) {
  return {
    value: () => editor.value, selection: () => ({ start: editor.selectionStart, end: editor.selectionEnd, text: editor.value.slice(editor.selectionStart, editor.selectionEnd) }),
    replace: (start, end, text, mode = 'end') => { editor.setRangeText(text, start, end, mode); notify(); },
    select: (start, end = start) => editor.setSelectionRange(start, end), focus: () => editor.focus(), focused: () => document.activeElement === editor
  };
}

function liveSurface(editor) {
  return { value: () => editor.value(), selection: () => editor.getSelection(), replace: (start, end, text, mode = 'end') => editor.replaceRange(start, end, text, mode), select: (start, end = start) => editor.setSelectionRange(start, end), focus: () => editor.focus(), focused: () => editor.isFocused() };
}

function runEditorHistory(action, mode, live, textarea) {
  if (mode === 'live') { live[action]?.(); return; }
  textarea.focus();
  document.execCommand(action === 'undo' ? 'undo' : 'redo');
}

function applyFormat(type, surface) {
  if (!surface) return;
  const value = surface.value(), { start, end, text: selected } = surface.selection(); let before = '', after = '', replacement = selected;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  switch (type) {
    case 'heading': before = '## '; break; case 'bold': before = '**'; after = '**'; break; case 'italic': before = '*'; after = '*'; break; case 'strike': before = '~~'; after = '~~'; break; case 'highlight': before = '=='; after = '=='; break;
    case 'link': before = '['; after = '](https://)'; break; case 'wikilink': before = '[['; after = ']]'; break; case 'code': before = selected.includes('\n') ? '```\n' : '`'; after = selected.includes('\n') ? '\n```' : '`'; break;
    case 'quote': replacement = value.slice(lineStart, end).split('\n').map(line => `> ${line}`).join('\n'); surface.replace(lineStart, end, replacement, 'select'); return;
    case 'list': replacement = value.slice(lineStart, end).split('\n').map(line => `- ${line}`).join('\n'); surface.replace(lineStart, end, replacement, 'select'); return;
    case 'task': replacement = value.slice(lineStart, end).split('\n').map(line => `- [ ] ${line}`).join('\n'); surface.replace(lineStart, end, replacement, 'select'); return;
  }
  surface.replace(start, end, `${before}${replacement}${after}`, 'end'); surface.focus();
}

function formatSelection(type) { applyFormat(type, viewMode === 'live' ? liveSurface(liveEditor) : textareaSurface($('editor'))); }

function renderWikiSuggest(box, surface, fromPath) {
  if (!surface?.focused()) { box.classList.add('hidden'); return; }
  const value = surface.value(), { start: caret } = surface.selection(); const before = value.slice(0, caret);
  const wikiMatch = before.match(/\[\[([^\]\n]*)$/);
  const tagMatch = wikiMatch ? null : before.match(/(?:^|\s)#([\p{L}\p{N}_/-]*)$/u);
  if ((!wikiMatch && !tagMatch) || !index) { box.classList.add('hidden'); return; }
  box.innerHTML = '';
  let candidates = [];
  if (wikiMatch) {
    const query = wikiMatch[1].toLowerCase();
    candidates = index.entries.filter(entry => `${noteStem(entry.path)} ${entry.path}`.toLowerCase().includes(query) && entry.path !== fromPath).slice(0, 12).map(entry => ({ value: noteStem(entry.path), label: noteStem(entry.path), meta: dirname(entry.path), start: caret - wikiMatch[1].length, suffix: ']]' }));
    box.setAttribute('aria-label', '選擇要連結的筆記');
  } else {
    const query = tagMatch[1].toLowerCase();
    const tags = new Set(index.entries.flatMap(entry => entry.tags || extractTags(entry.content)));
    candidates = [...tags].filter(tag => tag.toLowerCase().includes(query)).sort((a, b) => a.localeCompare(b, 'zh-Hant')).slice(0, 12).map(tag => ({ value: tag, label: `#${tag}`, meta: '標籤', start: caret - tagMatch[1].length, suffix: '' }));
    box.setAttribute('aria-label', '選擇標籤');
  }
  candidates.forEach(item => { const button = document.createElement('button'); button.type = 'button'; button.className = 'suggestion'; button.innerHTML = '<span></span><small></small>'; button.firstChild.textContent = item.label; button.lastChild.textContent = item.meta; button.onpointerdown = event => { event.preventDefault(); surface.replace(item.start, caret, `${item.value}${item.suffix}`); box.classList.add('hidden'); surface.focus(); }; box.append(button); });
  box.classList.toggle('hidden', !candidates.length);
}

function updateWikiSuggest() { renderWikiSuggest($('wikiSuggest'), viewMode === 'live' ? liveSurface(liveEditor) : textareaSurface($('editor')), currentPath); }
function updatePaneWikiSuggest(pane) { renderWikiSuggest(pane.suggest, pane.mode === 'live' ? liveSurface(pane.live) : textareaSurface(pane.editor, pane.markDirty), pane.path); }

function searchTag(tag) {
  const clean = String(tag || '').replace(/^#/, '').trim();
  if (!clean) return;
  $('fileSearch').value = `#${clean}`;
  if (innerWidth <= 760) app.classList.add('left-open');
  else { app.classList.remove('left-collapsed'); $('showLeft').classList.add('hidden'); }
  renderTree();
  requestAnimationFrame(() => { $('fileSearch').focus(); $('fileSearch').setSelectionRange($('fileSearch').value.length, $('fileSearch').value.length); });
}

async function importPastedImage(event) {
  if (!vault || currentType !== 'md') return;
  const file = [...event.clipboardData.files].find(item => item.type.startsWith('image/'));
  if (!file) return;
  event.preventDefault();
  await importAttachments([file], textareaSurface($('editor')));
}

async function importAttachments(files, surface = null) {
  if (!vault || !files.length) return;
  const folder = settings.attachmentFolder.trim().replace(/^\/|\/$/g, '');
  let parentPath = '';
  for (const part of folder.split('/').filter(Boolean)) { const next = `${parentPath ? `${parentPath}/` : ''}${safeName(part)}`; if (!vault.node(next)) await vault.createFolder(parentPath, part); parentPath = next; }
  const normalized = files.map((file, index) => {
    if (file.name && file.name !== 'image.png') return file;
    const extension = file.name?.includes('.') ? `.${file.name.split('.').pop()}` : `.${file.type.split('/')[1] || 'png'}`;
    return new File([file], `圖片 ${new Date().toISOString().replace(/[:.]/g, '-')}${index ? ` ${index + 1}` : ''}${extension}`, { type: file.type });
  });
  const paths = await vault.importFiles(parentPath, normalized);
  const markdown = paths.map((path, index) => normalized[index].type.startsWith('image/') ? `![[${path}]]` : `[${normalized[index].name}](${path})`).join('\n');
  surface ||= viewMode === 'live' ? liveSurface(liveEditor) : textareaSurface($('editor'));
  const { start, end } = surface.selection(); surface.replace(start, end, markdown); renderTree();
}

function openGraph() {
  if (!index) return toast('請先開啟筆記庫');
  graphDocked = true;
  if (!$('graphWorkspace').closest('.pane-slot')) insertPane($('graphWorkspace'), 'graph', 'right', activePaneSlot);
  showView('graph'); persistVaultState();
  requestAnimationFrame(() => { updateGraph(); graph.resize(); graph.draw(); });
}

function toggleGraphDock() { if (graphDocked) closeGraphDock(); else openGraph(); }

function closeGraphDock() {
  graphDocked = false; $('graphWorkspace').classList.add('hidden');
  const slot = $('graphWorkspace').closest('.pane-slot'); if (slot) detachPaneSlot(slot);
  persistVaultState();
  if (!currentPath && !secondaryPanes.size) showView('welcome');
}

function updateGraph() {
  graph.setData(index, { scope: $('graphScope').value, currentPath: currentType === 'md' ? currentPath : '', depth: Number($('graphDepth').value), filter: $('graphFilter').value, isolates: $('graphIsolates').classList.contains('active') });
  $('graphSummary').textContent = `${graph.nodes.length} 篇筆記 · ${graph.edges.length} 條連結`;
}

function closeSpecialView() { closeGraphDock(); }

const liveEditor = new LiveMarkdownEditor($('liveEditor'), {
  onChange: source => { $('editor').value = source; scheduleSave(); renderRightPanel(); }, onCursor: updateWikiSuggest,
  onLink: async (target, heading) => {
    const resolved = index?.resolve(target, currentPath);
    if (resolved) { await openPath(resolved.path); if (heading) requestAnimationFrame(() => document.getElementById(heading.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-'))?.scrollIntoView()); }
  },
  onFileLink: target => { if (/^https?:\/\//i.test(target)) window.open(target, '_blank', 'noopener'); else { const node = resolveAsset(target); if (node) openPath(node.path); } },
  onTag: searchTag,
  onPasteFiles: files => importAttachments(files, liveSurface(liveEditor))
});

const graph = new GraphView($('graphCanvas'), path => openPath(path));
const canvasView = new CanvasView({
  viewport: $('canvasViewport'), surface: $('canvasSurface'), nodesLayer: $('canvasNodes'), edgesLayer: $('canvasEdges'),
  onChange: () => { if (currentType === 'canvas' && currentCanvasValid) scheduleSave(); }, onOpenNote: path => openPath(path),
  onOpenTextLink: (target, kind) => { const node = kind === 'wiki' ? index?.resolve(target, currentPath) : resolveAsset(target, currentPath); if (node) openPath(node.path); },
  onTag: searchTag,
  onViewChange: (state, key) => { if (key) writeCanvasViewState(key, state); },
  chooseNote: async () => {
    if (!index?.entries.length) return null;
    const entry = await chooseFromList('選擇筆記', index.entries, item => item.path, '選擇要放入 Canvas 的筆記…'); return entry?.path || null;
  }
});

async function openTimelineLinkedNote(path, options = {}) {
  const node = vault?.node(path);
  if (!node || node.ext !== 'md') return toast(`找不到連結筆記「${path}」；可能尚未由 FolderSync 同步完成`, true);
  const primarySlot = document.querySelector('.pane-slot[data-pane-key="primary"]');
  const availableWidth = primarySlot?.getBoundingClientRect().width || 0;
  if (options.beside && availableWidth >= 720) {
    const existing = [...secondaryPanes.values()].find(pane => pane.tabs.includes(path));
    if (existing) return openPathInSecondaryPane(existing, path, false);
    return addSecondaryPane(path, 'right', primarySlot || activePaneSlot);
  }
  return openPath(path, true, true);
}

const timelineView = new TimelineView({
  root: $('timelineWorkspace'),
  onChange: () => { if (currentType === 'timeline' && currentTimelineValid) scheduleSave(); },
  onOpenNote: openTimelineLinkedNote,
  onAcceptNote: path => vault?.node(path)?.ext === 'md',
  requestText: (title, value, help) => ask(title, value, help),
  notify: toast
});

function openCommandPalette() {
  const commands = [
    { label: '新增筆記', hint: settings.shortcuts.newNote, run: () => createNote() }, { label: '新增資料夾', run: () => createFolder() }, { label: '新增 Canvas', run: () => createCanvas() }, { label: '新增時間線', run: () => createTimeline() },
    { label: '關聯圖譜', hint: settings.shortcuts.graph, run: openGraph }, { label: '分割目前筆記', hint: settings.shortcuts.split, run: splitCurrentNote }, { label: '重新讀取筆記庫', run: refreshVault }, { label: '設定', run: openSettings }
  ];
  const specialDocuments = vault ? [...vault.canvasNodes(), ...vault.timelineNodes()].map(node => ({
    label: basename(node.path).replace(/\.(canvas|timeline)$/i, ''),
    hint: dirname(node.path),
    kind: node.ext === 'timeline' ? '時間線' : 'Canvas',
    run: () => openPath(node.path)
  })) : [];
  $('commandSearch').placeholder = '輸入指令或筆記名稱…'; $('commandSearch').value = ''; $('commandDialog').showModal();
  const render = () => {
    const q = $('commandSearch').value.toLowerCase(); $('commandResults').innerHTML = '';
    const rows = [...commands.map(item => ({ ...item, kind: '指令' })), ...(index?.entries || []).map(entry => ({ label: noteStem(entry.path), hint: dirname(entry.path), kind: '筆記', run: () => openPath(entry.path) })), ...specialDocuments].filter(item => `${item.label} ${item.hint || ''}`.toLowerCase().includes(q)).slice(0, 60);
    rows.forEach(item => { const button = document.createElement('button'); button.type = 'button'; button.className = 'command-result'; button.innerHTML = '<span></span><span></span><small></small>'; button.children[0].textContent = item.kind === '筆記' ? '▤' : item.kind === '時間線' ? '⌁' : item.kind === 'Canvas' ? '◇' : '›'; button.children[1].textContent = item.label; button.children[2].textContent = item.hint || item.kind; button.onclick = () => { $('commandDialog').close(); item.run(); }; $('commandResults').append(button); });
  };
  const listener = render; $('commandSearch').addEventListener('input', listener); render(); setTimeout(() => $('commandSearch').focus(), 0);
  $('commandDialog').addEventListener('close', () => $('commandSearch').removeEventListener('input', listener), { once: true });
}

async function refreshVault() {
  if (!vault || fileOperationDepth > 0) return;
  beginFileOperation('正在重新讀取筆記庫…');
  try {
    if (dirty || [...secondaryPanes.values()].some(pane => pane.dirty)) await saveAllPanes(true);
    if (dirty || [...secondaryPanes.values()].some(pane => pane.dirty)) return toast('仍有內容尚未儲存；請先處理衝突再重新讀取', true);
    if (settingsFolderHandle) await loadSettingsFile(settingsFolderHandle);
    const previousModified = currentPath ? vault.node(currentPath)?.lastModified : null;
    await vault.scan();
    if (fileClipboard && !vault.node(fileClipboard.path)) fileClipboard = null;
    await rebuildIndex(); renderTree();
    const current = vault.node(currentPath);
    if (current && previousModified && current.lastModified !== previousModified && !dirty) await openPath(currentPath, false, true);
    if (!current && currentPath && !dirty) { tabs = tabs.filter(path => path !== currentPath); currentPath = ''; currentType = ''; currentCanvasValid = true; currentTimelineValid = true; showView('welcome'); renderTabs(); }
    toast('已重新讀取筆記庫');
  } finally {
    endFileOperation();
  }
}

async function saveAllPanes(silent = false) {
  await saveCurrent(silent);
  await Promise.all([...secondaryPanes.values()].map(pane => pane.save()));
}

function shortcutFromEvent(event) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return '';
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  let key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  if (key === ' ') key = 'Space';
  parts.push(key);
  return parts.join('+');
}

function eventMatchesShortcut(event, shortcut) {
  if (!shortcut) return false;
  return shortcutFromEvent(event).toLowerCase() === shortcut.toLowerCase();
}

function updateShortcutHints() {
  $('fileSearchShortcut').textContent = settings.shortcuts.search || '—';
  $('fileSearch').title = settings.shortcuts.search ? `搜尋筆記庫（${settings.shortcuts.search}）` : '搜尋筆記庫';
  $('openGraph').title = `開啟或關閉關聯圖譜${settings.shortcuts.graph ? `（${settings.shortcuts.graph}）` : ''}`;
  $('splitCurrent').title = `選擇分割方向${settings.shortcuts.split ? `（${settings.shortcuts.split}）` : ''}`;
  $('timelineAddEvent').title = `直接新增事件${settings.shortcuts.timelineNewEvent ? `（${settings.shortcuts.timelineNewEvent}）` : ''}`;
  $('timelineAddTrack').title = `直接新增軌道${settings.shortcuts.timelineNewTrack ? `（${settings.shortcuts.timelineNewTrack}）` : ''}`;
  $('timelineAddGroup').title = `新增軌道資料夾${settings.shortcuts.timelineNewGroup ? `（${settings.shortcuts.timelineNewGroup}）` : ''}`;
}

function renderShortcutSettings() {
  const container = $('shortcutSettings'); container.innerHTML = '';
  for (const [action, label] of Object.entries(SHORTCUT_LABELS)) {
    const row = document.createElement('label'); row.className = 'shortcut-row';
    row.innerHTML = '<span></span><input class="shortcut-input" readonly>';
    row.firstChild.textContent = label;
    const input = row.querySelector('input'); input.value = settings.shortcuts[action] || ''; input.placeholder = '未設定';
    input.onfocus = () => { input.classList.add('recording'); input.select(); };
    input.onblur = () => input.classList.remove('recording');
    input.onkeydown = event => {
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Backspace' || event.key === 'Delete') settings.shortcuts[action] = '';
      else if (event.key === 'Escape') { input.blur(); return; }
      else {
        const value = shortcutFromEvent(event); if (!value) return;
        for (const key of Object.keys(settings.shortcuts)) if (key !== action && settings.shortcuts[key].toLowerCase() === value.toLowerCase()) settings.shortcuts[key] = '';
        settings.shortcuts[action] = value;
      }
      persistSettings(); renderShortcutSettings();
    };
    container.append(row);
  }
  const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = '重設為預設快捷鍵';
  reset.onclick = () => { settings.shortcuts = { ...DEFAULT_SHORTCUTS }; persistSettings(); renderShortcutSettings(); };
  container.append(reset);
}

function openSettings() {
  $('settingsVault').textContent = vault?.name || '尚未選擇';
  $('attachmentFolder').value = settings.attachmentFolder;
  $('trashMode').value = settings.trashMode;
  $('updateLinks').checked = settings.updateLinks;
  $('autoSave').checked = settings.autoSave;
  $('settingsFileName').value = settings.settingsFileName || 'mysyncnote-settings.json';
  $('settingsFileLocation').textContent = settingsFolderHandle ? `${settingsFolderHandle.name}/${safeName(settings.settingsFileName, '.json')}` : '目前只儲存在這台裝置';
  renderShortcutSettings();
  $('settingsDialog').showModal();
}

// Main controls
$('openVault').onclick = openVaultPicker; $('settingsChangeVault').onclick = openVaultPicker;
$('newNote').onclick = () => createNote(); $('newFolder').onclick = () => createFolder(); $('newCanvas').onclick = () => createCanvas(); $('newTimeline').onclick = () => createTimeline(); $('refreshVault').onclick = refreshVault;
$('splitCurrent').onclick = event => showMenu([
  { label: '向右分割目前筆記', action: () => splitCurrentNote('right') },
  { label: '向下分割目前筆記', action: () => splitCurrentNote('bottom') },
  { label: '向左分割目前筆記', action: () => splitCurrentNote('left') },
  { label: '向上分割目前筆記', action: () => splitCurrentNote('top') }
], event.clientX, event.clientY);
$('workspaceDock').ondragover = event => { if ([...event.dataTransfer.types].includes('text/mysyncnote-path')) { event.preventDefault(); $('workspaceDock').classList.add('drag-target'); } };
$('workspaceDock').ondragleave = event => { if (!$('workspaceDock').contains(event.relatedTarget)) $('workspaceDock').classList.remove('drag-target'); };
$('workspaceDock').ondrop = event => { $('workspaceDock').classList.remove('drag-target'); const path = event.dataTransfer.getData('text/mysyncnote-path'); if (path) { event.preventDefault(); addSecondaryPane(path); } };
$('fileSearch').oninput = renderTree; $('fileSearch').onkeydown = event => { if (event.key === 'Escape') { event.currentTarget.value = ''; renderTree(); } };
$('collapseLeft').onclick = () => { app.classList.add('left-collapsed'); app.classList.remove('left-open'); $('showLeft').classList.remove('hidden'); };
$('showLeft').onclick = () => { if (innerWidth <= 760) app.classList.add('left-open'); else { app.classList.remove('left-collapsed'); $('showLeft').classList.add('hidden'); } };
$('leftScrim').onclick = hideMobilePanels;
$('collapseRight').onclick = () => { app.classList.add('right-collapsed'); app.classList.remove('right-open'); };
$('toggleRight').onclick = () => { if (innerWidth <= 1050) app.classList.toggle('right-open'); else app.classList.toggle('right-collapsed'); };
$('openSettings').onclick = openSettings;
$('vaultMenu').onclick = event => showMenu([{ label: vault ? '更換筆記庫' : '開啟筆記庫', action: openVaultPicker }, { label: '重新讀取', action: refreshVault }, { label: '設定', action: openSettings }], event.clientX, event.clientY);
$('explorerMore').onclick = event => showMenu([{ label: '依名稱排序', action: renderTree }, ...(fileClipboard ? [{ label: '貼上到筆記庫根目錄', shortcut: 'Ctrl+V', action: () => pasteFileClipboard('') }, 'separator'] : []), { label: '全部展開', action: () => { vault && [...vault.nodes.values()].filter(n => n.kind === 'directory').forEach(n => expanded.add(n.path)); persistSettings(); renderTree(); } }, { label: '全部收合', action: () => { expanded.clear(); persistSettings(); renderTree(); } }], event.clientX, event.clientY);
document.addEventListener('pointerdown', event => { if (!event.target.closest('#contextMenu,[data-menu-anchor]')) $('contextMenu').classList.add('hidden'); });

$('editor').addEventListener('input', () => { scheduleSave(); if (viewMode !== 'edit') renderPreview(); renderRightPanel(); updateWikiSuggest(); });
$('editor').addEventListener('keyup', updateWikiSuggest); $('editor').addEventListener('click', updateWikiSuggest); $('editor').addEventListener('paste', importPastedImage);
$('editor').addEventListener('dragover', event => { if (event.dataTransfer?.files?.length) event.preventDefault(); });
$('editor').addEventListener('drop', event => { if (!event.dataTransfer?.files?.length) return; event.preventDefault(); importAttachments([...event.dataTransfer.files]); });
document.querySelectorAll('[data-format]').forEach(button => button.onclick = () => formatSelection(button.dataset.format));
document.querySelectorAll('[data-history]').forEach(button => button.onclick = () => runEditorHistory(button.dataset.history, viewMode, liveEditor, $('editor')));
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { viewMode = button.dataset.view; localStorage.setItem('mysyncnote-view', viewMode); applyViewMode(); renderPreview(); persistVaultState(); });
$('documentTitle').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { event.currentTarget.value = noteStem(currentPath); event.currentTarget.blur(); } });
$('documentTitle').addEventListener('change', () => renamePath(currentPath, $('documentTitle').value));
$('documentMore').onclick = event => { const node = vault?.node(currentPath); if (node) showNodeMenu(node, event.clientX, event.clientY); };
$('closeDocument').onclick = () => currentPath && closeTab(currentPath);

document.querySelectorAll('[data-panel]').forEach(button => button.onclick = () => { rightPanel = button.dataset.panel; document.querySelectorAll('[data-panel]').forEach(item => item.classList.toggle('active', item === button)); renderRightPanel(); });
$('goBack').onclick = () => { if (historyIndex > 0) openPath(history[--historyIndex], false, true).then(updateHistoryButtons); };
$('goForward').onclick = () => { if (historyIndex < history.length - 1) openPath(history[++historyIndex], false, true).then(updateHistoryButtons); };
$('openGraph').onclick = toggleGraphDock; $('closeGraph').onclick = closeGraphDock; $('graphScope').onchange = updateGraph; $('graphDepth').oninput = updateGraph; $('graphFilter').oninput = updateGraph; $('graphIsolates').onclick = () => { $('graphIsolates').classList.toggle('active'); updateGraph(); };
$('canvasAddText').onclick = () => canvasView.addText(); $('canvasAddNote').onclick = () => canvasView.addNote(); $('canvasAddLink').onclick = async () => { const url = await ask('新增網頁連結', 'https://', '輸入要放進 Canvas 的網址'); if (url) canvasView.addLink(url); }; $('canvasAddGroup').onclick = () => canvasView.addGroup(); $('canvasUndo').onclick = () => canvasView.undo(); $('canvasRedo').onclick = () => canvasView.redo(); $('canvasZoomOut').onclick = () => canvasView.zoomBy(1 / 1.2); $('canvasZoomReset').onclick = () => canvasView.resetView(); $('canvasZoomIn').onclick = () => canvasView.zoomBy(1.2); $('canvasFit').onclick = () => canvasView.fit(); $('closeCanvas').onclick = () => currentPath && closeTab(currentPath);
$('timelineTitle').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { event.currentTarget.value = basename(currentPath).replace(/\.timeline$/i, ''); event.currentTarget.blur(); } });
$('timelineTitle').addEventListener('change', () => { if (currentType === 'timeline') renamePath(currentPath, $('timelineTitle').value); });
$('closeTimeline').onclick = () => currentPath && closeTab(currentPath);

$('attachmentFolder').onchange = () => { settings.attachmentFolder = $('attachmentFolder').value.trim() || 'attachments'; persistSettings(); };
$('trashMode').onchange = () => { settings.trashMode = $('trashMode').value; persistSettings(); };
$('updateLinks').onchange = () => { settings.updateLinks = $('updateLinks').checked; persistSettings(); };
$('autoSave').onchange = () => { settings.autoSave = $('autoSave').checked; persistSettings(); };
$('settingsFileName').onchange = () => { settings.settingsFileName = safeName($('settingsFileName').value, '.json'); $('settingsFileName').value = settings.settingsFileName; persistSettings(); renderTree(); };
$('chooseSettingsFolder').onclick = chooseSettingsFolder;

addEventListener('keydown', event => {
  if (fileOperationDepth > 0) {
    if (!event.target.closest?.('dialog')) event.preventDefault();
    return;
  }
  if (event.target.classList?.contains('shortcut-input')) return;
  const typing = event.target.matches?.('input,textarea,select,[contenteditable]') || Boolean(event.target.closest?.('[contenteditable]'));
  const clipboardShortcut = (event.ctrlKey || event.metaKey) && !event.altKey;
  if (!typing && currentView === 'timeline' && currentTimelineValid && eventMatchesShortcut(event, settings.shortcuts.timelineNewEvent)) { event.preventDefault(); timelineView.addEvent(); }
  else if (!typing && currentView === 'timeline' && currentTimelineValid && eventMatchesShortcut(event, settings.shortcuts.timelineNewTrack)) { event.preventDefault(); timelineView.addTrack(); }
  else if (!typing && currentView === 'timeline' && currentTimelineValid && eventMatchesShortcut(event, settings.shortcuts.timelineNewGroup)) { event.preventDefault(); timelineView.addTrackGroup(); }
  else if (!typing && clipboardShortcut && event.key.toLowerCase() === 'c' && selectedPath) { event.preventDefault(); setFileClipboard('copy', selectedPath); }
  else if (!typing && clipboardShortcut && event.key.toLowerCase() === 'x' && selectedPath) { event.preventDefault(); setFileClipboard('cut', selectedPath); }
  else if (!typing && clipboardShortcut && event.key.toLowerCase() === 'v' && fileClipboard) { event.preventDefault(); pasteFileClipboard(); }
  else if (eventMatchesShortcut(event, settings.shortcuts.save)) { event.preventDefault(); const pane = activeSecondaryPane(); pane ? pane.save() : saveCurrent(); }
  else if (eventMatchesShortcut(event, settings.shortcuts.close) && activeDocumentPath()) { event.preventDefault(); const pane = activeSecondaryPane(); pane ? closeSecondaryTab(pane, pane.path) : closeTab(currentPath); }
  else if (eventMatchesShortcut(event, settings.shortcuts.command)) { event.preventDefault(); openCommandPalette(); }
  else if (eventMatchesShortcut(event, settings.shortcuts.search)) { event.preventDefault(); $('fileSearch').focus(); }
  else if (eventMatchesShortcut(event, settings.shortcuts.newNote)) { event.preventDefault(); createNote(); }
  else if (eventMatchesShortcut(event, settings.shortcuts.graph)) { event.preventDefault(); toggleGraphDock(); }
  else if (eventMatchesShortcut(event, settings.shortcuts.rename) && selectedPath && !typing) { event.preventDefault(); renamePath(selectedPath); }
  else if (eventMatchesShortcut(event, settings.shortcuts.toggleLeft) && !typing) { event.preventDefault(); if (innerWidth <= 760) app.classList.toggle('left-open'); else { app.classList.toggle('left-collapsed'); $('showLeft').classList.toggle('hidden', !app.classList.contains('left-collapsed')); } }
  else if (eventMatchesShortcut(event, settings.shortcuts.split) && !typing) { event.preventDefault(); splitCurrentNote(); }
  if (event.key === 'Delete' && selectedPath && !['canvas', 'timeline'].includes(currentView) && !event.target.matches('input,textarea,[contenteditable]')) { event.preventDefault(); deletePath(selectedPath); }
  if (event.key === 'Escape') { hideMobilePanels(); $('contextMenu').classList.add('hidden'); $('wikiSuggest').classList.add('hidden'); }
});

addEventListener('beforeunload', event => { if (dirty || [...secondaryPanes.values()].some(pane => pane.dirty)) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { const anyDirty = dirty || [...secondaryPanes.values()].some(pane => pane.dirty); if (document.hidden && anyDirty) saveAllPanes(true); else if (!document.hidden && vault && !anyDirty && fileOperationDepth === 0) refreshVault(); });
addEventListener('focus', () => { if (vault && fileOperationDepth === 0 && !dirty && ![...secondaryPanes.values()].some(pane => pane.dirty) && document.visibilityState === 'visible') refreshVault(); });

async function restore() {
  renderTree(); applyViewMode();
  const recalledSettings = await recalledSettingsFolder();
  if (recalledSettings) {
    try {
      const permission = await recalledSettings.queryPermission({ mode: 'readwrite' });
      if (permission === 'granted') {
        settingsFolderHandle = recalledSettings;
        if (!await loadSettingsFile(recalledSettings)) await writeSettingsFile();
      } else $('settingsFileLocation').textContent = `需要重新選擇「${recalledSettings.name}」`;
    } catch (error) { console.warn('無法還原設定檔位置', error); }
  }
  rememberedHandle = await recalledVault();
  if (!rememberedHandle) return;
  try {
    const permission = typeof rememberedHandle.queryPermission === 'function' ? await rememberedHandle.queryPermission({ mode: 'readwrite' }) : 'granted';
    if (permission === 'granted') { const handle = rememberedHandle; rememberedHandle = null; await loadVault(handle); }
    else { $('vaultName').textContent = rememberedHandle.name; $('vaultState').textContent = '點一下重新連線'; $('openVaultText').textContent = `重新連線「${rememberedHandle.name}」`; }
  } catch (error) { console.warn('無法還原筆記庫', error); }
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(console.warn);
initPaneLayout();
updateShortcutHints();
updateWelcome();
restore();
