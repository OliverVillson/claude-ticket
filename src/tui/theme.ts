import type { TicketStatus } from '../db/types.ts';
import type { Style } from './style.ts';
import { GLYPHS } from '../ui/glyphs.ts';

/**
 * Visual language: matrix green on black (palette in ../ui/theme.ts). Bright green marks focus
 * (cursor row, running tickets, wordmark), dim green is chrome (borders, hints), amber warns,
 * red errors, teal means paused. Rounded single-line borders and a hint line under the frame,
 * in the manner of the claude prompt box.
 */

/** Cursor marker in front of the selected row, as in the claude prompt. */
export const CURSOR_GLYPH = GLYPHS.cursor;

/** The claude "thinking" spinner frames, used for running tickets (✳ left out: it is an emoji). */
export const SPINNER_FRAMES = GLYPHS.spinner;

/** Tone names map to palette roles: accent=bright green, green=ok, yellow=warn (amber), red=error, magenta=paused (teal). */
export type Tone = 'accent' | 'magenta' | 'yellow' | 'red' | 'green' | 'plain';

export interface StatusStyle {
  glyph: string;
  tone: Tone;
  dim?: boolean;
  label: string;
}

export const STATUS_STYLE: Record<TicketStatus, StatusStyle> = {
  running: { glyph: GLYPHS.running, tone: 'accent', label: 'running' },
  paused: { glyph: GLYPHS.paused, tone: 'magenta', label: 'paused' },
  todo: { glyph: GLYPHS.todo, tone: 'plain', dim: true, label: 'todo' },
  blocked: { glyph: GLYPHS.blocked, tone: 'yellow', label: 'blocked' },
  failed: { glyph: GLYPHS.failed, tone: 'red', label: 'failed' },
  done: { glyph: GLYPHS.done, tone: 'green', label: 'done' },
};

/** Order statuses appear in summaries (mirrors the list sort order). */
export const STATUS_ORDER: TicketStatus[] = ['running', 'paused', 'todo', 'blocked', 'failed', 'done'];

/** Colour `text` with a tone, optionally dimmed and/or bold. */
export function paint(st: Style, tone: Tone, text: string, o: { dim?: boolean; bold?: boolean } = {}): string {
  let s = text;
  if (tone !== 'plain') s = st[tone](s);
  if (o.bold) s = st.bold(s);
  if (o.dim) s = st.dim(s);
  return s;
}

export function paintStatus(st: Style, status: TicketStatus, text: string): string {
  const s = STATUS_STYLE[status];
  return paint(st, s.tone, text, { dim: s.dim });
}

/** Priority 0 ("now") and 1 are loud, 2 is noticeable, 3 to 5 fade out. */
export function paintPriority(st: Style, p: number, text: string): string {
  if (p <= 0) return paint(st, 'accent', text, { bold: true });
  if (p === 1) return paint(st, 'accent', text);
  if (p === 2) return paint(st, 'yellow', text);
  if (p === 3) return text;
  return st.dim(text);
}
