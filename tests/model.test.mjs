import assert from 'node:assert/strict';
import test from 'node:test';
import { displayDate, localDateTime } from '../apps/web/src/model.ts';

test('datetime-local values use the local clock across timezones and daylight saving', () => {
  const originalZone = process.env.TZ;
  try {
    for (const [zone, instant, expected] of [
      ['America/Toronto', '2024-07-12T14:30:45Z', '2024-07-12T10:30'],
      ['America/Toronto', '2024-12-12T14:30:45Z', '2024-12-12T09:30'],
      ['Asia/Tokyo', '2024-07-12T23:30:00Z', '2024-07-13T08:30'],
      ['UTC', '2024-07-12T14:30:00Z', '2024-07-12T14:30']
    ]) {
      process.env.TZ = zone;
      assert.equal(localDateTime(instant), expected);
    }
    assert.equal(localDateTime(null), '');
    assert.equal(localDateTime(), '');
    assert.equal(localDateTime('invalid date'), '');
  } finally {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  }
});

test('display dates use the local calendar day for full and offset timestamps', () => {
  const originalZone = process.env.TZ;
  try {
    process.env.TZ = 'America/Toronto';
    const toronto = '2024-07-13T02:30:00Z';
    assert.equal(localDateTime(toronto), '2024-07-12T22:30');
    assert.equal(displayDate(toronto), 'July 12, 2024');
    assert.equal(displayDate(toronto, true), 'Jul 12');

    const offset = '2024-07-13T01:30:00+02:00';
    assert.equal(localDateTime(offset), '2024-07-12T19:30');
    assert.equal(displayDate(offset), 'July 12, 2024');

    process.env.TZ = 'Asia/Tokyo';
    const tokyo = '2024-07-12T23:30:00Z';
    assert.equal(localDateTime(tokyo), '2024-07-13T08:30');
    assert.equal(displayDate(tokyo), 'July 13, 2024');

    process.env.TZ = 'UTC';
    assert.equal(displayDate('2024-07-13T00:30:00Z'), 'July 13, 2024');
    assert.equal(displayDate(undefined), 'Date unknown');
    assert.equal(displayDate(null), 'Date unknown');
    assert.equal(displayDate('invalid date'), 'Date unknown');
  } finally {
    if (originalZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalZone;
  }
});
