// Model + date normalisation helpers shared across the API and scrapers.

const SUFFIXES = ['/k9', '-bundle', '-sec', '-ipbase'];

/**
 * Normalise a raw model string for fuzzy matching.
 * - lowercase
 * - strip common suffixes (/k9, -bundle, -sec, -ipbase)
 * - remove special chars except spaces and dots
 * - collapse multiple spaces
 * Example: "Cisco ISR 4321/K9" -> "cisco isr 4321"
 */
export function normalizeModel(input: string): string {
  let s = (input || '').toLowerCase().trim();
  for (const suffix of SUFFIXES) {
    while (s.endsWith(suffix)) {
      s = s.slice(0, -suffix.length);
    }
  }
  // Remove special chars except spaces and dots.
  s = s.replace(/[^a-z0-9 .]/g, ' ');
  // Collapse multiple spaces.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

const MONTHS: Record<string, number> = {
  january: 1, jan: 1,
  february: 2, feb: 2,
  march: 3, mar: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

function iso(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// Last day of a month (handles leap years).
function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Normalise a date value from a variety of formats into an ISO date string
 * (YYYY-MM-DD), or null when it cannot / should not be represented as a date.
 *
 * Handles:
 *   "2026-03-31"      -> 2026-03-31
 *   "March 31, 2026"  -> 2026-03-31
 *   "31/03/2026"      -> 2026-03-31
 *   "Q1 2026"         -> 2026-03-31 (end of quarter)
 *   "2026"            -> 2026-12-31
 *   true / false      -> null
 */
export function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return null;

  let s = String(value).trim();
  if (!s) return null;

  // ISO: 2026-03-31 (also tolerate datetime suffix)
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    return iso(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  // Quarter: "Q1 2026" -> end of quarter
  m = s.match(/^q([1-4])\s+(\d{4})$/i);
  if (m) {
    const q = Number(m[1]);
    const year = Number(m[2]);
    const month = q * 3; // Q1->3, Q2->6, Q3->9, Q4->12
    return iso(year, month, lastDay(year, month));
  }

  // Year only: "2026" -> Dec 31
  m = s.match(/^(\d{4})$/);
  if (m) {
    return iso(Number(m[1]), 12, 31);
  }

  // DD/MM/YYYY -> 31/03/2026
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return iso(year, month, day);
    }
  }

  // "March 31, 2026" or "31 March 2026" or "March 2026"
  const lower = s.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const monthName = Object.keys(MONTHS).find((name) =>
    new RegExp(`(^|\\s)${name}(\\s|$)`).test(lower)
  );
  if (monthName) {
    const month = MONTHS[monthName];
    const yearMatch = lower.match(/\b(\d{4})\b/);
    const dayMatch = lower.match(/\b(\d{1,2})\b/);
    if (yearMatch) {
      const year = Number(yearMatch[1]);
      const day = dayMatch ? Number(dayMatch[1]) : lastDay(year, month);
      return iso(year, month, Math.min(day, lastDay(year, month)));
    }
  }

  return null;
}
