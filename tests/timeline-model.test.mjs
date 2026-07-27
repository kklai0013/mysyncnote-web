import test from 'node:test';
import assert from 'node:assert/strict';
import {
  branchLineage,
  branchVisibleEvents,
  createEmptyTimeline,
  moveNarrativeItemModel,
  normalizeTimeline,
  relativeChainIncludes,
  resolveChronology,
  validateTimeline,
  visibleEvents
} from '../js/timeline.js';

function event(id, overrides = {}) {
  return {
    id,
    title: id,
    description: '',
    time: { kind: 'undated', start: '', end: '', precision: 'exact', momentId: '', anchorId: '', offset: 0, unit: 'day' },
    trackIds: ['track-main'],
    branchId: 'main',
    variantGroupId: null,
    variantLabel: '',
    notePaths: [],
    tags: [],
    status: 'idea',
    dependsOn: [],
    order: 0,
    ...overrides
  };
}

function base() {
  return normalizeTimeline({
    ...createEmptyTimeline('測試'),
    tracks: [{ id: 'track-main', name: '主線', color: '#78dba0', order: 0 }],
    narrativeSections: [{ id: 'section-main', title: '故事', order: 0 }]
  });
}

test('空白資料會補上必要結構並保留未知欄位', () => {
  const data = normalizeTimeline({ title: '故事', futureField: { keep: true } });
  assert.equal(data.format, 'mysyncnote-timeline');
  assert.equal(data.version, 1);
  assert.equal(data.tracks.length, 1);
  assert.equal(data.branches.some(branch => branch.id === 'main'), true);
  assert.deepEqual(data.futureField, { keep: true });
});

test('較新版本不會被舊版程式正規化覆寫', () => {
  assert.throws(() => normalizeTimeline({ format: 'mysyncnote-timeline', version: 2 }), /較新的第 2 版/);
});

test('軌道資料夾會保留成員關係，遺失的資料夾會安全解除', () => {
  const data = normalizeTimeline({
    ...createEmptyTimeline('版本管理'),
    trackGroups: [{ id: 'versions', name: '版本', collapsed: true, order: 0 }],
    tracks: [
      { id: 'track-a', name: '版本 A', color: '#78dba0', groupId: 'versions', order: 0 },
      { id: 'track-b', name: '版本 B', color: '#7fb5ff', groupId: 'missing', order: 1000 }
    ]
  });
  assert.equal(data.trackGroups[0].collapsed, true);
  assert.equal(data.tracks.find(track => track.id === 'track-a').groupId, 'versions');
  assert.equal(data.tracks.find(track => track.id === 'track-b').groupId, null);
});

test('事件片段會正規化開始位置與長度，並可從舊數字時間推導', () => {
  const data = base();
  data.events = [
    event('a', { time: { kind: 'exact', start: '8', end: '14', precision: 'exact', momentId: '', anchorId: '', offset: 0, unit: 'day' } }),
    event('b', { time: { kind: 'exact', start: '', end: '', precision: 'exact', momentId: '', anchorId: '', offset: 0, unit: 'day', position: -3, duration: 0 } })
  ];
  const normalized = normalizeTimeline(data);
  assert.equal(normalized.events[0].time.position, 8);
  assert.equal(normalized.events[0].time.duration, 6);
  assert.equal(normalized.events[1].time.position, 0);
  assert.equal(normalized.events[1].time.duration, 1);
});

test('相對時間可連續解析，並能偵測循環', () => {
  const data = base();
  data.events = [
    event('a', { time: { kind: 'exact', start: '2026-01-01T00:00:00', end: '', precision: 'exact', momentId: '', anchorId: '', offset: 0, unit: 'day' } }),
    event('b', { time: { kind: 'relative', start: '', end: '', precision: 'exact', momentId: '', anchorId: 'a', offset: 2, unit: 'day' } }),
    event('c', { time: { kind: 'relative', start: '', end: '', precision: 'exact', momentId: '', anchorId: 'b', offset: 3, unit: 'hour' } })
  ];
  const normalized = normalizeTimeline(data);
  const rows = new Map(resolveChronology(normalized).rows.map(row => [row.eventId, row]));
  assert.equal(rows.get('b').value - rows.get('a').value, 2 * 24 * 60 * 60 * 1000);
  assert.equal(rows.get('c').value - rows.get('b').value, 3 * 60 * 60 * 1000);

  normalized.events.find(item => item.id === 'a').time = { kind: 'relative', start: '', end: '', precision: 'exact', momentId: '', anchorId: 'c', offset: 1, unit: 'day' };
  assert.ok(validateTimeline(normalized).warnings.some(message => message.includes('循環')));
});

test('純數字故事時間用日數解析，不會混入毫秒單位', () => {
  const data = base();
  data.events = [
    event('day-3', { order: 0, time: { kind: 'exact', start: '3', end: '', precision: 'exact', momentId: '', anchorId: '', offset: 0, unit: 'day' } }),
    event('day-4', { order: 1000, time: { kind: 'exact', start: '4', end: '', precision: 'exact', momentId: '', anchorId: '', offset: 0, unit: 'day' } }),
    event('day-5', { order: 2000, time: { kind: 'relative', start: '', end: '', precision: 'exact', momentId: '', anchorId: 'day-3', offset: 2, unit: 'day' } })
  ];
  const rows = resolveChronology(normalizeTimeline(data)).rows;
  assert.deepEqual(rows.map(row => row.eventId), ['day-3', 'day-4', 'day-5']);
  assert.equal(rows.find(row => row.eventId === 'day-5').value, 5);
});

test('相對時間鏈可預先阻止拖曳形成間接循環', () => {
  const data = base();
  data.events = [
    event('a', { time: { kind: 'undated', start: '', end: '', precision: 'exact', momentId: '', anchorId: '', offset: 0, unit: 'day' } }),
    event('b', { time: { kind: 'relative', start: '', end: '', precision: 'exact', momentId: '', anchorId: 'a', offset: 1, unit: 'day' } }),
    event('c', { time: { kind: 'relative', start: '', end: '', precision: 'exact', momentId: '', anchorId: 'b', offset: 1, unit: 'day' } })
  ];
  const normalized = normalizeTimeline(data);
  assert.equal(relativeChainIncludes(normalized, 'c', 'a'), true);
  assert.equal(relativeChainIncludes(normalized, 'a', 'c'), false);
});

test('敘事順序可重複引用同一事件並跨章節移動', () => {
  const data = base();
  data.events = [event('a')];
  data.narrativeSections.push({ id: 'section-two', title: '第二章', order: 1000 });
  data.narrativeItems = [
    { id: 'n1', eventId: 'a', sectionId: 'section-main', order: 1000, label: '伏筆' },
    { id: 'n2', eventId: 'a', sectionId: 'section-main', order: 2000, label: '揭露' }
  ];
  const normalized = normalizeTimeline(data);
  assert.equal(normalized.narrativeItems.length, 2);
  moveNarrativeItemModel(normalized, 'n2', 'section-two');
  assert.equal(normalized.narrativeItems.find(item => item.id === 'n2').sectionId, 'section-two');
});

test('敘事項目可以插到 order 為零的第一項之前', () => {
  const data = base();
  data.events = [event('a'), event('b')];
  data.narrativeItems = [
    { id: 'n1', eventId: 'a', sectionId: 'section-main', order: 0, label: '' },
    { id: 'n2', eventId: 'b', sectionId: 'section-main', order: 1000, label: '' }
  ];
  const normalized = normalizeTimeline(data);
  moveNarrativeItemModel(normalized, 'n2', 'section-main', 'n1');
  assert.ok(normalized.narrativeItems.find(item => item.id === 'n2').order < normalized.narrativeItems.find(item => item.id === 'n1').order);
});

test('分支血統只包含祖先，子分支不會看到父分支分叉後事件', () => {
  const data = base();
  data.branches.push({ id: 'alt', name: '替代線', parentId: 'main', fromEventId: 'fork', color: '#7fb5ff', order: 1000 });
  data.events = [
    event('before', { order: 0 }),
    event('fork', { order: 1000 }),
    event('after-main', { order: 2000 }),
    event('after-alt', { branchId: 'alt', order: 3000 })
  ];
  const normalized = normalizeTimeline(data);
  assert.deepEqual(branchLineage(normalized, 'alt').map(branch => branch.id), ['main', 'alt']);
  assert.deepEqual(new Set(branchVisibleEvents(normalized, 'alt').map(item => item.id)), new Set(['before', 'fork', 'after-alt']));
});

test('子分支包含分叉時刻的同時事件，但排除同一組的互斥方案', () => {
  const data = base();
  data.branches.push({ id: 'alt', name: '替代線', parentId: 'main', fromEventId: 'fork', color: '#7fb5ff', order: 1000 });
  data.variantGroups = [{ id: 'choice', name: '選擇', activeEventId: 'fork', eventIds: ['fork', 'other-choice'], order: 0 }];
  const sameTime = { kind: 'exact', start: '3', end: '', precision: 'exact', momentId: 'moment-3', anchorId: '', offset: 0, unit: 'day' };
  data.events = [
    event('before', { order: 0, time: { ...sameTime, start: '2', momentId: '' } }),
    event('fork', { order: 1000, time: { ...sameTime }, variantGroupId: 'choice', variantLabel: 'A' }),
    event('same-moment', { order: 2000, time: { ...sameTime } }),
    event('other-choice', { order: 3000, time: { ...sameTime }, variantGroupId: 'choice', variantLabel: 'B' }),
    event('after-main', { order: 4000, time: { ...sameTime, start: '4', momentId: '' } }),
    event('after-alt', { branchId: 'alt', order: 5000, time: { kind: 'relative', start: '', end: '', precision: 'exact', momentId: '', anchorId: 'fork', offset: 1, unit: 'day' } })
  ];
  const normalized = normalizeTimeline(data);
  assert.deepEqual(
    new Set(branchVisibleEvents(normalized, 'alt').map(item => item.id)),
    new Set(['before', 'fork', 'same-moment', 'after-alt'])
  );
});

test('搜尋會涵蓋描述、標籤、筆記路徑、軌道和分支', () => {
  const data = base();
  data.tracks[0].name = '角色甲';
  data.events = [event('a', { title: '逃亡', description: '穿過森林', tags: ['伏筆'], notePaths: ['人物/主角.md'] })];
  const normalized = normalizeTimeline(data);
  for (const query of ['森林', '#伏筆', '主角', '角色甲', '主時間線']) {
    assert.equal(visibleEvents(normalized, { query }).length, 1);
  }
});
