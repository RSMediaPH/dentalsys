// Timezone helpers. Everything is stored in UTC; branches display in their own timezone.
import { DateTime } from 'luxon';
import { clock, invalid } from './core.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDate(s: string): boolean {
  return DATE_RE.test(s) && DateTime.fromISO(s, { zone: 'utc' }).isValid;
}

/** Convert a branch-local date + "HH:mm" into a UTC ISO string. Rejects nonexistent local times. */
export function localToUtcIso(date: string, time: string, tz: string): string {
  if (!isValidDate(date)) throw invalid('Please enter a valid date.', { date: 'Invalid date' });
  if (!TIME_RE.test(time)) throw invalid('Please enter a valid time (HH:MM).', { time: 'Invalid time' });
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: tz });
  if (!dt.isValid || dt.toFormat('yyyy-MM-dd HH:mm') !== `${date} ${time}`) {
    throw invalid('That local time does not exist in the branch timezone.', { time: 'Invalid local time' });
  }
  return dt.toUTC().toISO({ suppressMilliseconds: false })!;
}

export const toLocal = (iso: string, tz: string): DateTime => DateTime.fromISO(iso, { zone: 'utc' }).setZone(tz);

/** [start, end) of a branch-local calendar day, as UTC ISO strings. */
export function dayRangeUtc(date: string, tz: string): [string, string] {
  if (!isValidDate(date)) throw invalid('Please enter a valid date.', { date: 'Invalid date' });
  const start = DateTime.fromISO(date, { zone: tz }).startOf('day');
  return [start.toUTC().toISO()!, start.plus({ days: 1 }).toUTC().toISO()!];
}

export const todayIn = (tz: string): string => DateTime.fromJSDate(clock.now()).setZone(tz).toISODate()!;

export const minutesToHHMM = (m: number): string =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export const fmtDateTime = (iso: string | null | undefined, tz: string): string =>
  iso ? toLocal(iso, tz).toFormat('d MMM yyyy, h:mm a') : '';
export const fmtTime = (iso: string, tz: string): string => toLocal(iso, tz).toFormat('h:mm a');
export const fmtDate = (isoDate: string): string =>
  isoDate ? DateTime.fromISO(isoDate, { zone: 'utc' }).toFormat('d MMM yyyy') : '';
