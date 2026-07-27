import { createEmptyTimeline, normalizeTimeline, validateTimeline } from './timeline.js?v=19';

const COLORS = ['#78dba0', '#7fb5ff', '#d99cff', '#f4b86a', '#ff8d8d', '#69d4d0', '#c7d36f'];
const MIN_DURATION = 1;
const DEFAULT_DURATION = 4;
const BASE_UNIT_WIDTH = 56;

function id(prefix) {
  return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function snap(value) {
  return Math.max(0, Math.round(finite(value) * 4) / 4);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nextOrder(items) {
  return items.length ? Math.max(...items.map(item => finite(item.order))) + 1000 : 1000;
}

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function button(text, title = '') {
  const node = element('button', '', text);
  node.type = 'button';
  if (title) node.title = title;
  return node;
}

function input(value = '', type = 'text') {
  const node = element('input');
  node.type = type;
  node.value = value ?? '';
  return node;
}

function stopControlEvents(control) {
  control.addEventListener('click', event => event.stopPropagation());
  control.addEventListener('pointerdown', event => event.stopPropagation());
  control.addEventListener('dragstart', event => event.stopPropagation());
}

function eventPosition(event) {
  return snap(event?.time?.position);
}

function eventDuration(event) {
  return Math.max(MIN_DURATION, snap(event?.time?.duration || DEFAULT_DURATION));
}

function syncClipTime(event) {
  const position = eventPosition(event);
  const duration = eventDuration(event);
  event.time = {
    ...(event.time || {}),
    kind: 'exact',
    start: String(position),
    end: String(position + duration),
    precision: 'exact',
    momentId: '',
    anchorId: '',
    offset: 0,
    unit: 'day',
    position,
    duration
  };
}

export class TimelineView {
  constructor(options) {
    this.root = options.root;
    this.stage = this.root.querySelector('#timelineStage');
    this.onChange = options.onChange || (() => {});
    this.onOpenNote = options.onOpenNote || (() => {});
    this.onAcceptNote = options.onAcceptNote || (() => false);
    this.notify = options.notify || (() => {});
    this.data = createEmptyTimeline();
    this.notes = [];
    this.key = '';
    this.zoom = 1;
    this.cursor = 0;
    this.query = '';
    this.selectedEventId = '';
    this.selectedTrackId = '';
    this.undoStack = [];
    this.redoStack = [];
    this.pendingFocus = null;
    this.bind();
  }

  bind() {
    this.root.querySelector('#timelineAddEvent').onclick = () => this.addEvent();
    this.root.querySelector('#timelineAddTrack').onclick = () => this.addTrack();
    this.root.querySelector('#timelineAddGroup').onclick = () => this.addTrackGroup();
    this.root.querySelector('#timelineUndo').onclick = () => this.undo();
    this.root.querySelector('#timelineRedo').onclick = () => this.redo();
    this.root.querySelector('#timelineZoomOut').onclick = () => this.setZoom(this.zoom / 1.18);
    this.root.querySelector('#timelineZoomIn').onclick = () => this.setZoom(this.zoom * 1.18);
    this.root.querySelector('#timelineZoomReset').onclick = () => this.setZoom(1);
    this.root.querySelector('#timelineSearch').oninput = event => {
      this.query = event.currentTarget.value;
      this.persistView();
      this.render();
    };
    this.root.addEventListener('keydown', event => {
      const typing = event.target.matches?.('input,textarea,select,[contenteditable]');
      if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.stopPropagation();
        event.shiftKey ? this.redo() : this.undo();
      } else if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        event.stopPropagation();
        this.redo();
      } else if (!typing && event.key === 'Delete' && this.selectedEventId) {
        event.preventDefault();
        event.stopPropagation();
        this.deleteEvent(this.selectedEventId);
      } else if (!typing && event.key === 'Escape') {
        this.selectedEventId = '';
        this.renderSelection();
      }
    });
  }

  load(text, options = {}) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Timeline JSON 無法解析：${error.message}`);
    }
    this.data = normalizeTimeline(parsed, options.title);
    const validation = validateTimeline(this.data);
    if (validation.errors.length) throw new Error(validation.errors.join('\n'));
    for (const event of this.data.events) syncClipTime(event);
    this.key = options.key || '';
    this.selectedEventId = '';
    this.undoStack = [];
    this.redoStack = [];
    this.restoreView();
    this.selectedTrackId = this.data.tracks.some(track => track.id === this.selectedTrackId)
      ? this.selectedTrackId
      : this.data.tracks[0]?.id || '';
    this.render();
  }

  json() {
    return `${JSON.stringify(this.data, null, 2)}\n`;
  }

  activate() {
    this.render();
  }

  setNotes(entries) {
    this.notes = (Array.isArray(entries) ? entries : [])
      .map(entry => typeof entry === 'string' ? entry : entry.path)
      .filter(Boolean);
  }

  setDocumentIdentity(key, title = '') {
    this.key = key || this.key;
    if (title && this.data.title !== title) {
      this.data.title = title;
      this.onChange();
    }
    this.persistView();
  }

  viewState() {
    return {
      zoom: this.zoom,
      cursor: this.cursor,
      query: this.query,
      selectedTrackId: this.selectedTrackId
    };
  }

  restoreView() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(`mysyncnote-timeline-daw:${this.key}`) || 'null');
    } catch {}
    this.zoom = Math.min(2.4, Math.max(.45, finite(saved?.zoom, 1)));
    this.cursor = snap(saved?.cursor);
    this.query = String(saved?.query || '');
    this.selectedTrackId = String(saved?.selectedTrackId || '');
  }

  persistView() {
    if (!this.key) return;
    try {
      localStorage.setItem(`mysyncnote-timeline-daw:${this.key}`, JSON.stringify(this.viewState()));
    } catch {}
  }

  snapshot() {
    return this.json();
  }

  pushHistory(before) {
    if (!before || before === this.json()) return;
    this.undoStack.push(before);
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
  }

  transact(_label, mutator, focus = null) {
    const before = this.snapshot();
    mutator(this.data);
    this.data = normalizeTimeline(this.data, this.data.title);
    for (const event of this.data.events) syncClipTime(event);
    if (before === this.json()) return false;
    this.pushHistory(before);
    this.pendingFocus = focus;
    this.render();
    this.onChange();
    return true;
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.json());
    this.data = normalizeTimeline(JSON.parse(previous), this.data.title);
    if (!this.data.events.some(event => event.id === this.selectedEventId)) this.selectedEventId = '';
    this.render();
    this.onChange();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.json());
    this.data = normalizeTimeline(JSON.parse(next), this.data.title);
    if (!this.data.events.some(event => event.id === this.selectedEventId)) this.selectedEventId = '';
    this.render();
    this.onChange();
  }

  setZoom(value) {
    this.zoom = Math.min(2.4, Math.max(.45, finite(value, 1)));
    this.persistView();
    this.render();
  }

  setCursor(value) {
    this.cursor = snap(value);
    this.persistView();
    this.root.querySelector('#timelineCursorLabel').textContent = `位置 ${this.cursor}`;
    for (const marker of this.stage.querySelectorAll('.timeline-playhead')) {
      marker.style.left = `${this.cursor * this.unitWidth()}px`;
    }
  }

  unitWidth() {
    return Math.round(BASE_UNIT_WIDTH * this.zoom);
  }

  selectedTrack() {
    return this.data.tracks.find(track => track.id === this.selectedTrackId) || this.data.tracks[0] || null;
  }

  selectedEvent() {
    return this.data.events.find(event => event.id === this.selectedEventId) || null;
  }

  nextPosition(trackId) {
    const events = this.data.events.filter(event => event.trackIds[0] === trackId);
    if (!events.length) return this.cursor;
    return Math.max(this.cursor, ...events.map(event => eventPosition(event) + eventDuration(event)));
  }

  addEvent(seed = {}) {
    const trackId = this.data.tracks.some(track => track.id === seed.trackId)
      ? seed.trackId
      : this.selectedTrack()?.id;
    if (!trackId) return;
    const eventId = id('event');
    const position = snap(seed.position ?? this.cursor);
    const duration = Math.max(MIN_DURATION, snap(seed.duration ?? DEFAULT_DURATION));
    this.selectedEventId = eventId;
    this.selectedTrackId = trackId;
    this.transact('新增事件', data => {
      const targetTrack = data.tracks.find(track => track.id === trackId);
      const targetGroup = data.trackGroups.find(group => group.id === targetTrack?.groupId);
      if (targetGroup) targetGroup.collapsed = false;
      const event = {
        id: eventId,
        title: seed.title || '新事件',
        description: seed.description || '',
        time: {
          kind: 'exact',
          start: String(position),
          end: String(position + duration),
          precision: 'exact',
          momentId: '',
          anchorId: '',
          offset: 0,
          unit: 'day',
          position,
          duration
        },
        trackIds: [trackId],
        branchId: 'main',
        variantGroupId: null,
        variantLabel: '',
        notePaths: [],
        tags: [],
        status: 'idea',
        dependsOn: [],
        order: nextOrder(data.events)
      };
      data.events.push(event);
    }, { kind: 'event', id: eventId });
    this.setCursor(position + duration);
  }

  addTrack() {
    const trackId = id('track');
    const currentGroup = this.selectedTrack()?.groupId || null;
    this.selectedTrackId = trackId;
    this.transact('新增軌道', data => {
      const targetGroup = data.trackGroups.find(group => group.id === currentGroup);
      if (targetGroup) targetGroup.collapsed = false;
      data.tracks.push({
        id: trackId,
        name: `軌道 ${data.tracks.length + 1}`,
        color: COLORS[data.tracks.length % COLORS.length],
        groupId: currentGroup,
        order: nextOrder(data.tracks)
      });
    }, { kind: 'track', id: trackId });
  }

  addTrackGroup() {
    const groupId = id('track-group');
    const selectedTrackId = this.selectedTrack()?.id;
    this.transact('新增軌道資料夾', data => {
      data.trackGroups.push({
        id: groupId,
        name: `資料夾 ${data.trackGroups.length + 1}`,
        collapsed: false,
        order: nextOrder(data.trackGroups)
      });
      const track = data.tracks.find(item => item.id === selectedTrackId);
      if (track) track.groupId = groupId;
    }, { kind: 'group', id: groupId });
  }

  deleteEvent(eventId) {
    if (!this.data.events.some(event => event.id === eventId)) return;
    this.transact('刪除事件', data => {
      data.events = data.events.filter(event => event.id !== eventId);
      data.narrativeItems = data.narrativeItems.filter(item => item.eventId !== eventId);
      data.relations = data.relations.filter(item => item.fromEventId !== eventId && item.toEventId !== eventId);
      for (const event of data.events) {
        event.dependsOn = event.dependsOn.filter(id => id !== eventId);
        if (event.time.anchorId === eventId) event.time.anchorId = '';
      }
      for (const branch of data.branches) if (branch.fromEventId === eventId) branch.fromEventId = null;
      for (const group of data.variantGroups) {
        group.eventIds = group.eventIds.filter(id => id !== eventId);
        if (group.activeEventId === eventId) group.activeEventId = group.eventIds[0] || '';
      }
      data.variantGroups = data.variantGroups.filter(group => group.eventIds.length > 1);
    });
    this.selectedEventId = '';
    this.renderSelection();
    this.notify('事件已刪除；可用 Ctrl+Z 復原');
  }

  removeTrack(trackId) {
    const track = this.data.tracks.find(item => item.id === trackId);
    if (!track || this.data.tracks.length === 1) return;
    if (!confirm(`刪除軌道「${track.name}」？\n裡面的事件會移到其他軌道，不會刪除。`)) return;
    this.transact('刪除軌道', data => {
      data.tracks = data.tracks.filter(item => item.id !== trackId);
      const fallbackId = data.tracks[0].id;
      for (const event of data.events) {
        if (event.trackIds[0] === trackId) event.trackIds = [fallbackId];
      }
    });
    this.selectedTrackId = this.data.tracks[0]?.id || '';
    this.persistView();
    this.renderSelection();
  }

  removeTrackGroup(groupId) {
    const group = this.data.trackGroups.find(item => item.id === groupId);
    if (!group) return;
    this.transact('移除軌道資料夾', data => {
      data.trackGroups = data.trackGroups.filter(item => item.id !== groupId);
      for (const track of data.tracks) if (track.groupId === groupId) track.groupId = null;
    });
  }

  moveEvent(eventId, trackId, position) {
    this.selectedEventId = eventId;
    this.selectedTrackId = trackId;
    this.transact('移動事件', data => {
      const event = data.events.find(item => item.id === eventId);
      if (!event) return;
      event.trackIds = [trackId];
      event.time.position = snap(position);
      syncClipTime(event);
    });
    this.persistView();
  }

  attachNote(eventId, path) {
    if (!path || !this.onAcceptNote(path)) return;
    this.transact('連結筆記', data => {
      const event = data.events.find(item => item.id === eventId);
      if (event && !event.notePaths.includes(path)) event.notePaths.push(path);
    });
  }

  bindDraft(control, apply, options = {}) {
    let before = '';
    control.addEventListener('focus', () => {
      before = this.snapshot();
      if (options.selectOnFocus) control.select();
    });
    control.addEventListener('input', () => {
      apply(control.value);
      this.onChange();
    });
    control.addEventListener('blur', () => {
      if (options.fallback && !String(control.value).trim()) {
        control.value = options.fallback;
        apply(options.fallback);
      }
      this.data = normalizeTimeline(this.data, this.data.title);
      this.pushHistory(before);
      before = '';
      if (options.renderOnBlur) this.render();
    });
    if (control.tagName === 'INPUT' && control.type === 'text') {
      control.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          control.blur();
        }
      });
    }
    stopControlEvents(control);
  }

  filteredEvents() {
    const query = this.query.trim().normalize('NFKC').toLocaleLowerCase('zh-Hant');
    if (!query) return this.data.events;
    return this.data.events.filter(event => [
      event.title,
      event.description,
      ...(event.notePaths || []),
      ...(event.tags || [])
    ].join(' ').normalize('NFKC').toLocaleLowerCase('zh-Hant').includes(query));
  }

  timelineUnits() {
    const end = Math.max(
      24,
      this.cursor + 8,
      ...this.data.events.map(event => eventPosition(event) + eventDuration(event) + 4)
    );
    return Math.min(400, Math.ceil(end));
  }

  render() {
    const oldScroll = this.stage.querySelector('.timeline-scroll');
    const scrollLeft = oldScroll?.scrollLeft || 0;
    const scrollTop = oldScroll?.scrollTop || 0;
    const unitWidth = this.unitWidth();
    const totalWidth = Math.max(960, this.timelineUnits() * unitWidth);
    const visibleEvents = new Set(this.filteredEvents().map(event => event.id));
    this.root.querySelector('#timelineUndo').disabled = !this.undoStack.length;
    this.root.querySelector('#timelineRedo').disabled = !this.redoStack.length;
    this.root.querySelector('#timelineZoomLabel').textContent = `${Math.round(this.zoom * 100)}%`;
    this.root.querySelector('#timelineCursorLabel').textContent = `位置 ${this.cursor}`;
    this.root.querySelector('#timelineSearch').value = this.query;
    this.stage.innerHTML = '';

    const scroll = element('div', 'timeline-scroll timeline-daw-scroll');
    const board = element('div', 'timeline-daw-board');
    board.style.setProperty('--timeline-width', `${totalWidth}px`);
    board.style.setProperty('--timeline-unit', `${unitWidth}px`);
    board.style.setProperty('--timeline-major', `${unitWidth * 4}px`);
    board.append(this.makeAxis(totalWidth, unitWidth));

    const groups = [...this.data.trackGroups].sort((a, b) => a.order - b.order);
    const ungrouped = this.data.tracks.filter(track => !groups.some(group => group.id === track.groupId));
    for (const track of ungrouped) board.append(this.makeTrackRow(track, visibleEvents, totalWidth, unitWidth));
    for (const group of groups) {
      board.append(this.makeGroupRow(group, totalWidth));
      if (group.collapsed) continue;
      const tracks = this.data.tracks.filter(track => track.groupId === group.id);
      for (const track of tracks) board.append(this.makeTrackRow(track, visibleEvents, totalWidth, unitWidth, true));
    }

    scroll.append(board);
    this.stage.append(scroll);
    scroll.scrollLeft = scrollLeft;
    scroll.scrollTop = scrollTop;
    this.renderSelection();
    this.focusPending();
  }

  makeAxis(totalWidth, unitWidth) {
    const row = element('div', 'timeline-daw-axis');
    const corner = element('div', 'timeline-daw-corner');
    corner.append(element('strong', '', '軌道'), element('small', '', '點時間尺移動位置'));
    const ruler = element('div', 'timeline-daw-ruler');
    ruler.style.width = `${totalWidth}px`;
    ruler.onclick = event => {
      const rect = ruler.getBoundingClientRect();
      this.setCursor((event.clientX - rect.left) / unitWidth);
    };
    const units = this.timelineUnits();
    for (let unit = 0; unit <= units; unit += 1) {
      const tick = element('span', `timeline-ruler-tick${unit % 4 === 0 ? ' major' : ''}`);
      tick.style.left = `${unit * unitWidth}px`;
      if (unit % 4 === 0) tick.textContent = String(unit);
      ruler.append(tick);
    }
    const playhead = element('span', 'timeline-playhead');
    playhead.style.left = `${this.cursor * unitWidth}px`;
    ruler.append(playhead);
    row.append(corner, ruler);
    return row;
  }

  makeGroupRow(group, totalWidth) {
    const row = element('div', 'timeline-track-folder-row');
    const label = element('div', 'timeline-track-folder-label');
    const collapse = button(group.collapsed ? '›' : '⌄', group.collapsed ? '展開資料夾' : '收合資料夾');
    collapse.className = 'icon-btn';
    collapse.onclick = () => this.transact('收合軌道資料夾', data => {
      const target = data.trackGroups.find(item => item.id === group.id);
      if (target) target.collapsed = !target.collapsed;
    });
    const name = input(group.name);
    name.className = 'timeline-folder-name';
    name.dataset.groupName = group.id;
    this.bindDraft(name, value => { group.name = value; }, { fallback: '未命名資料夾' });
    const count = element('small', '', `${this.data.tracks.filter(track => track.groupId === group.id).length}`);
    const remove = button('×', '移除資料夾但保留軌道');
    remove.className = 'icon-btn';
    remove.onclick = () => this.removeTrackGroup(group.id);
    label.append(collapse, element('span', 'timeline-folder-icon', '▰'), name, count, remove);
    const stage = element('div', 'timeline-track-folder-stage');
    stage.style.width = `${totalWidth}px`;
    row.ondragover = event => {
      if (event.dataTransfer.types.includes('text/mysyncnote-timeline-track')) event.preventDefault();
    };
    row.ondrop = event => {
      const trackId = event.dataTransfer.getData('text/mysyncnote-timeline-track');
      if (!trackId) return;
      event.preventDefault();
      this.transact('移入軌道資料夾', data => {
        const track = data.tracks.find(item => item.id === trackId);
        if (track) track.groupId = group.id;
      });
    };
    row.append(label, stage);
    return row;
  }

  makeTrackRow(track, visibleEvents, totalWidth, unitWidth, nested = false) {
    const row = element('div', `timeline-daw-track${nested ? ' nested' : ''}${track.id === this.selectedTrackId ? ' selected' : ''}`);
    row.dataset.trackId = track.id;
    const label = element('div', 'timeline-daw-track-label');
    label.onclick = () => {
      this.selectedTrackId = track.id;
      this.persistView();
      this.stage.querySelectorAll('.timeline-daw-track').forEach(item => item.classList.toggle('selected', item.dataset.trackId === track.id));
    };
    label.draggable = true;
    label.ondragstart = event => {
      if (event.target.matches('input,select,button')) return event.preventDefault();
      event.dataTransfer.setData('text/mysyncnote-timeline-track', track.id);
      event.dataTransfer.effectAllowed = 'move';
    };
    const head = element('div', 'timeline-track-head');
    const color = input(track.color, 'color');
    color.title = '軌道顏色';
    color.onchange = () => this.transact('修改軌道顏色', data => {
      const target = data.tracks.find(item => item.id === track.id);
      if (target) target.color = color.value;
    });
    stopControlEvents(color);
    const name = input(track.name);
    name.className = 'timeline-track-name';
    this.bindDraft(name, value => { track.name = value; }, { fallback: '未命名軌道' });
    const count = element('small', '', String(this.data.events.filter(event => event.trackIds[0] === track.id).length));
    const remove = button('×', '刪除軌道');
    remove.className = 'icon-btn';
    remove.disabled = this.data.tracks.length === 1;
    remove.onclick = event => {
      event.stopPropagation();
      this.removeTrack(track.id);
    };
    head.append(color, name, count, remove);
    const folder = element('select', 'timeline-track-folder-select');
    folder.append(new Option('不放資料夾', ''));
    for (const group of this.data.trackGroups) folder.append(new Option(`▾ ${group.name}`, group.id));
    folder.value = track.groupId || '';
    folder.title = '移到軌道資料夾';
    folder.onchange = () => this.transact('移動軌道資料夾', data => {
      const target = data.tracks.find(item => item.id === track.id);
      if (target) target.groupId = folder.value || null;
    });
    stopControlEvents(folder);
    label.append(head, folder);

    const lane = element('div', 'timeline-daw-lane');
    lane.style.width = `${totalWidth}px`;
    lane.style.setProperty('--track-color', track.color);
    lane.onclick = event => {
      if (event.target !== lane) return;
      this.selectedTrackId = track.id;
      const rect = lane.getBoundingClientRect();
      this.setCursor((event.clientX - rect.left) / unitWidth);
      this.renderSelection();
    };
    lane.ondblclick = event => {
      if (event.target !== lane) return;
      const rect = lane.getBoundingClientRect();
      this.addEvent({ trackId: track.id, position: (event.clientX - rect.left) / unitWidth });
    };
    lane.ondragover = event => {
      if (event.dataTransfer.types.includes('text/mysyncnote-timeline-event')) {
        event.preventDefault();
        lane.classList.add('drop-target');
      }
    };
    lane.ondragleave = () => lane.classList.remove('drop-target');
    lane.ondrop = event => {
      const eventId = event.dataTransfer.getData('text/mysyncnote-timeline-event');
      if (!eventId) return;
      event.preventDefault();
      lane.classList.remove('drop-target');
      const rect = lane.getBoundingClientRect();
      this.moveEvent(eventId, track.id, (event.clientX - rect.left) / unitWidth);
    };
    const playhead = element('span', 'timeline-playhead');
    playhead.style.left = `${this.cursor * unitWidth}px`;
    lane.append(playhead);
    const events = this.data.events
      .filter(event => event.trackIds[0] === track.id && visibleEvents.has(event.id))
      .sort((a, b) => eventPosition(a) - eventPosition(b));
    for (const event of events) lane.append(this.makeEventCard(event, unitWidth));
    if (!events.length) lane.append(element('span', 'timeline-lane-empty', this.query ? '此軌道沒有符合搜尋的事件' : '雙擊空白處新增事件'));
    row.append(label, lane);
    return row;
  }

  makeEventCard(event, unitWidth) {
    const track = this.data.tracks.find(item => item.id === event.trackIds[0]);
    const card = element('article', `timeline-daw-event${event.id === this.selectedEventId ? ' selected' : ''}`);
    card.dataset.eventId = event.id;
    card.style.left = `${eventPosition(event) * unitWidth}px`;
    card.style.width = `${eventDuration(event) * unitWidth}px`;
    card.style.setProperty('--track-color', track?.color || COLORS[0]);
    card.onclick = () => {
      this.selectedEventId = event.id;
      this.selectedTrackId = event.trackIds[0];
      this.persistView();
      this.renderSelection();
    };
    card.ondragover = dragEvent => {
      if (dragEvent.dataTransfer.types.includes('text/mysyncnote-path')) {
        dragEvent.preventDefault();
        card.classList.add('note-drop-target');
      }
    };
    card.ondragleave = () => card.classList.remove('note-drop-target');
    card.ondrop = dragEvent => {
      const path = dragEvent.dataTransfer.getData('text/mysyncnote-path');
      if (!path) return;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      card.classList.remove('note-drop-target');
      this.attachNote(event.id, path);
    };

    const header = element('div', 'timeline-clip-header');
    const grip = element('span', 'timeline-clip-grip', '⠿');
    grip.title = '拖曳事件';
    grip.draggable = true;
    grip.ondragstart = dragEvent => {
      dragEvent.stopPropagation();
      dragEvent.dataTransfer.setData('text/mysyncnote-timeline-event', event.id);
      dragEvent.dataTransfer.effectAllowed = 'move';
    };
    const title = input(event.title);
    title.className = 'timeline-clip-title';
    title.dataset.eventTitle = event.id;
    this.bindDraft(title, value => { event.title = value; }, { fallback: '未命名事件', selectOnFocus: this.pendingFocus?.kind === 'event' && this.pendingFocus.id === event.id });
    const remove = button('×', '刪除事件');
    remove.className = 'timeline-clip-delete';
    remove.onclick = clickEvent => {
      clickEvent.stopPropagation();
      this.deleteEvent(event.id);
    };
    header.append(grip, title, remove);

    const description = element('textarea', 'timeline-clip-description');
    description.value = event.description;
    description.placeholder = '直接寫事件內容…';
    description.rows = 2;
    this.bindDraft(description, value => { event.description = value; });

    const footer = element('div', 'timeline-clip-footer');
    const positionLabel = element('label', '', '起');
    const position = input(eventPosition(event), 'number');
    position.min = '0';
    position.step = '.25';
    position.title = '開始位置';
    position.onchange = () => this.transact('修改事件位置', data => {
      const target = data.events.find(item => item.id === event.id);
      if (!target) return;
      target.time.position = snap(position.value);
      syncClipTime(target);
    });
    stopControlEvents(position);
    positionLabel.append(position);
    const durationLabel = element('label', '', '長');
    const duration = input(eventDuration(event), 'number');
    duration.min = String(MIN_DURATION);
    duration.step = '.25';
    duration.title = '事件長度';
    duration.onchange = () => this.transact('修改事件長度', data => {
      const target = data.events.find(item => item.id === event.id);
      if (!target) return;
      target.time.duration = Math.max(MIN_DURATION, snap(duration.value));
      syncClipTime(target);
    });
    stopControlEvents(duration);
    durationLabel.append(duration);
    const trackSelect = element('select', 'timeline-clip-track');
    for (const item of this.data.tracks) trackSelect.append(new Option(item.name, item.id));
    trackSelect.value = event.trackIds[0];
    trackSelect.title = '移到其他軌道';
    trackSelect.onchange = () => this.moveEvent(event.id, trackSelect.value, eventPosition(event));
    stopControlEvents(trackSelect);
    footer.append(positionLabel, durationLabel, trackSelect);
    if (event.notePaths.length) {
      const note = button(`▤ ${event.notePaths.length}`, '開啟連結筆記');
      note.className = 'timeline-clip-note';
      note.onclick = clickEvent => {
        clickEvent.stopPropagation();
        this.onOpenNote(event.notePaths[0], { beside: true });
      };
      footer.append(note);
    }

    const resize = element('span', 'timeline-clip-resize');
    resize.title = '拖曳調整事件長度';
    resize.onpointerdown = pointerEvent => this.startResize(pointerEvent, event, card, duration, unitWidth);
    card.append(header, description, footer, resize);
    return card;
  }

  startResize(pointerEvent, event, card, durationInput, unitWidth) {
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    const before = this.snapshot();
    const startX = pointerEvent.clientX;
    const startDuration = eventDuration(event);
    const pointerId = pointerEvent.pointerId;
    const handle = pointerEvent.currentTarget;
    handle.setPointerCapture?.(pointerId);
    card.classList.add('resizing');
    const move = moveEvent => {
      const duration = Math.max(MIN_DURATION, snap(startDuration + (moveEvent.clientX - startX) / unitWidth));
      event.time.duration = duration;
      syncClipTime(event);
      card.style.width = `${duration * unitWidth}px`;
      durationInput.value = duration;
      this.onChange();
    };
    const finish = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      card.classList.remove('resizing');
      this.data = normalizeTimeline(this.data, this.data.title);
      this.pushHistory(before);
      this.render();
      this.onChange();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  renderSelection() {
    for (const card of this.stage.querySelectorAll('.timeline-daw-event')) {
      card.classList.toggle('selected', card.dataset.eventId === this.selectedEventId);
    }
    for (const row of this.stage.querySelectorAll('.timeline-daw-track')) {
      row.classList.toggle('selected', row.dataset.trackId === this.selectedTrackId);
    }
  }

  focusPending() {
    const focus = this.pendingFocus;
    this.pendingFocus = null;
    if (!focus) return;
    requestAnimationFrame(() => {
      const selector = focus.kind === 'event'
        ? `.timeline-clip-title[data-event-title="${CSS.escape(focus.id)}"]`
        : focus.kind === 'track'
          ? `.timeline-daw-track[data-track-id="${CSS.escape(focus.id)}"] .timeline-track-name`
          : `.timeline-track-folder-row [data-group-name="${CSS.escape(focus.id)}"]`;
      const control = this.stage.querySelector(selector);
      control?.focus();
      control?.select?.();
    });
  }
}
