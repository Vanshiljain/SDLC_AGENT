const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
  ['second', 1],
];

export function timeAgo(input: string | Date | null | undefined, now = Date.now()): string {
  if (!input) return '—';
  const diff = (new Date(input).getTime() - now) / 1000;
  if (Math.abs(diff) < 10) return 'just now';
  for (const [unit, seconds] of UNITS) {
    if (Math.abs(diff) >= seconds || unit === 'second') return rtf.format(Math.round(diff / seconds), unit);
  }
  return '—';
}

export function formatDateTime(input: string | Date | null | undefined): string {
  if (!input) return '—';
  return new Date(input).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function durationBetween(start: string | null | undefined, end: string | null | undefined, now = Date.now()): number | null {
  if (!start) return null;
  return (end ? new Date(end).getTime() : now) - new Date(start).getTime();
}

export function formatNumber(n: number | null | undefined, opts: Intl.NumberFormatOptions = {}): string {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat(undefined, { notation: n >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 1, ...opts }).format(n);
}

export function formatPercent(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined) return '—';
  return `${Math.round(ratio * (ratio <= 1 ? 100 : 1))}%`;
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '')).toUpperCase();
}

export function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/[_.-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '—';
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
