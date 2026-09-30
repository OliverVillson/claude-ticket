import { formatClock, formatResetTime } from '../usage/format.ts';
import { displayWidth } from './format.ts';
import type { Style } from './style.ts';
import { GLYPHS } from '../ui/glyphs.ts';

/**
 * The usage-left indicator in the header: how much of the 5-hour window (and the week) is left,
 * as a short bar. Pure: a cached snapshot goes in, one styled string comes out, sized to the room
 * there is. The data layer (src/usage) owns fetching and refresh; the view only renders.
 *
 *   5h ▰▰▰▱▱ 38% left · resets 3:45pm  wk ▰▰▰▰▱ 72%     wide
 *   5h ▰▰▰▱▱ 38% · 3:45pm                                medium
 *   5h 38%                                               narrow
 *   usage n/a                                            no data (API-key auth, offline)
 */
export interface UsageWindow {
  /** 'five_hour', 'weekly', 'weekly_opus', ... */
  key: string;
  label: string;
  /** 0-100, null when the window is known but not measured */
  usedPercent: number | null;
  status: 'ok' | 'warning' | 'rejected' | 'unknown';
  /** epoch ms */
  resetsAt: number | null;
}

export interface UsageSnapshot {
  available: boolean;
  /** the numbers are older than the data layer wants: shown with a ~ */
  stale: boolean;
  fetchedAt: number;
  windows: UsageWindow[];
}

/** Where the App gets usage from; `subscribe` returns an unsubscribe. */
export interface UsageSource {
  get(): UsageSnapshot | null;
  subscribe(cb: (s: UsageSnapshot | null) => void): () => void;
}

const BAR_CELLS = 5;

export const percentLeft = (w: UsageWindow): number | null => (w.usedPercent == null ? null : Math.max(0, Math.min(100, Math.round(100 - w.usedPercent))));

export function windowOf(s: UsageSnapshot, key: 'five_hour' | 'weekly'): UsageWindow | undefined {
  return s.windows.find((w) => w.key === key) ?? (key === 'five_hour' ? s.windows.find((w) => /5|five|session/i.test(w.key + w.label)) : s.windows.find((w) => /week/i.test(w.key + w.label) && !/opus|sonnet/i.test(w.key)));
}

/** Colour by how close to the limit: greens, amber under 30% left, red under 10% or rejected. */
export function tone(w: UsageWindow): 'ok' | 'warn' | 'error' {
  const left = percentLeft(w);
  if (w.status === 'rejected' || (left != null && left <= 10)) return 'error';
  if (w.status === 'warning' || (left != null && left <= 30)) return 'warn';
  return 'ok';
}

const paint = (st: Style, t: 'ok' | 'warn' | 'error', s: string) => (t === 'error' ? st.red(s) : t === 'warn' ? st.yellow(s) : st.accent(s));

export function usageBar(left: number, cells = BAR_CELLS): string {
  const full = left <= 0 ? 0 : Math.max(1, Math.round((left / 100) * cells));
  return GLYPHS.barFull.repeat(full) + GLYPHS.barEmpty.repeat(cells - full);
}

interface Form {
  weekly: boolean;
  bar: boolean;
  left: boolean;
  reset: 'full' | 'short' | null;
}
const FORMS: Form[] = [
  { weekly: true, bar: true, left: true, reset: 'full' },
  { weekly: false, bar: true, left: true, reset: 'full' },
  { weekly: false, bar: true, left: false, reset: 'short' },
  { weekly: false, bar: true, left: false, reset: null },
  { weekly: false, bar: false, left: false, reset: null },
];

function render(s: UsageSnapshot, f: Form, st: Style, now: number): string {
  const five = windowOf(s, 'five_hour');
  const week = windowOf(s, 'weekly');
  const main = five ?? week;
  if (!main) return st.dim('usage n/a');
  const one = (w: UsageWindow, name: string, withReset: boolean) => {
    const left = percentLeft(w);
    if (left == null) return st.dim(`${name} ?`);
    const t = tone(w);
    let out = st.dim(name + ' ');
    if (f.bar) out += paint(st, t, usageBar(left)) + ' ';
    out += paint(st, t, `${left}%${s.stale ? '~' : ''}`);
    if (f.left && withReset) out += st.dim(' left');
    if (withReset && f.reset && w.resetsAt) out += st.dim(` ${GLYPHS.dot} ${f.reset === 'full' ? 'resets ' : ''}${f.reset === 'full' ? formatResetTime(w.resetsAt, now) : formatClock(w.resetsAt)}`);
    return out;
  };
  let out = one(main, main === five ? '5h' : 'wk', true);
  if (f.weekly && five && week) out += '  ' + one(week, 'wk', false);
  return out;
}

/** The indicator for `room` cells, or '' when even the smallest form does not fit. */
export function usageText(s: UsageSnapshot | null, room: number, st: Style, now = Date.now()): string {
  if (!s || !s.available || s.windows.length === 0) {
    const na = st.dim('usage n/a');
    return displayWidth('usage n/a') <= room ? na : '';
  }
  for (const f of FORMS) {
    const out = render(s, f, st, now);
    if (displayWidth(out) <= room) return out;
  }
  return '';
}
