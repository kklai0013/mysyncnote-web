import { Vault, rememberVault, recalledVault, rememberSettingsFolder, recalledSettingsFolder, safeName, dirname, basename } from './storage.js';
import { renderMarkdown, extractHeadings, extractTags, extractLinks, buildIndex, noteStem, replaceWikiTarget, parseFrontmatter } from './markdown.js';
import { GraphView } from './graph.js';
import { CanvasView } from './canvas.js';

const $ = id => document.getElementById(id);
const app = $('app');
const DEFAULT_SHORTCUTS = { save: 'Ctrl+S', command: 'Ctrl+P', search: 'Ctrl+K', newNote: 'Ctrl+N', graph: 'Ctrl+G', rename: 'F2', toggleLeft: 'Ctrl+B', split: 'Ctrl+\\' };
const SHORTCUT_LABELS = { save: '立即儲存', command: '命令面板', search: '搜尋筆記庫', newNote: '新增筆記', graph: '顯示／關閉關聯圖譜', rename: '重新命名選取項目', toggleLeft: '顯示／收起左側欄', split: '將目前筆記分割到新窗格' };
const settings = Object.assign({ attachmentFolder: 'attachments', defaultFolder: '', trashMode: 'trash', updateLinks: true, autoSave: true, settingsFileName: 'mysyncnote-settings.json', shortcuts: { ...DEFAULT_SHORTCUTS } }, JSON.parse(localStorage.getItem('mysyncnote-preferences') || '{}'));
settings.shortcuts = { ...DEFAULT_SHORTCUTS, ...(settings.shortcuts || {}) };
for (const key of Object.keys(DEFAULT_SHORTCUTS)) if (typeof settings.shortcuts[key] !== 'string') settings.shortcuts[key] = '';
let vault = null;
let rememberedHandle = null;
let settingsFolderHandle = null;
let index = null;
let selectedPath = '';
let currentPath = '';
let currentType = '';
let loadedModified = null;
let dirty = false;
let autoSaveTimer = null;
let saveChain = Promise.resolve();
let indexingTimer = null;
let rightPanel = 'outline';
let viewMode = localStorage.getItem('mysyncnote-view') || 'edit';
let currentView = 'welcome';
let graphDocked = false;
let tabs = JSON.parse(sessionStorage.getItem('mysyncnote-tabs') || '[]');
let secondaryPanePaths = JSON.parse(sessionStorage.getItem('mysyncnote-secondary-panes') || '[]');
const secondaryPanes = new Map();
let history = [];
let historyIndex = -1;
let objectUrls = [];
const expanded = new Set(JSON.parse(localStorage.getItem('mysyncnote-expanded') || '[]'));

function persistSettings() {
  localStorage.setItem('mysyncnote-preferences', JSON.stringify(settings));
  localStorage.setItem('mysyncnote-expanded', JSON.stringify([...expanded]));
  scheduleSettingsFileWrite();
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
    Object.assign(settings, incoming, { shortcuts: { ...DEFAULT_SHORTCUTS, ...(incoming.shortcuts || {}) } });
    for (const key of Object.keys(DEFAULT_SHORTCUTS)) if (typeof settings.shortcuts[key] !== 'string') settings.shortcuts[key] = '';
    localStorage.setItem('mysyncnote-preferences', JSON.stringify(settings));
    settingsFolderHandle = handle;
    $('settingsFileLocation').textContent = `${handle.name}/${name}`;
    return true;
  } catch (error) {
    if (error.name !== 'NotFoundError') console.warn('設定檔讀取失敗', error);
    return false;
  }
}

async function chooseSettingsFolder() {
  if (!window.showDirectoryPicker) return toast('這個瀏覽器不能選擇設定檔資料夾', true);
  try {
    const handle = await showDirectoryPicker({ mode: 'readwrite' });
    settingsFolderHandle = handle;
    await rememberSettingsFolder(handle);
    await writeSettingsFile();
    toast(`設定檔會儲存在「${handle.name}」`);
  } catch (error) { if (error.name !== 'AbortError') toast(error.message, true); }
}

function toast(message, error = false) {
  const element = $('toast');
  element.textContent = message;
  element.className = `toast${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.add('hidden'), error ? 6000 : 3200);
}

function setSaveState(text, error = false) {
  $('saveState').textContent = text;
  $('saveState').classList.toggle('error', error);
  $('canvasState').textContent = text;
}

function showView(name) {
  if (name === 'graph') {
    graphDocked = true;
    name = currentType === 'canvas' ? 'canvas' : currentPath ? 'note' : 'graph';
  }
  currentView = name;
  const workspaceVisible = name !== 'welcome' || graphDocked || secondaryPanes.size > 0;
  $('welcome').classList.toggle('hidden', workspaceVisible);
  $('workspaceDock').classList.toggle('hidden', !workspaceVisible);
  $('noteWorkspace').classList.toggle('hidden', name !== 'note');
  $('canvasWorkspace').classList.toggle('hidden', name !== 'canvas');
  $('graphWorkspace').classList.toggle('hidden', !graphDocked);
}

function hideMobilePanels() {
  app.classList.remove('left-open', 'right-open');
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
  if (currentPath) return dirname(currentPath);
  return '';
}

async function openVaultPicker() {
  if (!window.showDirectoryPicker) {
    toast('這個瀏覽器不能直接開啟資料夾。請使用最新版 Chrome 或 Edge，並從 HTTPS 網址開啟。', true);
    return;
  }
  try {
    let handle;
    if (rememberedHandle) {
      const permission = await rememberedHandle.requestPermission({ mode: 'readwrite' });
      if (permission === 'granted') handle = rememberedHandle;
    }
    if (!handle) handle = await showDirectoryPicker({ mode: 'readwrite' });
    await rememberVault(handle);
    rememberedHandle = null;
    await loadVault(handle);
  } catch (error) {
    if (error.name !== 'AbortError') toast(`${error.name}: ${error.message}`, true);
  }
}

async function loadVault(handle) {
  if (dirty || [...secondaryPanes.values()].some(pane => pane.dirty)) await saveAllPanes();
  vault = new Vault(handle);
  if (await vault.permission(true) !== 'granted') throw new Error('沒有筆記庫的讀寫權限');
  $('vaultState').textContent = '正在讀取…';
  await vault.scan();
  $('vaultName').textContent = vault.name;
  $('vaultState').textContent = '本機筆記庫';
  $('openVaultText').textContent = '更換筆記庫';
  $('settingsVault').textContent = vault.name;
  localStorage.setItem('mysyncnote-vault-name', vault.name);
  await rebuildIndex();
  const defaultPath = settings.defaultFolder.trim().replace(/\\/g, '/').replace(/^\/|\/$/g, '');
  if (defaultPath && vault.node(defaultPath)?.kind === 'directory') {
    selectedPath = defaultPath;
    for (let path = defaultPath; path; path = dirname(path)) expanded.add(path);
  } else selectedPath = '';
  renderTree();
  if (tabs.length) {
    tabs = tabs.filter(path => vault.node(path));
    if (tabs.length) await openPath(tabs[0], false);
    else showView('welcome');
  } else {
    const candidates = [...vault.markdownNodes(), ...vault.canvasNodes()];
    const first = candidates.find(node => !defaultPath || node.path.startsWith(`${defaultPath}/`)) || candidates[0];
    if (first) await openPath(first.path);
    else showView('welcome');
  }
  await restoreSecondaryPanes();
  renderTabs();
  toast(`已開啟筆記庫「${vault.name}」`);
}

async function rebuildIndex() {
  if (!vault) return;
  const entries = [];
  for (const node of vault.markdownNodes()) {
    try { entries.push({ path: node.path, content: await vault.readText(node.path), modified: node.lastModified }); }
    catch (error) { console.warn('索引失敗', node.path, error); }
  }
  index = buildIndex(entries);
  renderRightPanel();
}

function scheduleIndex() {
  clearTimeout(indexingTimer);
  indexingTimer = setTimeout(rebuildIndex, 450);
}

function treeMatches(node, query) {
  if (!query) return true;
  if (node.path.toLowerCase().includes(query)) return true;
  if (node.kind === 'file' && node.ext === 'md') return index?.byPath.get(node.path)?.content.toLowerCase().includes(query);
  return node.children?.some(child => treeMatches(child, query));
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
  if (!treeMatches(node, query)) return;
  const row = document.createElement('div');
  row.className = `tree-row${node.path === selectedPath || node.path === currentPath ? ' active' : ''}`;
  row.style.paddingLeft = `${6 + depth * 16}px`;
  row.dataset.path = node.path; row.draggable = true; row.setAttribute('role', 'treeitem');
  const toggle = document.createElement('span'); toggle.className = 'tree-toggle';
  toggle.textContent = node.kind === 'directory' ? (expanded.has(node.path) || query ? '▾' : '▸') : '';
  const icon = document.createElement('span'); icon.className = 'tree-icon';
  icon.textContent = node.kind === 'directory' ? (expanded.has(node.path) || query ? '▾' : '▸') : node.ext === 'canvas' ? '◇' : node.ext === 'md' ? '▤' : '·';
  const label = document.createElement('span'); label.className = 'tree-label'; label.textContent = node.name.replace(/\.(md|canvas)$/i, '');
  row.append(toggle, icon, label);
  row.onclick = async event => {
    event.stopPropagation(); selectedPath = node.path;
    if (node.kind === 'directory') {
      expanded.has(node.path) ? expanded.delete(node.path) : expanded.add(node.path);
      persistSettings(); renderTree();
    } else await openPath(node.path);
    hideMobilePanels();
  };
  row.ondblclick = event => { event.preventDefault(); renamePath(node.path); };
  row.oncontextmenu = event => { event.preventDefault(); selectedPath = node.path; renderTree(); showNodeMenu(node, event.clientX, event.clientY); };
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
    { label: '在這裡新增 Canvas', action: () => createCanvas(node.path) }, 'separator'
  );
  else items.push({ label: '開啟', action: () => openPath(node.path) }, 'separator');
  items.push(
    { label: '重新命名', shortcut: settings.shortcuts.rename, action: () => renamePath(node.path) },
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
  try {
    const node = await vault.createNote(parentPath, value);
    expanded.add(parentPath); selectedPath = node.path; await rebuildIndex(); renderTree(); await openPath(node.path); $('documentTitle').focus(); $('documentTitle').select();
  } catch (error) { toast(error.message, true); }
}

async function createFolder(parentPath = selectedFolder()) {
  if (!vault) return openVaultPicker();
  const value = await ask('新增資料夾', '新資料夾', `建立位置：${parentPath || '筆記庫根目錄'}`);
  if (!value) return;
  try { const node = await vault.createFolder(parentPath, value); expanded.add(parentPath); expanded.add(node.path); selectedPath = node.path; renderTree(); }
  catch (error) { toast(error.message, true); }
}

async function createCanvas(parentPath = selectedFolder()) {
  if (!vault) return openVaultPicker();
  const value = await ask('新增 Canvas', '未命名 Canvas', `建立位置：${parentPath || '筆記庫根目錄'}`);
  if (!value) return;
  try { const node = await vault.createCanvas(parentPath, value); expanded.add(parentPath); selectedPath = node.path; renderTree(); await openPath(node.path); }
  catch (error) { toast(error.message, true); }
}

async function renamePath(path, explicitName = null) {
  if (!vault) return;
  const node = vault.node(path); if (!node) return;
  const extension = node.kind === 'file' ? `.${node.ext}` : '';
  const initial = node.kind === 'file' ? node.name.slice(0, -extension.length) : node.name;
  const value = explicitName ?? await ask(`重新命名${node.kind === 'directory' ? '資料夾' : '檔案'}`, initial, `${settings.shortcuts.rename || '快捷鍵未設定'} 只是快捷鍵；平常可用右鍵、長按或直接修改筆記標題。`);
  if (!value || safeName(value, extension) === node.name) return;
  const oldStem = noteStem(node.name), newName = safeName(value, extension), newStem = noteStem(newName);
  try {
    if (path === currentPath && dirty) await saveCurrent();
    const target = await vault.rename(path, newName);
    if (node.kind === 'file' && node.ext === 'md' && settings.updateLinks) await updateLinksAfterRename(oldStem, newStem);
    tabs = tabs.map(tab => tab === path ? target : tab.startsWith(`${path}/`) ? `${target}${tab.slice(path.length)}` : tab);
    remapSecondaryPath(path, target);
    if (currentPath === path || currentPath.startsWith(`${path}/`)) currentPath = `${target}${currentPath.slice(path.length)}`;
    selectedPath = target;
    await rebuildIndex(); renderTree(); renderTabs();
    if (currentPath === target) { $('documentTitle').value = noteStem(target); $('breadcrumbs').textContent = target; loadedModified = vault.node(target)?.lastModified; }
    toast(`已重新命名為「${basename(target)}」`);
  } catch (error) { toast(error.message, true); }
}

async function updateLinksAfterRename(oldStem, newStem) {
  for (const node of vault.markdownNodes()) {
    const content = await vault.readText(node.path);
    const replaced = replaceWikiTarget(content, oldStem, newStem);
    if (replaced !== content) await vault.writeText(node.path, replaced);
  }
}

async function chooseMoveDestination(path) {
  const folders = [...vault.nodes.values()].filter(node => node.kind === 'directory' && node.path !== path && !node.path.startsWith(`${path}/`)).map(node => node.path);
  const destination = await chooseFromList('移動到', folders, item => item || '筆記庫根目錄', '選擇目的資料夾…');
  if (destination == null) return;
  await movePath(path, destination);
}

async function movePath(path, destination) {
  try {
    if (path === currentPath && dirty) await saveCurrent();
    const target = await vault.move(path, destination);
    tabs = tabs.map(tab => tab === path ? target : tab.startsWith(`${path}/`) ? `${target}${tab.slice(path.length)}` : tab);
    remapSecondaryPath(path, target);
    if (currentPath === path || currentPath.startsWith(`${path}/`)) currentPath = `${target}${currentPath.slice(path.length)}`;
    selectedPath = target; expanded.add(destination); await rebuildIndex(); renderTree(); renderTabs(); toast(`已移動到「${destination || vault.name}」`);
  } catch (error) { toast(error.message, true); }
}

async function deletePath(path) {
  const node = vault?.node(path); if (!node) return;
  if (!await confirmAction(`刪除「${node.name}」？`, settings.trashMode === 'trash' ? '項目會移到筆記庫的 .trash 資料夾。' : '這會直接永久刪除，無法復原。', '刪除')) return;
  try {
    await vault.remove(path, settings.trashMode === 'trash');
    for (const panePath of [...secondaryPanes.keys()]) if (panePath === path || panePath.startsWith(`${path}/`)) await closeSecondaryPane(panePath, false);
    tabs = tabs.filter(tab => tab !== path && !tab.startsWith(`${path}/`));
    if (currentPath === path || currentPath.startsWith(`${path}/`)) { currentPath = ''; currentType = ''; showView('welcome'); }
    selectedPath = ''; await rebuildIndex(); renderTree(); renderTabs(); toast('已刪除');
  } catch (error) { toast(error.message, true); }
}

async function openPath(path, addHistory = true) {
  if (!vault) return;
  const node = vault.node(path); if (!node || node.kind !== 'file') return;
  if (dirty && currentPath !== path) await saveCurrent();
  selectedPath = path; currentPath = path; currentType = node.ext; loadedModified = node.lastModified; dirty = false;
  if (!tabs.includes(path)) tabs.push(path);
  sessionStorage.setItem('mysyncnote-tabs', JSON.stringify(tabs));
  if (addHistory && history[historyIndex] !== path) { history = history.slice(0, historyIndex + 1); history.push(path); historyIndex = history.length - 1; }
  if (node.ext === 'md') {
    const content = await vault.readText(path, true);
    $('editor').value = content; $('documentTitle').value = noteStem(path); showView('note'); applyViewMode(); renderPreview(); renderRightPanel();
  } else if (node.ext === 'canvas') {
    const content = await vault.readText(path, true); canvasView.load(content); $('canvasTitle').textContent = noteStem(path); showView('canvas');
  } else {
    const blob = await vault.readBlob(path); window.open(URL.createObjectURL(blob), '_blank');
  }
  $('breadcrumbs').textContent = path; setSaveState('已儲存'); renderTree(); renderTabs(); updateHistoryButtons(); hideMobilePanels();
}

function renderTabs() {
  const container = $('tabs'); container.innerHTML = '';
  for (const path of tabs) {
    if (!vault?.node(path)) continue;
    const tab = document.createElement('button'); tab.className = `tab${path === currentPath ? ' active' : ''}`; tab.role = 'tab';
    const icon = vault.node(path)?.ext === 'canvas' ? '◇' : '▤';
    tab.draggable = true;
    tab.innerHTML = `<span>${icon}</span><span class="tab-label"></span><span class="tab-close">×</span>`;
    tab.querySelector('.tab-label').textContent = basename(path).replace(/\.(md|canvas)$/i, '');
    tab.onclick = event => { if (event.target.closest('.tab-close')) closeTab(path); else openPath(path); };
    tab.ondragstart = event => { event.dataTransfer.setData('text/mysyncnote-path', path); event.dataTransfer.effectAllowed = 'copyMove'; };
    tab.ondragover = event => { if ([...event.dataTransfer.types].includes('text/mysyncnote-path')) event.preventDefault(); };
    tab.ondrop = event => {
      const source = event.dataTransfer.getData('text/mysyncnote-path'); if (!source || source === path || !tabs.includes(source)) return;
      event.preventDefault(); event.stopPropagation();
      tabs = tabs.filter(item => item !== source); const targetIndex = tabs.indexOf(path); tabs.splice(targetIndex, 0, source);
      sessionStorage.setItem('mysyncnote-tabs', JSON.stringify(tabs)); renderTabs();
    };
    container.append(tab);
  }
}

async function addSecondaryPane(path, insertBefore = null) {
  if (!vault || vault.node(path)?.ext !== 'md') return toast('只有 Markdown 筆記可以加入筆記窗格', true);
  if (secondaryPanes.has(path)) {
    secondaryPanes.get(path).element.scrollIntoView({ behavior: 'smooth', inline: 'center' });
    return;
  }
  const node = vault.node(path);
  const content = await vault.readText(path, true);
  const pane = { path, modified: node.lastModified, dirty: false, timer: null, mode: 'edit', objectUrls: [] };
  const element = document.createElement('section');
  element.className = 'dock-pane secondary-note-pane'; element.dataset.path = path;
  element.innerHTML = `<header class="secondary-pane-header" draggable="true"><span class="tree-icon">▤</span><span class="secondary-pane-title"></span><span class="secondary-pane-state">已儲存</span><button class="pane-mode" title="切換編輯／並排／閱讀">編輯</button><button class="pane-primary icon-btn" title="在主要窗格開啟">↗</button><button class="pane-close icon-btn" title="關閉窗格">×</button></header><div class="secondary-pane-body"><textarea class="secondary-pane-editor" spellcheck="true"></textarea><article class="secondary-pane-preview markdown-body"></article></div>`;
  pane.element = element; pane.editor = element.querySelector('.secondary-pane-editor'); pane.preview = element.querySelector('.secondary-pane-preview'); pane.state = element.querySelector('.secondary-pane-state'); pane.body = element.querySelector('.secondary-pane-body');
  element.querySelector('.secondary-pane-title').textContent = path;
  pane.editor.value = content;
  const render = () => {
    pane.objectUrls.forEach(URL.revokeObjectURL); pane.objectUrls = [];
    pane.preview.innerHTML = renderMarkdown(pane.editor.value, { resolveWiki: target => index?.resolve(target, pane.path) });
    pane.preview.querySelectorAll('[data-wikilink]').forEach(link => link.onclick = () => { const target = index?.resolve(link.dataset.wikilink, pane.path); if (target) openPath(target.path); });
    pane.preview.querySelectorAll('[data-vault-image]').forEach(async image => { const asset = resolveAsset(image.dataset.vaultImage, pane.path); if (!asset) return; const url = URL.createObjectURL(await vault.readBlob(asset.path)); pane.objectUrls.push(url); image.src = url; });
  };
  pane.save = async () => {
    if (!pane.dirty) return;
    clearTimeout(pane.timer); pane.state.textContent = '正在儲存…';
    try {
      pane.modified = await vault.writeText(pane.path, pane.editor.value, pane.modified);
      pane.dirty = false; pane.state.textContent = '已儲存'; scheduleIndex();
      if (pane.path === currentPath && !dirty) { $('editor').value = pane.editor.value; loadedModified = pane.modified; renderPreview(); }
    } catch (error) {
      pane.state.textContent = '外部版本衝突';
      if (error.name === 'ExternalChangeError' && await confirmAction('這個窗格偵測到外部修改', `「${pane.path}」已被 FolderSync 或另一個窗格修改。要用這個窗格的內容覆蓋嗎？`, '保留這個窗格', true)) {
        pane.modified = await vault.writeText(pane.path, pane.editor.value, null); pane.dirty = false; pane.state.textContent = '已儲存'; scheduleIndex();
      } else toast(`「${pane.path}」尚未儲存`, true);
    }
  };
  pane.editor.oninput = () => { pane.dirty = true; pane.state.textContent = '尚未儲存'; if (pane.mode !== 'edit') render(); clearTimeout(pane.timer); if (settings.autoSave) pane.timer = setTimeout(pane.save, 800); };
  pane.editor.onkeydown = event => { if (eventMatchesShortcut(event, settings.shortcuts.save)) { event.preventDefault(); event.stopPropagation(); pane.save(); } };
  element.querySelector('.pane-mode').onclick = event => {
    pane.mode = pane.mode === 'edit' ? 'split' : pane.mode === 'split' ? 'read' : 'edit';
    pane.body.className = `secondary-pane-body ${pane.mode}`; event.currentTarget.textContent = pane.mode === 'edit' ? '編輯' : pane.mode === 'split' ? '並排' : '閱讀'; render();
  };
  element.querySelector('.pane-primary').onclick = () => openPath(pane.path);
  element.querySelector('.pane-close').onclick = () => closeSecondaryPane(pane.path);
  const header = element.querySelector('.secondary-pane-header');
  header.ondragstart = event => { event.dataTransfer.setData('text/mysyncnote-pane', pane.path); event.dataTransfer.effectAllowed = 'move'; };
  element.ondragover = event => { if (![...event.dataTransfer.types].includes('text/mysyncnote-pane')) return; event.preventDefault(); const rect = element.getBoundingClientRect(); element.classList.toggle('pane-drop-before', event.clientX < rect.left + rect.width / 2); element.classList.toggle('pane-drop-after', event.clientX >= rect.left + rect.width / 2); };
  element.ondragleave = () => element.classList.remove('pane-drop-before', 'pane-drop-after');
  element.ondrop = event => {
    const source = event.dataTransfer.getData('text/mysyncnote-pane'); if (!source || source === pane.path) return;
    event.preventDefault(); const sourcePane = secondaryPanes.get(source); if (!sourcePane) return;
    const before = element.classList.contains('pane-drop-before'); $('workspaceDock').insertBefore(sourcePane.element, before ? element : element.nextSibling); element.classList.remove('pane-drop-before', 'pane-drop-after'); persistSecondaryOrder();
  };
  secondaryPanes.set(path, pane);
  if (insertBefore) $('workspaceDock').insertBefore(element, insertBefore);
  else $('workspaceDock').insertBefore(element, $('graphWorkspace'));
  secondaryPanePaths = [...secondaryPanes.keys()]; persistSecondaryOrder(); render();
  showView(currentView === 'welcome' ? (currentPath ? (currentType === 'canvas' ? 'canvas' : 'note') : 'welcome') : currentView);
}

async function closeSecondaryPane(path, save = true) {
  const pane = secondaryPanes.get(path); if (!pane) return;
  if (save && pane.dirty) await pane.save();
  clearTimeout(pane.timer); pane.objectUrls.forEach(URL.revokeObjectURL); pane.element.remove(); secondaryPanes.delete(path); persistSecondaryOrder();
  if (!currentPath && !graphDocked && !secondaryPanes.size) showView('welcome');
}

function persistSecondaryOrder() {
  secondaryPanePaths = [...$('workspaceDock').querySelectorAll('.secondary-note-pane')].map(element => element.dataset.path);
  sessionStorage.setItem('mysyncnote-secondary-panes', JSON.stringify(secondaryPanePaths));
}

async function restoreSecondaryPanes() {
  const paths = [...secondaryPanePaths].filter(path => vault.node(path)?.ext === 'md');
  for (const pane of [...secondaryPanes.values()]) await closeSecondaryPane(pane.path, false);
  secondaryPanePaths = [];
  for (const path of paths) await addSecondaryPane(path);
}

function remapSecondaryPath(oldPath, newPath) {
  const changes = [...secondaryPanes.values()].filter(pane => pane.path === oldPath || pane.path.startsWith(`${oldPath}/`));
  for (const pane of changes) {
    secondaryPanes.delete(pane.path); pane.path = `${newPath}${pane.path.slice(oldPath.length)}`; pane.element.dataset.path = pane.path; pane.element.querySelector('.secondary-pane-title').textContent = pane.path; secondaryPanes.set(pane.path, pane);
  }
  persistSecondaryOrder();
}

async function splitCurrentNote() {
  if (!currentPath || currentType !== 'md') return toast('請先開啟一篇 Markdown 筆記');
  await addSecondaryPane(currentPath);
}

async function closeTab(path) {
  if (path === currentPath && dirty) await saveCurrent();
  const indexOf = tabs.indexOf(path); tabs = tabs.filter(tab => tab !== path); sessionStorage.setItem('mysyncnote-tabs', JSON.stringify(tabs));
  if (path === currentPath) { const next = tabs[Math.min(indexOf, tabs.length - 1)]; if (next) await openPath(next, false); else { currentPath = ''; showView('welcome'); } }
  renderTabs();
}

function updateHistoryButtons() { $('goBack').disabled = historyIndex <= 0; $('goForward').disabled = historyIndex < 0 || historyIndex >= history.length - 1; }

function applyViewMode() {
  $('editorArea').className = `editor-area mode-${viewMode}`;
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === viewMode));
}

function scheduleSave() {
  dirty = true; setSaveState('尚未儲存');
  clearTimeout(autoSaveTimer);
  if (settings.autoSave && vault) autoSaveTimer = setTimeout(() => saveCurrent(true), 800);
}

async function saveCurrent(silent = false) {
  if (!vault || !currentPath || !dirty) return;
  clearTimeout(autoSaveTimer);
  const pathAtStart = currentPath;
  const text = currentType === 'canvas' ? canvasView.json() : $('editor').value;
  const expected = loadedModified;
  setSaveState('正在儲存…');
  saveChain = saveChain.then(async () => {
    try {
      const modified = await vault.writeText(pathAtStart, text, expected);
      if (currentPath === pathAtStart) { loadedModified = modified; dirty = false; setSaveState('已儲存'); }
      const mirror = secondaryPanes.get(pathAtStart);
      if (mirror && !mirror.dirty) { mirror.editor.value = text; mirror.modified = modified; mirror.state.textContent = '已同步'; }
      scheduleIndex();
      if (!silent) toast('已儲存');
    } catch (error) {
      if (error.name === 'ExternalChangeError') await resolveConflict(pathAtStart, text, error);
      else { setSaveState('儲存失敗', true); toast(error.message, true); }
    }
  });
  return saveChain;
}

async function resolveConflict(path, localText, error) {
  $('confirmTitle').textContent = '偵測到外部修改';
  $('confirmMessage').textContent = 'FolderSync 或其他程式已經修改這份筆記。請選擇要保留哪個版本。';
  $('confirmOk').textContent = '保留目前版本'; $('confirmOk').className = 'danger';
  $('confirmExtra').innerHTML = '<div class="dialog-actions" style="justify-content:flex-start"><button type="button" data-choice="external">載入外部版本</button><button type="button" data-choice="both">兩份都保留</button></div>';
  $('confirmDialog').showModal();
  $('confirmExtra').querySelectorAll('button').forEach(button => button.onclick = () => { $('confirmDialog').returnValue = button.dataset.choice; $('confirmDialog').close(); });
  const choice = await new Promise(resolve => $('confirmDialog').addEventListener('close', () => resolve($('confirmDialog').returnValue), { once: true }));
  if (choice === 'default') {
    loadedModified = await vault.writeText(path, localText, null); dirty = false; setSaveState('已儲存'); toast('已保留目前版本');
  } else if (choice === 'external') {
    $('editor').value = error.externalText; vault.contents.set(path, error.externalText); loadedModified = error.externalModified; dirty = false; renderPreview(); setSaveState('已載入外部版本');
  } else if (choice === 'both') {
    const folder = dirname(path); const desired = `${noteStem(path)}（衝突 ${new Date().toLocaleString('zh-TW').replace(/[/:]/g, '-')}）.md`;
    const name = await vault.uniqueName(folder, desired); await vault.writeText(`${folder ? `${folder}/` : ''}${name}`, localText);
    $('editor').value = error.externalText; vault.contents.set(path, error.externalText); loadedModified = error.externalModified; dirty = false; await vault.scan(); await rebuildIndex(); renderTree(); renderPreview(); setSaveState('已保留兩份'); toast(`目前內容另存為「${name}」`);
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
  $('preview').querySelectorAll('[data-tag]').forEach(tag => tag.addEventListener('click', () => { $('fileSearch').value = `#${tag.dataset.tag}`; renderTree(); }));
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
    headings.forEach(heading => { const button = document.createElement('button'); button.className = `outline-item level-${Math.min(heading.level, 3)}`; button.textContent = heading.text; button.onclick = () => { const lines = $('editor').value.split('\n'); const offset = lines.slice(0, heading.line).join('\n').length + (heading.line ? 1 : 0); $('editor').focus(); $('editor').setSelectionRange(offset, offset + lines[heading.line].length); }; panel.append(button); });
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

function formatSelection(type) {
  const editor = $('editor'); const start = editor.selectionStart, end = editor.selectionEnd; const selected = editor.value.slice(start, end); let before = '', after = '', replacement = selected;
  const lineStart = editor.value.lastIndexOf('\n', start - 1) + 1;
  switch (type) {
    case 'heading': before = '## '; break; case 'bold': before = '**'; after = '**'; break; case 'italic': before = '*'; after = '*'; break; case 'strike': before = '~~'; after = '~~'; break; case 'highlight': before = '=='; after = '=='; break;
    case 'link': before = '['; after = '](https://)'; break; case 'wikilink': before = '[['; after = ']]'; break; case 'code': before = selected.includes('\n') ? '```\n' : '`'; after = selected.includes('\n') ? '\n```' : '`'; break;
    case 'quote': editor.setSelectionRange(lineStart, end); replacement = editor.value.slice(lineStart, end).split('\n').map(line => `> ${line}`).join('\n'); editor.setRangeText(replacement, lineStart, end, 'select'); editor.dispatchEvent(new Event('input')); return;
    case 'list': editor.setSelectionRange(lineStart, end); replacement = editor.value.slice(lineStart, end).split('\n').map(line => `- ${line}`).join('\n'); editor.setRangeText(replacement, lineStart, end, 'select'); editor.dispatchEvent(new Event('input')); return;
    case 'task': editor.setSelectionRange(lineStart, end); replacement = editor.value.slice(lineStart, end).split('\n').map(line => `- [ ] ${line}`).join('\n'); editor.setRangeText(replacement, lineStart, end, 'select'); editor.dispatchEvent(new Event('input')); return;
  }
  editor.setRangeText(`${before}${replacement}${after}`, start, end, 'end'); editor.focus(); editor.dispatchEvent(new Event('input'));
}

function updateWikiSuggest() {
  const editor = $('editor'); const before = editor.value.slice(0, editor.selectionStart); const match = before.match(/\[\[([^\]\n]*)$/); const box = $('wikiSuggest');
  if (!match || !index) { box.classList.add('hidden'); return; }
  const query = match[1].toLowerCase(); const candidates = index.entries.filter(entry => noteStem(entry.path).toLowerCase().includes(query) && entry.path !== currentPath).slice(0, 12);
  box.innerHTML = '';
  candidates.forEach(entry => { const button = document.createElement('button'); button.type = 'button'; button.className = 'suggestion'; button.innerHTML = '<span></span><small></small>'; button.firstChild.textContent = noteStem(entry.path); button.lastChild.textContent = dirname(entry.path); button.onmousedown = event => { event.preventDefault(); const start = editor.selectionStart - match[1].length; editor.setRangeText(`${noteStem(entry.path)}]]`, start, editor.selectionStart, 'end'); box.classList.add('hidden'); editor.dispatchEvent(new Event('input')); }; box.append(button); });
  box.classList.toggle('hidden', !candidates.length);
}

async function importPastedImage(event) {
  if (!vault || currentType !== 'md') return;
  const file = [...event.clipboardData.files].find(item => item.type.startsWith('image/'));
  if (!file) return;
  event.preventDefault();
  await importAttachments([file]);
}

async function importAttachments(files) {
  if (!vault || currentType !== 'md' || !files.length) return;
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
  $('editor').setRangeText(markdown, $('editor').selectionStart, $('editor').selectionEnd, 'end'); $('editor').dispatchEvent(new Event('input')); renderTree();
}

function openGraph() {
  if (!index) return toast('請先開啟筆記庫');
  graphDocked = true; showView('graph');
  requestAnimationFrame(() => { updateGraph(); graph.resize(); graph.draw(); });
}

function toggleGraphDock() { if (graphDocked) closeGraphDock(); else openGraph(); }

function closeGraphDock() {
  graphDocked = false; $('graphWorkspace').classList.add('hidden');
  if (!currentPath && !secondaryPanes.size) showView('welcome');
}

function updateGraph() {
  graph.setData(index, { scope: $('graphScope').value, currentPath, depth: Number($('graphDepth').value), filter: $('graphFilter').value, isolates: $('graphIsolates').classList.contains('active') });
  $('graphSummary').textContent = `${graph.nodes.length} 篇筆記 · ${graph.edges.length} 條連結`;
}

function closeSpecialView() { closeGraphDock(); }

const graph = new GraphView($('graphCanvas'), path => openPath(path));
const canvasView = new CanvasView({
  viewport: $('canvasViewport'), surface: $('canvasSurface'), nodesLayer: $('canvasNodes'), edgesLayer: $('canvasEdges'),
  onChange: () => { scheduleSave(); setSaveState('尚未儲存'); }, onOpenNote: path => openPath(path),
  chooseNote: async () => {
    if (!index?.entries.length) return null;
    const entry = await chooseFromList('選擇筆記', index.entries, item => item.path, '選擇要放入 Canvas 的筆記…'); return entry?.path || null;
  }
});

function openCommandPalette() {
  const commands = [
    { label: '新增筆記', hint: settings.shortcuts.newNote, run: () => createNote() }, { label: '新增資料夾', run: () => createFolder() }, { label: '新增 Canvas', run: () => createCanvas() },
    { label: '關聯圖譜', hint: settings.shortcuts.graph, run: openGraph }, { label: '分割目前筆記', hint: settings.shortcuts.split, run: splitCurrentNote }, { label: '重新讀取筆記庫', run: refreshVault }, { label: '設定', run: openSettings }
  ];
  $('commandSearch').placeholder = '輸入指令或筆記名稱…'; $('commandSearch').value = ''; $('commandDialog').showModal();
  const render = () => {
    const q = $('commandSearch').value.toLowerCase(); $('commandResults').innerHTML = '';
    const rows = [...commands.map(item => ({ ...item, kind: '指令' })), ...(index?.entries || []).map(entry => ({ label: noteStem(entry.path), hint: dirname(entry.path), kind: '筆記', run: () => openPath(entry.path) }))].filter(item => `${item.label} ${item.hint || ''}`.toLowerCase().includes(q)).slice(0, 60);
    rows.forEach(item => { const button = document.createElement('button'); button.type = 'button'; button.className = 'command-result'; button.innerHTML = '<span></span><span></span><small></small>'; button.children[0].textContent = item.kind === '筆記' ? '▤' : '›'; button.children[1].textContent = item.label; button.children[2].textContent = item.hint || item.kind; button.onclick = () => { $('commandDialog').close(); item.run(); }; $('commandResults').append(button); });
  };
  const listener = render; $('commandSearch').addEventListener('input', listener); render(); setTimeout(() => $('commandSearch').focus(), 0);
  $('commandDialog').addEventListener('close', () => $('commandSearch').removeEventListener('input', listener), { once: true });
}

async function refreshVault() {
  if (!vault) return;
  if (dirty || [...secondaryPanes.values()].some(pane => pane.dirty)) await saveAllPanes(true);
  if (settingsFolderHandle) await loadSettingsFile(settingsFolderHandle);
  const previousModified = currentPath ? vault.node(currentPath)?.lastModified : null;
  await vault.scan(); await rebuildIndex(); renderTree();
  const current = vault.node(currentPath);
  if (current && previousModified && current.lastModified !== previousModified && !dirty) await openPath(currentPath, false);
  if (!current && currentPath) { tabs = tabs.filter(path => path !== currentPath); currentPath = ''; showView('welcome'); renderTabs(); }
  toast('已重新讀取筆記庫');
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
  $('defaultFolder').value = settings.defaultFolder || '';
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
$('openVault').onclick = openVaultPicker; $('welcomeOpen').onclick = openVaultPicker; $('settingsChangeVault').onclick = openVaultPicker;
$('newNote').onclick = () => createNote(); $('newFolder').onclick = () => createFolder(); $('newCanvas').onclick = () => createCanvas(); $('refreshVault').onclick = refreshVault;
$('splitCurrent').onclick = splitCurrentNote;
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
$('explorerMore').onclick = event => showMenu([{ label: '依名稱排序', action: renderTree }, { label: '全部展開', action: () => { vault && [...vault.nodes.values()].filter(n => n.kind === 'directory').forEach(n => expanded.add(n.path)); persistSettings(); renderTree(); } }, { label: '全部收合', action: () => { expanded.clear(); persistSettings(); renderTree(); } }], event.clientX, event.clientY);
document.addEventListener('pointerdown', event => { if (!event.target.closest('#contextMenu,[data-menu-anchor]')) $('contextMenu').classList.add('hidden'); });

$('editor').addEventListener('input', () => { scheduleSave(); if (viewMode !== 'edit') renderPreview(); renderRightPanel(); updateWikiSuggest(); });
$('editor').addEventListener('keyup', updateWikiSuggest); $('editor').addEventListener('click', updateWikiSuggest); $('editor').addEventListener('paste', importPastedImage);
$('editor').addEventListener('dragover', event => { if (event.dataTransfer?.files?.length) event.preventDefault(); });
$('editor').addEventListener('drop', event => { if (!event.dataTransfer?.files?.length) return; event.preventDefault(); importAttachments([...event.dataTransfer.files]); });
document.querySelectorAll('[data-format]').forEach(button => button.onclick = () => formatSelection(button.dataset.format));
document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { viewMode = button.dataset.view; localStorage.setItem('mysyncnote-view', viewMode); applyViewMode(); renderPreview(); });
$('documentTitle').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } if (event.key === 'Escape') { event.currentTarget.value = noteStem(currentPath); event.currentTarget.blur(); } });
$('documentTitle').addEventListener('change', () => renamePath(currentPath, $('documentTitle').value));
$('documentMore').onclick = event => { const node = vault?.node(currentPath); if (node) showNodeMenu(node, event.clientX, event.clientY); };

document.querySelectorAll('[data-panel]').forEach(button => button.onclick = () => { rightPanel = button.dataset.panel; document.querySelectorAll('[data-panel]').forEach(item => item.classList.toggle('active', item === button)); renderRightPanel(); });
$('goBack').onclick = () => { if (historyIndex > 0) openPath(history[--historyIndex], false).then(updateHistoryButtons); };
$('goForward').onclick = () => { if (historyIndex < history.length - 1) openPath(history[++historyIndex], false).then(updateHistoryButtons); };
$('openGraph').onclick = toggleGraphDock; $('closeGraph').onclick = closeGraphDock; $('graphScope').onchange = updateGraph; $('graphDepth').oninput = updateGraph; $('graphFilter').oninput = updateGraph; $('graphIsolates').onclick = () => { $('graphIsolates').classList.toggle('active'); updateGraph(); };
$('canvasAddText').onclick = () => canvasView.addText(); $('canvasAddNote').onclick = () => canvasView.addNote(); $('canvasAddGroup').onclick = () => canvasView.addGroup(); $('canvasFit').onclick = () => canvasView.fit(); $('canvasConnect').onclick = () => { const on = canvasView.toggleConnect(); $('canvasConnect').classList.toggle('primary', on); $('canvasConnect').textContent = on ? '請選兩個節點' : '連接節點'; }; $('closeCanvas').onclick = () => closeTab(currentPath);

$('attachmentFolder').onchange = () => { settings.attachmentFolder = $('attachmentFolder').value.trim() || 'attachments'; persistSettings(); };
$('defaultFolder').onchange = () => {
  const path = $('defaultFolder').value.trim().replace(/\\/g, '/').replace(/^\/|\/$/g, '');
  if (path && vault && vault.node(path)?.kind !== 'directory') { toast('這個相對路徑不是筆記庫裡的資料夾', true); $('defaultFolder').value = settings.defaultFolder || ''; return; }
  settings.defaultFolder = path; persistSettings();
  if (path && vault) { selectedPath = path; for (let parent = path; parent; parent = dirname(parent)) expanded.add(parent); renderTree(); }
};
$('trashMode').onchange = () => { settings.trashMode = $('trashMode').value; persistSettings(); };
$('updateLinks').onchange = () => { settings.updateLinks = $('updateLinks').checked; persistSettings(); };
$('autoSave').onchange = () => { settings.autoSave = $('autoSave').checked; persistSettings(); };
$('settingsFileName').onchange = () => { settings.settingsFileName = safeName($('settingsFileName').value, '.json'); $('settingsFileName').value = settings.settingsFileName; persistSettings(); };
$('chooseSettingsFolder').onclick = chooseSettingsFolder;

addEventListener('keydown', event => {
  if (event.target.classList?.contains('shortcut-input')) return;
  const typing = event.target.matches('input,textarea,[contenteditable]');
  if (eventMatchesShortcut(event, settings.shortcuts.save)) { event.preventDefault(); saveCurrent(); }
  else if (eventMatchesShortcut(event, settings.shortcuts.command)) { event.preventDefault(); openCommandPalette(); }
  else if (eventMatchesShortcut(event, settings.shortcuts.search)) { event.preventDefault(); $('fileSearch').focus(); }
  else if (eventMatchesShortcut(event, settings.shortcuts.newNote)) { event.preventDefault(); createNote(); }
  else if (eventMatchesShortcut(event, settings.shortcuts.graph)) { event.preventDefault(); toggleGraphDock(); }
  else if (eventMatchesShortcut(event, settings.shortcuts.rename) && selectedPath && !typing) { event.preventDefault(); renamePath(selectedPath); }
  else if (eventMatchesShortcut(event, settings.shortcuts.toggleLeft) && !typing) { event.preventDefault(); if (innerWidth <= 760) app.classList.toggle('left-open'); else { app.classList.toggle('left-collapsed'); $('showLeft').classList.toggle('hidden', !app.classList.contains('left-collapsed')); } }
  else if (eventMatchesShortcut(event, settings.shortcuts.split) && !typing) { event.preventDefault(); splitCurrentNote(); }
  if (event.key === 'Delete' && selectedPath && currentView !== 'canvas' && !event.target.matches('input,textarea,[contenteditable]')) { event.preventDefault(); deletePath(selectedPath); }
  if (event.key === 'Escape') { hideMobilePanels(); $('contextMenu').classList.add('hidden'); $('wikiSuggest').classList.add('hidden'); }
});

addEventListener('beforeunload', event => { if (dirty || [...secondaryPanes.values()].some(pane => pane.dirty)) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { const anyDirty = dirty || [...secondaryPanes.values()].some(pane => pane.dirty); if (document.hidden && anyDirty) saveAllPanes(true); else if (!document.hidden && vault && !anyDirty) refreshVault(); });
addEventListener('focus', () => { if (vault && !dirty && ![...secondaryPanes.values()].some(pane => pane.dirty) && document.visibilityState === 'visible') refreshVault(); });

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
    const permission = await rememberedHandle.queryPermission({ mode: 'readwrite' });
    if (permission === 'granted') { const handle = rememberedHandle; rememberedHandle = null; await loadVault(handle); }
    else { $('vaultName').textContent = rememberedHandle.name; $('vaultState').textContent = '點一下重新連線'; $('openVaultText').textContent = `重新連線「${rememberedHandle.name}」`; }
  } catch (error) { console.warn('無法還原筆記庫', error); }
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch(console.warn);
restore();
