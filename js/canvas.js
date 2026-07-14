const uid = prefix => `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const clone = value => JSON.parse(JSON.stringify(value));
const COLORS = ['', '1', '2', '3', '4', '5', '6'];
const COLOR_VALUES = { '1': '#e57373', '2': '#ffb25c', '3': '#e1cb62', '4': '#6dca87', '5': '#56c8d8', '6': '#b08ae5' };

export class CanvasView {
  constructor({ viewport, surface, nodesLayer, edgesLayer, onChange, onOpenNote, chooseNote }) {
    Object.assign(this, { viewport, surface, nodesLayer, edgesLayer, onChange, onOpenNote, chooseNote });
    this.data = { nodes: [], edges: [] };
    this.scale = 1; this.pan = { x: 120, y: 90 };
    this.selected = new Set(); this.selectedEdge = null;
    this.drag = null; this.connection = null; this.marquee = null;
    this.keys = new Set(); this.touchPoints = new Map(); this.clipboard = null;
    this.history = []; this.future = [];
    this.#createControls(); this.#events();
  }

  load(text) {
    try {
      const parsed = JSON.parse(text || '{}');
      this.data = { nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [], edges: Array.isArray(parsed.edges) ? parsed.edges : [] };
    } catch { this.data = { nodes: [], edges: [] }; }
    this.selected.clear(); this.selectedEdge = null; this.history = []; this.future = [];
    this.render(); this.fit();
  }

  json() { return JSON.stringify(this.data, null, 2); }
  #remember() { this.history.push(this.json()); if (this.history.length > 80) this.history.shift(); this.future = []; }
  #changed() { this.onChange?.(this.json()); this.#updateControls(); }

  undo() {
    if (!this.history.length) return;
    this.future.push(this.json()); this.data = JSON.parse(this.history.pop()); this.selected.clear(); this.selectedEdge = null; this.render(); this.#changed();
  }
  redo() {
    if (!this.future.length) return;
    this.history.push(this.json()); this.data = JSON.parse(this.future.pop()); this.selected.clear(); this.selectedEdge = null; this.render(); this.#changed();
  }

  #viewportCenter() {
    const rect = this.viewport.getBoundingClientRect();
    return { x: (rect.width / 2 - this.pan.x) / this.scale, y: (rect.height / 2 - this.pan.y) / this.scale };
  }

  addText(x, y, text = '# 新卡片\n\n在這裡輸入內容。') {
    const center = this.#viewportCenter(); x ??= center.x - 140; y ??= center.y - 90;
    this.#remember(); const node = { id: uid('node'), type: 'text', x: Math.round(x), y: Math.round(y), width: 280, height: 180, text };
    this.data.nodes.push(node); this.selected = new Set([node.id]); this.selectedEdge = null; this.#changed(); this.render(); return node;
  }

  async addNote(x, y) {
    const path = await this.chooseNote?.(); if (!path) return;
    const center = this.#viewportCenter(); x ??= center.x - 150; y ??= center.y - 95;
    this.#remember(); const node = { id: uid('node'), type: 'file', x: Math.round(x), y: Math.round(y), width: 300, height: 190, file: path };
    this.data.nodes.push(node); this.selected = new Set([node.id]); this.#changed(); this.render();
  }

  addLink(url, x, y) {
    url = String(url || '').trim();
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const center = this.#viewportCenter(); x ??= center.x - 150; y ??= center.y - 90;
    this.#remember();
    const node = { id: uid('node'), type: 'link', x: Math.round(x), y: Math.round(y), width: 300, height: 180, url };
    this.data.nodes.push(node); this.selected = new Set([node.id]); this.selectedEdge = null; this.#changed(); this.render(); return node;
  }

  addGroup() {
    const selectedNodes = this.data.nodes.filter(node => this.selected.has(node.id) && node.type !== 'group');
    this.#remember();
    let group;
    if (selectedNodes.length) {
      const bounds = this.#bounds(selectedNodes), padding = 45;
      group = { id: uid('group'), type: 'group', x: Math.round(bounds.x - padding), y: Math.round(bounds.y - padding - 24), width: Math.round(bounds.width + padding * 2), height: Math.round(bounds.height + padding * 2 + 24), label: '群組' };
    } else {
      const center = this.#viewportCenter(); group = { id: uid('group'), type: 'group', x: Math.round(center.x - 300), y: Math.round(center.y - 190), width: 600, height: 380, label: '群組' };
    }
    this.data.nodes.unshift(group); this.selected = new Set([group.id]); this.#changed(); this.render();
  }

  ungroupSelected() {
    const groups = this.data.nodes.filter(node => node.type === 'group' && this.selected.has(node.id));
    if (!groups.length) return;
    this.#remember(); this.data.nodes = this.data.nodes.filter(node => !groups.includes(node)); groups.forEach(group => this.selected.delete(group.id)); this.#changed(); this.render();
  }

  toggleConnect() { return false; }

  deleteSelected() {
    if (!this.selected.size && !this.selectedEdge) return;
    this.#remember();
    if (this.selectedEdge) this.data.edges = this.data.edges.filter(edge => edge.id !== this.selectedEdge);
    if (this.selected.size) {
      this.data.nodes = this.data.nodes.filter(node => !this.selected.has(node.id));
      this.data.edges = this.data.edges.filter(edge => !this.selected.has(edge.fromNode) && !this.selected.has(edge.toNode));
    }
    this.selected.clear(); this.selectedEdge = null; this.#changed(); this.render();
  }

  selectAll() { this.selected = new Set(this.data.nodes.map(node => node.id)); this.selectedEdge = null; this.#selectionClasses(); this.#updateControls(); }

  copySelected() {
    const nodes = this.data.nodes.filter(node => this.selected.has(node.id));
    if (!nodes.length) return;
    const ids = new Set(nodes.map(node => node.id));
    this.clipboard = { nodes: clone(nodes), edges: clone(this.data.edges.filter(edge => ids.has(edge.fromNode) && ids.has(edge.toNode))) };
  }

  paste() {
    if (!this.clipboard) return;
    this.#remember(); const idMap = new Map();
    const nodes = this.clipboard.nodes.map(node => { const copy = { ...clone(node), id: uid(node.type === 'group' ? 'group' : 'node'), x: node.x + 40, y: node.y + 40 }; idMap.set(node.id, copy.id); return copy; });
    const edges = this.clipboard.edges.map(edge => ({ ...clone(edge), id: uid('edge'), fromNode: idMap.get(edge.fromNode), toNode: idMap.get(edge.toNode) }));
    this.data.nodes.push(...nodes); this.data.edges.push(...edges); this.selected = new Set(nodes.map(node => node.id)); this.#changed(); this.render();
  }

  #duplicateSelection() { this.copySelected(); this.paste(); }

  render() {
    this.nodesLayer.innerHTML = '';
    for (const node of this.data.nodes) this.nodesLayer.append(this.#nodeElement(node));
    this.#transform(); this.#renderEdges(); this.#updateControls();
  }

  #nodeElement(node) {
    const element = document.createElement('article');
    element.className = `canvas-node ${node.type === 'group' ? 'group' : ''}${this.selected.has(node.id) ? ' selected' : ''}`;
    element.dataset.id = node.id;
    const color = COLOR_VALUES[node.color] || node.color || '';
    element.style.cssText = `left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px;${color ? `border-color:${color};--node-color:${color}` : ''}`;
    const header = document.createElement('div'); header.className = 'canvas-node-header';
    const title = document.createElement('span'); title.className = 'canvas-node-title';
    title.textContent = node.type === 'group' ? (node.label || '群組') : node.type === 'file' ? node.file : node.type === 'link' ? node.url : '文字卡片'; header.append(title);
    if (node.type === 'group') {
      title.ondblclick = event => { event.stopPropagation(); const label = prompt('群組名稱', node.label || '群組'); if (label != null) { this.#remember(); node.label = label.trim() || '群組'; this.#changed(); this.render(); } };
      element.append(header);
    } else {
      const content = document.createElement('div'); content.className = 'canvas-node-content';
      if (node.type === 'text') {
        const textarea = document.createElement('textarea'); textarea.value = node.text || '';
        textarea.addEventListener('focus', () => { if (!this.selected.has(node.id)) { this.selected = new Set([node.id]); this.#selectionClasses(); } });
        textarea.addEventListener('input', () => { node.text = textarea.value; this.#changed(); }); content.append(textarea);
      } else if (node.type === 'file') {
        content.innerHTML = '<p>筆記卡片</p><b></b><p class="hint">雙擊開啟完整筆記</p>'; content.querySelector('b').textContent = node.file || '找不到筆記'; content.ondblclick = () => this.onOpenNote?.(node.file);
      } else if (node.type === 'link') {
        const link = document.createElement('a'); link.href = node.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = node.url; content.append(link);
      }
      element.append(header, content);
      for (const side of ['top', 'right', 'bottom', 'left']) { const port = document.createElement('button'); port.className = `canvas-port ${side}`; port.dataset.side = side; port.title = '拖曳到另一張卡片建立連線'; element.append(port); }
    }
    const resize = document.createElement('div'); resize.className = 'canvas-resize'; element.append(resize);
    element.addEventListener('pointerdown', event => this.#nodePointerDown(event, node, element));
    return element;
  }

  #nodePointerDown(event, node, element) {
    if (event.target.closest('textarea,a')) return;
    const port = event.target.closest('.canvas-port');
    if (port) { event.preventDefault(); event.stopPropagation(); this.#startConnection(event, node, port.dataset.side); return; }
    const resizing = Boolean(event.target.closest('.canvas-resize'));
    if (!resizing && !event.target.closest('.canvas-node-header,.canvas-node-content,.canvas-node')) return;
    event.preventDefault(); event.stopPropagation();
    if (event.shiftKey) {
      this.selected.has(node.id) ? this.selected.delete(node.id) : this.selected.add(node.id);
      this.selectedEdge = null; this.#selectionClasses(); this.#updateControls(); if (!this.selected.has(node.id)) return;
    } else if (!this.selected.has(node.id)) { this.selected = new Set([node.id]); this.selectedEdge = null; }
    if (event.altKey && !resizing) this.#duplicateSelection();
    this.#remember();
    const point = this.#worldPoint(event); const movingIds = new Set(this.selected);
    if (node.type === 'group') this.#containedNodes(node).forEach(child => movingIds.add(child.id));
    const positions = new Map(this.data.nodes.filter(item => movingIds.has(item.id)).map(item => [item.id, { x: item.x, y: item.y, width: item.width, height: item.height }]));
    this.drag = { type: resizing ? 'resize' : 'nodes', node, start: point, positions, moved: false };
    element.setPointerCapture(event.pointerId);
    const move = moveEvent => this.#moveNodes(moveEvent);
    const up = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); if (this.drag?.moved) this.#changed(); this.drag = null; this.render(); };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', up); this.#selectionClasses(); this.#updateControls();
  }

  #moveNodes(event) {
    if (!this.drag) return;
    const point = this.#worldPoint(event), dx0 = point.x - this.drag.start.x, dy0 = point.y - this.drag.start.y;
    let dx = dx0, dy = dy0;
    if (event.shiftKey) Math.abs(dx) > Math.abs(dy) ? dy = 0 : dx = 0;
    this.drag.moved = Math.abs(dx) + Math.abs(dy) > 1;
    if (this.drag.type === 'resize') {
      const start = this.drag.positions.get(this.drag.node.id), snap = this.keys.has('Space') ? 1 : 10;
      this.drag.node.width = Math.max(140, Math.round((start.width + dx) / snap) * snap); this.drag.node.height = Math.max(90, Math.round((start.height + dy) / snap) * snap);
    } else {
      const snap = this.keys.has('Space') ? 1 : 10;
      for (const [id, start] of this.drag.positions) { const item = this.data.nodes.find(node => node.id === id); if (!item) continue; item.x = Math.round((start.x + dx) / snap) * snap; item.y = Math.round((start.y + dy) / snap) * snap; }
    }
    for (const [id] of this.drag.positions) { const el = this.nodesLayer.querySelector(`[data-id="${id}"]`), item = this.data.nodes.find(node => node.id === id); if (el && item) el.style.cssText += `;left:${item.x}px;top:${item.y}px;width:${item.width}px;height:${item.height}px`; }
    this.#renderEdges(); this.#updateControls();
  }

  #containedNodes(group) {
    return this.data.nodes.filter(node => node.id !== group.id && node.x >= group.x && node.y >= group.y && node.x + node.width <= group.x + group.width && node.y + node.height <= group.y + group.height);
  }

  #startConnection(event, node, side) {
    this.#remember(); this.connection = { fromNode: node.id, fromSide: side, point: this.#worldPoint(event) };
    const move = moveEvent => { this.connection.point = this.#worldPoint(moveEvent); this.#renderEdges(); };
    const up = upEvent => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      const targetElement = document.elementFromPoint(upEvent.clientX, upEvent.clientY)?.closest('.canvas-node');
      let target = targetElement ? this.data.nodes.find(item => item.id === targetElement.dataset.id) : null;
      const point = this.#worldPoint(upEvent);
      if (!target) target = this.addText(point.x - 140, point.y - 60, '# 新卡片');
      if (target.id !== node.id) {
        const targetSide = this.#nearestSide(target, point);
        this.data.edges.push({ id: uid('edge'), fromNode: node.id, fromSide: side, fromEnd: 'none', toNode: target.id, toSide: targetSide, toEnd: 'arrow' });
      }
      this.connection = null; this.#changed(); this.render();
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up, { once: true }); this.#renderEdges();
  }

  #nearestSide(node, point) {
    const distances = { left: Math.abs(point.x - node.x), right: Math.abs(point.x - (node.x + node.width)), top: Math.abs(point.y - node.y), bottom: Math.abs(point.y - (node.y + node.height)) };
    return Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0];
  }

  #selectionClasses() { for (const element of this.nodesLayer.children) element.classList.toggle('selected', this.selected.has(element.dataset.id)); }

  #anchor(id, side = 'right') {
    const node = this.data.nodes.find(item => item.id === id); if (!node) return null;
    return { x: node.x + (side === 'left' ? 0 : side === 'right' ? node.width : node.width / 2), y: node.y + (side === 'top' ? 0 : side === 'bottom' ? node.height : node.height / 2) };
  }

  #edgePath(a, b, fromSide = 'right', toSide = 'left') {
    const distance = Math.max(55, Math.hypot(b.x - a.x, b.y - a.y) * .35);
    const vector = side => ({ left: [-distance, 0], right: [distance, 0], top: [0, -distance], bottom: [0, distance] })[side] || [distance, 0];
    const av = vector(fromSide), bv = vector(toSide);
    return `M ${a.x} ${a.y} C ${a.x + av[0]} ${a.y + av[1]}, ${b.x + bv[0]} ${b.y + bv[1]}, ${b.x} ${b.y}`;
  }

  #renderEdges() {
    this.edgesLayer.setAttribute('viewBox', '-10000 -10000 20000 20000'); this.edgesLayer.style.cssText = 'left:-10000px;top:-10000px;width:20000px;height:20000px';
    this.edgesLayer.innerHTML = '<defs><marker id="canvas-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>';
    for (const edge of this.data.edges) {
      const a = this.#anchor(edge.fromNode, edge.fromSide), b = this.#anchor(edge.toNode, edge.toSide); if (!a || !b) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', this.#edgePath(a, b, edge.fromSide, edge.toSide));
      path.setAttribute('class', `canvas-edge${edge.id === this.selectedEdge ? ' selected' : ''}`); path.dataset.edgeId = edge.id;
      const color = COLOR_VALUES[edge.color] || edge.color || '#84909d'; path.setAttribute('stroke', color); path.setAttribute('marker-end', edge.toEnd === 'none' ? '' : 'url(#canvas-arrow)');
      path.addEventListener('pointerdown', event => { event.stopPropagation(); this.selected.clear(); this.selectedEdge = edge.id; this.#selectionClasses(); this.#updateControls(); this.#renderEdges(); });
      path.addEventListener('dblclick', event => { event.stopPropagation(); const label = prompt('連線標籤', edge.label || ''); if (label != null) { this.#remember(); edge.label = label; this.#changed(); this.#renderEdges(); } });
      this.edgesLayer.append(path);
      if (edge.label) { const label = document.createElementNS('http://www.w3.org/2000/svg', 'text'); label.setAttribute('x', (a.x + b.x) / 2); label.setAttribute('y', (a.y + b.y) / 2 - 8); label.setAttribute('class', 'canvas-edge-label'); label.textContent = edge.label; this.edgesLayer.append(label); }
    }
    if (this.connection) {
      const a = this.#anchor(this.connection.fromNode, this.connection.fromSide), b = this.connection.point;
      if (a && b) { const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', this.#edgePath(a, b, this.connection.fromSide, this.#nearestSide({ x: b.x - 1, y: b.y - 1, width: 2, height: 2 }, a))); path.setAttribute('class', 'canvas-edge connecting'); this.edgesLayer.append(path); }
    }
  }

  #bounds(nodes) {
    const minX = Math.min(...nodes.map(node => node.x)), minY = Math.min(...nodes.map(node => node.y));
    const maxX = Math.max(...nodes.map(node => node.x + node.width)), maxY = Math.max(...nodes.map(node => node.y + node.height));
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  #createControls() {
    this.selectionBox = document.createElement('div'); this.selectionBox.className = 'canvas-selection-box hidden'; this.viewport.append(this.selectionBox);
    this.controls = document.createElement('div'); this.controls.className = 'canvas-selection-controls hidden';
    this.controls.innerHTML = '<button data-action="group">群組</button><button data-action="ungroup">取消群組</button><button data-action="color">顏色</button><button data-action="fit">聚焦</button><button data-action="delete" class="danger">刪除</button>';
    this.viewport.append(this.controls);
    this.controls.onclick = event => { const action = event.target.closest('button')?.dataset.action; if (action === 'group') this.addGroup(); else if (action === 'ungroup') this.ungroupSelected(); else if (action === 'color') this.#cycleColor(); else if (action === 'fit') this.fitSelection(); else if (action === 'delete') this.deleteSelected(); };
  }

  #cycleColor() {
    if (!this.selected.size && !this.selectedEdge) return;
    this.#remember();
    const items = this.data.nodes.filter(node => this.selected.has(node.id)); if (this.selectedEdge) items.push(this.data.edges.find(edge => edge.id === this.selectedEdge));
    for (const item of items.filter(Boolean)) item.color = COLORS[(COLORS.indexOf(item.color || '') + 1) % COLORS.length];
    this.#changed(); this.render();
  }

  #updateControls() {
    const nodes = this.data.nodes.filter(node => this.selected.has(node.id));
    if (!nodes.length && !this.selectedEdge) { this.controls.classList.add('hidden'); return; }
    this.controls.classList.remove('hidden');
    this.controls.querySelector('[data-action="group"]').classList.toggle('hidden', nodes.filter(node => node.type !== 'group').length < 1);
    this.controls.querySelector('[data-action="ungroup"]').classList.toggle('hidden', !nodes.some(node => node.type === 'group'));
    if (nodes.length) {
      const bounds = this.#bounds(nodes), rect = this.viewport.getBoundingClientRect();
      const x = bounds.x * this.scale + this.pan.x + bounds.width * this.scale / 2;
      const y = bounds.y * this.scale + this.pan.y - 42;
      this.controls.style.left = `${clamp(x, 120, rect.width - 120)}px`; this.controls.style.top = `${Math.max(8, y)}px`;
    } else { this.controls.style.left = '50%'; this.controls.style.top = '12px'; }
  }

  #worldPoint(event) { const rect = this.viewport.getBoundingClientRect(); return { x: (event.clientX - rect.left - this.pan.x) / this.scale, y: (event.clientY - rect.top - this.pan.y) / this.scale }; }
  #transform() { this.surface.style.transform = `translate(${this.pan.x}px,${this.pan.y}px) scale(${this.scale})`; this.#updateControls(); }

  fit() {
    if (!this.data.nodes.length) { this.scale = 1; this.pan = { x: 120, y: 90 }; this.#transform(); return; }
    this.#fitBounds(this.#bounds(this.data.nodes));
  }
  fitSelection() { const nodes = this.data.nodes.filter(node => this.selected.has(node.id)); if (nodes.length) this.#fitBounds(this.#bounds(nodes)); }
  #fitBounds(bounds) {
    const rect = this.viewport.getBoundingClientRect(); this.scale = clamp(Math.min((rect.width - 120) / Math.max(1, bounds.width), (rect.height - 120) / Math.max(1, bounds.height)), .2, 1.8);
    this.pan = { x: (rect.width - bounds.width * this.scale) / 2 - bounds.x * this.scale, y: (rect.height - bounds.height * this.scale) / 2 - bounds.y * this.scale }; this.#transform();
  }

  #events() {
    this.viewport.addEventListener('dblclick', event => { if (!event.target.closest('.canvas-node,.canvas-selection-controls')) { const point = this.#worldPoint(event); this.addText(point.x - 140, point.y - 60, ''); } });
    this.viewport.addEventListener('pointerdown', event => {
      if (event.target.closest('.canvas-node,.canvas-selection-controls,.canvas-edge')) return;
      this.viewport.setPointerCapture(event.pointerId);
      if (event.pointerType === 'touch') this.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const pan = event.button === 1 || this.keys.has('Space') || event.pointerType === 'touch';
      if (pan) this.drag = { type: 'pan', x: event.clientX, y: event.clientY, ox: this.pan.x, oy: this.pan.y };
      else {
        const rect = this.viewport.getBoundingClientRect();
        this.marquee = { x: event.clientX - rect.left, y: event.clientY - rect.top, base: event.shiftKey ? new Set(this.selected) : new Set() };
        if (!event.shiftKey) { this.selected.clear(); this.selectedEdge = null; }
        this.selectionBox.classList.remove('hidden');
      }
    });
    this.viewport.addEventListener('pointermove', event => {
      if (this.touchPoints.has(event.pointerId)) this.touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (this.touchPoints.size === 2) {
        const points = [...this.touchPoints.values()];
        if (!this.pinch) this.pinch = { distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), scale: this.scale, pan: { ...this.pan }, center: { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } };
        const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), next = clamp(this.pinch.scale * distance / Math.max(1, this.pinch.distance), .18, 3);
        const rect = this.viewport.getBoundingClientRect(), mx = this.pinch.center.x - rect.left, my = this.pinch.center.y - rect.top;
        this.pan.x = mx - (mx - this.pinch.pan.x) * next / this.pinch.scale; this.pan.y = my - (my - this.pinch.pan.y) * next / this.pinch.scale; this.scale = next; this.#transform(); return;
      }
      if (this.drag?.type === 'pan') { this.pan.x = this.drag.ox + event.clientX - this.drag.x; this.pan.y = this.drag.oy + event.clientY - this.drag.y; this.#transform(); return; }
      if (!this.marquee) return;
      const rect = this.viewport.getBoundingClientRect(), x2 = event.clientX - rect.left, y2 = event.clientY - rect.top;
      const left = Math.min(this.marquee.x, x2), top = Math.min(this.marquee.y, y2), width = Math.abs(x2 - this.marquee.x), height = Math.abs(y2 - this.marquee.y);
      Object.assign(this.selectionBox.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      const a = { x: (left - this.pan.x) / this.scale, y: (top - this.pan.y) / this.scale, width: width / this.scale, height: height / this.scale };
      this.selected = new Set(this.marquee.base);
      for (const node of this.data.nodes) if (node.x < a.x + a.width && node.x + node.width > a.x && node.y < a.y + a.height && node.y + node.height > a.y) this.selected.add(node.id);
      this.#selectionClasses(); this.#updateControls();
    });
    const end = event => { this.touchPoints.delete(event.pointerId); if (this.touchPoints.size < 2) this.pinch = null; this.drag = null; if (this.marquee) { this.marquee = null; this.selectionBox.classList.add('hidden'); this.selectionBox.removeAttribute('style'); this.#selectionClasses(); this.#updateControls(); } };
    this.viewport.addEventListener('pointerup', end); this.viewport.addEventListener('pointercancel', end);
    this.viewport.addEventListener('wheel', event => {
      event.preventDefault(); const rect = this.viewport.getBoundingClientRect(), mx = event.clientX - rect.left, my = event.clientY - rect.top, old = this.scale;
      this.scale = clamp(this.scale * Math.exp(-event.deltaY * .0012), .18, 3); this.pan.x = mx - (mx - this.pan.x) * this.scale / old; this.pan.y = my - (my - this.pan.y) * this.scale / old; this.#transform();
    }, { passive: false });
    this.viewport.addEventListener('dragover', event => event.preventDefault());
    this.viewport.addEventListener('drop', event => { event.preventDefault(); const path = event.dataTransfer.getData('text/mysyncnote-path'); if (!path) return; const point = this.#worldPoint(event); this.#remember(); const node = { id: uid('node'), type: 'file', x: point.x, y: point.y, width: 300, height: 190, file: path }; this.data.nodes.push(node); this.selected = new Set([node.id]); this.#changed(); this.render(); });
    addEventListener('keydown', event => {
      this.keys.add(event.code === 'Space' ? 'Space' : event.key);
      if (!this.viewport.closest('.canvas-workspace:not(.hidden)') || event.target.matches('input,textarea,[contenteditable]')) return;
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.key.toLowerCase() === 'a') { event.preventDefault(); this.selectAll(); }
      else if (ctrl && event.key.toLowerCase() === 'c') { event.preventDefault(); this.copySelected(); }
      else if (ctrl && event.key.toLowerCase() === 'v') { event.preventDefault(); this.paste(); }
      else if (ctrl && event.key.toLowerCase() === 'z' && !event.shiftKey) { event.preventDefault(); this.undo(); }
      else if ((ctrl && event.key.toLowerCase() === 'y') || (ctrl && event.shiftKey && event.key.toLowerCase() === 'z')) { event.preventDefault(); this.redo(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); this.deleteSelected(); }
      else if (event.key === 'Escape') { this.connection = null; this.marquee = null; this.selected.clear(); this.selectedEdge = null; this.render(); }
    });
    addEventListener('keyup', event => this.keys.delete(event.code === 'Space' ? 'Space' : event.key));
  }
}
