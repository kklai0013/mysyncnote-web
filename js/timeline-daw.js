import { createEmptyTimeline, normalizeTimeline, validateTimeline } from './timeline.js?v=24';
import { LiveMarkdownEditor } from './live-editor.js';

const COLORS = ['#78dba0', '#7fb5ff', '#d99cff', '#f4b86a', '#ff8d8d', '#69d4d0', '#c7d36f'];
const MIN_DURATION = 1;
const DEFAULT_DURATION = 4;
const DEFAULT_TRACK_HEIGHT = 144;
const BASE_UNIT_WIDTH = 56;
const EVENT_MIME = 'text/mysyncnote-timeline-event';
const TRACK_MIME = 'text/mysyncnote-timeline-track';
const GROUP_MIME = 'text/mysyncnote-timeline-group';

function id(prefix) {
  return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function snapMeasure(value) {
  return Math.max(0, Math.round(finite(value)));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function isAdditive(event) {
  return Boolean(event.shiftKey || event.ctrlKey || event.metaKey);
}

function isLockedTextControl(target) {
  const control = target.closest?.('[data-double-click-edit]');
  return Boolean(control && (control.readOnly || control.contentEditable === 'false'));
}

function intersects(a, b) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function eventPosition(event) {
  return snapMeasure(event?.time?.position);
}

function eventDuration(event) {
  return Math.max(MIN_DURATION, snapMeasure(event?.time?.duration || DEFAULT_DURATION));
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

/**
 * Moves a selected block while preserving the events' relative measure and
 * relative track offsets. Exported so the behaviour can be regression-tested.
 */
export function moveTimelineEventsModel(data, eventIds, anchorId, targetTrackId, targetPosition, trackOrder) {
  const ids = new Set(eventIds);
  const events = data.events.filter(event => ids.has(event.id));
  const anchor = events.find(event => event.id === anchorId);
  if (!anchor || !trackOrder.includes(targetTrackId)) return false;
  const anchorTrackIndex = trackOrder.indexOf(anchor.trackIds[0]);
  const targetTrackIndex = trackOrder.indexOf(targetTrackId);
  const trackDelta = targetTrackIndex - anchorTrackIndex;
  let positionDelta = snapMeasure(targetPosition) - eventPosition(anchor);
  const minimumPosition = Math.min(...events.map(event => eventPosition(event) + positionDelta));
  if (minimumPosition < 0) positionDelta -= minimumPosition;
  for (const event of events) {
    const oldTrackIndex = Math.max(0, trackOrder.indexOf(event.trackIds[0]));
    const newTrackIndex = clamp(oldTrackIndex + trackDelta, 0, trackOrder.length - 1);
    event.trackIds = [trackOrder[newTrackIndex]];
    event.time.position = snapMeasure(eventPosition(event) + positionDelta);
    syncClipTime(event);
  }
  return true;
}

function timelineContainerItems(data, parentId) {
  const normalizedParent = parentId || null;
  return [
    ...data.trackGroups
      .filter(group => (group.parentId || null) === normalizedParent)
      .map(group => ({ kind: 'group', id: group.id, order: finite(group.order) })),
    ...data.tracks
      .filter(track => (track.groupId || null) === normalizedParent)
      .map(track => ({ kind: 'track', id: track.id, order: finite(track.order) }))
  ].sort((a, b) => a.order - b.order || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

function timelineGroupContains(data, ancestorId, candidateId) {
  let currentId = candidateId || null;
  const seen = new Set();
  while (currentId && !seen.has(currentId)) {
    if (currentId === ancestorId) return true;
    seen.add(currentId);
    currentId = data.trackGroups.find(group => group.id === currentId)?.parentId || null;
  }
  return false;
}

/**
 * Reorders tracks and folders in one shared list. `inside` is only valid for
 * a folder target; `before` and `after` use the target item's parent.
 */
export function reorderTimelineItemsModel(data, moving, targetKind, targetId, position) {
  const target = targetKind === 'group'
    ? data.trackGroups.find(group => group.id === targetId)
    : data.tracks.find(track => track.id === targetId);
  if (!target) return false;
  const movingTrackIds = new Set(moving.trackIds || []);
  const movingGroup = moving.groupId ? data.trackGroups.find(group => group.id === moving.groupId) : null;
  if (!movingTrackIds.size && !movingGroup) return false;
  if (targetKind === 'track' && movingTrackIds.has(targetId)) return false;
  if (movingGroup?.id === targetId) return false;
  const parentId = position === 'inside' && targetKind === 'group'
    ? target.id
    : targetKind === 'group'
      ? target.parentId || null
      : target.groupId || null;
  if (movingGroup && timelineGroupContains(data, movingGroup.id, parentId)) return false;

  const orderedMovingTracks = data.tracks
    .filter(track => movingTrackIds.has(track.id))
    .sort((a, b) => finite(a.order) - finite(b.order));
  for (const track of orderedMovingTracks) track.groupId = parentId;
  if (movingGroup) movingGroup.parentId = parentId;

  const movingKeys = new Set([
    ...orderedMovingTracks.map(track => `track:${track.id}`),
    ...(movingGroup ? [`group:${movingGroup.id}`] : [])
  ]);
  const container = timelineContainerItems(data, parentId).filter(item => !movingKeys.has(`${item.kind}:${item.id}`));
  const movingItems = [
    ...(movingGroup ? [{ kind: 'group', id: movingGroup.id, order: finite(movingGroup.order) }] : []),
    ...orderedMovingTracks.map(track => ({ kind: 'track', id: track.id, order: finite(track.order) }))
  ].sort((a, b) => a.order - b.order || a.kind.localeCompare(b.kind));
  let index = container.length;
  if (position !== 'inside') {
    const targetIndex = container.findIndex(item => item.kind === targetKind && item.id === targetId);
    if (targetIndex < 0) return false;
    index = targetIndex + (position === 'after' ? 1 : 0);
  }
  container.splice(index, 0, ...movingItems);
  container.forEach((item, itemIndex) => {
    const source = item.kind === 'group'
      ? data.trackGroups.find(group => group.id === item.id)
      : data.tracks.find(track => track.id === item.id);
    if (source) source.order = itemIndex * 1000;
  });
  return true;
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
    this.selectedGroupId = '';
    this.selectedEventIds = new Set();
    this.selectedTrackIds = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.pendingFocus = null;
    this.dragPayload = null;
    this.suppressLaneClick = false;
    this.bind();
  }

  bind() {
    this.root.querySelector('#timelineAddEvent').onclick = () => this.addEvent();
    this.root.querySelector('#timelineAddTrack').onclick = () => this.addTrack();
    this.root.querySelector('#timelineAddGroup').onclick = () => this.addTrackGroup();
    this.root.querySelector('#timelineCompactTracks').onclick = () => this.compactTrackHeights();
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
      } else if (!typing && event.key === 'Delete' && this.selectedEventIds.size) {
        event.preventDefault();
        event.stopPropagation();
        this.deleteEvents([...this.selectedEventIds]);
      } else if (!typing && event.key === 'Escape') {
        this.clearSelection();
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
    this.selectedGroupId = '';
    this.selectedEventIds.clear();
    this.selectedTrackIds.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.restoreView();
    this.selectedTrackId = this.data.tracks.some(track => track.id === this.selectedTrackId)
      ? this.selectedTrackId
      : this.data.tracks[0]?.id || '';
    if (this.selectedTrackId) this.selectedTrackIds.add(this.selectedTrackId);
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
    return { zoom: this.zoom, cursor: this.cursor, query: this.query, selectedTrackId: this.selectedTrackId };
  }

  restoreView() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(`mysyncnote-timeline-daw:${this.key}`) || 'null');
    } catch {}
    this.zoom = clamp(finite(saved?.zoom, 1), .45, 2.4);
    this.cursor = snapMeasure(saved?.cursor);
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
    this.reconcileSelection();
    this.render();
    this.onChange();
    return true;
  }

  reconcileSelection() {
    const eventIds = new Set(this.data.events.map(event => event.id));
    const trackIds = new Set(this.data.tracks.map(track => track.id));
    const groupIds = new Set(this.data.trackGroups.map(group => group.id));
    this.selectedEventIds = new Set([...this.selectedEventIds].filter(eventId => eventIds.has(eventId)));
    this.selectedTrackIds = new Set([...this.selectedTrackIds].filter(trackId => trackIds.has(trackId)));
    if (!eventIds.has(this.selectedEventId)) this.selectedEventId = '';
    if (!trackIds.has(this.selectedTrackId)) this.selectedTrackId = this.data.tracks[0]?.id || '';
    if (!groupIds.has(this.selectedGroupId)) this.selectedGroupId = '';
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.json());
    this.data = normalizeTimeline(JSON.parse(previous), this.data.title);
    this.reconcileSelection();
    this.render();
    this.onChange();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.json());
    this.data = normalizeTimeline(JSON.parse(next), this.data.title);
    this.reconcileSelection();
    this.render();
    this.onChange();
  }

  setZoom(value) {
    this.zoom = clamp(finite(value, 1), .45, 2.4);
    this.persistView();
    this.render();
  }

  compactTrackHeights() {
    this.transact('全部軌道收至最小高度', data => {
      for (const track of data.tracks) {
        track.height = 84;
        delete track.heightBeforeExpand;
      }
      for (const event of data.events) event.expanded = false;
    });
  }

  selectionLabel() {
    if (this.selectedEventIds.size || this.selectedTrackIds.size) {
      const parts = [];
      if (this.selectedEventIds.size) parts.push(`${this.selectedEventIds.size} 個事件`);
      if (this.selectedTrackIds.size) parts.push(`${this.selectedTrackIds.size} 條軌道`);
      return parts.join(' · ');
    }
    return `第 ${this.cursor + 1} 小節`;
  }

  setCursor(value) {
    this.cursor = snapMeasure(value);
    this.persistView();
    this.root.querySelector('#timelineCursorLabel').textContent = this.selectionLabel();
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

  displayedTracks() {
    const result = [];
    const appendContainer = parentId => {
      for (const item of timelineContainerItems(this.data, parentId)) {
        if (item.kind === 'track') {
          const track = this.data.tracks.find(candidate => candidate.id === item.id);
          if (track) result.push(track);
        } else {
          appendContainer(item.id);
        }
      }
    };
    appendContainer(null);
    return result;
  }

  descendantGroupIds(groupId) {
    const descendants = new Set();
    const visit = parentId => {
      for (const group of this.data.trackGroups.filter(item => item.parentId === parentId)) {
        if (descendants.has(group.id)) continue;
        descendants.add(group.id);
        visit(group.id);
      }
    };
    visit(groupId);
    return descendants;
  }

  groupTrackIds(groupId) {
    const groupIds = this.descendantGroupIds(groupId);
    groupIds.add(groupId);
    return this.data.tracks.filter(track => groupIds.has(track.groupId)).map(track => track.id);
  }

  startGroupDrag(dragEvent, group) {
    this.selectedGroupId = group.id;
    const payload = { groupId: group.id };
    this.dragPayload = payload;
    dragEvent.dataTransfer.setData(GROUP_MIME, JSON.stringify(payload));
    dragEvent.dataTransfer.effectAllowed = 'move';
    this.renderSelection();
  }

  moveGroupInto(groupId, parentId) {
    if (!groupId || groupId === parentId || this.descendantGroupIds(groupId).has(parentId)) return;
    this.selectedGroupId = groupId;
    this.transact('移動軌道資料夾', data => {
      const group = data.trackGroups.find(item => item.id === groupId);
      const parent = data.trackGroups.find(item => item.id === parentId);
      if (!group || !parent) return;
      group.parentId = parent.id;
      parent.collapsed = false;
    });
  }

  selectEvent(eventId, additive = false) {
    const target = this.data.events.find(event => event.id === eventId);
    if (!target) return;
    if (!additive) {
      this.selectedEventIds.clear();
      this.selectedGroupId = '';
    }
    if (additive && this.selectedEventIds.has(eventId)) this.selectedEventIds.delete(eventId);
    else this.selectedEventIds.add(eventId);
    this.selectedEventId = this.selectedEventIds.has(eventId) ? eventId : [...this.selectedEventIds].at(-1) || '';
    this.selectedTrackId = target.trackIds[0];
    this.persistView();
    this.renderSelection();
  }

  selectTrack(trackId, additive = false) {
    if (!this.data.tracks.some(track => track.id === trackId)) return;
    if (!additive) {
      this.selectedTrackIds.clear();
      this.selectedGroupId = '';
    }
    if (additive && this.selectedTrackIds.has(trackId)) this.selectedTrackIds.delete(trackId);
    else this.selectedTrackIds.add(trackId);
    this.selectedTrackId = this.selectedTrackIds.has(trackId) ? trackId : [...this.selectedTrackIds].at(-1) || trackId;
    this.persistView();
    this.renderSelection();
  }

  clearSelection() {
    this.selectedEventIds.clear();
    this.selectedTrackIds.clear();
    this.selectedEventId = '';
    this.selectedGroupId = '';
    this.renderSelection();
  }

  addEvent(seed = {}) {
    const trackId = this.data.tracks.some(track => track.id === seed.trackId) ? seed.trackId : this.selectedTrack()?.id;
    if (!trackId) return;
    const eventId = id('event');
    const position = snapMeasure(seed.position ?? this.cursor);
    const duration = Math.max(MIN_DURATION, snapMeasure(seed.duration ?? DEFAULT_DURATION));
    this.selectedEventId = eventId;
    this.selectedEventIds = new Set([eventId]);
    this.selectedTrackId = trackId;
    this.transact('新增事件', data => {
      const targetTrack = data.tracks.find(track => track.id === trackId);
      const targetGroup = data.trackGroups.find(group => group.id === targetTrack?.groupId);
      if (targetGroup) targetGroup.collapsed = false;
      data.events.push({
        id: eventId,
        title: seed.title || '未命名事件',
        description: seed.description || '',
        expanded: false,
        time: {
          kind: 'exact', start: String(position), end: String(position + duration), precision: 'exact',
          momentId: '', anchorId: '', offset: 0, unit: 'day', position, duration
        },
        trackIds: [trackId], branchId: 'main', variantGroupId: null, variantLabel: '',
        notePaths: [], tags: [], status: 'idea', dependsOn: [], order: nextOrder(data.events)
      });
    }, { kind: 'event', id: eventId });
    this.setCursor(position + duration);
  }

  addTrack() {
    const trackId = id('track');
    const currentGroup = this.selectedTrack()?.groupId || null;
    this.selectedTrackId = trackId;
    this.selectedTrackIds = new Set([trackId]);
    this.transact('新增軌道', data => {
      const targetGroup = data.trackGroups.find(group => group.id === currentGroup);
      if (targetGroup) targetGroup.collapsed = false;
      data.tracks.push({
        id: trackId,
        name: `軌道 ${data.tracks.length + 1}`,
        color: COLORS[data.tracks.length % COLORS.length],
        groupId: currentGroup,
        height: DEFAULT_TRACK_HEIGHT,
        order: nextOrder(timelineContainerItems(data, currentGroup))
      });
    }, { kind: 'track', id: trackId });
  }

  addTrackGroup(options = {}) {
    const groupId = id('track-group');
    const selectedIds = this.selectedTrackIds.size
      ? new Set(this.selectedTrackIds)
      : new Set(this.selectedTrack()?.id ? [this.selectedTrack().id] : []);
    const selectedParents = new Set(
      this.data.tracks.filter(track => selectedIds.has(track.id)).map(track => track.groupId || null)
    );
    const parentId = options.parentId !== undefined
      ? options.parentId
      : this.selectedGroupId || (selectedParents.size === 1 ? [...selectedParents][0] : null);
    const moveSelected = options.moveSelected !== false;
    this.selectedGroupId = groupId;
    this.transact('新增軌道資料夾', data => {
      data.trackGroups.push({
        id: groupId,
        name: `資料夾 ${data.trackGroups.length + 1}`,
        color: COLORS[data.trackGroups.length % COLORS.length],
        parentId: data.trackGroups.some(group => group.id === parentId) ? parentId : null,
        collapsed: false,
        order: nextOrder(timelineContainerItems(data, parentId))
      });
      if (moveSelected) {
        for (const track of data.tracks) if (selectedIds.has(track.id)) track.groupId = groupId;
      }
    }, { kind: 'group', id: groupId });
  }

  deleteEvents(ids) {
    const deleted = new Set(ids);
    if (!deleted.size) return;
    this.transact('刪除事件', data => {
      data.events = data.events.filter(event => !deleted.has(event.id));
      data.narrativeItems = data.narrativeItems.filter(item => !deleted.has(item.eventId));
      data.relations = data.relations.filter(item => !deleted.has(item.fromEventId) && !deleted.has(item.toEventId));
      for (const event of data.events) {
        event.dependsOn = event.dependsOn.filter(eventId => !deleted.has(eventId));
        if (deleted.has(event.time.anchorId)) event.time.anchorId = '';
      }
      for (const branch of data.branches) if (deleted.has(branch.fromEventId)) branch.fromEventId = null;
      for (const group of data.variantGroups) {
        group.eventIds = group.eventIds.filter(eventId => !deleted.has(eventId));
        if (deleted.has(group.activeEventId)) group.activeEventId = group.eventIds[0] || '';
      }
      data.variantGroups = data.variantGroups.filter(group => group.eventIds.length > 1);
    });
    this.selectedEventIds.clear();
    this.selectedEventId = '';
    this.renderSelection();
    this.notify(`${deleted.size} 個事件已刪除，可按 Ctrl+Z 復原`);
  }

  deleteEvent(eventId) {
    this.deleteEvents([eventId]);
  }

  removeTrack(trackId) {
    const track = this.data.tracks.find(item => item.id === trackId);
    if (!track || this.data.tracks.length === 1) return;
    if (!confirm(`刪除軌道「${track.name}」？\n軌道裡的事件會移到第一條軌道。`)) return;
    this.transact('刪除軌道', data => {
      data.tracks = data.tracks.filter(item => item.id !== trackId);
      const fallbackId = data.tracks[0].id;
      for (const event of data.events) if (event.trackIds[0] === trackId) event.trackIds = [fallbackId];
    });
    this.selectedTrackIds.delete(trackId);
    this.selectedTrackId = this.data.tracks[0]?.id || '';
    this.persistView();
    this.renderSelection();
  }

  removeTrackGroup(groupId) {
    const group = this.data.trackGroups.find(item => item.id === groupId);
    if (!group) return;
    this.transact('移除軌道資料夾', data => {
      data.trackGroups = data.trackGroups.filter(item => item.id !== groupId);
      for (const track of data.tracks) if (track.groupId === groupId) track.groupId = group.parentId || null;
      for (const child of data.trackGroups) if (child.parentId === groupId) child.parentId = group.parentId || null;
    });
    if (this.selectedGroupId === groupId) this.selectedGroupId = group.parentId || '';
  }

  moveEvents(payload, trackId, position) {
    const ids = payload.eventIds?.length ? payload.eventIds : [payload.anchorId];
    this.selectedEventIds = new Set(ids);
    this.selectedEventId = payload.anchorId;
    this.transact('移動事件', data => {
      moveTimelineEventsModel(data, ids, payload.anchorId, trackId, position, this.displayedTracks().map(track => track.id));
    });
    const anchor = this.data.events.find(event => event.id === payload.anchorId);
    if (anchor) {
      this.selectedTrackId = anchor.trackIds[0];
      this.setCursor(eventPosition(anchor));
    }
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
      this.pushHistory(before);
      before = '';
      if (options.renderOnBlur) this.render();
      if (options.doubleClickEdit) {
        control.readOnly = true;
        control.classList.remove('editing');
        if (options.onLockedDrag) control.draggable = true;
      }
    });
    if (control.tagName === 'INPUT' && control.type === 'text') {
      control.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          control.blur();
        }
      });
    }
    if (options.doubleClickEdit) {
      control.readOnly = true;
      control.dataset.doubleClickEdit = '';
      control.title = options.editTitle || '雙擊編輯';
      if (options.onLockedDrag) control.draggable = true;
      control.addEventListener('click', event => {
        if (control.readOnly) return;
        event.stopPropagation();
      });
      control.addEventListener('pointerdown', event => {
        if (!control.readOnly) event.stopPropagation();
      });
      control.addEventListener('dblclick', event => {
        event.preventDefault();
        event.stopPropagation();
        control.readOnly = false;
        if (options.onLockedDrag) control.draggable = false;
        control.classList.add('editing');
        control.focus();
        if (options.selectOnEdit) control.select?.();
      });
      control.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          control.blur();
        }
      });
      control.addEventListener('dragstart', event => {
        event.stopPropagation();
        if (!control.readOnly || !options.onLockedDrag) {
          event.preventDefault();
          return;
        }
        options.onLockedDrag(event);
      });
    } else {
      stopControlEvents(control);
    }
  }

  filteredEvents() {
    const query = this.query.trim().normalize('NFKC').toLocaleLowerCase('zh-Hant');
    if (!query) return this.data.events;
    return this.data.events.filter(event => [
      event.title, event.description, ...(event.notePaths || []), ...(event.tags || [])
    ].join(' ').normalize('NFKC').toLocaleLowerCase('zh-Hant').includes(query));
  }

  timelineUnits() {
    const end = Math.max(24, this.cursor + 8, ...this.data.events.map(event => eventPosition(event) + eventDuration(event) + 4));
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
    this.root.querySelector('#timelineCursorLabel').textContent = this.selectionLabel();
    this.root.querySelector('#timelineSearch').value = this.query;
    this.stage.innerHTML = '';

    const scroll = element('div', 'timeline-scroll timeline-daw-scroll');
    const board = element('div', 'timeline-daw-board');
    board.style.setProperty('--timeline-width', `${totalWidth}px`);
    board.style.setProperty('--timeline-unit', `${unitWidth}px`);
    board.style.setProperty('--timeline-major', `${unitWidth * 4}px`);
    board.append(this.makeAxis(totalWidth, unitWidth));

    const appendContainer = (parentId, depth) => {
      for (const item of timelineContainerItems(this.data, parentId)) {
        if (item.kind === 'track') {
          const track = this.data.tracks.find(candidate => candidate.id === item.id);
          if (track) board.append(this.makeTrackRow(track, visibleEvents, totalWidth, unitWidth, depth));
          continue;
        }
        const group = this.data.trackGroups.find(candidate => candidate.id === item.id);
        if (!group) continue;
        board.append(this.makeGroupRow(group, totalWidth, depth));
        if (!group.collapsed) appendContainer(group.id, depth + 1);
      }
    };
    appendContainer(null, 0);

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
    corner.append(element('strong', '', '軌道'), element('small', '', 'Shift 多選 · 拖曳框選'));
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
      tick.textContent = String(unit + 1);
      ruler.append(tick);
    }
    const playhead = element('span', 'timeline-playhead');
    playhead.style.left = `${this.cursor * unitWidth}px`;
    ruler.append(playhead);
    row.append(corner, ruler);
    return row;
  }

  itemDropZone(row, dragEvent, allowInside) {
    const rect = row.getBoundingClientRect();
    const ratio = clamp((dragEvent.clientY - rect.top) / Math.max(1, rect.height), 0, 1);
    if (allowInside && ratio >= .25 && ratio <= .75) return 'inside';
    return ratio < .5 ? 'before' : 'after';
  }

  showItemDropHint(row, zone) {
    this.clearItemDropHints();
    row.classList.add(`drop-${zone}`);
  }

  clearItemDropHints() {
    for (const row of this.stage.querySelectorAll('.drop-before,.drop-after,.drop-inside')) {
      row.classList.remove('drop-before', 'drop-after', 'drop-inside');
    }
  }

  acceptsItemDrop(dragEvent) {
    return dragEvent.dataTransfer.types.includes(TRACK_MIME)
      || dragEvent.dataTransfer.types.includes(GROUP_MIME);
  }

  applyItemDrop(dragEvent, targetKind, targetId, position) {
    const groupPayload = dragEvent.dataTransfer.types.includes(GROUP_MIME)
      ? this.dragPayload || this.readDragPayload(dragEvent, GROUP_MIME)
      : null;
    const trackPayload = dragEvent.dataTransfer.types.includes(TRACK_MIME)
      ? this.dragPayload || this.readDragPayload(dragEvent, TRACK_MIME)
      : null;
    const moving = groupPayload?.groupId
      ? { groupId: groupPayload.groupId }
      : { trackIds: trackPayload?.trackIds?.length ? trackPayload.trackIds : [trackPayload?.anchorId].filter(Boolean) };
    const changed = this.transact('調整軌道順序', data => {
      const reordered = reorderTimelineItemsModel(data, moving, targetKind, targetId, position);
      if (reordered && position === 'inside' && targetKind === 'group') {
        const target = data.trackGroups.find(group => group.id === targetId);
        if (target) target.collapsed = false;
      }
    });
    if (changed && moving.groupId) this.selectedGroupId = moving.groupId;
    this.dragPayload = null;
    this.clearItemDropHints();
  }

  makeGroupRow(group, totalWidth, depth = 0) {
    const directTracks = this.data.tracks.filter(track => track.groupId === group.id);
    const allTrackIds = this.groupTrackIds(group.id);
    const childCount = this.data.trackGroups.filter(item => item.parentId === group.id).length;
    const row = element('div', `timeline-track-folder-row${this.selectedGroupId === group.id ? ' selected' : ''}`);
    row.dataset.groupId = group.id;
    row.classList.toggle('nested', depth > 0);
    row.style.setProperty('--folder-depth', depth);
    row.style.setProperty('--folder-indent', `${9 + depth * 18}px`);
    row.style.setProperty('--group-color', group.color || COLORS[0]);
    const label = element('div', 'timeline-track-folder-label');
    label.onclick = clickEvent => {
      if (clickEvent.target.closest('button') || (clickEvent.target.closest('input') && !isLockedTextControl(clickEvent.target))) return;
      this.selectedGroupId = group.id;
      if (!isAdditive(clickEvent)) this.selectedTrackIds.clear();
      for (const trackId of allTrackIds) this.selectedTrackIds.add(trackId);
      this.selectedTrackId = allTrackIds.at(-1) || this.selectedTrackId;
      this.renderSelection();
    };
    label.draggable = true;
    label.ondragstart = dragEvent => {
      if (dragEvent.target.matches('input,button')) return dragEvent.preventDefault();
      this.startGroupDrag(dragEvent, group);
    };
    label.ondragend = () => {
      this.dragPayload = null;
      this.clearItemDropHints();
    };
    const collapse = button(group.collapsed ? '›' : '⌄', group.collapsed ? '展開資料夾' : '收合資料夾');
    collapse.className = 'timeline-folder-toggle';
    collapse.onclick = () => this.transact('收合軌道資料夾', data => {
      const target = data.trackGroups.find(item => item.id === group.id);
      if (target) target.collapsed = !target.collapsed;
    });
    const badge = element('span', 'timeline-folder-icon');
    const nameWrap = element('div', 'timeline-folder-copy');
    const name = input(group.name);
    name.className = 'timeline-folder-name';
    name.dataset.groupName = group.id;
    this.bindDraft(name, value => { group.name = value; }, {
      fallback: '未命名資料夾',
      doubleClickEdit: true,
      selectOnEdit: true,
      editTitle: '雙擊重新命名資料夾',
      onLockedDrag: dragEvent => this.startGroupDrag(dragEvent, group)
    });
    const summary = [
      allTrackIds.length ? `${allTrackIds.length} 條軌道` : '',
      childCount ? `${childCount} 個子資料夾` : ''
    ].filter(Boolean).join(' · ') || '空資料夾';
    nameWrap.append(name, element('small', '', summary));
    const addChild = button('＋', '在這個資料夾內新增子資料夾');
    addChild.className = 'timeline-folder-add';
    addChild.onclick = clickEvent => {
      clickEvent.stopPropagation();
      this.addTrackGroup({ parentId: group.id, moveSelected: false });
    };
    const remove = button('×', '解除資料夾（保留裡面的軌道）');
    remove.className = 'timeline-folder-remove';
    remove.onclick = clickEvent => {
      clickEvent.stopPropagation();
      this.removeTrackGroup(group.id);
    };
    label.append(collapse, badge, nameWrap, addChild, remove);

    const stage = element('div', 'timeline-track-folder-stage');
    stage.style.width = `${totalWidth}px`;
    stage.append(element('span', '', directTracks.length || childCount
      ? `第 ${depth + 1} 層 · 可放軌道或子資料夾`
      : '把軌道或資料夾拖到這裡'));
    row.ondragover = dragEvent => {
      if (!this.acceptsItemDrop(dragEvent)) return;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      const zone = this.itemDropZone(row, dragEvent, true);
      this.showItemDropHint(row, zone);
    };
    row.ondragleave = dragEvent => {
      if (!row.contains(dragEvent.relatedTarget)) this.clearItemDropHints();
    };
    row.ondrop = dragEvent => {
      if (!this.acceptsItemDrop(dragEvent)) return;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      this.applyItemDrop(dragEvent, 'group', group.id, this.itemDropZone(row, dragEvent, true));
    };
    row.append(label, stage);
    return row;
  }

  makeTrackRow(track, visibleEvents, totalWidth, unitWidth, nestedDepth = 0) {
    const height = clamp(finite(track.height, DEFAULT_TRACK_HEIGHT), 84, 480);
    const row = element('div', `timeline-daw-track${nestedDepth ? ' nested' : ''}${this.selectedTrackIds.has(track.id) ? ' selected' : ''}`);
    row.dataset.trackId = track.id;
    row.style.setProperty('--folder-depth', nestedDepth);
    row.style.setProperty('--track-indent', `${9 + nestedDepth * 18}px`);
    row.style.height = `${height}px`;
    const label = element('div', 'timeline-daw-track-label');
    label.onclick = clickEvent => {
      if (clickEvent.target.closest('button') || (clickEvent.target.closest('input') && !isLockedTextControl(clickEvent.target))) return;
      this.selectTrack(track.id, isAdditive(clickEvent));
    };
    label.draggable = true;
    label.ondragstart = dragEvent => {
      if (dragEvent.target.matches('input,select,button')) return dragEvent.preventDefault();
      this.startTrackDrag(dragEvent, track);
    };
    label.ondragend = () => {
      this.dragPayload = null;
      this.clearItemDropHints();
    };
    row.ondragover = dragEvent => {
      if (!this.acceptsItemDrop(dragEvent)) return;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      this.showItemDropHint(row, this.itemDropZone(row, dragEvent, false));
    };
    row.ondragleave = dragEvent => {
      if (!row.contains(dragEvent.relatedTarget)) this.clearItemDropHints();
    };
    row.ondrop = dragEvent => {
      if (!this.acceptsItemDrop(dragEvent)) return;
      dragEvent.preventDefault();
      dragEvent.stopPropagation();
      this.applyItemDrop(dragEvent, 'track', track.id, this.itemDropZone(row, dragEvent, false));
    };
    const head = element('div', 'timeline-track-head');
    const color = input(track.color, 'color');
    color.title = '軌道顏色';
    color.onchange = () => this.transact('變更軌道顏色', data => {
      const target = data.tracks.find(item => item.id === track.id);
      if (target) target.color = color.value;
    });
    stopControlEvents(color);
    const name = input(track.name);
    name.className = 'timeline-track-name';
    this.bindDraft(name, value => { track.name = value; }, {
      fallback: '未命名軌道',
      selectOnFocus: this.pendingFocus?.kind === 'track' && this.pendingFocus.id === track.id,
      doubleClickEdit: true,
      selectOnEdit: true,
      editTitle: '雙擊重新命名軌道',
      onLockedDrag: dragEvent => this.startTrackDrag(dragEvent, track)
    });
    const count = element('small', '', String(this.data.events.filter(event => event.trackIds[0] === track.id).length));
    const remove = button('×', '刪除軌道');
    remove.className = 'icon-btn';
    remove.disabled = this.data.tracks.length === 1;
    remove.onclick = clickEvent => {
      clickEvent.stopPropagation();
      this.removeTrack(track.id);
    };
    head.append(color, name, count, remove);
    label.append(head);
    if (nestedDepth) {
      const group = this.data.trackGroups.find(item => item.id === track.groupId);
      const folderMeta = element('div', 'timeline-track-folder-meta');
      folderMeta.append(element('span', '', group?.name || '資料夾'));
      const ungroup = button('移出', '移出資料夾');
      ungroup.onclick = clickEvent => {
        clickEvent.stopPropagation();
        this.transact('移出軌道資料夾', data => {
          const target = data.tracks.find(item => item.id === track.id);
          if (target) target.groupId = null;
        });
      };
      folderMeta.append(ungroup);
      label.append(folderMeta);
    }

    const lane = element('div', 'timeline-daw-lane');
    lane.style.width = `${totalWidth}px`;
    lane.style.setProperty('--track-color', track.color);
    lane.onpointerdown = pointerEvent => {
      if (pointerEvent.target === lane && pointerEvent.button === 0) this.startMarquee(pointerEvent, lane);
    };
    lane.onclick = clickEvent => {
      if (clickEvent.target !== lane || this.suppressLaneClick) {
        this.suppressLaneClick = false;
        return;
      }
      this.selectTrack(track.id, isAdditive(clickEvent));
      const rect = lane.getBoundingClientRect();
      this.setCursor((clickEvent.clientX - rect.left) / unitWidth);
    };
    lane.ondblclick = clickEvent => {
      if (clickEvent.target !== lane) return;
      const rect = lane.getBoundingClientRect();
      this.addEvent({ trackId: track.id, position: (clickEvent.clientX - rect.left) / unitWidth });
    };
    lane.ondragover = dragEvent => {
      if (!dragEvent.dataTransfer.types.includes(EVENT_MIME)) return;
      dragEvent.preventDefault();
      dragEvent.dataTransfer.dropEffect = 'move';
      const rect = lane.getBoundingClientRect();
      const position = snapMeasure((dragEvent.clientX - rect.left) / unitWidth);
      this.showDropPreview(this.dragPayload || this.readDragPayload(dragEvent, EVENT_MIME), track.id, position, unitWidth);
    };
    lane.ondrop = dragEvent => {
      if (!dragEvent.dataTransfer.types.includes(EVENT_MIME)) return;
      const payload = this.dragPayload || this.readDragPayload(dragEvent, EVENT_MIME);
      if (!payload) return;
      dragEvent.preventDefault();
      const rect = lane.getBoundingClientRect();
      const position = snapMeasure((dragEvent.clientX - rect.left) / unitWidth);
      this.clearDropPreview();
      this.moveEvents(payload, track.id, position);
      this.dragPayload = null;
    };
    const playhead = element('span', 'timeline-playhead');
    playhead.style.left = `${this.cursor * unitWidth}px`;
    lane.append(playhead);
    const events = this.data.events
      .filter(event => event.trackIds[0] === track.id && visibleEvents.has(event.id))
      .sort((a, b) => eventPosition(a) - eventPosition(b));
    for (const event of events) lane.append(this.makeEventCard(event, track, unitWidth));
    if (!events.length) lane.append(element('span', 'timeline-lane-empty', this.query ? '這條軌道沒有符合搜尋的事件' : '雙擊空白處新增事件'));
    const trackResize = element('span', 'timeline-track-resize');
    trackResize.title = '上下拖曳調整軌道高度';
    trackResize.onpointerdown = pointerEvent => this.startTrackResize(pointerEvent, track, row);
    row.append(label, lane, trackResize);
    return row;
  }

  makeEventCard(event, track, unitWidth) {
    const cardHeight = Math.max(66, finite(track.height, DEFAULT_TRACK_HEIGHT) - 18);
    const card = element('article', `timeline-daw-event${this.selectedEventIds.has(event.id) ? ' selected' : ''}${event.expanded ? ' expanded' : ''}`);
    card.dataset.eventId = event.id;
    card.style.left = `${eventPosition(event) * unitWidth}px`;
    card.style.width = `${eventDuration(event) * unitWidth}px`;
    card.style.height = `${cardHeight}px`;
    card.style.setProperty('--track-color', track?.color || COLORS[0]);
    card.draggable = true;
    card.ondragstart = dragEvent => {
      if (dragEvent.target.closest('[contenteditable="true"],input:not([readonly]),textarea,select,button,.timeline-clip-resize')) {
        dragEvent.preventDefault();
        return;
      }
      this.startEventDrag(dragEvent, event);
    };
    card.ondragend = () => {
      this.dragPayload = null;
      this.clearDropPreview();
    };
    card.onclick = clickEvent => {
      const control = clickEvent.target.closest('input,textarea,select,button');
      if (control && !isLockedTextControl(clickEvent.target)) return;
      this.selectEvent(event.id, isAdditive(clickEvent));
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
    grip.title = '拖曳事件；Shift 點選可多選';
    grip.draggable = true;
    grip.ondragstart = dragEvent => {
      dragEvent.stopPropagation();
      this.startEventDrag(dragEvent, event);
    };
    const title = input(event.title);
    title.className = 'timeline-clip-title';
    title.dataset.eventTitle = event.id;
    this.bindDraft(title, value => { event.title = value; }, {
      fallback: '未命名事件',
      selectOnFocus: this.pendingFocus?.kind === 'event' && this.pendingFocus.id === event.id,
      doubleClickEdit: true,
      selectOnEdit: true,
      editTitle: '雙擊編輯事件標題',
      onLockedDrag: dragEvent => this.startEventDrag(dragEvent, event)
    });
    const expand = button(event.expanded ? '↥' : '↕', event.expanded ? '恢復展開前的軌道高度' : '依內容展開整條軌道');
    expand.className = 'timeline-clip-expand';
    expand.onclick = clickEvent => {
      clickEvent.stopPropagation();
      this.toggleEventExpanded(event.id);
    };
    const remove = button('×', '刪除事件');
    remove.className = 'timeline-clip-delete';
    remove.onclick = clickEvent => {
      clickEvent.stopPropagation();
      this.deleteEvent(event.id);
    };
    header.append(grip, title, expand, remove);

    const description = this.makeMarkdownBlock(event);

    const footer = element('div', 'timeline-clip-footer');
    const positionLabel = element('label', '', '小節');
    const position = input(eventPosition(event) + 1, 'number');
    position.min = '1';
    position.step = '1';
    position.title = '開始小節';
    position.onchange = () => this.transact('變更事件位置', data => {
      const target = data.events.find(item => item.id === event.id);
      if (!target) return;
      target.time.position = snapMeasure(finite(position.value, 1) - 1);
      syncClipTime(target);
    });
    stopControlEvents(position);
    positionLabel.append(position);
    const durationLabel = element('label', '', '長度');
    const duration = input(eventDuration(event), 'number');
    duration.min = String(MIN_DURATION);
    duration.step = '1';
    duration.title = '事件跨越的小節數';
    duration.onchange = () => this.transact('變更事件長度', data => {
      const target = data.events.find(item => item.id === event.id);
      if (!target) return;
      target.time.duration = Math.max(MIN_DURATION, snapMeasure(duration.value));
      syncClipTime(target);
    });
    stopControlEvents(duration);
    const trackSelect = element('select', 'timeline-clip-track');
    for (const item of this.displayedTracks()) trackSelect.append(new Option(item.name, item.id));
    trackSelect.value = event.trackIds[0];
    trackSelect.title = '移到其他軌道';
    trackSelect.onchange = () => this.moveEvents({ anchorId: event.id, eventIds: [event.id] }, trackSelect.value, eventPosition(event));
    stopControlEvents(trackSelect);
    durationLabel.append(duration);
    footer.append(positionLabel, durationLabel, trackSelect);
    if (event.notePaths.length) {
      const note = button(`筆記 ${event.notePaths.length}`, '開啟連結筆記');
      note.className = 'timeline-clip-note';
      note.onclick = clickEvent => {
        clickEvent.stopPropagation();
        this.onOpenNote(event.notePaths[0], { beside: true });
      };
      footer.append(note);
    }

    const resize = element('span', 'timeline-clip-resize');
    resize.title = '左右拖曳調整事件長度（吸附到小節）';
    resize.onpointerdown = pointerEvent => this.startEventResize(pointerEvent, event, card, duration, unitWidth);
    card.append(header, description, footer, resize);
    return card;
  }

  startTrackDrag(dragEvent, track) {
    if (!this.selectedTrackIds.has(track.id)) this.selectTrack(track.id, false);
    const payload = { anchorId: track.id, trackIds: [...this.selectedTrackIds] };
    this.dragPayload = payload;
    dragEvent.dataTransfer.setData(TRACK_MIME, JSON.stringify(payload));
    dragEvent.dataTransfer.effectAllowed = 'move';
  }

  startEventDrag(dragEvent, event) {
    if (!this.selectedEventIds.has(event.id)) this.selectEvent(event.id, false);
    const payload = { anchorId: event.id, eventIds: [...this.selectedEventIds] };
    this.dragPayload = payload;
    dragEvent.dataTransfer.setData(EVENT_MIME, JSON.stringify(payload));
    dragEvent.dataTransfer.effectAllowed = 'move';
  }

  makeMarkdownBlock(event) {
    const block = element('div', 'timeline-clip-description timeline-clip-markdown live-editor');
    block.dataset.doubleClickEdit = '';
    block.dataset.placeholder = '雙擊輸入事件內容…';
    block.title = 'Markdown 混合顯示；雙擊編輯';
    let before = '';
    const live = new LiveMarkdownEditor(block, {
      onChange: source => {
        event.description = source;
        this.onChange();
      }
    });
    live.setValue(event.description);
    block.contentEditable = 'false';
    block.draggable = true;
    block.addEventListener('pointerdown', pointerEvent => {
      if (block.isContentEditable) pointerEvent.stopPropagation();
    });
    block.addEventListener('click', clickEvent => {
      if (block.isContentEditable) clickEvent.stopPropagation();
    });
    block.addEventListener('dblclick', doubleClickEvent => {
      doubleClickEvent.preventDefault();
      doubleClickEvent.stopPropagation();
      if (block.isContentEditable) return;
      before = this.snapshot();
      block.contentEditable = 'true';
      block.draggable = false;
      block.classList.add('editing');
      live.focus();
      live.setSelectionRange(live.value().length);
    });
    block.addEventListener('blur', () => {
      if (!block.isContentEditable) return;
      block.contentEditable = 'false';
      block.draggable = true;
      block.classList.remove('editing');
      this.pushHistory(before);
      before = '';
    });
    block.addEventListener('keydown', keyEvent => {
      if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault();
        block.blur();
      }
    });
    block.addEventListener('dragstart', dragEvent => {
      dragEvent.stopPropagation();
      if (block.isContentEditable) {
        dragEvent.preventDefault();
        return;
      }
      this.startEventDrag(dragEvent, event);
    });
    return block;
  }

  toggleEventExpanded(eventId) {
    const targetEvent = this.data.events.find(event => event.id === eventId);
    if (!targetEvent) return;
    const trackId = targetEvent.trackIds[0];
    const requiredHeights = new Map();
    for (const event of this.data.events.filter(item => item.trackIds[0] === trackId)) {
      const description = this.stage.querySelector(`.timeline-daw-event[data-event-id="${CSS.escape(event.id)}"] .timeline-clip-description`);
      requiredHeights.set(event.id, clamp((description?.scrollHeight || 166) + 94, DEFAULT_TRACK_HEIGHT, 480));
    }
    this.transact('依內容調整軌道高度', data => {
      const event = data.events.find(item => item.id === eventId);
      const track = data.tracks.find(item => item.id === trackId);
      if (!event || !track) return;
      const wasExpanded = Boolean(event.expanded);
      const hadExpandedEvent = data.events.some(item => item.trackIds[0] === trackId && item.expanded);
      if (!wasExpanded && !hadExpandedEvent) track.heightBeforeExpand = finite(track.height, DEFAULT_TRACK_HEIGHT);
      event.expanded = !wasExpanded;
      const expandedEvents = data.events.filter(item => item.trackIds[0] === trackId && item.expanded);
      if (!expandedEvents.length) {
        track.height = clamp(finite(track.heightBeforeExpand, DEFAULT_TRACK_HEIGHT), 84, 480);
        delete track.heightBeforeExpand;
      } else {
        track.height = Math.max(
          finite(track.heightBeforeExpand, DEFAULT_TRACK_HEIGHT),
          ...expandedEvents.map(item => requiredHeights.get(item.id) || 260)
        );
      }
    });
  }

  startEventResize(pointerEvent, event, card, durationInput, unitWidth) {
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    const before = this.snapshot();
    const startX = pointerEvent.clientX;
    const startDuration = eventDuration(event);
    const handle = pointerEvent.currentTarget;
    handle.setPointerCapture?.(pointerEvent.pointerId);
    card.classList.add('resizing');
    const move = moveEvent => {
      const duration = Math.max(MIN_DURATION, snapMeasure(startDuration + (moveEvent.clientX - startX) / unitWidth));
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

  startTrackResize(pointerEvent, track, row) {
    pointerEvent.preventDefault();
    pointerEvent.stopPropagation();
    const selectedIds = this.selectedTrackIds.has(track.id) && this.selectedTrackIds.size
      ? [...this.selectedTrackIds]
      : [track.id];
    const starts = new Map(selectedIds.map(trackId => {
      const item = this.data.tracks.find(candidate => candidate.id === trackId);
      return [trackId, finite(item?.height, DEFAULT_TRACK_HEIGHT)];
    }));
    const before = this.snapshot();
    const startY = pointerEvent.clientY;
    const handle = pointerEvent.currentTarget;
    handle.setPointerCapture?.(pointerEvent.pointerId);
    const move = moveEvent => {
      const delta = moveEvent.clientY - startY;
      for (const [trackId, startHeight] of starts) {
        const item = this.data.tracks.find(candidate => candidate.id === trackId);
        if (item) item.height = clamp(startHeight + delta, 84, 480);
        const targetRow = this.stage.querySelector(`.timeline-daw-track[data-track-id="${CSS.escape(trackId)}"]`);
        if (targetRow) targetRow.style.height = `${item.height}px`;
      }
      this.onChange();
    };
    const finish = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
      this.data = normalizeTimeline(this.data, this.data.title);
      this.pushHistory(before);
      this.render();
      this.onChange();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
  }

  startMarquee(pointerEvent, lane) {
    const startX = pointerEvent.clientX;
    const startY = pointerEvent.clientY;
    const additive = isAdditive(pointerEvent);
    const baseEvents = additive ? new Set(this.selectedEventIds) : new Set();
    const baseTracks = additive ? new Set(this.selectedTrackIds) : new Set();
    const overlay = element('div', 'timeline-marquee');
    const target = pointerEvent.currentTarget;
    let active = false;
    target.setPointerCapture?.(pointerEvent.pointerId);
    const move = moveEvent => {
      const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);
      if (!active && distance < 5) return;
      if (!active) {
        active = true;
        document.body.append(overlay);
      }
      const rect = {
        left: Math.min(startX, moveEvent.clientX),
        top: Math.min(startY, moveEvent.clientY),
        right: Math.max(startX, moveEvent.clientX),
        bottom: Math.max(startY, moveEvent.clientY)
      };
      overlay.style.left = `${rect.left}px`;
      overlay.style.top = `${rect.top}px`;
      overlay.style.width = `${rect.right - rect.left}px`;
      overlay.style.height = `${rect.bottom - rect.top}px`;
      const events = new Set(baseEvents);
      const tracks = new Set(baseTracks);
      for (const card of this.stage.querySelectorAll('.timeline-daw-event')) {
        if (intersects(rect, card.getBoundingClientRect())) events.add(card.dataset.eventId);
      }
      for (const label of this.stage.querySelectorAll('.timeline-daw-track-label')) {
        if (intersects(rect, label.getBoundingClientRect())) tracks.add(label.closest('.timeline-daw-track').dataset.trackId);
      }
      this.selectedEventIds = events;
      this.selectedTrackIds = tracks;
      this.selectedEventId = [...events].at(-1) || '';
      this.selectedTrackId = [...tracks].at(-1) || this.selectedTrackId;
      this.renderSelection();
    };
    const finish = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', finish);
      target.removeEventListener('pointercancel', finish);
      overlay.remove();
      if (active) {
        this.suppressLaneClick = true;
        this.persistView();
      }
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', finish);
    target.addEventListener('pointercancel', finish);
  }

  readDragPayload(event, mime) {
    try {
      const raw = event.dataTransfer.getData(mime);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  showDropPreview(payload, targetTrackId, targetPosition, unitWidth) {
    if (!payload?.anchorId) return;
    this.clearDropPreview();
    const copy = clone(this.data);
    const ids = payload.eventIds?.length ? payload.eventIds : [payload.anchorId];
    const trackOrder = this.displayedTracks().map(track => track.id);
    if (!moveTimelineEventsModel(copy, ids, payload.anchorId, targetTrackId, targetPosition, trackOrder)) return;
    for (const event of copy.events.filter(item => ids.includes(item.id))) {
      const lane = this.stage.querySelector(`.timeline-daw-track[data-track-id="${CSS.escape(event.trackIds[0])}"] .timeline-daw-lane`);
      if (!lane) continue;
      const preview = element('div', 'timeline-drop-preview', `第 ${eventPosition(event) + 1} 小節`);
      preview.style.left = `${eventPosition(event) * unitWidth}px`;
      preview.style.width = `${eventDuration(event) * unitWidth}px`;
      lane.append(preview);
      lane.classList.add('drop-target');
    }
  }

  clearDropPreview() {
    for (const preview of this.stage.querySelectorAll('.timeline-drop-preview')) preview.remove();
    for (const lane of this.stage.querySelectorAll('.timeline-daw-lane.drop-target')) lane.classList.remove('drop-target');
  }

  renderSelection() {
    for (const card of this.stage.querySelectorAll('.timeline-daw-event')) {
      card.classList.toggle('selected', this.selectedEventIds.has(card.dataset.eventId));
    }
    for (const row of this.stage.querySelectorAll('.timeline-daw-track')) {
      row.classList.toggle('selected', this.selectedTrackIds.has(row.dataset.trackId));
    }
    for (const row of this.stage.querySelectorAll('.timeline-track-folder-row')) {
      row.classList.toggle('selected', row.dataset.groupId === this.selectedGroupId);
    }
    this.root.querySelector('#timelineCursorLabel').textContent = this.selectionLabel();
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
