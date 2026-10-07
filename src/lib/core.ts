// Small shared helpers: IDs, errors, clock, money, HTML escaping.
import crypto from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';

// ---------- IDs ----------
export const newId = (): string => uuidv7();
export const randomToken = (bytes = 32): string => crypto.randomBytes(bytes).toString('base64url');
export const sha256Hex = (data: string | Buffer): string => crypto.createHash('sha256').update(data).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);

// ---------- Clock (overridable in tests; never used to order sync events) ----------
export const clock = { now: (): Date => new Date() };
export const nowIso = (): string => clock.now().toISOString();

// ---------- Errors ----------
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} not found.`);
export const forbidden = () => new AppError(403, 'FORBIDDEN', 'You do not have permission to do this.');
export const invalid = (message: string, fields: Record<string, string> = {}) =>
  new AppError(422, 'VALIDATION', message, fields);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

// ---------- Money (integer minor units) ----------
const digitsCache = new Map<string, number>();
export function currencyDigits(currency: string): number {
  let d = digitsCache.get(currency);
  if (d === undefined) {
    d = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    digitsCache.set(currency, d);
  }
  return d;
}

/** Parse "1,234.50" into minor units without floating point. Returns null when invalid. */
export function parseMoney(input: string, currency: string): number | null {
  const digits = currencyDigits(currency);
  const s = String(input ?? '').trim().replace(/,/g, '');
  const m = /^(\d{1,10})(?:\.(\d*))?$/.exec(s);
  if (!m) return null;
  const frac = m[2] ?? '';
  if (frac.length > digits) return null;
  const minor = Number(m[1]) * 10 ** digits + Number((frac + '0'.repeat(digits)).slice(0, digits) || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}

export function formatMoney(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  // Build the decimal string from integers, then let Intl add symbol/grouping.
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 10 ** digits);
  const frac = String(abs % 10 ** digits).padStart(digits, '0');
  const fmt = new Intl.NumberFormat('en-PH', { style: 'currency', currency, minimumFractionDigits: digits });
  return sign + fmt.format(Number(digits ? `${whole}.${frac}` : `${whole}`));
}

/** Plain decimal string for form inputs, e.g. 150050 -> "1500.50". */
export function minorToInput(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  if (!digits) return String(minor);
  return `${Math.floor(minor / 10 ** digits)}.${String(minor % 10 ** digits).padStart(digits, '0')}`;
}

// ---------- HTML (auto-escaping tagged template) ----------
export class SafeHtml {
  constructor(public readonly value: string) {}
  toString(): string {
    return this.value;
  }
}
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);
function renderValue(v: unknown): string {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  return escapeHtml(String(v));
}
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + strings[i + 1]!;
  return new SafeHtml(out);
}

// ---------- Text normalisation for search / duplicate detection ----------
export const normalizeText = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
/** Last 10 digits, so 0917 123 4567 and +63 917 123 4567 match. */
export const normalizePhone = (s: string): string => s.replace(/\D/g, '').slice(-10);
