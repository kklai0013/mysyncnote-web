import test from 'node:test';
import assert from 'node:assert/strict';
import { moveTimelineEventsModel, reorderTimelineItemsModel, snapMeasure, TimelineView } from '../js/timeline-daw.js';

function clip(id, trackId, position, duration = 2) {
  return { id, title: id, trackIds: [trackId], time: { position, duration } };
}

test('事件位置吸附到整數小節', () => {
  assert.equal(snapMeasure(1.49), 1);
  assert.equal(snapMeasure(1.5), 2);
  assert.equal(snapMeasure(-10), 0);
});

test('多事件拖曳會保留相對小節與軌道距離', () => {
  const data = {
    events: [
      clip('anchor', 'track-a', 4, 2),
      clip('second', 'track-b', 7, 3),
      clip('untouched', 'track-c', 9, 1)
    ]
  };
  const moved = moveTimelineEventsModel(
    data,
    ['anchor', 'second'],
    'anchor',
    'track-b',
    10,
    ['track-a', 'track-b', 'track-c']
  );
  assert.equal(moved, true);
  assert.deepEqual(data.events[0].trackIds, ['track-b']);
  assert.equal(data.events[0].time.position, 10);
  assert.deepEqual(data.events[1].trackIds, ['track-c']);
  assert.equal(data.events[1].time.position, 13);
  assert.deepEqual(data.events[2].trackIds, ['track-c']);
  assert.equal(data.events[2].time.position, 9);
});

test('多事件拖到時間線左側不會產生負小節', () => {
  const data = { events: [clip('anchor', 'track-a', 5), clip('earlier', 'track-a', 2)] };
  moveTimelineEventsModel(data, ['anchor', 'earlier'], 'anchor', 'track-a', 0, ['track-a']);
  assert.equal(data.events.find(event => event.id === 'earlier').time.position, 0);
  assert.equal(data.events.find(event => event.id === 'anchor').time.position, 3);
});

test('軌道與資料夾可在同一層混合排序', () => {
  const data = {
    trackGroups: [{ id: 'folder', parentId: null, order: 1000 }],
    tracks: [
      { id: 'track-a', groupId: null, order: 0 },
      { id: 'track-b', groupId: null, order: 2000 }
    ]
  };
  assert.equal(reorderTimelineItemsModel(data, { trackIds: ['track-b'] }, 'group', 'folder', 'before'), true);
  const trackA = data.tracks.find(track => track.id === 'track-a');
  const trackB = data.tracks.find(track => track.id === 'track-b');
  assert.ok(trackA.order < trackB.order);
  assert.ok(trackB.order < data.trackGroups[0].order);
});

test('多選軌道移入資料夾時保持整組順序', () => {
  const data = {
    trackGroups: [{ id: 'folder', parentId: null, order: 3000 }],
    tracks: [
      { id: 'a', groupId: null, order: 0 },
      { id: 'b', groupId: null, order: 1000 },
      { id: 'c', groupId: null, order: 2000 }
    ]
  };
  assert.equal(reorderTimelineItemsModel(data, { trackIds: ['a', 'b'] }, 'group', 'folder', 'inside'), true);
  const inside = data.tracks.filter(track => track.groupId === 'folder').sort((a, b) => a.order - b.order);
  assert.deepEqual(inside.map(track => track.id), ['a', 'b']);
});

test('資料夾不能移進自己的後代', () => {
  const data = {
    trackGroups: [
      { id: 'parent', parentId: null, order: 0 },
      { id: 'child', parentId: 'parent', order: 0 }
    ],
    tracks: []
  };
  assert.equal(reorderTimelineItemsModel(data, { groupId: 'parent' }, 'group', 'child', 'inside'), false);
  assert.equal(data.trackGroups.find(group => group.id === 'parent').parentId, null);
});

test('文字編輯失焦不會替換事件物件並遺失接著輸入的內容', () => {
  class FakeControl {
    constructor(value) {
      this.value = value;
      this.tagName = 'TEXTAREA';
      this.type = '';
      this.listeners = new Map();
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    fire(type) {
      for (const listener of this.listeners.get(type) || []) listener({ key: '', preventDefault() {}, stopPropagation() {} });
    }
  }

  const draftEvent = { id: 'event', description: '舊內容' };
  const view = Object.create(TimelineView.prototype);
  view.data = { title: '測試', events: [draftEvent] };
  view.json = () => JSON.stringify(view.data);
  view.snapshot = () => view.json();
  view.pushHistory = () => {};
  view.onChange = () => {};
  view.render = () => {};
  const control = new FakeControl(draftEvent.description);
  view.bindDraft(control, value => { draftEvent.description = value; });
  control.fire('focus');
  control.value = '剛輸入、接著拖曳也必須保留';
  control.fire('input');
  control.fire('blur');
  assert.strictEqual(view.data.events[0], draftEvent);
  assert.equal(view.data.events[0].description, '剛輸入、接著拖曳也必須保留');
});
