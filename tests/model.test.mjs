import assert from 'node:assert/strict';
import test from 'node:test';
import { localDateTime } from '../apps/web/src/model.ts';

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
