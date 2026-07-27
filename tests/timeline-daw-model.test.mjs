import test from 'node:test';
import assert from 'node:assert/strict';
import { moveTimelineEventsModel, snapMeasure } from '../js/timeline-daw.js';

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
