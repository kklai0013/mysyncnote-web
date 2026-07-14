import { noteStem } from './markdown.js';

function hashColor(value) {
  let hash = 0;
  for (const char of value) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 58% 68%)`;
}

export class GraphView {
  constructor(canvas, onOpen) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onOpen = onOpen;
    this.nodes = [];
    this.edges = [];
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
    this.drag = null;
    this.hover = null;
    this.frame = null;
    this.#events();
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => {
        if (!this.canvas.closest('.hidden')) { this.resize(); this.draw(); }
      });
      this.resizeObserver.observe(this.canvas.parentElement);
    }
  }

  setData(index, { scope = 'all', currentPath = '', depth = 2, filter = '', isolates = true } = {}) {
    if (!index) return;
    let paths = new Set(index.entries.map(entry => entry.path));
    if (scope === 'local' && currentPath) {
      paths = new Set([currentPath]);
      for (let step = 0; step < depth; step++) {
        for (const edge of index.edges) if (paths.has(edge.source) || paths.has(edge.target)) { paths.add(edge.source); if (!edge.broken) paths.add(edge.target); }
      }
    }
    const needle = filter.trim().toLowerCase();
    if (needle) {
      const matching = new Set(index.entries.filter(entry => `${entry.path} ${entry.tags.join(' ')}`.toLowerCase().includes(needle)).map(entry => entry.path));
      const neighbors = new Set(matching);
      for (const edge of index.edges) if (matching.has(edge.source) || matching.has(edge.target)) { neighbors.add(edge.source); if (!edge.broken) neighbors.add(edge.target); }
      paths = new Set([...paths].filter(path => neighbors.has(path)));
    }
    let edges = index.edges.filter(edge => paths.has(edge.source) && (edge.broken || paths.has(edge.target)));
    if (!isolates) {
      const linked = new Set(edges.flatMap(edge => [edge.source, edge.target]));
      paths = new Set([...paths].filter(path => linked.has(path)));
    }
    const previous = new Map(this.nodes.map(node => [node.path, node]));
    const width = this.canvas.clientWidth || 800;
    const height = this.canvas.clientHeight || 600;
    const brokenTargets = [...new Set(edges.filter(edge => edge.broken).map(edge => edge.target))];
    const visiblePaths = [...paths, ...brokenTargets.map(target => `__broken:${target}`)];
    this.nodes = visiblePaths.map((path, i) => {
      const ghost = path.startsWith('__broken:');
      const targetLabel = ghost ? path.slice(9) : path;
      const entry = index.byPath.get(path);
      const old = previous.get(path);
      const angle = i / Math.max(visiblePaths.length, 1) * Math.PI * 2;
      return old || { path, ghost, label: noteStem(targetLabel), folder: targetLabel.split('/')[0] || '根目錄', tags: entry?.tags || [], x: width / 2 + Math.cos(angle) * Math.min(width, height) * .28, y: height / 2 + Math.sin(angle) * Math.min(width, height) * .28, vx: 0, vy: 0, radius: ghost ? 5 : 6 + Math.min(8, (entry?.links?.length || 0) * .5), color: ghost ? '#ee8383' : hashColor(path.split('/')[0] || 'root') };
    });
    const byPath = new Map(this.nodes.map(node => [node.path, node]));
    this.edges = edges.map(edge => ({ ...edge, a: byPath.get(edge.source), b: byPath.get(edge.broken ? `__broken:${edge.target}` : edge.target) })).filter(edge => edge.a && edge.b);
    this.fit();
    this.start();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.canvas.height = Math.max(1, Math.round(rect.height * ratio));
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.width = rect.width; this.height = rect.height; this.ratio = ratio;
  }

  fit() {
    this.resize();
    this.scale = 1;
    this.offset = { x: 0, y: 0 };
  }

  start() {
    cancelAnimationFrame(this.frame);
    let iterations = 0;
    const tick = () => {
      if (iterations++ < 180 && !this.drag) this.#simulate();
      this.draw();
      if (iterations < 220 || this.drag) this.frame = requestAnimationFrame(tick);
    };
    tick();
  }

  #simulate() {
    const repulsion = Math.min(2800, 800 + this.nodes.length * 16);
    for (let i = 0; i < this.nodes.length; i++) {
      const a = this.nodes[i];
      for (let j = i + 1; j < this.nodes.length; j++) {
        const b = this.nodes[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        const distance2 = dx * dx + dy * dy + .1;
        const distance = Math.sqrt(distance2);
        const force = repulsion / distance2;
        dx /= distance; dy /= distance;
        a.vx -= dx * force; a.vy -= dy * force; b.vx += dx * force; b.vy += dy * force;
      }
    }
    for (const edge of this.edges) {
      if (!edge.b) continue;
      const dx = edge.b.x - edge.a.x, dy = edge.b.y - edge.a.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (distance - 110) * .008;
      edge.a.vx += dx / distance * force; edge.a.vy += dy / distance * force;
      edge.b.vx -= dx / distance * force; edge.b.vy -= dy / distance * force;
    }
    const cx = (this.width || 800) / 2, cy = (this.height || 600) / 2;
    for (const node of this.nodes) {
      node.vx += (cx - node.x) * .0008; node.vy += (cy - node.y) * .0008;
      node.vx *= .86; node.vy *= .86;
      node.x += node.vx; node.y += node.vy;
    }
  }

  draw() {
    if (!this.width) this.resize();
    const ctx = this.ctx;
    ctx.save();
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.translate(this.offset.x, this.offset.y);
    ctx.scale(this.scale, this.scale);
    ctx.lineWidth = 1 / this.scale;
    for (const edge of this.edges) {
      if (!edge.b) continue;
      ctx.strokeStyle = '#68717b88';
      ctx.beginPath(); ctx.moveTo(edge.a.x, edge.a.y); ctx.lineTo(edge.b.x, edge.b.y); ctx.stroke();
    }
    ctx.textBaseline = 'middle'; ctx.font = `${12 / Math.max(.75, this.scale)}px system-ui`;
    for (const node of this.nodes) {
      const hovered = node === this.hover || node === this.drag?.node;
      ctx.beginPath(); ctx.arc(node.x, node.y, hovered ? node.radius + 3 : node.radius, 0, Math.PI * 2);
      ctx.fillStyle = node.color; ctx.fill();
      if (hovered) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 / this.scale; ctx.stroke(); }
      if (this.scale > .42 || hovered) {
        ctx.fillStyle = '#eef0f3';
        ctx.fillText(node.label, node.x + node.radius + 5, node.y);
      }
    }
    ctx.restore();
  }

  #point(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left - this.offset.x) / this.scale, y: (event.clientY - rect.top - this.offset.y) / this.scale, screenX: event.clientX, screenY: event.clientY };
  }

  #hit(point) {
    return this.nodes.slice().reverse().find(node => Math.hypot(node.x - point.x, node.y - point.y) <= Math.max(node.radius + 5, 12 / this.scale));
  }

  #events() {
    this.canvas.addEventListener('pointerdown', event => {
      this.canvas.setPointerCapture(event.pointerId);
      const point = this.#point(event);
      const node = this.#hit(point);
      this.drag = node ? { node, dx: point.x - node.x, dy: point.y - node.y, x: event.clientX, y: event.clientY, moved: false } : { pan: true, x: event.clientX, y: event.clientY, ox: this.offset.x, oy: this.offset.y, moved: false };
      this.start();
    });
    this.canvas.addEventListener('pointermove', event => {
      const point = this.#point(event);
      this.hover = this.#hit(point);
      this.canvas.style.cursor = this.hover ? 'pointer' : this.drag?.pan ? 'grabbing' : 'grab';
      if (!this.drag) { this.draw(); return; }
      const moved = Math.hypot(event.clientX - this.drag.x, event.clientY - this.drag.y) > 4;
      if (this.drag.node) {
        if (!moved && !this.drag.moved) return;
        this.drag.node.x = point.x - this.drag.dx; this.drag.node.y = point.y - this.drag.dy; this.drag.node.vx = 0; this.drag.node.vy = 0; this.drag.moved = true;
      } else {
        if (!moved && !this.drag.moved) return;
        this.offset.x = this.drag.ox + event.clientX - this.drag.x; this.offset.y = this.drag.oy + event.clientY - this.drag.y; this.drag.moved = true;
      }
      this.draw();
    });
    this.canvas.addEventListener('pointerup', () => {
      if (this.drag?.node && !this.drag.moved && !this.drag.node.ghost) this.onOpen(this.drag.node.path);
      this.drag = null;
    });
    this.canvas.addEventListener('pointercancel', () => { this.drag = null; });
    this.canvas.addEventListener('wheel', event => {
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const mx = event.clientX - rect.left, my = event.clientY - rect.top;
      const old = this.scale;
      this.scale = Math.max(.18, Math.min(3.2, this.scale * Math.exp(-event.deltaY * .0012)));
      this.offset.x = mx - (mx - this.offset.x) * this.scale / old;
      this.offset.y = my - (my - this.offset.y) * this.scale / old;
      this.draw();
    }, { passive: false });
    addEventListener('resize', () => { if (!this.canvas.closest('.hidden')) { this.resize(); this.draw(); } });
  }
}
