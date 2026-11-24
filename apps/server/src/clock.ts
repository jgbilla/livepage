// The person's own day. New pages are filed in a daily folder YYYY/MM/DD, and templates fill in
// {{date}} and {{time}}, by the person's local clock, not the server's (Render runs in UTC).
// The browser sends its date with each create; agents don't know it, so the app also remembers the
// person's time zone (sent by the browser as X-Time-Zone) and the server works the date out from that.
import type { Db } from './db.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/** An IANA time zone like "Europe/Paris", or null if this runtime does not know it. */
export function cleanTimeZone(raw: unknown): string | null {
  const tz = typeof raw === 'string' ? raw.trim() : '';
  if (!tz || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

/** "YYYY-MM-DD" and "HH:mm" at `now` in a time zone (the server's own when null). */
export function clockIn(tz: string | null, now = new Date()): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz ?? undefined, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

// Saved zones, so a browser that sends the same one on every request writes it once.
const known = new Map<string, string>();

/** Remember the time zone a person's browser reports (agents never set it: their clock may be elsewhere). */
export async function noteTimeZone(db: Db, userId: string, raw: unknown): Promise<void> {
  const tz = cleanTimeZone(raw);
  if (!tz || known.get(userId) === tz) return;
  known.set(userId, tz);
  await db.query('update users set time_zone = $2 where id = $1 and time_zone is distinct from $2', [userId, tz]).catch(() => known.delete(userId));
}

export async function timeZoneOf(db: Db, userId: string): Promise<string | null> {
  const [row] = await db.query('select time_zone from users where id = $1', [userId]).catch(() => []);
  return cleanTimeZone(row?.time_zone);
}

/** The date and time to use for a request: what the caller sent, else the person's own clock. */
export async function personClock(db: Db, userId: string, b: { date?: unknown; time?: unknown } = {}): Promise<{ date: string; time: string }> {
  const sentDate = typeof b.date === 'string' && DATE.test(b.date) ? b.date : null;
  const sentTime = typeof b.time === 'string' && TIME.test(b.time) ? b.time : null;
  if (sentDate && sentTime) return { date: sentDate, time: sentTime };
  const own = clockIn(await timeZoneOf(db, userId));
  return { date: sentDate ?? own.date, time: sentTime ?? own.time };
}
