import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTimeZone, clockIn, personClock } from '../src/clock.ts';
import type { Db } from '../src/db.ts';

const at = new Date('2026-11-24T03:30:00Z'); // still Nov 23 in New York, already Nov 24 in Paris

test('the date comes from the person\'s time zone, not the server\'s', () => {
  assert.deepEqual(clockIn('America/New_York', at), { date: '2026-11-23', time: '22:30' });
  assert.deepEqual(clockIn('Europe/Paris', at), { date: '2026-11-24', time: '04:30' });
  assert.deepEqual(clockIn('UTC', new Date('2026-11-24T00:05:00Z')), { date: '2026-11-24', time: '00:05' });
});

test('only real time zones are kept', () => {
  assert.equal(cleanTimeZone('Europe/Paris'), 'Europe/Paris');
  assert.equal(cleanTimeZone('Mars/Olympus'), null);
  assert.equal(cleanTimeZone(''), null);
  assert.equal(cleanTimeZone(42), null);
});

test('a date the caller sends wins; otherwise the saved time zone is used', async () => {
  const db = { query: async () => [{ time_zone: 'Pacific/Kiritimati' }] } as unknown as Db; // UTC+14
  assert.deepEqual(await personClock(db, 'u', { date: '2026-01-02', time: '09:15' }), { date: '2026-01-02', time: '09:15' });
  const own = await personClock(db, 'u');
  assert.equal(own.date, clockIn('Pacific/Kiritimati').date);
  const none = { query: async () => [] } as unknown as Db;
  assert.equal((await personClock(none, 'u')).date, clockIn(null).date);
});
