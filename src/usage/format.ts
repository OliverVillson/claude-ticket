import type { PauseState } from './types.ts';

/** "45s", "12m", "1h 12m", "2d 4h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return h ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Local clock time the way Claude Code prints it: "3:45pm", "12:00am". */
export function formatClock(at: number): string {
  const d = new Date(at);
  const h24 = d.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}${h24 < 12 ? 'am' : 'pm'}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "3:45pm" today, "tomorrow 3:45pm", "Mon 12:00am" within the week, else "Oct 7 12:00am". */
export function formatResetTime(at: number, now = Date.now()): string {
  const d = new Date(at);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return formatClock(at);
  const tomorrow = new Date(n);
  tomorrow.setDate(n.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${formatClock(at)}`;
  if (at - now < 6 * 86_400_000 && at > now) return `${DAYS[d.getDay()]} ${formatClock(at)}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${formatClock(at)}`;
}

/**
 * One line for `ticket status` and the TUI header, e.g.
 * "session limit · resumes 3:45pm (in 1h 12m)" or
 * "Opus limit · Opus tickets resume Mon 12:00am (in 2d 4h) · other models keep running".
 */
export function formatPause(state: PauseState | null, now = Date.now()): string {
  if (!state) return 'running';
  if (state.manual && !(state.until > 0)) return 'paused by hand · ticket resume to continue';
  const left = state.until - now;
  const who = state.models.length ? `${state.models.map(cap).join('/')} tickets resume` : 'resumes';
  const when = left > 0 ? `${who} ${formatResetTime(state.until, now)} (in ${formatDuration(left)})` : 'checking whether the window is open';
  let line = `${state.reason} · ${when}`;
  if (state.models.length) line += ' · other models keep running';
  if (state.manual) line += ' · also paused by hand';
  return line;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
