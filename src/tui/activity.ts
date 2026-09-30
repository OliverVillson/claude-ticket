import type { TicketView } from '../db/types.ts';
import { wrapText, displayWidth } from './format.ts';
import type { LogLine } from './log-tail.ts';
import type { Style } from './style.ts';
import { renderDog } from './dog/render.ts';
import { sleepFrame } from './dog/line.ts';
import { GLYPHS } from '../ui/glyphs.ts';

/**
 * The live-activity area between the panes and the command line: what the worker of one
 * running ticket is doing, in the claude transcript style. Pure helpers; the app supplies the
 * log lines (read from the same jsonl file `salu log` reads).
 */

/**
 * Which ticket the area follows: the pinned one if it exists, else the selected ticket when it is
 * running, else the most recently updated running ticket.
 */
export function pickTarget(tickets: TicketView[], selected: TicketView | undefined, pinnedId: number | null): TicketView | null {
  if (pinnedId != null) {
    const pinned = tickets.find((t) => t.id === pinnedId);
    if (pinned) return pinned;
  }
  if (selected?.status === 'running') return selected;
  let best: TicketView | null = null;
  for (const t of tickets) if (t.status === 'running' && (!best || t.updated_at > best.updated_at)) best = t;
  return best;
}

/** Display lines for the log, wrapped to `width`, styled per kind. Continuation lines are indented. */
export function activityLines(log: LogLine[], width: number, st: Style): string[] {
  const out: string[] = [];
  const room = Math.max(8, width - 2);
  for (const l of log) {
    const parts = wrapText(l.text, room);
    parts.forEach((part, i) => {
      const lead = i === 0 ? glyph(l.kind, st) : '  ';
      out.push(st.base(lead + paintText(l.kind, part, st)));
    });
  }
  return out;
}

function glyph(kind: LogLine['kind'], st: Style): string {
  switch (kind) {
    case 'tool':
      return st.dim(GLYPHS.say + ' ');
    case 'text':
      return st.accent(GLYPHS.say + ' ');
    case 'result':
      return st.green(GLYPHS.done + ' ');
    case 'error':
      return st.red(GLYPHS.failed + ' ');
    default:
      return st.dim(GLYPHS.dot + ' ');
  }
}

function paintText(kind: LogLine['kind'], text: string, st: Style): string {
  switch (kind) {
    case 'tool':
      return st.dim(text);
    case 'result':
      return st.green(text);
    case 'error':
      return st.red(text);
    case 'system':
    case 'raw':
      return st.dim(text);
    default:
      return st.text(text);
  }
}

/** The window of `all` shown when scrolled back by `back` lines from the newest, `height` rows tall. */
export function visibleWindow(all: string[], height: number, back: number): { lines: string[]; back: number } {
  const maxBack = Math.max(0, all.length - height);
  const b = Math.min(Math.max(0, back), maxBack);
  const end = all.length - b;
  return { lines: all.slice(Math.max(0, end - height), end), back: b };
}

/**
 * Calm empty state: a sleeping dog and a line of text, centred in `width` x `height`. `egg` swaps
 * in an easter-egg frame (eggs.ts) for the dog, and its words for the text on the one-line version.
 */
export function idleLines(width: number, height: number, st: Style, tick: number, egg?: { lines: string[]; say?: string }): string[] {
  const dog = egg?.lines ?? renderDog(tick, { mode: 'sleep', size: 'full', level: st.level });
  const text = egg?.say ? st.bold(st.text(egg.say)) : st.dim('no tickets running');
  const pad = (s: string) => ' '.repeat(Math.max(0, Math.floor((width - displayWidth(s)) / 2))) + s;
  // Too short for the whole dog: one line with a tiny sleeper instead of a cropped sprite.
  const fits = height >= dog.length + 2 && width >= displayWidth(dog[0] ?? '') + 2;
  const shown = fits ? [...dog, '', st.dim('no tickets running')] : height >= 1 ? [sleepFrame({ level: st.level }) + ' ' + text] : [];
  const top = Math.max(0, Math.floor((height - shown.length) / 2));
  return [...Array(top).fill(''), ...shown.map(pad)];
}
