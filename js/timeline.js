const FORMAT = 'mysyncnote-timeline';
const VERSION = 1;
const COLORS = ['#78dba0', '#7fb5ff', '#d99cff', '#f4b86a', '#ff8d8d', '#69d4d0', '#c7d36f'];
const STATUS = {
  canon: '正式',
  draft: '草稿',
  idea: '想法',
  discarded: '捨棄'
};
const TIME_UNITS = {
  minute: ['分鐘', 60 * 1000],
  hour: ['小時', 60 * 60 * 1000],
  day: ['天', 24 * 60 * 60 * 1000],
  week: ['週', 7 * 24 * 60 * 60 * 1000]
};
const collator = new Intl.Collator('zh-Hant', { numeric: true, sensitivity: 'base' });

function id(prefix) {
  return globalThis.crypto?.randomUUID?.() || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function stringList(value) {
  return [...new Set(list(value).map(item => String(item || '').trim()).filter(Boolean))];
}

function uniqueId(value, prefix, used) {
  let result = String(value || '').trim();
  if (!result || used.has(result)) result = id(prefix);
  used.add(result);
  return result;
}

function finite(value, fallback = 0) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('zh-Hant');
}

function escapeSelector(value) {
  return globalThis.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, '\\$&');
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

function field(label, control, hint = '') {
  const wrapper = element('label', 'timeline-field');
  wrapper.append(element('span', 'timeline-field-label', label), control);
  if (hint) wrapper.append(element('small', '', hint));
  return wrapper;
}

function input(value = '', type = 'text') {
  const node = element('input');
  node.type = type;
  node.value = value ?? '';
  return node;
}

function select(options, value) {
  const node = element('select');
  for (const [optionValue, label] of options) {
    const option = element('option', '', label);
    option.value = optionValue;
    option.selected = String(optionValue) === String(value);
    node.append(option);
  }
  return node;
}

function nextOrder(items) {
  return items.length ? Math.max(...items.map(item => finite(item.order))) + 1000 : 1000;
}

export function createEmptyTimeline(title = '未命名時間線') {
  const trackId = id('track');
  return {
    format: FORMAT,
    version: VERSION,
    title: String(title || '未命名時間線'),
    calendar: { mode: 'flexible', timeZone: 'local' },
    trackGroups: [],
    tracks: [{ id: trackId, name: '主線', color: COLORS[0], groupId: null, height: 144, order: 0 }],
    branches: [{ id: 'main', name: '主時間線', parentId: null, fromEventId: null, color: COLORS[0], order: 0 }],
    variantGroups: [],
    events: [],
    narrativeSections: [{ id: id('section'), title: '故事', order: 0 }],
    narrativeItems: [],
    relations: []
  };
}

export function normalizeTimeline(source, fallbackTitle = '未命名時間線') {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Timeline 根內容必須是 JSON 物件');
  if (source.format && source.format !== FORMAT) throw new Error(`不支援的 Timeline 格式：${source.format}`);
  const sourceVersion = finite(source.version, 1);
  if (sourceVersion > VERSION) throw new Error(`這份 Timeline 是較新的第 ${sourceVersion} 版，目前版本無法安全編輯`);

  const migratedTracks = source.tracks || source.lanes;
  const migratedEvents = source.events || source.items;
  const document = { ...source, format: FORMAT, version: VERSION };
  document.title = String(source.title || fallbackTitle || '未命名時間線');
  document.calendar = { mode: 'flexible', timeZone: 'local', ...(source.calendar || {}) };

  const trackGroupIds = new Set();
  document.trackGroups = list(source.trackGroups).map((group, index) => ({
    ...group,
    id: uniqueId(group?.id, 'track-group', trackGroupIds),
    name: String(group?.name || `資料夾 ${index + 1}`),
    color: String(group?.color || COLORS[index % COLORS.length]),
    parentId: group?.parentId ? String(group.parentId) : null,
    collapsed: Boolean(group?.collapsed),
    order: finite(group?.order, index * 1000)
  })).sort((a, b) => a.order - b.order);
  const validTrackGroupIds = new Set(document.trackGroups.map(group => group.id));
  const trackGroupById = new Map(document.trackGroups.map(group => [group.id, group]));
  for (const group of document.trackGroups) {
    if (!validTrackGroupIds.has(group.parentId) || group.parentId === group.id) group.parentId = null;
  }
  for (const group of document.trackGroups) {
    const seen = new Set([group.id]);
    let parentId = group.parentId;
    while (parentId) {
      if (seen.has(parentId)) {
        group.parentId = null;
        break;
      }
      seen.add(parentId);
      parentId = trackGroupById.get(parentId)?.parentId || null;
    }
  }

  const trackIds = new Set();
  document.tracks = list(migratedTracks).map((track, index) => ({
    ...track,
    id: uniqueId(track?.id, 'track', trackIds),
    name: String(track?.name || `軌道 ${index + 1}`),
    color: String(track?.color || COLORS[index % COLORS.length]),
    groupId: validTrackGroupIds.has(track?.groupId) ? track.groupId : null,
    height: Math.min(480, Math.max(84, finite(track?.height, 144))),
    order: finite(track?.order, index * 1000)
  }));
  if (!document.tracks.length) {
    const trackId = uniqueId('track-main', 'track', trackIds);
    document.tracks.push({ id: trackId, name: '主線', color: COLORS[0], groupId: null, height: 144, order: 0 });
  }
  document.tracks.sort((a, b) => a.order - b.order);
  const validTrackIds = new Set(document.tracks.map(track => track.id));

  const branchIds = new Set();
  document.branches = list(source.branches).map((branch, index) => ({
    ...branch,
    id: uniqueId(branch?.id, 'branch', branchIds),
    name: String(branch?.name || `分支 ${index + 1}`),
    parentId: branch?.parentId == null ? null : String(branch.parentId),
    fromEventId: branch?.fromEventId || branch?.forkEventId || null,
    color: String(branch?.color || COLORS[index % COLORS.length]),
    order: finite(branch?.order, index * 1000)
  }));
  if (!document.branches.some(branch => branch.id === 'main')) {
    document.branches.unshift({ id: 'main', name: '主時間線', parentId: null, fromEventId: null, color: COLORS[0], order: -1000 });
    branchIds.add('main');
  }
  const validBranchIds = new Set(document.branches.map(branch => branch.id));
  for (const branch of document.branches) {
    if (branch.id === 'main') branch.parentId = null;
    else if (!validBranchIds.has(branch.parentId) || branch.parentId === branch.id) branch.parentId = 'main';
  }
  document.branches.sort((a, b) => a.order - b.order);

  const eventIds = new Set();
  document.events = list(migratedEvents).map((event, index) => {
    const eventId = uniqueId(event?.id, 'event', eventIds);
    const legacyWhen = event?.when || event?.time || {};
    let kind = String(legacyWhen.kind || (legacyWhen.relativeToEventId || legacyWhen.anchorId ? 'relative' : (legacyWhen.start || event?.start) ? 'exact' : 'undated'));
    if (kind === 'date' || kind === 'order') kind = 'exact';
    if (!['exact', 'relative', 'undated'].includes(kind)) kind = 'undated';
    const notePaths = stringList(event?.notePaths?.length ? event.notePaths : event?.notePath ? [event.notePath] : []);
    const requestedTracks = stringList(event?.trackIds).filter(trackId => validTrackIds.has(trackId));
    const numericStart = String(legacyWhen.start ?? event?.start ?? '').trim() === '' ? NaN : Number(legacyWhen.start ?? event?.start);
    const numericEnd = String(legacyWhen.end ?? event?.end ?? '').trim() === '' ? NaN : Number(legacyWhen.end ?? event?.end);
    const positionFallback = Number.isFinite(numericStart) ? numericStart : index * 4;
    const durationFallback = Number.isFinite(numericStart) && Number.isFinite(numericEnd) && numericEnd > numericStart ? numericEnd - numericStart : 4;
    const time = {
      ...legacyWhen,
      kind,
      start: String(legacyWhen.start ?? event?.start ?? ''),
      end: String(legacyWhen.end ?? event?.end ?? ''),
      precision: ['exact', 'approximate'].includes(legacyWhen.precision) ? legacyWhen.precision : 'exact',
      momentId: legacyWhen.momentId ? String(legacyWhen.momentId) : '',
      anchorId: String(legacyWhen.anchorId || legacyWhen.relativeToEventId || ''),
      offset: finite(legacyWhen.offset?.value ?? legacyWhen.offset, 0),
      unit: TIME_UNITS[legacyWhen.offset?.unit || legacyWhen.unit] ? (legacyWhen.offset?.unit || legacyWhen.unit) : 'day',
      position: Math.max(0, finite(legacyWhen.position, positionFallback)),
      duration: Math.max(1, finite(legacyWhen.duration, durationFallback))
    };
    return {
      ...event,
      id: eventId,
      title: String(event?.title || `未命名事件 ${index + 1}`),
      description: String(event?.description ?? event?.summary ?? ''),
      expanded: Boolean(event?.expanded),
      time,
      trackIds: requestedTracks.length ? requestedTracks : [document.tracks[0].id],
      branchId: validBranchIds.has(event?.branchId) ? event.branchId : 'main',
      variantGroupId: event?.variantGroupId ? String(event.variantGroupId) : null,
      variantLabel: String(event?.variantLabel || ''),
      notePaths,
      tags: stringList(event?.tags).map(tag => tag.replace(/^#/, '')),
      status: STATUS[event?.status] ? event.status : 'idea',
      dependsOn: stringList(event?.dependsOn),
      order: finite(event?.order ?? legacyWhen.order, index * 1000)
    };
  });

  for (const event of document.events) {
    event.dependsOn = event.dependsOn.filter(eventId => eventIds.has(eventId) && eventId !== event.id);
    if (!eventIds.has(event.time.anchorId) || event.time.anchorId === event.id) event.time.anchorId = '';
    if (event.time.kind === 'relative' && !event.time.anchorId) event.time.kind = 'undated';
  }

  const groupIds = new Set();
  document.variantGroups = list(source.variantGroups).map((group, index) => {
    const groupId = uniqueId(group?.id, 'variant', groupIds);
    const legacyOptions = list(group?.options);
    const eventIdsInGroup = stringList(group?.eventIds?.length ? group.eventIds : legacyOptions.map(option => option.eventId)).filter(eventId => eventIds.has(eventId));
    return {
      ...group,
      id: groupId,
      name: String(group?.name || group?.title || `方案組 ${index + 1}`),
      activeEventId: String(group?.activeEventId || legacyOptions.find(option => option.id === group?.activeOptionId)?.eventId || ''),
      eventIds: eventIdsInGroup,
      order: finite(group?.order, index * 1000)
    };
  });
  const validGroupIds = new Set(document.variantGroups.map(group => group.id));
  for (const event of document.events) if (!validGroupIds.has(event.variantGroupId)) event.variantGroupId = null;
  for (const group of document.variantGroups) {
    for (const event of document.events.filter(item => item.variantGroupId === group.id)) if (!group.eventIds.includes(event.id)) group.eventIds.push(event.id);
    group.eventIds = group.eventIds.filter(eventId => document.events.some(event => event.id === eventId && event.variantGroupId === group.id));
    if (!group.eventIds.includes(group.activeEventId)) group.activeEventId = group.eventIds[0] || '';
  }
  document.variantGroups = document.variantGroups.filter(group => group.eventIds.length > 1);
  const survivingGroupIds = new Set(document.variantGroups.map(group => group.id));
  for (const event of document.events) {
    if (event.variantGroupId && !survivingGroupIds.has(event.variantGroupId)) {
      event.variantGroupId = null;
      event.variantLabel = '';
    }
  }

  const sectionIds = new Set();
  document.narrativeSections = list(source.narrativeSections).map((section, index) => ({
    ...section,
    id: uniqueId(section?.id, 'section', sectionIds),
    title: String(section?.title || `章節 ${index + 1}`),
    order: finite(section?.order, index * 1000)
  }));
  if (!document.narrativeSections.length) {
    const sectionId = uniqueId('section-main', 'section', sectionIds);
    document.narrativeSections.push({ id: sectionId, title: '故事', order: 0 });
  }
  document.narrativeSections.sort((a, b) => a.order - b.order);

  const legacyNarrative = source.narrativeItems || source.storyOrder || source.narrative;
  const narrativeIds = new Set();
  document.narrativeItems = list(legacyNarrative).map((item, index) => {
    const eventId = typeof item === 'string' ? item : item?.eventId;
    return {
      ...(typeof item === 'object' && item ? item : {}),
      id: uniqueId(typeof item === 'object' ? item.id : '', 'narrative', narrativeIds),
      eventId: String(eventId || ''),
      sectionId: String((typeof item === 'object' && item?.sectionId) || document.narrativeSections[0].id),
      order: finite(typeof item === 'object' ? item?.order : null, index * 1000),
      label: String((typeof item === 'object' && item?.label) || '')
    };
  }).filter(item => eventIds.has(item.eventId));
  for (const item of document.narrativeItems) if (!sectionIds.has(item.sectionId)) item.sectionId = document.narrativeSections[0].id;

  const relationIds = new Set();
  const legacyRelations = source.relations || source.dependencies;
  document.relations = list(legacyRelations).map(relation => ({
    ...relation,
    id: uniqueId(relation?.id, 'relation', relationIds),
    fromEventId: String(relation?.fromEventId || ''),
    toEventId: String(relation?.toEventId || ''),
    type: String(relation?.type || 'requires'),
    label: String(relation?.label || '')
  })).filter(relation => eventIds.has(relation.fromEventId) && eventIds.has(relation.toEventId) && relation.fromEventId !== relation.toEventId);

  return document;
}

function parseExact(value) {
  const source = String(value || '').trim();
  if (!source) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(source)) return { value: Number(source), domain: 'scalar' };
  if (/^\d{4}(?:-\d{2}(?:-\d{2})?)?(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(source)) {
    const parsed = Date.parse(source.length === 4 ? `${source}-01-01T00:00:00` : source);
    if (Number.isFinite(parsed)) return { value: parsed, domain: 'timestamp' };
  }
  return null;
}

export function resolveChronology(document) {
  const events = new Map(document.events.map(event => [event.id, event]));
  const memo = new Map();
  const visiting = new Set();
  const cycles = new Set();
  const resolve = eventId => {
    if (memo.has(eventId)) return memo.get(eventId);
    const event = events.get(eventId);
    if (!event) return null;
    if (visiting.has(eventId)) {
      for (const id of visiting) cycles.add(id);
      return null;
    }
    visiting.add(eventId);
    let resolved = null;
    if (event.time.kind === 'exact') resolved = parseExact(event.time.start);
    else if (event.time.kind === 'relative' && event.time.anchorId) {
      const anchor = resolve(event.time.anchorId);
      if (anchor) {
        const scalarUnits = { minute: 1 / 1440, hour: 1 / 24, day: 1, week: 7 };
        const unitSize = anchor.domain === 'scalar' ? scalarUnits[event.time.unit] : TIME_UNITS[event.time.unit][1];
        resolved = { value: anchor.value + finite(event.time.offset) * unitSize, domain: anchor.domain };
      }
    }
    visiting.delete(eventId);
    memo.set(eventId, resolved);
    return resolved;
  };

  const rows = document.events.map(event => {
    const resolved = resolve(event.id);
    const custom = event.time.kind === 'exact' && resolved == null ? event.time.start.trim() : '';
    return { eventId: event.id, value: resolved?.value ?? null, domain: resolved?.domain || '', custom, unresolved: event.time.kind !== 'exact' && resolved == null, cycle: cycles.has(event.id) };
  });
  rows.sort((a, b) => {
    if (a.value != null && b.value != null) {
      if (a.domain === b.domain) return a.value - b.value || document.events.find(event => event.id === a.eventId).order - document.events.find(event => event.id === b.eventId).order;
      return document.events.find(event => event.id === a.eventId).order - document.events.find(event => event.id === b.eventId).order;
    }
    if (a.value != null) return -1;
    if (b.value != null) return 1;
    if (a.custom && b.custom) return collator.compare(a.custom, b.custom);
    if (a.custom) return -1;
    if (b.custom) return 1;
    const eventA = document.events.find(event => event.id === a.eventId);
    const eventB = document.events.find(event => event.id === b.eventId);
    return eventA.order - eventB.order;
  });
  return { rows, cycles: [...cycles] };
}

export function validateTimeline(document) {
  const errors = [];
  const warnings = [];
  if (document.format !== FORMAT) errors.push('格式識別不正確');
  if (document.version > VERSION) errors.push('檔案版本比目前程式新');
  const chronology = resolveChronology(document);
  if (chronology.cycles.length) warnings.push(`有 ${chronology.cycles.length} 個事件形成相對時間循環，已放到待安排區`);

  const branches = new Map(document.branches.map(branch => [branch.id, branch]));
  for (const branch of document.branches) {
    const seen = new Set([branch.id]);
    let parent = branch.parentId;
    while (parent) {
      if (seen.has(parent)) {
        warnings.push(`分支「${branch.name}」的父子關係形成循環`);
        break;
      }
      seen.add(parent);
      parent = branches.get(parent)?.parentId || null;
    }
  }
  const eventMap = new Map(document.events.map(event => [event.id, event]));
  for (const group of document.variantGroups) {
    const groupBranches = new Set(group.eventIds.map(eventId => eventMap.get(eventId)?.branchId).filter(Boolean));
    if (groupBranches.size > 1) warnings.push(`方案組「${group.name}」跨越不同分支，請把方案放回同一分支`);
  }
  const momentGroups = new Map();
  for (const event of document.events) {
    if (!event.time.momentId) continue;
    const signature = event.time.kind === 'relative'
      ? `relative:${event.time.anchorId}:${event.time.offset}:${event.time.unit}`
      : event.time.kind === 'exact'
        ? `exact:${event.time.start}:${event.time.precision}`
        : 'undated';
    if (!momentGroups.has(event.time.momentId)) momentGroups.set(event.time.momentId, new Set());
    momentGroups.get(event.time.momentId).add(signature);
  }
  if ([...momentGroups.values()].some(signatures => signatures.size > 1)) {
    warnings.push('有「同時群組」包含互相矛盾的開始時間，請開啟事件內容確認');
  }
  const dependencyVisiting = new Set();
  const dependencyVisited = new Set();
  let dependencyCycle = false;
  const visitDependency = eventId => {
    if (dependencyVisiting.has(eventId)) { dependencyCycle = true; return; }
    if (dependencyVisited.has(eventId)) return;
    dependencyVisiting.add(eventId);
    for (const dependencyId of eventMap.get(eventId)?.dependsOn || []) visitDependency(dependencyId);
    dependencyVisiting.delete(eventId);
    dependencyVisited.add(eventId);
  };
  for (const event of document.events) visitDependency(event.id);
  if (dependencyCycle) warnings.push('前置事件關係形成循環，請調整因果順序');
  return { errors, warnings };
}

export function relativeChainIncludes(document, startEventId, targetEventId) {
  const events = new Map(document.events.map(event => [event.id, event]));
  const seen = new Set();
  let currentId = startEventId;
  while (currentId && !seen.has(currentId)) {
    if (currentId === targetEventId) return true;
    seen.add(currentId);
    const current = events.get(currentId);
    if (current?.time.kind !== 'relative') return false;
    currentId = current.time.anchorId;
  }
  return false;
}

export function branchLineage(document, branchId) {
  const map = new Map(document.branches.map(branch => [branch.id, branch]));
  const result = [];
  const seen = new Set();
  let current = map.get(branchId);
  while (current && !seen.has(current.id)) {
    result.unshift(current);
    seen.add(current.id);
    current = current.parentId ? map.get(current.parentId) : null;
  }
  return result;
}

export function branchVisibleEvents(document, branchId) {
  const lineage = branchLineage(document, branchId);
  if (!lineage.length) return [];
  const allowed = new Set(lineage.map(branch => branch.id));
  const cutoffs = new Map();
  for (let index = 1; index < lineage.length; index++) cutoffs.set(lineage[index - 1].id, lineage[index].fromEventId);
  const chronology = resolveChronology(document).rows;
  const order = new Map(chronology.map((row, index) => [row.eventId, index]));
  const resolved = new Map(chronology.map(row => [row.eventId, row]));
  const eventMap = new Map(document.events.map(event => [event.id, event]));
  return document.events.filter(event => {
    if (!allowed.has(event.branchId)) return false;
    const cutoff = cutoffs.get(event.branchId);
    if (!cutoff) return true;
    if ((order.get(event.id) ?? Infinity) <= (order.get(cutoff) ?? Infinity)) return true;
    const fork = eventMap.get(cutoff);
    if (!fork) return false;
    const sameMoment = momentKey(event, resolved.get(event.id)) === momentKey(fork, resolved.get(fork.id));
    return sameMoment && (!fork.variantGroupId || event.variantGroupId !== fork.variantGroupId || event.id === fork.id);
  });
}

export function visibleEvents(document, filters = {}) {
  const query = normalizeText(filters.query);
  const tracks = new Map(document.tracks.map(track => [track.id, track.name]));
  const branches = new Map(document.branches.map(branch => [branch.id, branch.name]));
  const branchEventIds = filters.branch && filters.branch !== 'all' ? new Set(branchVisibleEvents(document, filters.branch).map(event => event.id)) : null;
  return document.events.filter(event => {
    if (filters.status && filters.status !== 'all' && event.status !== filters.status) return false;
    if (branchEventIds && !branchEventIds.has(event.id)) return false;
    if (filters.track && filters.track !== 'all' && !event.trackIds.includes(filters.track)) return false;
    if (!query) return true;
    const haystack = normalizeText([
      event.title,
      event.description,
      ...event.tags.flatMap(tag => [tag, `#${tag}`]),
      ...event.notePaths,
      ...event.trackIds.map(trackId => tracks.get(trackId) || ''),
      branches.get(event.branchId) || ''
    ].join(' '));
    return haystack.includes(query);
  });
}

export function moveNarrativeItemModel(document, itemId, sectionId, beforeId = '') {
  const item = document.narrativeItems.find(candidate => candidate.id === itemId);
  if (!item || !document.narrativeSections.some(section => section.id === sectionId)) return document;
  const siblings = document.narrativeItems
    .filter(candidate => candidate.sectionId === sectionId && candidate.id !== itemId)
    .sort((a, b) => a.order - b.order);
  const foundIndex = beforeId ? siblings.findIndex(candidate => candidate.id === beforeId) : -1;
  const index = foundIndex >= 0 ? foundIndex : siblings.length;
  const after = siblings[index]?.order ?? ((siblings[index - 1]?.order ?? 0) + 2000);
  const before = siblings[index - 1]?.order ?? (after - 2000);
  item.sectionId = sectionId;
  item.order = (before + after) / 2;
  if (Math.abs(after - before) < 1e-6) siblings.concat(item).sort((a, b) => a.order - b.order).forEach((candidate, position) => { candidate.order = (position + 1) * 1000; });
  return document;
}

function timeLabel(event, eventMap) {
  if (event.time.kind === 'exact') {
    const start = event.time.start.trim() || '時間未定';
    const label = event.time.end.trim() ? `${start} → ${event.time.end.trim()}` : start;
    return event.time.precision === 'approximate' ? `約 ${label}` : label;
  }
  if (event.time.kind === 'relative') {
    const anchor = eventMap.get(event.time.anchorId);
    const offset = finite(event.time.offset);
    const sign = offset >= 0 ? '+' : '';
    return `${anchor?.title || '未知事件'} ${sign}${offset} ${TIME_UNITS[event.time.unit][0]}`;
  }
  return '待安排';
}

function momentKey(event, resolved) {
  if (event.time.momentId) return `moment:${event.time.momentId}`;
  if (resolved?.value != null) return `value:${resolved.domain}:${resolved.value}`;
  if (event.time.kind === 'exact' && event.time.start.trim()) return `custom:${event.time.start.trim().toLocaleLowerCase('zh-Hant')}`;
  if (event.time.kind === 'relative') return `relative:${event.time.anchorId}:${event.time.offset}:${event.time.unit}`;
  return `undated:${event.id}`;
}

export class TimelineView {
  constructor(options) {
    this.root = options.root;
    this.stage = this.root.querySelector('#timelineStage');
    this.inspector = this.root.querySelector('#timelineInspector');
    this.onChange = options.onChange || (() => {});
    this.onOpenNote = options.onOpenNote || (() => {});
    this.onAcceptNote = options.onAcceptNote || (() => false);
    this.requestText = options.requestText || (async (_title, value) => value);
    this.notify = options.notify || (() => {});
    this.notes = [];
    this.data = createEmptyTimeline();
    this.key = '';
    this.selectedId = '';
    this.mode = 'chronology';
    this.zoom = 1;
    this.inspectorCollapsed = true;
    this.filters = { query: '', status: 'all', branch: 'all', track: 'all' };
    this.undoStack = [];
    this.redoStack = [];
    this.warnings = [];
    this.bind();
  }

  bind() {
    this.root.querySelectorAll('[data-timeline-view]').forEach(item => item.addEventListener('click', () => this.setMode(item.dataset.timelineView)));
    this.root.querySelector('#timelineAddEvent').onclick = () => this.addEvent();
    this.root.querySelector('#timelineAddSimultaneous').onclick = () => this.addSimultaneous();
    this.root.querySelector('#timelineAddTrack').onclick = () => this.addTrack();
    this.root.querySelector('#timelineAddVariant').onclick = () => this.addVariant();
    this.root.querySelector('#timelineAddBranch').onclick = () => this.addBranch();
    this.root.querySelector('#timelineAddChapter').onclick = () => this.addSection();
    this.root.querySelector('#timelinePlaceSelected').onclick = () => this.addNarrativeItem(this.selectedId);
    this.root.querySelector('#timelineUndo').onclick = () => this.undo();
    this.root.querySelector('#timelineRedo').onclick = () => this.redo();
    this.root.querySelector('#timelineZoomOut').onclick = () => this.setZoom(this.zoom / 1.18);
    this.root.querySelector('#timelineZoomIn').onclick = () => this.setZoom(this.zoom * 1.18);
    this.root.querySelector('#timelineZoomReset').onclick = () => this.setZoom(1);
    this.root.querySelector('#timelineToggleInspector').onclick = () => this.setInspectorCollapsed(!this.inspectorCollapsed);
    this.root.querySelector('#timelineSearch').oninput = event => { this.filters.query = event.currentTarget.value; this.persistView(); this.render(); };
    this.root.querySelector('#timelineStatusFilter').onchange = event => { this.filters.status = event.currentTarget.value; this.persistView(); this.render(); };
    this.root.querySelector('#timelineBranchFilter').onchange = event => { this.filters.branch = event.currentTarget.value; this.persistView(); this.render(); };
    this.root.querySelector('#timelineTrackFilter').onchange = event => { this.filters.track = event.currentTarget.value; this.persistView(); this.render(); };
    this.root.addEventListener('keydown', event => {
      const typing = event.target.matches('input,textarea,select,[contenteditable]');
      if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? this.redo() : this.undo(); }
      else if (!typing && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); this.redo(); }
      else if (!typing && event.key === 'Delete' && this.selectedId) { event.preventDefault(); this.deleteEvent(this.selectedId); }
      else if (event.key === 'Escape' && this.selectedId) { event.preventDefault(); this.selectEvent(''); }
    });
  }

  load(text, options = {}) {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (error) { throw new Error(`Timeline JSON 無法解析：${error.message}`); }
    this.data = normalizeTimeline(parsed, options.title);
    const validation = validateTimeline(this.data);
    if (validation.errors.length) throw new Error(validation.errors.join('\n'));
    this.warnings = validation.warnings;
    this.key = options.key || '';
    this.selectedId = '';
    this.undoStack = [];
    this.redoStack = [];
    this.restoreView();
    this.render();
  }

  json() {
    return `${JSON.stringify(this.data, null, 2)}\n`;
  }

  activate() {
    this.render();
  }

  setNotes(entries) {
    this.notes = list(entries).map(entry => typeof entry === 'string' ? entry : entry.path).filter(Boolean);
    const datalist = this.inspector.querySelector('datalist');
    if (datalist) {
      datalist.innerHTML = '';
      for (const path of this.notes) { const option = element('option'); option.value = path; datalist.append(option); }
    }
  }

  viewState() {
    return { mode: this.mode, zoom: this.zoom, inspectorCollapsed: this.inspectorCollapsed, filters: { ...this.filters } };
  }

  setDocumentIdentity(key, title = '') {
    this.key = key || this.key;
    this.persistView();
    if (title && this.data.title !== title) {
      this.data.title = title;
      this.onChange();
    }
  }

  restoreView() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(`mysyncnote-timeline-view:${this.key}`) || 'null'); } catch {}
    this.mode = ['chronology', 'narrative', 'branches'].includes(saved?.mode) ? saved.mode : 'chronology';
    this.zoom = Math.min(1.6, Math.max(.7, finite(saved?.zoom, 1)));
    this.inspectorCollapsed = typeof saved?.inspectorCollapsed === 'boolean' ? saved.inspectorCollapsed : true;
    this.filters = { query: '', status: 'all', branch: 'all', track: 'all', ...(saved?.filters || {}) };
    this.normalizeFilters();
  }

  persistView() {
    if (!this.key) return;
    try { localStorage.setItem(`mysyncnote-timeline-view:${this.key}`, JSON.stringify(this.viewState())); } catch {}
  }

  setMode(mode) {
    if (!['chronology', 'narrative', 'branches'].includes(mode)) return;
    this.mode = mode;
    this.persistView();
    this.render();
  }

  setZoom(value) {
    this.zoom = Math.min(1.6, Math.max(.7, value));
    this.persistView();
    this.renderToolbar();
    if (this.mode === 'chronology') this.renderStage();
  }

  setInspectorCollapsed(collapsed) {
    this.inspectorCollapsed = Boolean(collapsed);
    this.root.classList.toggle('inspector-collapsed', this.inspectorCollapsed);
    this.root.classList.toggle('inspector-open', !this.inspectorCollapsed);
    this.persistView();
    this.renderToolbar();
  }

  normalizeFilters() {
    let changed = false;
    if (!STATUS[this.filters.status] && this.filters.status !== 'all') { this.filters.status = 'all'; changed = true; }
    if (this.filters.branch !== 'all' && !this.data.branches.some(branch => branch.id === this.filters.branch)) { this.filters.branch = 'all'; changed = true; }
    if (this.filters.track !== 'all' && !this.data.tracks.some(track => track.id === this.filters.track)) { this.filters.track = 'all'; changed = true; }
    if (changed) this.persistView();
  }

  transact(_label, mutator) {
    const before = this.json();
    mutator(this.data);
    this.data = normalizeTimeline(this.data, this.data.title);
    const after = this.json();
    if (before === after) return false;
    this.undoStack.push(before);
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack = [];
    this.warnings = validateTimeline(this.data).warnings;
    this.render();
    this.onChange();
    return true;
  }

  undo() {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(this.json());
    this.data = normalizeTimeline(JSON.parse(previous), this.data.title);
    if (!this.data.events.some(event => event.id === this.selectedId)) this.selectedId = '';
    this.warnings = validateTimeline(this.data).warnings;
    this.render();
    this.onChange();
  }

  redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.json());
    this.data = normalizeTimeline(JSON.parse(next), this.data.title);
    if (!this.data.events.some(event => event.id === this.selectedId)) this.selectedId = '';
    this.warnings = validateTimeline(this.data).warnings;
    this.render();
    this.onChange();
  }

  selectedEvent() {
    return this.data.events.find(event => event.id === this.selectedId) || null;
  }

  wouldCreateDependency(eventId, dependencyId) {
    const events = new Map(this.data.events.map(event => [event.id, event]));
    const stack = [dependencyId];
    const seen = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (current === eventId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(events.get(current)?.dependsOn || []));
    }
    return false;
  }

  bindDraft(control, apply) {
    let before = '';
    control.addEventListener('focus', () => { before = this.json(); });
    control.addEventListener('input', () => {
      apply(control.value);
      this.onChange();
    });
    control.addEventListener('blur', () => {
      if (!before) return;
      const after = this.json();
      if (before !== after) {
        this.undoStack.push(before);
        if (this.undoStack.length > 80) this.undoStack.shift();
        this.redoStack = [];
        this.warnings = validateTimeline(this.data).warnings;
        setTimeout(() => {
          this.renderStage();
          this.renderToolbar();
        }, 120);
      }
      before = '';
    });
  }

  mutateMomentTime(event, mutator) {
    const targets = event.time.momentId
      ? this.data.events.filter(candidate => candidate.time.momentId === event.time.momentId)
      : [event];
    for (const target of targets) mutator(target.time, target);
  }

  selectEvent(eventId) {
    this.selectedId = this.data.events.some(event => event.id === eventId) ? eventId : '';
    if (this.selectedId) this.inspectorCollapsed = false;
    this.root.classList.toggle('inspector-collapsed', this.inspectorCollapsed);
    this.root.classList.toggle('inspector-open', !this.inspectorCollapsed);
    this.persistView();
    this.stage.querySelectorAll('.timeline-event-card').forEach(card => card.classList.toggle('selected', card.dataset.eventId === this.selectedId));
    this.renderInspector();
    this.renderToolbar();
  }

  async addEvent(seed = {}) {
    const title = await this.requestText('新增事件', seed.title || '新事件', '事件可在右側直接補上時間、軌道、方案與連結筆記');
    if (!title) return;
    const eventId = id('event');
    const selected = this.selectedEvent();
    const branchId = seed.branchId || (this.filters.branch !== 'all' ? this.filters.branch : selected?.branchId) || 'main';
    const trackIds = seed.trackIds || (this.filters.track !== 'all' ? [this.filters.track] : selected?.trackIds) || [this.data.tracks[0].id];
    const time = seed.time || { kind: 'undated', start: '', end: '', precision: 'exact', momentId: '', anchorId: '', offset: 0, unit: 'day' };
    this.transact('新增事件', data => {
      data.events.push({
        id: eventId,
        title,
        description: '',
        time,
        trackIds: [...trackIds],
        branchId,
        variantGroupId: null,
        variantLabel: '',
        notePaths: [],
        tags: [],
        status: 'idea',
        dependsOn: [],
        order: nextOrder(data.events),
        ...seed,
        id: eventId,
        title
      });
    });
    this.selectEvent(eventId);
  }

  async addSimultaneous() {
    const source = this.selectedEvent();
    if (!source) return this.notify('請先選擇要與哪個事件同時發生', true);
    const title = await this.requestText('新增同時事件', '同時發生的事件', `會和「${source.title}」放在同一個時間點，但兩件事可以同時成立`);
    if (!title) return;
    const eventId = id('event');
    const momentId = source.time.momentId || id('moment');
    this.transact('新增同時事件', data => {
      const original = data.events.find(item => item.id === source.id);
      original.time.momentId = momentId;
      data.events.push({
        id: eventId,
        title,
        description: '',
        time: { ...clone(original.time), momentId },
        trackIds: [...original.trackIds],
        branchId: original.branchId,
        variantGroupId: null,
        variantLabel: '',
        notePaths: [],
        tags: [],
        status: 'idea',
        dependsOn: [],
        order: nextOrder(data.events)
      });
    });
    this.selectEvent(eventId);
  }

  updateEvent(eventId, patch) {
    this.transact('修改事件', data => {
      const event = data.events.find(item => item.id === eventId);
      if (!event) return;
      if (typeof patch === 'function') patch(event);
      else Object.assign(event, patch);
    });
  }

  moveEventToBranch(eventId, branchId) {
    const event = this.data.events.find(item => item.id === eventId);
    if (!event || event.branchId === branchId || !this.data.branches.some(branch => branch.id === branchId)) return;
    if (this.data.branches.some(branch => branch.fromEventId === eventId)) {
      this.notify(`「${event.title}」是其他分支的分叉點；請先移除那些分支，再移動這個事件`, true);
      return;
    }
    this.transact('移動事件分支', data => {
      const item = data.events.find(candidate => candidate.id === eventId);
      if (!item) return;
      const group = data.variantGroups.find(candidate => candidate.id === item.variantGroupId);
      item.branchId = branchId;
      if (group && group.eventIds.some(candidateId => candidateId !== item.id && data.events.find(candidate => candidate.id === candidateId)?.branchId !== branchId)) {
        group.eventIds = group.eventIds.filter(candidateId => candidateId !== item.id);
        if (group.activeEventId === item.id) group.activeEventId = group.eventIds[0] || '';
        item.variantGroupId = null;
        item.variantLabel = '';
      }
    });
  }

  deleteEvent(eventId) {
    const event = this.data.events.find(item => item.id === eventId);
    const childBranches = this.data.branches.filter(branch => branch.fromEventId === eventId);
    if (!event) return;
    if (childBranches.length) {
      this.notify(`「${event.title}」是 ${childBranches.length} 個分支的分叉點。請先刪除那些分支（事件會移回父線），再刪除這個事件`, true);
      return;
    }
    if (!confirm(`刪除事件「${event.title}」？\n敘事順序與方案中的引用也會一起移除。`)) return;
    this.transact('刪除事件', data => {
      data.events = data.events.filter(item => item.id !== eventId);
      data.narrativeItems = data.narrativeItems.filter(item => item.eventId !== eventId);
      data.relations = data.relations.filter(item => item.fromEventId !== eventId && item.toEventId !== eventId);
      for (const item of data.events) {
        item.dependsOn = item.dependsOn.filter(id => id !== eventId);
        if (item.time.anchorId === eventId) { item.time.kind = 'undated'; item.time.anchorId = ''; }
      }
      for (const group of data.variantGroups) {
        group.eventIds = group.eventIds.filter(id => id !== eventId);
        if (group.activeEventId === eventId) group.activeEventId = group.eventIds[0] || '';
      }
      data.variantGroups = data.variantGroups.filter(group => group.eventIds.length > 1);
      const survivingGroups = new Set(data.variantGroups.map(group => group.id));
      for (const item of data.events) if (item.variantGroupId && !survivingGroups.has(item.variantGroupId)) { item.variantGroupId = null; item.variantLabel = ''; }
    });
    this.selectedId = '';
    this.root.classList.remove('inspector-open');
    this.render();
  }

  async addTrack() {
    const name = await this.requestText('新增軌道', '新軌道', '可用於角色、地點、陣營或劇情線');
    if (!name) return;
    const trackId = id('track');
    this.transact('新增軌道', data => data.tracks.push({ id: trackId, name, color: COLORS[data.tracks.length % COLORS.length], order: nextOrder(data.tracks) }));
  }

  removeTrack(trackId) {
    const track = this.data.tracks.find(item => item.id === trackId);
    if (!track || this.data.tracks.length === 1 || !confirm(`刪除軌道「${track.name}」？\n事件不會刪除，會移到其他軌道。`)) return;
    if (this.filters.track === trackId) { this.filters.track = 'all'; this.persistView(); }
    this.transact('刪除軌道', data => {
      data.tracks = data.tracks.filter(item => item.id !== trackId);
      for (const event of data.events) {
        event.trackIds = event.trackIds.filter(id => id !== trackId);
        if (!event.trackIds.length) event.trackIds = [data.tracks[0].id];
      }
    });
  }

  async addVariant() {
    const source = this.selectedEvent();
    if (!source) return this.notify('請先選擇要建立替代方案的事件', true);
    let group = this.data.variantGroups.find(item => item.id === source.variantGroupId);
    let groupName = group?.name;
    if (!group) {
      groupName = await this.requestText('建立方案組', `${source.title}的方案`, 'A／B／C 是互斥構想，不等於會繼續發展的時間分支');
      if (!groupName) return;
    }
    const newId = id('event');
    this.transact('新增方案', data => {
      let targetGroup = data.variantGroups.find(item => item.id === source.variantGroupId);
      if (!targetGroup) {
        targetGroup = { id: id('variant'), name: groupName, activeEventId: source.id, eventIds: [source.id], order: nextOrder(data.variantGroups) };
        data.variantGroups.push(targetGroup);
        const original = data.events.find(item => item.id === source.id);
        original.variantGroupId = targetGroup.id;
        original.variantLabel = original.variantLabel || 'A';
      }
      const labels = new Set(targetGroup.eventIds.map(eventId => data.events.find(item => item.id === eventId)?.variantLabel).filter(Boolean));
      let index = 0;
      while (labels.has(String.fromCharCode(65 + index))) index += 1;
      const copy = clone(data.events.find(item => item.id === source.id));
      copy.id = newId;
      copy.variantGroupId = targetGroup.id;
      copy.variantLabel = String.fromCharCode(65 + index);
      copy.status = 'idea';
      copy.order = nextOrder(data.events);
      data.events.push(copy);
      targetGroup.eventIds.push(newId);
    });
    this.selectEvent(newId);
  }

  setActiveVariant(groupId, eventId) {
    this.transact('採用方案', data => {
      const group = data.variantGroups.find(item => item.id === groupId);
      if (group?.eventIds.includes(eventId)) group.activeEventId = eventId;
    });
  }

  detachVariant(eventId) {
    this.transact('移出方案組', data => {
      const event = data.events.find(item => item.id === eventId);
      const group = data.variantGroups.find(item => item.id === event?.variantGroupId);
      if (!event || !group) return;
      event.variantGroupId = null;
      event.variantLabel = '';
      group.eventIds = group.eventIds.filter(id => id !== eventId);
      if (group.activeEventId === eventId) group.activeEventId = group.eventIds[0] || '';
      if (group.eventIds.length < 2) {
        const survivor = data.events.find(item => item.id === group.eventIds[0]);
        if (survivor) { survivor.variantGroupId = null; survivor.variantLabel = ''; }
        data.variantGroups = data.variantGroups.filter(item => item.id !== group.id);
      }
    });
  }

  async addBranch() {
    const source = this.selectedEvent();
    if (!source) return this.notify('請先選擇分叉點事件', true);
    const name = await this.requestText('新增時間分支', '另一條發展', `從「${source.title}」之後分叉`);
    if (!name) return;
    const branchId = id('branch');
    this.filters.branch = 'all';
    this.persistView();
    this.transact('新增分支', data => data.branches.push({
      id: branchId,
      name,
      parentId: source.branchId,
      fromEventId: source.id,
      color: COLORS[data.branches.length % COLORS.length],
      order: nextOrder(data.branches)
    }));
    this.mode = 'branches';
    this.persistView();
    this.render();
    await this.addEvent({
      branchId,
      trackIds: source.trackIds,
      time: { kind: 'relative', start: '', end: '', precision: 'exact', momentId: '', anchorId: source.id, offset: 1, unit: 'day' },
      title: `${name}的第一個事件`
    });
  }

  removeBranch(branchId) {
    const branch = this.data.branches.find(item => item.id === branchId);
    if (!branch || branch.id === 'main') return;
    const parentId = branch.parentId || 'main';
    if (!confirm(`刪除分支「${branch.name}」？\n分支內事件與子分支會移回父分支，不會遺失。`)) return;
    if (this.filters.branch === branchId) { this.filters.branch = 'all'; this.persistView(); }
    this.transact('刪除分支', data => {
      for (const event of data.events) if (event.branchId === branchId) event.branchId = parentId;
      for (const child of data.branches) if (child.parentId === branchId) child.parentId = parentId;
      data.branches = data.branches.filter(item => item.id !== branchId);
    });
  }

  async addSection() {
    const title = await this.requestText('新增敘事章節', '新章節', '章節只安排讀者看到事件的順序，不會改變實際時間');
    if (!title) return;
    this.transact('新增章節', data => data.narrativeSections.push({ id: id('section'), title, order: nextOrder(data.narrativeSections) }));
  }

  addNarrativeItem(eventId, sectionId = '', beforeId = '') {
    if (!this.data.events.some(event => event.id === eventId)) return this.notify('請先選擇一個事件', true);
    const targetSection = sectionId || this.data.narrativeSections[0]?.id;
    this.transact('加入敘事順序', data => {
      const narrativeId = id('narrative');
      data.narrativeItems.push({
        id: narrativeId,
        eventId,
        sectionId: targetSection,
        order: nextOrder(data.narrativeItems.filter(item => item.sectionId === targetSection)),
        label: ''
      });
      if (beforeId) moveNarrativeItemModel(data, narrativeId, targetSection, beforeId);
    });
    this.mode = 'narrative';
    this.persistView();
    this.render();
  }

  moveNarrativeItem(itemId, sectionId, beforeId = '') {
    this.transact('調整敘事順序', data => moveNarrativeItemModel(data, itemId, sectionId, beforeId));
  }

  removeNarrativeItem(itemId) {
    this.transact('移出敘事順序', data => { data.narrativeItems = data.narrativeItems.filter(item => item.id !== itemId); });
  }

  attachNote(eventId, path) {
    if (!path || !this.onAcceptNote(path)) return this.notify('只能連結筆記庫中的 Markdown 檔案', true);
    this.updateEvent(eventId, event => { if (!event.notePaths.includes(path)) event.notePaths.push(path); });
  }

  render() {
    this.normalizeFilters();
    this.renderToolbar();
    this.renderStage();
    this.renderInspector();
    this.root.classList.toggle('inspector-collapsed', this.inspectorCollapsed);
    this.root.classList.toggle('inspector-open', !this.inspectorCollapsed);
  }

  renderToolbar() {
    this.normalizeFilters();
    this.root.querySelectorAll('[data-timeline-view]').forEach(item => item.classList.toggle('active', item.dataset.timelineView === this.mode));
    this.root.querySelector('#timelineUndo').disabled = !this.undoStack.length;
    this.root.querySelector('#timelineRedo').disabled = !this.redoStack.length;
    this.root.querySelector('#timelineAddVariant').disabled = !this.selectedEvent();
    this.root.querySelector('#timelineAddSimultaneous').disabled = !this.selectedEvent();
    this.root.querySelector('#timelineAddBranch').disabled = !this.selectedEvent();
    this.root.querySelector('#timelinePlaceSelected').disabled = !this.selectedEvent();
    this.root.querySelector('#timelineAddChapter').classList.toggle('hidden', this.mode !== 'narrative');
    this.root.querySelector('#timelinePlaceSelected').classList.toggle('hidden', this.mode !== 'narrative');
    this.root.querySelector('#timelineZoomOut').classList.toggle('hidden', this.mode !== 'chronology');
    this.root.querySelector('#timelineZoomReset').classList.toggle('hidden', this.mode !== 'chronology');
    this.root.querySelector('#timelineZoomIn').classList.toggle('hidden', this.mode !== 'chronology');
    this.root.querySelector('#timelineZoomLabel').textContent = `${Math.round(this.zoom * 100)}%`;
    this.root.querySelector('#timelineToggleInspector').classList.toggle('active', !this.inspectorCollapsed);
    this.root.querySelector('#timelineSearch').value = this.filters.query;

    const status = this.root.querySelector('#timelineStatusFilter');
    status.innerHTML = '<option value="all">所有狀態</option>';
    for (const [value, label] of Object.entries(STATUS)) status.append(new Option(label, value));
    status.value = STATUS[this.filters.status] ? this.filters.status : 'all';

    const branch = this.root.querySelector('#timelineBranchFilter');
    branch.innerHTML = '<option value="all">所有分支</option>';
    for (const item of this.data.branches) branch.append(new Option(item.name, item.id));
    branch.value = this.data.branches.some(item => item.id === this.filters.branch) ? this.filters.branch : 'all';

    const track = this.root.querySelector('#timelineTrackFilter');
    track.innerHTML = '<option value="all">所有軌道</option>';
    for (const item of this.data.tracks) track.append(new Option(item.name, item.id));
    track.value = this.data.tracks.some(item => item.id === this.filters.track) ? this.filters.track : 'all';
  }

  renderStage() {
    this.stage.innerHTML = '';
    if (this.warnings.length) {
      const warning = element('div', 'timeline-warning');
      warning.textContent = this.warnings.join('；');
      this.stage.append(warning);
    }
    if (this.mode === 'narrative') this.renderNarrative();
    else if (this.mode === 'branches') this.renderBranches();
    else this.renderChronology();
  }

  filteredEvents() {
    return visibleEvents(this.data, this.filters);
  }

  clearFilters() {
    this.filters = { query: '', status: 'all', branch: 'all', track: 'all' };
    this.persistView();
    this.render();
  }

  renderChronology() {
    const events = this.filteredEvents();
    if (!events.length) {
      if (this.data.events.length) return this.renderEmpty('目前的篩選沒有符合事件', '清除篩選', () => this.clearFilters());
      return this.renderEmpty('還沒有事件', '新增第一個事件', () => this.addEvent());
    }
    const eventMap = new Map(this.data.events.map(event => [event.id, event]));
    const chronology = resolveChronology(this.data);
    const resolved = new Map(chronology.rows.map(row => [row.eventId, row]));
    const groups = new Map();
    for (const event of events) {
      const key = momentKey(event, resolved.get(event.id));
      if (!groups.has(key)) groups.set(key, { key, label: timeLabel(event, eventMap), events: [], source: event });
      groups.get(key).events.push(event);
    }
    const eventOrder = new Map(chronology.rows.map((row, index) => [row.eventId, index]));
    const buckets = [...groups.values()].sort((a, b) => Math.min(...a.events.map(event => eventOrder.get(event.id) ?? Infinity)) - Math.min(...b.events.map(event => eventOrder.get(event.id) ?? Infinity)));
    const columnWidth = Math.round(230 * this.zoom);
    const totalWidth = Math.max(680, buckets.length * columnWidth);

    const scroll = element('div', 'timeline-scroll');
    const chronologyNode = element('div', 'timeline-chronology');
    chronologyNode.style.setProperty('--timeline-width', `${totalWidth}px`);
    chronologyNode.style.setProperty('--timeline-column', `${columnWidth}px`);
    const axis = element('div', 'timeline-axis-row');
    axis.append(element('div', 'timeline-axis-corner', '軌道／時間'));
    const axisStage = element('div', 'timeline-axis-stage');
    axisStage.style.width = `${totalWidth}px`;
    buckets.forEach((bucket, index) => {
      const marker = element('div', 'timeline-axis-marker');
      marker.style.left = `${index * columnWidth}px`;
      marker.style.width = `${columnWidth}px`;
      const variantGroups = new Set(bucket.events.map(event => event.variantGroupId).filter(Boolean));
      const variantCount = bucket.events.filter(event => event.variantGroupId).length;
      const coexistCount = bucket.events.filter(event => !event.variantGroupId).length + variantGroups.size;
      const summary = [];
      if (coexistCount > 1) summary.push(`同時 ${coexistCount} 件`);
      if (variantCount > 1) summary.push(`${variantCount} 個互斥方案`);
      marker.append(element('strong', '', bucket.label), element('small', '', summary.join(' · ')));
      axisStage.append(marker);
    });
    axis.append(axisStage);
    chronologyNode.append(axis);

    const activeTrackIds = this.filters.track !== 'all' ? new Set([this.filters.track]) : new Set(this.data.tracks.map(track => track.id));
    for (const track of this.data.tracks.filter(track => activeTrackIds.has(track.id))) {
      const laneEvents = events.filter(event => event.trackIds.includes(track.id));
      const stacks = new Map();
      for (const event of laneEvents) {
        const index = buckets.findIndex(bucket => bucket.key === momentKey(event, resolved.get(event.id)));
        if (!stacks.has(index)) stacks.set(index, []);
        stacks.get(index).push(event);
      }
      const maxStack = Math.max(1, ...[...stacks.values()].map(items => items.length));
      const row = element('div', 'timeline-lane');
      const label = element('div', 'timeline-lane-label');
      const dot = element('span', 'timeline-track-dot'); dot.style.background = track.color;
      label.append(dot, element('span', '', track.name), element('small', '', `${laneEvents.length}`));
      row.append(label);
      const lane = element('div', 'timeline-lane-stage');
      lane.style.width = `${totalWidth}px`;
      lane.style.height = `${Math.max(126, maxStack * 106 + 18)}px`;
      buckets.forEach((bucket, index) => {
        const drop = element('div', 'timeline-drop-column');
        drop.style.left = `${index * columnWidth}px`;
        drop.style.width = `${columnWidth}px`;
        drop.ondragover = event => {
          if (event.dataTransfer.types.includes('text/mysyncnote-timeline-event')) { event.preventDefault(); drop.classList.add('drop-target'); }
        };
        drop.ondragleave = () => drop.classList.remove('drop-target');
        drop.ondrop = event => {
          event.preventDefault(); event.stopPropagation(); drop.classList.remove('drop-target');
          let payload; try { payload = JSON.parse(event.dataTransfer.getData('text/mysyncnote-timeline-event')); } catch { return; }
          const dragged = this.data.events.find(item => item.id === payload.eventId);
          if (dragged && bucket.source.id !== dragged.id && relativeChainIncludes(this.data, bucket.source.id, dragged.id)) {
            this.notify('這個位置的相對時間最終依賴被移動的事件，拖過去會形成時間循環', true);
            return;
          }
          this.transact('移動事件', data => {
            const item = data.events.find(candidate => candidate.id === payload.eventId);
            if (!item) return;
            if (event.shiftKey) item.trackIds = [...new Set([...item.trackIds, track.id])];
            else if (payload.trackId && item.trackIds.includes(payload.trackId)) item.trackIds = [...new Set(item.trackIds.map(id => id === payload.trackId ? track.id : id))];
            else item.trackIds = [track.id];
            const source = bucket.source;
            item.time = clone(source.time);
            item.time.momentId = source.time.momentId || '';
          });
        };
        lane.append(drop);
      });
      for (const [bucketIndex, stack] of stacks) stack.forEach((event, stackIndex) => {
        const card = this.makeEventCard(event, { trackId: track.id, compact: true });
        card.style.left = `${bucketIndex * columnWidth + 10}px`;
        card.style.top = `${12 + stackIndex * 106}px`;
        card.style.width = `${columnWidth - 20}px`;
        lane.append(card);
      });
      row.append(lane);
      chronologyNode.append(row);
    }
    scroll.append(chronologyNode);
    this.stage.append(scroll);
  }

  renderNarrative() {
    const events = this.filteredEvents();
    const eventMap = new Map(this.data.events.map(event => [event.id, event]));
    const visibleIds = new Set(events.map(event => event.id));
    const board = element('div', 'timeline-narrative-board');
    const used = new Set(this.data.narrativeItems.map(item => item.eventId));
    const inbox = element('section', 'timeline-story-column timeline-story-inbox');
    const inboxHeader = element('header', '');
    inboxHeader.append(element('strong', '', '尚未編排'), element('small', '', '拖到章節中'));
    inbox.append(inboxHeader);
    const inboxBody = element('div', 'timeline-story-list');
    for (const event of events.filter(event => !used.has(event.id))) {
      const wrapper = element('div', 'timeline-inbox-item');
      wrapper.append(this.makeEventCard(event, { compact: true, narrativeSource: true }));
      const touchActions = element('div', 'timeline-inbox-actions');
      const destination = select(this.data.narrativeSections.map(section => [section.id, section.title]), this.data.narrativeSections[0]?.id);
      const add = button('加入');
      add.onclick = clickEvent => { clickEvent.stopPropagation(); this.addNarrativeItem(event.id, destination.value); };
      touchActions.append(destination, add);
      wrapper.append(touchActions);
      inboxBody.append(wrapper);
    }
    if (!inboxBody.children.length) inboxBody.append(element('div', 'timeline-column-empty', '所有可見事件都已編排'));
    inbox.append(inboxBody);
    board.append(inbox);

    const sections = [...this.data.narrativeSections].sort((a, b) => a.order - b.order);
    sections.forEach((section, sectionIndex) => {
      const column = element('section', 'timeline-story-column');
      column.dataset.sectionId = section.id;
      const header = element('header', '');
      const title = element('strong', '', section.title);
      title.title = '按兩下重新命名';
      const renameSection = async () => {
        const value = await this.requestText('重新命名章節', section.title, '');
        if (value) this.transact('重新命名章節', data => { const item = data.narrativeSections.find(candidate => candidate.id === section.id); if (item) item.title = value; });
      };
      title.ondblclick = renameSection;
      const controls = element('div', 'timeline-story-controls');
      const edit = button('✎', '重新命名章節');
      const left = button('←', '往前移'); left.disabled = sectionIndex === 0;
      const right = button('→', '往後移'); right.disabled = sectionIndex === sections.length - 1;
      const remove = button('×', '刪除章節');
      edit.onclick = renameSection;
      left.onclick = () => this.moveSection(section.id, -1);
      right.onclick = () => this.moveSection(section.id, 1);
      remove.onclick = () => this.removeSection(section.id);
      controls.append(edit, left, right, remove);
      header.append(title, controls);
      column.append(header);
      const body = element('div', 'timeline-story-list');
      body.ondragover = event => {
        if (event.dataTransfer.types.includes('text/mysyncnote-timeline-event')) { event.preventDefault(); body.classList.add('drop-target'); }
      };
      body.ondragleave = () => body.classList.remove('drop-target');
      body.ondrop = event => {
        event.preventDefault(); body.classList.remove('drop-target');
        let payload; try { payload = JSON.parse(event.dataTransfer.getData('text/mysyncnote-timeline-event')); } catch { return; }
        if (payload.narrativeItemId) this.moveNarrativeItem(payload.narrativeItemId, section.id);
        else this.addNarrativeItem(payload.eventId, section.id);
      };
      const items = this.data.narrativeItems.filter(item => item.sectionId === section.id && visibleIds.has(item.eventId)).sort((a, b) => a.order - b.order);
      items.forEach((item, index) => {
        const event = eventMap.get(item.eventId);
        if (!event) return;
        const wrapper = element('div', 'timeline-story-item');
        const card = this.makeEventCard(event, { compact: true, narrativeItemId: item.id });
        const actions = element('div', 'timeline-story-item-actions');
        const up = button('↑', '往前'); up.disabled = index === 0;
        const down = button('↓', '往後'); down.disabled = index === items.length - 1;
        const remove = button('×', '只從敘事順序移除');
        const destination = select(sections.map(candidate => [candidate.id, candidate.title]), section.id);
        destination.title = '移到其他章節';
        destination.onchange = changeEvent => { changeEvent.stopPropagation(); this.moveNarrativeItem(item.id, destination.value); };
        up.onclick = event => { event.stopPropagation(); this.moveNarrativeBefore(item.id, items[index - 1]?.id); };
        down.onclick = event => { event.stopPropagation(); this.moveNarrativeBefore(item.id, items[index + 2]?.id || ''); };
        remove.onclick = event => { event.stopPropagation(); this.removeNarrativeItem(item.id); };
        actions.append(destination, up, down, remove);
        wrapper.append(card, actions);
        wrapper.ondragover = event => { event.preventDefault(); wrapper.classList.add('drop-before'); };
        wrapper.ondragleave = () => wrapper.classList.remove('drop-before');
        wrapper.ondrop = event => {
          event.preventDefault(); event.stopPropagation(); wrapper.classList.remove('drop-before');
          let payload; try { payload = JSON.parse(event.dataTransfer.getData('text/mysyncnote-timeline-event')); } catch { return; }
          if (payload.narrativeItemId) this.moveNarrativeItem(payload.narrativeItemId, section.id, item.id);
          else this.addNarrativeItem(payload.eventId, section.id, item.id);
        };
        body.append(wrapper);
      });
      if (!body.children.length) body.append(element('div', 'timeline-column-empty', '把事件拖到這裡'));
      column.append(body);
      board.append(column);
    });
    this.stage.append(board);
  }

  moveNarrativeBefore(itemId, beforeId) {
    const item = this.data.narrativeItems.find(candidate => candidate.id === itemId);
    if (item) this.moveNarrativeItem(itemId, item.sectionId, beforeId);
  }

  moveSection(sectionId, delta) {
    this.transact('移動章節', data => {
      const sections = [...data.narrativeSections].sort((a, b) => a.order - b.order);
      const index = sections.findIndex(section => section.id === sectionId);
      const other = sections[index + delta];
      if (!other) return;
      [sections[index].order, other.order] = [other.order, sections[index].order];
    });
  }

  removeSection(sectionId) {
    if (this.data.narrativeSections.length === 1) return this.notify('至少要保留一個敘事章節', true);
    const section = this.data.narrativeSections.find(item => item.id === sectionId);
    if (!section || !confirm(`刪除章節「${section.title}」？\n裡面的事件會移到第一個章節。`)) return;
    this.transact('刪除章節', data => {
      data.narrativeSections = data.narrativeSections.filter(item => item.id !== sectionId);
      for (const item of data.narrativeItems) if (item.sectionId === sectionId) item.sectionId = data.narrativeSections[0].id;
    });
  }

  renderBranches() {
    let events = visibleEvents(this.data, { ...this.filters, branch: 'all' });
    if (this.filters.branch !== 'all') {
      const branchEventIds = new Set(branchVisibleEvents(this.data, this.filters.branch).map(event => event.id));
      events = events.filter(event => branchEventIds.has(event.id));
    }
    const chronology = new Map(resolveChronology(this.data).rows.map((row, index) => [row.eventId, index]));
    const board = element('div', 'timeline-branch-board');
    const visibleBranchIds = this.filters.branch === 'all' ? null : new Set(branchLineage(this.data, this.filters.branch).map(branch => branch.id));
    for (const branch of this.data.branches) {
      if (visibleBranchIds && !visibleBranchIds.has(branch.id)) continue;
      const column = element('section', 'timeline-branch-column');
      column.style.setProperty('--branch-color', branch.color);
      column.dataset.branchId = branch.id;
      column.ondragover = event => {
        if (event.dataTransfer.types.includes('text/mysyncnote-timeline-event')) { event.preventDefault(); column.classList.add('drop-target'); }
      };
      column.ondragleave = () => column.classList.remove('drop-target');
      column.ondrop = event => {
        event.preventDefault(); column.classList.remove('drop-target');
        let payload; try { payload = JSON.parse(event.dataTransfer.getData('text/mysyncnote-timeline-event')); } catch { return; }
        this.moveEventToBranch(payload.eventId, branch.id);
      };
      const header = element('header', 'timeline-branch-header');
      const parent = this.data.branches.find(item => item.id === branch.parentId);
      const fork = this.data.events.find(item => item.id === branch.fromEventId);
      const title = element('div', '');
      title.append(element('strong', '', branch.name), element('small', '', branch.id === 'main' ? '主線' : `從 ${parent?.name || '主線'}／${fork?.title || '未指定事件'} 分出`));
      header.append(title);
      if (branch.id !== 'main') {
        const remove = button('×', '刪除分支');
        remove.onclick = () => this.removeBranch(branch.id);
        header.append(remove);
      }
      column.append(header);
      const listNode = element('div', 'timeline-branch-events');
      const branchEvents = events.filter(event => event.branchId === branch.id).sort((a, b) => (chronology.get(a.id) ?? Infinity) - (chronology.get(b.id) ?? Infinity));
      let previousGroup = '';
      for (const event of branchEvents) {
        const group = this.data.variantGroups.find(item => item.id === event.variantGroupId);
        if (group && group.id !== previousGroup) {
          const groupHeader = element('div', 'timeline-variant-header');
          groupHeader.append(element('strong', '', `方案：${group.name}`), element('small', '', '一次採用一個，其他想法仍保留'));
          listNode.append(groupHeader);
          previousGroup = group.id;
        } else if (!group) previousGroup = '';
        listNode.append(this.makeEventCard(event, { compact: false }));
      }
      if (!branchEvents.length) listNode.append(element('div', 'timeline-column-empty', '把事件拖到這個分支，或從分叉點新增'));
      column.append(listNode);
      board.append(column);
    }
    this.stage.append(board);
  }

  makeEventCard(event, options = {}) {
    const card = element('article', `timeline-event-card${event.id === this.selectedId ? ' selected' : ''}`);
    const track = this.data.tracks.find(item => item.id === (options.trackId || event.trackIds[0]));
    const branch = this.data.branches.find(item => item.id === event.branchId);
    const group = this.data.variantGroups.find(item => item.id === event.variantGroupId);
    const activeVariant = !group || group.activeEventId === event.id;
    card.classList.toggle('inactive-variant', !activeVariant);
    card.dataset.eventId = event.id;
    card.style.setProperty('--track-color', track?.color || branch?.color || COLORS[0]);
    card.tabIndex = 0;
    card.draggable = true;
    card.onclick = () => this.selectEvent(event.id);
    card.onkeydown = keyEvent => { if (keyEvent.key === 'Enter' || keyEvent.key === ' ') { keyEvent.preventDefault(); this.selectEvent(event.id); } };
    card.ondragstart = dragEvent => {
      dragEvent.stopPropagation();
      dragEvent.dataTransfer.setData('text/mysyncnote-timeline-event', JSON.stringify({
        eventId: event.id,
        trackId: options.trackId || '',
        narrativeItemId: options.narrativeItemId || ''
      }));
      dragEvent.dataTransfer.effectAllowed = 'copyMove';
    };
    card.ondragover = dragEvent => {
      if (dragEvent.dataTransfer.types.includes('text/mysyncnote-path')) { dragEvent.preventDefault(); card.classList.add('note-drop-target'); }
    };
    card.ondragleave = () => card.classList.remove('note-drop-target');
    card.ondrop = dragEvent => {
      const path = dragEvent.dataTransfer.getData('text/mysyncnote-path');
      if (!path) return;
      dragEvent.preventDefault(); dragEvent.stopPropagation(); card.classList.remove('note-drop-target');
      this.attachNote(event.id, path);
    };
    const top = element('div', 'timeline-card-top');
    const title = element('strong', '', event.title);
    const badges = element('div', 'timeline-card-badges');
    if (group) {
      const variant = element('span', `timeline-badge variant${activeVariant ? ' active' : ''}`, event.variantLabel || '方案');
      variant.title = `${group.name}${activeVariant ? '（目前採用）' : '（候選）'}`;
      badges.append(variant);
    }
    badges.append(element('span', `timeline-badge status-${event.status}`, STATUS[event.status]));
    top.append(title, badges);
    card.append(top);
    const time = element('div', 'timeline-card-time', timeLabel(event, new Map(this.data.events.map(item => [item.id, item]))));
    card.append(time);
    if (!options.compact && event.description) card.append(element('p', '', event.description.slice(0, 140)));
    const meta = element('div', 'timeline-card-meta');
    if (branch && branch.id !== 'main') meta.append(element('span', '', `⑂ ${branch.name}`));
    if (event.notePaths.length) meta.append(element('span', '', `▤ ${event.notePaths.length}`));
    if (event.tags.length) meta.append(element('span', '', event.tags.slice(0, 2).map(tag => `#${tag}`).join(' ')));
    if (event.dependsOn.length) meta.append(element('span', '', `需先完成 ${event.dependsOn.length}`));
    card.append(meta);
    return card;
  }

  renderEmpty(message, actionLabel, action) {
    const empty = element('div', 'timeline-empty');
    empty.append(element('div', 'timeline-empty-mark', '⌁'), element('h3', '', message), element('p', '', '事件可連結現有 Markdown 筆記，檔案仍留在你的筆記庫中。'));
    const actionButton = button(actionLabel); actionButton.className = 'primary'; actionButton.onclick = action;
    empty.append(actionButton);
    this.stage.append(empty);
  }

  renderInspector() {
    this.inspector.innerHTML = '';
    const header = element('header', 'timeline-inspector-header');
    header.append(element('strong', '', this.selectedEvent() ? '事件內容' : '時間線結構'));
    const close = button('×', '收起時間線內容'); close.className = 'icon-btn'; close.onclick = () => {
      this.selectedId = '';
      this.setInspectorCollapsed(true);
      this.stage.querySelectorAll('.timeline-event-card').forEach(card => card.classList.remove('selected'));
      this.renderInspector();
    };
    header.append(close);
    this.inspector.append(header);
    const body = element('div', 'timeline-inspector-body');
    this.inspector.append(body);
    const event = this.selectedEvent();
    if (!event) return this.renderOverview(body);

    if (!this.filteredEvents().some(item => item.id === event.id)) body.append(element('div', 'timeline-inspector-notice', '這個事件目前被篩選條件隱藏，但仍可在這裡編輯。'));
    const titleInput = input(event.title);
    this.bindDraft(titleInput, value => { event.title = value; });
    titleInput.addEventListener('blur', () => { if (!event.title.trim()) event.title = '未命名事件'; });
    body.append(field('事件名稱', titleInput));

    const description = element('textarea');
    description.rows = 6; description.value = event.description; description.placeholder = '寫下場景、因果、人物想法或尚未決定的細節…';
    this.bindDraft(description, value => { event.description = value; });
    body.append(field('描述', description, '可寫 Markdown；內容直接存進 .timeline 檔。'));

    const timeKind = select([['exact', '確切／自訂時間'], ['relative', '相對其他事件'], ['undated', '尚未決定']], event.time.kind);
    timeKind.onchange = () => {
      const groupIds = new Set(event.time.momentId ? this.data.events.filter(candidate => candidate.time.momentId === event.time.momentId).map(candidate => candidate.id) : [event.id]);
      const defaultAnchor = this.data.events.find(candidate => !groupIds.has(candidate.id))?.id || '';
      this.transact('修改時間方式', () => {
        this.mutateMomentTime(event, time => {
        time.kind = timeKind.value;
          if (timeKind.value === 'relative' && !time.anchorId) time.anchorId = defaultAnchor;
        });
      });
    };
    body.append(field('時間方式', timeKind));

    if (event.time.kind === 'exact') {
      const start = input(event.time.start); start.placeholder = '例如 2026-07-26 18:30、第三天、戰後 2 年';
      this.bindDraft(start, value => this.mutateMomentTime(event, time => { time.start = value; }));
      const end = input(event.time.end); end.placeholder = '可留空';
      this.bindDraft(end, value => { event.time.end = value; });
      const precision = select([['exact', '確切'], ['approximate', '大約']], event.time.precision);
      precision.onchange = () => this.transact('修改時間精確度', () => this.mutateMomentTime(event, time => { time.precision = precision.value; }));
      body.append(field('開始時間', start), field('結束時間', end), field('精確程度', precision));
    } else if (event.time.kind === 'relative') {
      const sameMomentIds = new Set(event.time.momentId ? this.data.events.filter(item => item.time.momentId === event.time.momentId).map(item => item.id) : [event.id]);
      const choices = this.data.events.filter(item => !sameMomentIds.has(item.id)).map(item => [item.id, item.title]);
      const anchor = select([['', '選擇錨點事件'], ...choices], event.time.anchorId);
      anchor.onchange = () => this.transact('修改相對時間錨點', () => this.mutateMomentTime(event, time => { time.anchorId = anchor.value; }));
      const offsetRow = element('div', 'timeline-inline-fields');
      const offset = input(event.time.offset, 'number'); offset.step = 'any';
      this.bindDraft(offset, value => this.mutateMomentTime(event, time => { time.offset = finite(value); }));
      const unit = select(Object.entries(TIME_UNITS).map(([key, value]) => [key, value[0]]), event.time.unit);
      unit.onchange = () => this.transact('修改相對時間單位', () => this.mutateMomentTime(event, time => { time.unit = unit.value; }));
      offsetRow.append(offset, unit);
      body.append(field('相對於', anchor), field('時間差', offsetRow, '正數是之後，負數是之前。'));
    }

    const momentRow = element('div', 'timeline-inline-fields');
    const moment = input(event.time.momentId); moment.placeholder = '可留空';
    this.bindDraft(moment, value => { event.time.momentId = value.trim(); });
    moment.addEventListener('change', () => {
      const other = this.data.events.find(candidate => candidate.id !== event.id && candidate.time.momentId === event.time.momentId && event.time.momentId);
      if (other) {
        const end = event.time.end;
        event.time = { ...clone(other.time), momentId: event.time.momentId, end };
        this.onChange();
      }
    });
    const detachMoment = button('解除同時');
    detachMoment.disabled = !event.time.momentId;
    detachMoment.onclick = () => this.updateEvent(event.id, item => { item.time.momentId = ''; });
    momentRow.append(moment, detachMoment);
    body.append(field('同時群組', momentRow, '同一群組代表明確同時發生；修改開始或相對時間時會同步整組。'));

    const status = select(Object.entries(STATUS), event.status);
    status.onchange = () => this.updateEvent(event.id, { status: status.value });
    body.append(field('狀態', status));

    const branch = select(this.data.branches.map(item => [item.id, item.name]), event.branchId);
    branch.onchange = () => this.moveEventToBranch(event.id, branch.value);
    body.append(field('時間分支', branch));

    const tracks = element('div', 'timeline-check-list');
    for (const track of this.data.tracks) {
      const row = element('label', 'timeline-check');
      const check = input('', 'checkbox'); check.checked = event.trackIds.includes(track.id);
      check.onchange = () => this.updateEvent(event.id, item => {
        if (check.checked) item.trackIds = [...new Set([...item.trackIds, track.id])];
        else if (item.trackIds.length > 1) item.trackIds = item.trackIds.filter(id => id !== track.id);
      });
      const dot = element('span', 'timeline-track-dot'); dot.style.background = track.color;
      row.append(check, dot, element('span', '', track.name));
      tracks.append(row);
    }
    body.append(field('所屬軌道', tracks, '同一事件可同時出現在多個角色、地點或劇情軌道。'));

    const tags = input(event.tags.map(tag => `#${tag}`).join(' '));
    tags.placeholder = '#伏筆 #角色A';
    this.bindDraft(tags, value => { event.tags = stringList(value.split(/[\s,]+/)).map(tag => tag.replace(/^#/, '')); });
    body.append(field('標籤', tags));

    const compatibleGroups = this.data.variantGroups.filter(group => group.id === event.variantGroupId || group.eventIds.every(eventId => this.data.events.find(item => item.id === eventId)?.branchId === event.branchId));
    const groupOptions = [['', '不屬於方案組'], ...compatibleGroups.map(group => [group.id, group.name])];
    const group = select(groupOptions, event.variantGroupId || '');
    group.onchange = () => {
      if (!group.value) return this.detachVariant(event.id);
      this.transact('調整方案組', data => {
        const item = data.events.find(candidate => candidate.id === event.id);
        const old = data.variantGroups.find(candidate => candidate.id === item.variantGroupId);
        if (old) {
          old.eventIds = old.eventIds.filter(id => id !== item.id);
          if (old.activeEventId === item.id) old.activeEventId = old.eventIds[0] || '';
        }
        const target = data.variantGroups.find(candidate => candidate.id === group.value);
        const usedLabels = new Set(target.eventIds.map(eventId => data.events.find(candidate => candidate.id === eventId)?.variantLabel).filter(Boolean));
        let labelIndex = 0;
        while (usedLabels.has(String.fromCharCode(65 + labelIndex))) labelIndex += 1;
        item.variantGroupId = target.id;
        item.variantLabel = String.fromCharCode(65 + labelIndex);
        if (!target.eventIds.includes(item.id)) target.eventIds.push(item.id);
        if (!target.activeEventId) target.activeEventId = item.id;
      });
    };
    body.append(field('互斥方案組', group, '方案是 A／B／C 候選；真正會延伸後續事件時請建立「分支」。'));
    const variantGroup = this.data.variantGroups.find(item => item.id === event.variantGroupId);
    if (variantGroup) {
      const variantRow = element('div', 'timeline-inline-fields');
      const labelInput = input(event.variantLabel); labelInput.placeholder = 'A';
      this.bindDraft(labelInput, value => { event.variantLabel = value; });
      const active = button(variantGroup.activeEventId === event.id ? '✓ 目前採用' : '設為採用');
      active.className = variantGroup.activeEventId === event.id ? 'toggle active' : '';
      active.onclick = () => this.setActiveVariant(variantGroup.id, event.id);
      variantRow.append(labelInput, active);
      body.append(field('方案代號', variantRow));
    }

    const dependencyBox = element('div', 'timeline-dependencies');
    for (const dependencyId of event.dependsOn) {
      const dependency = this.data.events.find(item => item.id === dependencyId);
      if (!dependency) continue;
      const chip = element('span', 'timeline-dependency-chip');
      chip.append(element('span', '', dependency.title));
      const remove = button('×', '移除前置事件');
      remove.onclick = () => this.updateEvent(event.id, item => { item.dependsOn = item.dependsOn.filter(id => id !== dependencyId); });
      chip.append(remove); dependencyBox.append(chip);
    }
    const dependencySelect = select([['', '加入前置事件…'], ...this.data.events.filter(item => item.id !== event.id && !event.dependsOn.includes(item.id) && !this.wouldCreateDependency(event.id, item.id)).map(item => [item.id, item.title])], '');
    dependencySelect.onchange = () => {
      if (dependencySelect.value) this.updateEvent(event.id, item => { item.dependsOn.push(dependencySelect.value); });
    };
    dependencyBox.append(dependencySelect);
    body.append(field('前置事件', dependencyBox, '表示這件事成立前必須先發生哪些事件。'));

    const noteBox = element('div', 'timeline-notes');
    for (const path of event.notePaths) {
      const row = element('div', 'timeline-note-row');
      const open = button(path);
      open.className = 'timeline-note-link';
      open.onclick = () => this.onOpenNote(path, { beside: true });
      const remove = button('×', '移除筆記連結');
      remove.onclick = () => this.updateEvent(event.id, item => { item.notePaths = item.notePaths.filter(notePath => notePath !== path); });
      row.append(open, remove); noteBox.append(row);
    }
    const noteInput = input('');
    const datalistId = `timeline-notes-${event.id}`;
    noteInput.setAttribute('list', datalistId);
    noteInput.placeholder = '輸入或選擇 Markdown 路徑';
    const datalist = element('datalist'); datalist.id = datalistId;
    for (const path of this.notes) { const option = element('option'); option.value = path; datalist.append(option); }
    const addNote = button('加入');
    addNote.onclick = () => { if (noteInput.value.trim()) this.attachNote(event.id, noteInput.value.trim()); };
    const noteAdd = element('div', 'timeline-inline-fields'); noteAdd.append(noteInput, addNote);
    noteBox.append(noteAdd, datalist);
    body.append(field('連結筆記', noteBox, '也可以從左側檔案樹把 Markdown 拖到事件卡。'));

    const narrativeCount = this.data.narrativeItems.filter(item => item.eventId === event.id).length;
    const narrative = button(narrativeCount ? `再次放入敘事順序（已有 ${narrativeCount} 次）` : '放入敘事順序');
    narrative.onclick = () => this.addNarrativeItem(event.id);
    body.append(narrative);

    const deleteButton = button('刪除這個事件');
    deleteButton.className = 'danger timeline-delete-event';
    deleteButton.onclick = () => this.deleteEvent(event.id);
    body.append(deleteButton);
  }

  renderOverview(body) {
    const summary = element('div', 'timeline-overview-summary');
    summary.innerHTML = `<strong>${this.data.events.length}</strong><span>事件</span><strong>${this.data.tracks.length}</strong><span>軌道</span><strong>${this.data.branches.length}</strong><span>分支</span>`;
    body.append(summary);
    const help = element('p', 'timeline-overview-help', '先建立事件，再用右側內容欄指定時間、角色軌道、A／B／C 方案與 Markdown 筆記。相同時間的事件可以共存；只有放進方案組的事件才互斥。');
    body.append(help);

    body.append(element('h3', '', '軌道'));
    for (const track of this.data.tracks) {
      const row = element('div', 'timeline-manager-row');
      const color = input(track.color, 'color');
      color.onchange = () => this.transact('修改軌道顏色', data => { data.tracks.find(item => item.id === track.id).color = color.value; });
      const name = input(track.name);
      this.bindDraft(name, value => { track.name = value || '未命名軌道'; });
      const remove = button('×', '刪除軌道'); remove.disabled = this.data.tracks.length === 1; remove.onclick = () => this.removeTrack(track.id);
      row.append(color, name, remove);
      body.append(row);
    }
    const addTrack = button('＋ 新增軌道'); addTrack.onclick = () => this.addTrack(); body.append(addTrack);

    body.append(element('h3', '', '分支'));
    for (const branch of this.data.branches) {
      const row = element('div', 'timeline-manager-row');
      const color = input(branch.color, 'color');
      color.onchange = () => this.transact('修改分支顏色', data => { data.branches.find(item => item.id === branch.id).color = color.value; });
      const name = input(branch.name);
      this.bindDraft(name, value => { branch.name = value || '未命名分支'; });
      const remove = button('×', '刪除分支'); remove.disabled = branch.id === 'main'; remove.onclick = () => this.removeBranch(branch.id);
      row.append(color, name, remove);
      body.append(row);
    }

    if (this.data.variantGroups.length) {
      body.append(element('h3', '', '方案組'));
      for (const group of this.data.variantGroups) {
        const active = this.data.events.find(event => event.id === group.activeEventId);
        const row = element('div', 'timeline-overview-group');
        row.append(element('strong', '', group.name), element('small', '', `${group.eventIds.length} 個方案 · 採用：${active?.variantLabel || active?.title || '未指定'}`));
        body.append(row);
      }
    }
  }
}
