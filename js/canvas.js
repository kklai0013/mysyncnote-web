const uid = prefix => `${prefix}-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class CanvasView {
  constructor({ viewport, surface, nodesLayer, edgesLayer, onChange, onOpenNote, chooseNote }) {
    Object.assign(this, { viewport, surface, nodesLayer, edgesLayer, onChange, onOpenNote, chooseNote });
    this.data = { nodes: [], edges: [] };
    this.scale = 1;
    this.pan = { x: 120, y: 90 };
    this.selected = new Set();
    this.connectMode = false;
    this.connectStart = null;
    this.drag = null;
    this.pointers = new Map();
    this.#events();
  }

  load(text) {
    try {
      const parsed = JSON.parse(text || '{}');
      this.data = { nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [], edges: Array.isArray(parsed.edges) ? parsed.edges : [] };
    } catch {
      this.data = { nodes: [], edges: [] };
    }
    this.selected.clear();
    this.render();
    this.fit();
  }

  json() { return JSON.stringify(this.data, null, 2); }

  addText(x = 140, y = 100) {
    this.data.nodes.push({ id: uid('node'), type: 'text', x, y, width: 280, height: 180, text: '# 新卡片\n\n在這裡輸入內容。' });
    this.#changed(); this.render();
  }

  async addNote(x = 180, y = 130) {
    const path = await this.chooseNote?.();
    if (!path) return;
    this.data.nodes.push({ id: uid('node'), type: 'file', x, y, width: 300, height: 190, file: path });
    this.#changed(); this.render();
  }

  addGroup(x = 80, y = 60) {
    this.data.nodes.unshift({ id: uid('group'), type: 'group', x, y, width: 600, height: 380, label: '群組' });
    this.#changed(); this.render();
  }

  toggleConnect() {
    this.connectMode = !this.connectMode;
    this.connectStart = null;
    return this.connectMode;
  }

  deleteSelected() {
    if (!this.selected.size) return;
    this.data.nodes = this.data.nodes.filter(node => !this.selected.has(node.id));
    this.data.edges = this.data.edges.filter(edge => !this.selected.has(edge.fromNode) && !this.selected.has(edge.toNode));
    this.selected.clear(); this.#changed(); this.render();
  }

  render() {
    this.nodesLayer.innerHTML = '';
    for (const node of this.data.nodes) this.nodesLayer.append(this.#nodeElement(node));
    this.#transform();
    requestAnimationFrame(() => this.#renderEdges());
  }

  #nodeElement(node) {
    const element = document.createElement('article');
    element.className = `canvas-node ${node.type === 'group' ? 'group' : ''}${this.selected.has(node.id) ? ' selected' : ''}`;
    element.dataset.id = node.id;
    element.style.cssText = `left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px;${node.color ? `border-color:${node.color}` : ''}`;
    if (node.type === 'group') {
      element.innerHTML = `<div class="canvas-node-header"><span class="canvas-node-title"></span></div><div class="canvas-resize"></div>`;
      element.querySelector('.canvas-node-title').textContent = node.label || '群組';
    } else {
      const header = document.createElement('div');
      header.className = 'canvas-node-header';
      const title = document.createElement('span'); title.className = 'canvas-node-title';
      title.textContent = node.type === 'file' ? node.file : node.type === 'link' ? node.url : '文字卡片';
      header.append(title);
      const content = document.createElement('div'); content.className = 'canvas-node-content';
      if (node.type === 'text') {
        const textarea = document.createElement('textarea'); textarea.value = node.text || '';
        textarea.addEventListener('input', () => { node.text = textarea.value; this.#changed(); });
        content.append(textarea);
      } else if (node.type === 'file') {
        content.innerHTML = `<p>筆記卡片</p><b></b><p class="hint">雙擊開啟完整筆記</p>`;
        content.querySelector('b').textContent = node.file || '找不到筆記';
        content.addEventListener('dblclick', () => this.onOpenNote?.(node.file));
      } else if (node.type === 'link') {
        const link = document.createElement('a'); link.href = node.url; link.target = '_blank'; link.rel = 'noopener'; link.textContent = node.url; content.append(link);
      }
      const left = document.createElement('button'); left.className = 'canvas-port left'; left.title = '建立連線'; left.dataset.side = 'left';
      const right = document.createElement('button'); right.className = 'canvas-port right'; right.title = '建立連線'; right.dataset.side = 'right';
      const resize = document.createElement('div'); resize.className = 'canvas-resize';
      element.append(header, content, left, right, resize);
    }
    element.addEventListener('pointerdown', event => this.#nodePointerDown(event, node, element));
    element.addEventListener('click', event => {
      if (event.target.closest('textarea,a')) return;
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey) this.selected.clear();
      this.selected.add(node.id); this.#selectionClasses();
    });
    return element;
  }

  #nodePointerDown(event, node, element) {
    if (event.target.closest('textarea,a')) return;
    const port = event.target.closest('.canvas-port');
    if (port || this.connectMode) {
      event.stopPropagation();
      if (!this.connectStart) {
        this.connectStart = { id: node.id, side: port?.dataset.side || 'right' };
        this.selected = new Set([node.id]); this.#selectionClasses();
      } else if (this.connectStart.id !== node.id) {
        this.data.edges.push({ id: uid('edge'), fromNode: this.connectStart.id, fromSide: this.connectStart.side, toNode: node.id, toSide: port?.dataset.side || 'left' });
        this.connectStart = null; this.connectMode = false; this.#changed(); this.#renderEdges();
      }
      return;
    }
    if (!event.target.closest('.canvas-node-header,.canvas-resize')) return;
    event.stopPropagation();
    element.setPointerCapture(event.pointerId);
    if (!this.selected.has(node.id)) this.selected = new Set([node.id]);
    const point = this.#worldPoint(event);
    const resizing = Boolean(event.target.closest('.canvas-resize'));
    this.drag = { node, element, resizing, startX: point.x, startY: point.y, x: node.x, y: node.y, width: node.width, height: node.height };
    this.#selectionClasses();
    const move = moveEvent => {
      if (!this.drag) return;
      const p = this.#worldPoint(moveEvent), dx = p.x - this.drag.startX, dy = p.y - this.drag.startY;
      if (resizing) { node.width = Math.max(140, this.drag.width + dx); node.height = Math.max(90, this.drag.height + dy); }
      else { node.x = Math.round((this.drag.x + dx) / 10) * 10; node.y = Math.round((this.drag.y + dy) / 10) * 10; }
      element.style.left = `${node.x}px`; element.style.top = `${node.y}px`; element.style.width = `${node.width}px`; element.style.height = `${node.height}px`;
      this.#renderEdges();
    };
    const up = () => { if (this.drag) this.#changed(); this.drag = null; element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', up); };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', up);
  }

  #selectionClasses() {
    for (const element of this.nodesLayer.children) element.classList.toggle('selected', this.selected.has(element.dataset.id));
  }

  #nodeCenter(id, side) {
    const node = this.data.nodes.find(item => item.id === id);
    if (!node) return null;
    return { x: node.x + (side === 'left' ? 0 : side === 'right' ? node.width : node.width / 2), y: node.y + node.height / 2 };
  }

  #renderEdges() {
    const bounds = this.data.nodes.reduce((acc, node) => ({ minX: Math.min(acc.minX, node.x), minY: Math.min(acc.minY, node.y), maxX: Math.max(acc.maxX, node.x + node.width), maxY: Math.max(acc.maxY, node.y + node.height) }), { minX: -2000, minY: -2000, maxX: 4000, maxY: 3000 });
    this.edgesLayer.setAttribute('viewBox', `${bounds.minX} ${bounds.minY} ${bounds.maxX - bounds.minX} ${bounds.maxY - bounds.minY}`);
    this.edgesLayer.style.cssText = `left:${bounds.minX}px;top:${bounds.minY}px;width:${bounds.maxX - bounds.minX}px;height:${bounds.maxY - bounds.minY}px`;
    this.edgesLayer.innerHTML = '<defs><marker id="canvas-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#84909d"/></marker></defs>';
    for (const edge of this.data.edges) {
      const a = this.#nodeCenter(edge.fromNode, edge.fromSide), b = this.#nodeCenter(edge.toNode, edge.toSide);
      if (!a || !b) continue;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const ax = a.x - bounds.minX, ay = a.y - bounds.minY, bx = b.x - bounds.minX, by = b.y - bounds.minY;
      const curve = Math.max(60, Math.abs(bx - ax) * .45);
      path.setAttribute('d', `M ${ax} ${ay} C ${ax + curve} ${ay}, ${bx - curve} ${by}, ${bx} ${by}`);
      path.setAttribute('class', 'canvas-edge'); path.setAttribute('marker-end', 'url(#canvas-arrow)');
      if (edge.color) path.setAttribute('stroke', edge.color);
      this.edgesLayer.append(path);
      if (edge.label) {
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', (ax + bx) / 2); label.setAttribute('y', (ay + by) / 2 - 6); label.setAttribute('fill', '#dce1e6'); label.setAttribute('font-size', '12'); label.textContent = edge.label; this.edgesLayer.append(label);
      }
    }
  }

  #worldPoint(event) {
    const rect = this.viewport.getBoundingClientRect();
    return { x: (event.clientX - rect.left - this.pan.x) / this.scale, y: (event.clientY - rect.top - this.pan.y) / this.scale };
  }

  #transform() { this.surface.style.transform = `translate(${this.pan.x}px,${this.pan.y}px) scale(${this.scale})`; }

  fit() {
    if (!this.data.nodes.length) { this.scale = 1; this.pan = { x: 120, y: 90 }; this.#transform(); return; }
    const minX = Math.min(...this.data.nodes.map(node => node.x)), minY = Math.min(...this.data.nodes.map(node => node.y));
    const maxX = Math.max(...this.data.nodes.map(node => node.x + node.width)), maxY = Math.max(...this.data.nodes.map(node => node.y + node.height));
    const rect = this.viewport.getBoundingClientRect();
    this.scale = clamp(Math.min((rect.width - 100) / Math.max(1, maxX - minX), (rect.height - 100) / Math.max(1, maxY - minY)), .25, 1.4);
    this.pan = { x: (rect.width - (maxX - minX) * this.scale) / 2 - minX * this.scale, y: (rect.height - (maxY - minY) * this.scale) / 2 - minY * this.scale };
    this.#transform();
  }

  #events() {
    this.viewport.addEventListener('pointerdown', event => {
      if (event.target.closest('.canvas-node')) return;
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      this.viewport.setPointerCapture(event.pointerId);
      this.drag = { pan: true, x: event.clientX, y: event.clientY, ox: this.pan.x, oy: this.pan.y };
      this.selected.clear(); this.#selectionClasses();
    });
    this.viewport.addEventListener('pointermove', event => {
      if (!this.drag?.pan) return;
      this.pan.x = this.drag.ox + event.clientX - this.drag.x; this.pan.y = this.drag.oy + event.clientY - this.drag.y; this.#transform();
    });
    const end = event => { this.pointers.delete(event.pointerId); if (this.drag?.pan) this.drag = null; };
    this.viewport.addEventListener('pointerup', end); this.viewport.addEventListener('pointercancel', end);
    this.viewport.addEventListener('wheel', event => {
      event.preventDefault();
      const rect = this.viewport.getBoundingClientRect(), mx = event.clientX - rect.left, my = event.clientY - rect.top;
      const old = this.scale; this.scale = clamp(this.scale * Math.exp(-event.deltaY * .0012), .18, 3);
      this.pan.x = mx - (mx - this.pan.x) * this.scale / old; this.pan.y = my - (my - this.pan.y) * this.scale / old; this.#transform();
    }, { passive: false });
    this.viewport.addEventListener('dragover', event => event.preventDefault());
    this.viewport.addEventListener('drop', event => {
      event.preventDefault();
      const path = event.dataTransfer.getData('text/mysyncnote-path');
      if (!path) return;
      const point = this.#worldPoint(event);
      this.data.nodes.push({ id: uid('node'), type: 'file', x: point.x, y: point.y, width: 300, height: 190, file: path });
      this.#changed(); this.render();
    });
    addEventListener('keydown', event => {
      if ((event.key === 'Delete' || event.key === 'Backspace') && !event.target.matches('input,textarea,[contenteditable]') && this.viewport.closest('.canvas-workspace:not(.hidden)')) { event.preventDefault(); this.deleteSelected(); }
      if (event.key === 'Escape') { this.connectMode = false; this.connectStart = null; }
    });
  }

  #changed() { this.onChange?.(this.json()); }
}
