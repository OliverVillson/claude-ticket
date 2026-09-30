import type { TicketStatus } from '../db/types.ts';
import type { Style } from './style.ts';

/**
 * Visual language borrowed from the Claude Code CLI: a muted grey palette, one accent colour
 * (Claude's orange) for the cursor row and running tickets, rounded single-line borders, and a
 * dim hint line under the frame.
 */
export const ACCENT = '#D97757';

/** Cursor marker in front of the selected row, as in the claude prompt. */
export const CURSOR_GLYPH = '❯';

/** The claude "thinking" spinner frames, used for running tickets. */
export const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽'];

export type Tone = 'accent' | 'magenta' | 'yellow' | 'red' | 'green' | 'plain';

export interface StatusStyle {
  glyph: string;
  tone: Tone;
  dim?: boolean;
  label: string;
}

export const STATUS_STYLE: Record<TicketStatus, StatusStyle> = {
  running: { glyph: '●', tone: 'accent', label: 'running' },
  paused: { glyph: '‖', tone: 'magenta', label: 'paused' },
  todo: { glyph: '○', tone: 'plain', dim: true, label: 'todo' },
  blocked: { glyph: '?', tone: 'yellow', label: 'blocked' },
  failed: { glyph: '✗', tone: 'red', label: 'failed' },
  done: { glyph: '✓', tone: 'green', dim: true, label: 'done' },
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
