import type { Turn } from '../db/types.ts';
import type { LogLine } from './log-tail.ts';
import type { TicketDetail } from './store.ts';
import { displayWidth, fmtCost, fmtDuration, truncate, wrapText } from './format.ts';
import type { Style } from './style.ts';
import { paint } from './theme.ts';
import { safeText, stripControl } from '../core/ansi.ts';
import { ticketOutputs } from '../core/outputs.ts';
import { GLYPHS, supportsUnicode } from '../ui/glyphs.ts';

/**
 * The thread view: one ticket as a conversation. Pure string maths (no React), shared by the
 * full-screen view and the third pane of wide terminals.
 *
 *   you   Login loops back to /login after SSO
 *   ───────────────────────────────────────────
 *   salu  Found it: the callback dropped `next`.
 *   did   Read ×3 · Edit ×2 · Bash ×4 · 14 turns · 3m · $0.42
 *   ───────────────────────────────────────────
 *   outputs  branch salu/fix-login   2 files
 *   ✓ reproduced   ✓ fixed   ◐ running full tests
 *
 * The first block is the conversation (scrolls), the rest is pinned to the bottom.
 */

/** A thing the thread produced; the shape of the core's `ticketOutputs` entries (src/core/outputs.ts once it lands). */
export interface ThreadOutput {
  kind: 'branch' | 'pr' | 'file' | 'link';
  ref: string;
  title?: string;
}

export interface ChecklistItem {
  text: string;
  state: 'done' | 'active' | 'todo';
}

/**
 * What the worker's `salu` tool will fill in (checklist, decision, attached outputs). Nothing
 * produces these yet: the slots stay clean until the tool contract lands.
 */
export interface ThreadExtras {
  checklist?: ChecklistItem[];
  outputs?: ThreadOutput[];
  /** an open question with options, shown above the checklist (answered with the number keys) */
  decision?: { id: number; question: string; options: string[]; recommended: number };
  /** sub-threads and the thread this one belongs to */
  parent?: { name: string; status: string };
  children?: Array<{ name: string; status: string }>;
}

/** What the worker's `salu` tool stored for this thread, in the shape the view draws. */
export function extrasOf(d: TicketDetail): ThreadExtras {
  const t = d.thread;
  const open = t.decisions.find((x) => x.status === 'open');
  return {
    checklist: t.checklist.map((c) => ({ text: c.text, state: c.state === 'doing' ? 'active' : c.state })),
    outputs: t.outputs.map((o) => ({ kind: o.kind, ref: o.ref, title: o.title || undefined })),
    decision: open ? { id: open.id, question: open.question, options: open.options.map((o) => o.label), recommended: open.recommended } : undefined,
    parent: t.parent ?? undefined,
    children: t.children,
  };
}

/** The open decision of a thread, if the worker asked one. */
export function openDecision(d: TicketDetail) {
  return d.thread.decisions.find((x) => x.status === 'open') ?? null;
}

export interface ThreadInput {
  detail: TicketDetail;
  log: LogLine[];
  /** overrides what is read from the detail (tests) */
  extras?: ThreadExtras;
  now: number;
  spinner?: number;
  /** outputs strip expanded to one line per output (the `o` key) */
  showOutputs?: boolean;
}

const LABEL_W = 7;

/** A resolved thread is stored as `done` (core contract): finished and put away, a reply revives it. */
export function isResolved(t: { status: string }): boolean {
  return t.status === 'done';
}

/** Resolved threads go to the bottom of the list (stable otherwise). */
export function partitionResolved<T extends { status: string; id?: number }>(rows: T[], asking?: Set<number>): T[] {
  const open: T[] = [];
  const done: T[] = [];
  // A resolved thread with an unanswered decision stays up with the open ones.
  for (const r of rows) (isResolved(r) && !(r.id != null && asking?.has(r.id)) ? done : open).push(r);
  return done.length ? [...open, ...done] : rows;
}

/** One block of the conversation: a label and a body wrapped under it. */
function block(label: string, tone: 'accent' | 'green' | 'dim' | 'red', body: string, width: number, st: Style, note = ''): string[] {
  const room = Math.max(8, width - LABEL_W);
  const wrapped = wrapText(stripControl(body).trim(), room);
  if (!wrapped.length) wrapped.push('');
  const lab = tone === 'dim' ? st.dim(label.padEnd(LABEL_W)) : paint(st, tone, label.padEnd(LABEL_W));
  const out = wrapped.map((l, i) => (i === 0 ? lab : ' '.repeat(LABEL_W)) + st.text(l));
  if (note) {
    const n = note.trim();
    if (displayWidth(wrapped[wrapped.length - 1]!) + 2 + displayWidth(n) <= room) out[out.length - 1] += st.dim('  ' + n);
    else out.push(' '.repeat(LABEL_W) + st.dim(n));
  }
  return out;
}

const rule = (width: number, st: Style) => st.dim((supportsUnicode() ? '─' : '-').repeat(Math.max(4, width)));

/** Join styled pieces with `gap`, dropping what does not fit in `width` cells (never cutting an escape). */
function joinFit(pieces: Array<{ text: string; w: number }>, gap: string, width: number): string {
  let out = '';
  let used = 0;
  const gw = displayWidth(gap);
  for (const p of pieces) {
    const add = (out ? gw : 0) + p.w;
    if (used + add > width) break;
    out += (out ? gap : '') + p.text;
    used += add;
  }
  return out;
}

/** `Read ×3 · Edit ×2 · 14 turns · 3m · $0.42`: what the last run did. */
export function didText(d: TicketDetail, now: number): string {
  const bits: string[] = [];
  for (const [name, n] of d.tools.slice(0, 5)) bits.push(n > 1 ? `${name} ×${n}` : name);
  const run = d.run;
  if (run) {
    if (run.turns != null) bits.push(`${run.turns} turns`);
    const end = run.ended_at ?? now;
    if (run.ended_at || d.ticket.status === 'running') bits.push(fmtDuration(Math.max(0, end - run.started_at)));
    if (run.cost_usd) bits.push(fmtCost(run.cost_usd));
  }
  return bits.join(' · ');
}

/** Every message of the conversation, oldest first. The first prompt counts as the first "you". */
export function conversationLines(i: ThreadInput, width: number, st: Style): string[] {
  const t = i.detail.ticket;
  const out: string[] = [];
  const turns: Turn[] = i.detail.turns;
  out.push(...block('you', 'accent', safeText(t.query), width, st));
  // The first run's reply is stored as a turn; the summary only stands in when there is none.
  const hasReply = turns.some((x) => x.role === 'assistant');
  if (!hasReply && t.summary && isResolved(t)) {
    out.push(rule(width, st), ...block('salu', 'green', safeText(t.summary), width, st));
  }
  const did = didText(i.detail, i.now);
  let lastReply = -1;
  turns.forEach((x, n) => {
    if (x.role === 'assistant') lastReply = n;
  });
  turns.forEach((x, n) => {
    out.push(rule(width, st));
    if (x.role === 'user') out.push(...block('you', 'accent', x.body, width, st, x.delivered ? '' : '  (waiting for the worker)'));
    else {
      out.push(...block('salu', 'green', x.body, width, st));
      if (n === lastReply && did && t.status !== 'running') out.push(...block('did', 'dim', did, width, st));
    }
  });
  if (!hasReply && did && t.status !== 'running' && !turns.length && (t.summary || t.error)) out.push(...block('did', 'dim', did, width, st));
  if (t.error) out.push(rule(width, st), ...block('error', 'red', safeText(t.error), width, st));
  return out;
}

/** Everything the thread produced: its branch plus whatever the worker attached. */
export function threadOutputs(i: ThreadInput): ThreadOutput[] {
  // The core's list first; attached outputs stored by the worker tool are folded in once, whichever place holds them.
  const out: ThreadOutput[] = ticketOutputs(i.detail.ticket);
  for (const o of (i.extras ?? extrasOf(i.detail)).outputs ?? []) if (!out.some((x) => x.kind === o.kind && x.ref === o.ref)) out.push(o);
  return out;
}

const KIND_WORD: Record<ThreadOutput['kind'], string> = { branch: 'branch', pr: 'PR', file: 'file', link: 'link' };

function outputsLines(i: ThreadInput, width: number, st: Style): string[] {
  const outs = threadOutputs(i);
  const lab = st.dim('outputs'.padEnd(LABEL_W + 1));
  if (!outs.length) return [lab + st.dim('none yet')];
  if (i.showOutputs) return outs.map((o, n) => (n === 0 ? lab : ' '.repeat(LABEL_W + 1)) + st.dim(KIND_WORD[o.kind].padEnd(7)) + st.text(truncate(safeText(o.title ?? o.ref), Math.max(8, width - LABEL_W - 9))));
  const room = Math.max(8, width - LABEL_W - 1);
  const parts = outs.map((o) => {
    const text = safeText(o.title ?? o.ref);
    const dup = text.toLowerCase().startsWith(KIND_WORD[o.kind].toLowerCase() + ' ');
    const label = truncate(dup ? text : `${KIND_WORD[o.kind]} ${text}`, room);
    const word = dup ? 0 : Math.min(KIND_WORD[o.kind].length + 1, label.length);
    return { text: st.dim(label.slice(0, word)) + st.text(label.slice(word)), w: displayWidth(label) };
  });
  return [lab + joinFit(parts, '   ', room)];
}

/** `part of <parent>` and `sub-threads  a ✓  b ●`: the thread tree around this one. */
function familyLines(i: ThreadInput, width: number, st: Style): string[] {
  const ex = i.extras ?? extrasOf(i.detail);
  const out: string[] = [];
  const lab = (w: string) => st.dim(w.padEnd(LABEL_W + 1));
  const glyph = (status: string) => (status === 'running' ? st.accent(GLYPHS.running) : status === 'done' ? paint(st, 'green', GLYPHS.done) : status === 'failed' ? paint(st, 'red', GLYPHS.failed) : st.dim(GLYPHS.todo));
  if (ex.parent) out.push(lab('part of') + st.text(truncate(safeText(ex.parent.name), Math.max(8, width - LABEL_W - 1))));
  if (ex.children?.length) {
    const room = Math.max(8, width - LABEL_W - 1);
    const pieces = ex.children.map((c) => {
      const name = truncate(safeText(c.name), 24);
      return { text: st.text(name) + ' ' + glyph(c.status), w: displayWidth(name) + 2 };
    });
    out.push(lab('threads') + joinFit(pieces, '   ', room));
  }
  return out;
}

/** The checklist slot: the worker's checklist while it works, else its live log, else the last run. */
function slotLines(i: ThreadInput, width: number, st: Style, budget: number): string[] {
  const t = i.detail.ticket;
  const ex = i.extras ?? extrasOf(i.detail);
  const cl = ex.checklist;
  const out: string[] = [];
  if (ex.decision) {
    const d = ex.decision;
    out.push(st.accent('? ') + st.text(truncate(safeText(d.question), width - 2)));
    const opts = d.options.map((o, n) => ({ text: st.accent(String(n + 1)) + ' ' + st.text(truncate(safeText(o), 28)) + (n === d.recommended ? st.dim(' (recommended)') : ''), w: 2 + Math.min(28, displayWidth(safeText(o))) + (n === d.recommended ? 14 : 0) }));
    out.push('  ' + joinFit(opts, '   ', width - 2));
  }
  if (cl?.length) {
    const spin = GLYPHS.spinner[(i.spinner ?? 0) % GLYPHS.spinner.length]!;
    const g = (s: ChecklistItem['state']) => (s === 'done' ? paint(st, 'green', GLYPHS.done) : s === 'active' ? st.accent(spin) : st.dim(GLYPHS.todo));
    out.push(
      joinFit(
        cl.map((c) => {
          const text = truncate(safeText(c.text), Math.max(6, width - 4));
          return { text: g(c.state) + ' ' + (c.state === 'todo' ? st.dim(text) : st.text(text)), w: displayWidth(text) + 2 };
        }),
        '   ',
        width,
      ),
    );
    if (t.status === 'running') for (const l of i.log.slice(-Math.max(0, budget - out.length))) out.push(st.dim(GLYPHS.say + ' ') + st.dim(truncate(l.text, width - 2)));
  } else if (t.status === 'running') {
    const live = i.log.slice(-Math.max(1, budget - out.length));
    out.push(...live.map((l) => (l.kind === 'tool' ? st.accent(GLYPHS.say + ' ') : st.dim(GLYPHS.say + ' ')) + st.text(truncate(l.text, width - 2))));
    if (!live.length) out.push(st.dim('waiting for the worker…'));
  } else if (i.detail.run) {
    const r = i.detail.run;
    out.push(st.dim(truncate(`last run · ${r.outcome ?? 'running'} · ended ${r.ended_at ? fmtDuration(Math.max(0, i.now - r.ended_at)) + ' ago' : 'not yet'}`, width)));
  }
  return out.slice(0, Math.max(1, budget));
}

export interface ThreadBlock {
  /** exactly `height` lines (padded), each at most `width` cells wide */
  lines: string[];
  /** how many conversation lines are hidden above the window, and below it when scrolled back */
  above: number;
  below: number;
}

/**
 * Lay the thread out in a box of `width` x `height`: the conversation window on top (newest at the
 * bottom, `back` lines scrolled up), the pinned outputs strip and checklist slot underneath.
 */
export function layoutThread(i: ThreadInput, width: number, height: number, back: number, st: Style): ThreadBlock {
  const outs = outputsLines(i, width, st);
  const slotBudget = height >= 12 ? 3 : height >= 8 ? 2 : 1;
  const slot = slotLines(i, width, st, slotBudget);
  const bottom = [rule(width, st), ...outs, ...familyLines(i, width, st), ...slot];
  const room = Math.max(1, height - bottom.length);
  const all = conversationLines(i, width, st);
  const maxBack = Math.max(0, all.length - room);
  const b = Math.min(Math.max(0, back), maxBack);
  const end = all.length - b;
  const window = all.slice(Math.max(0, end - room), end);
  const pad = Array.from({ length: Math.max(0, room - window.length) }, () => '');
  const lines = [...window, ...pad, ...bottom].slice(0, height);
  return { lines, above: Math.max(0, end - room), below: b };
}

/** Width of a styled line in cells (ANSI stripped by `displayWidth`). */
export const cells = displayWidth;
