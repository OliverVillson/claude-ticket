// Pure helpers for the notification window: geometry (so a mouse position maps to a row) and
// how a message is drawn. The component in components/NotifView.tsx only wires these to Ink.
import { notifText, type Notif } from '../notif/index.ts';
import { GLYPHS } from '../ui/glyphs.ts';
import { fit, relTime, truncate, wrapText } from './format.ts';
import type { Style } from './style.ts';
import { paint, type Tone } from './theme.ts';

/** Lines the frame takes: header, two border lines, the hint bar, plus one spare (as the other screens). */
export const NOTIF_CHROME = 5;

/** Screen rows above the first message: the header line and the top border. */
export const NOTIF_TOP_ROWS = 2;

/** Columns left of a message row's text: the border and its padding. */
export const NOTIF_LEFT_COLS = 2;

export interface NotifGeometry {
  /** message rows (one line each) */
  listRows: number;
  /** lines of the selected message's text under the list (0 when the terminal is too short) */
  detailRows: number;
}

export function notifGeometry(termRows: number): NotifGeometry {
  const inner = Math.max(3, termRows - NOTIF_CHROME);
  const detailRows = inner >= 10 ? 5 : inner >= 7 ? 3 : 0;
  const listRows = Math.max(1, inner - (detailRows ? detailRows + 1 : 0));
  return { listRows, detailRows };
}

/**
 * Which message is under a mouse position: `y` and `x` are 1-based terminal coordinates, `top` is
 * the index of the first visible message. -1 when the pointer is outside the list.
 */
export function rowAt(y: number, x: number, geo: NotifGeometry, top: number, count: number, columns: number): number {
  const row = y - NOTIF_TOP_ROWS - 1;
  if (row < 0 || row >= geo.listRows) return -1;
  if (x < NOTIF_LEFT_COLS || x > columns - 1) return -1;
  const i = top + row;
  return i < count ? i : -1;
}

const LEVEL_TONE: Record<Notif['level'], Tone> = { success: 'green', warn: 'yellow', error: 'red', info: 'plain' };

export function levelTone(n: Pick<Notif, 'level'>): Tone {
  return LEVEL_TONE[n.level];
}

/** One glyph per kind of message; a note that reports an error looks like a failure. */
export function glyphFor(n: Pick<Notif, 'type' | 'level'>): string {
  switch (n.type) {
    case 'ticket.done':
      return GLYPHS.done;
    case 'ticket.blocked':
      return GLYPHS.blocked;
    case 'ticket.failed':
      return GLYPHS.failed;
    case 'orchestrator.paused':
      return GLYPHS.paused;
    case 'ticket.started':
      return GLYPHS.start;
    default:
      return n.level === 'error' ? GLYPHS.failed : GLYPHS.dot;
  }
}

/**
 * `❯ ● ✓ "fix login" is done                 web › fix login   3m`
 * The dot is lit while the message is unread; the row the pointer or cursor is on is bold green.
 */
export function renderNotifRow(n: Notif, o: { width: number; now: number; selected: boolean; style: Style }): string {
  const { style: st, width } = o;
  const unread = n.read_at == null;
  const where = `${n.project}${n.ticket ? ` › ${n.ticket.name}` : ''}`;
  const age = relTime(n.at, o.now);
  const rightW = Math.min(Math.max(10, Math.floor(width / 3)), 34);
  const right = fit(`${where}  ${age}`.trim(), rightW, 'right');
  const leftW = Math.max(6, width - rightW - 2 - 6);
  const title = fit(n.title, leftW);
  const lead = (o.selected ? st.accent(GLYPHS.cursor) : ' ') + ' ' + (unread ? st.accent('●') : st.dim('○')) + ' ';
  const body = paint(st, levelTone(n), glyphFor(n)) + ' ' + (o.selected ? paint(st, 'accent', title, { bold: true }) : unread ? st.text(title) : st.dim(title));
  return st.base(lead + body + '  ' + st.dim(right));
}

/** The text of the selected message for the strip under the list: where, when, then the body. */
export function detailLines(n: Notif, width: number, rows: number, now: number): string[] {
  const age = relTime(n.at, now);
  const head = `${n.project}${n.ticket ? ` › ${n.ticket.name}` : ''} · from ${n.from} · ${age === 'now' ? 'just now' : age + ' ago'}`;
  const lines = [head, ...notifText(n, now).flatMap((t) => wrapText(t, width))];
  if (lines.length <= rows) return lines;
  const cut = lines.slice(0, rows);
  cut[rows - 1] = truncate(cut[rows - 1]! + ' …', width);
  return cut;
}

/** Keep `cursor` inside the window of `rows` messages; returns the new top index. */
export function scrollTopFor(top: number, cursor: number, rows: number, count: number): number {
  const maxTop = Math.max(0, count - rows);
  let t = Math.min(Math.max(0, top), maxTop);
  if (cursor < t) t = cursor;
  else if (cursor >= t + rows) t = cursor - rows + 1;
  return Math.min(Math.max(0, t), maxTop);
}
