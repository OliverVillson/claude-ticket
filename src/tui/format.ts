import type { TicketView } from '../db/types.ts';
import { ticketLabels, ticketTags } from '../db/types.ts';
import { safeText } from '../core/ansi.ts';

// ---------------------------------------------------------------------------
// Width-aware string helpers (no dependency; good enough for names, tags and prompts)
// ---------------------------------------------------------------------------

/** Terminal cell width of one code point: 0 for combining marks, 2 for wide glyphs, else 1. */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Combining marks and zero-width joiners / variation selectors.
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0x2060 ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  )
    return 0;
  // East Asian wide and fullwidth blocks, plus emoji.
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** Display width of a string in terminal cells. ANSI escapes count as zero. */
export function displayWidth(s: string): number {
  let w = 0;
  let i = 0;
  while (i < s.length) {
    // Skip ANSI CSI sequences.
    if (s.charCodeAt(i) === 0x1b && s[i + 1] === '[') {
      let j = i + 2;
      while (j < s.length && !/[A-Za-z]/.test(s[j]!)) j++;
      i = j + 1;
      continue;
    }
    const cp = s.codePointAt(i)!;
    w += charWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return w;
}

/** Cut `s` to at most `width` cells, ending with `…` when something was cut. */
export function truncate(s: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  if (displayWidth(s) <= width) return s;
  const ew = displayWidth(ellipsis);
  const target = Math.max(0, width - ew);
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0)!);
    if (w + cw > target) break;
    out += ch;
    w += cw;
  }
  return out + (width >= ew ? ellipsis : '');
}

export function padEnd(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

export function padStart(s: string, width: number): string {
  const w = displayWidth(s);
  return w >= width ? s : ' '.repeat(width - w) + s;
}

/** Truncate then pad so the result is exactly `width` cells wide. */
export function fit(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const t = truncate(s, width);
  return align === 'right' ? padStart(t, width) : padEnd(t, width);
}

/** Collapse newlines and runs of whitespace so a query fits on one row. */
export function oneLine(s: string): string {
  return safeText(s).replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Ticket-specific formatting
// ---------------------------------------------------------------------------

/** Short relative age: "now", "45s", "2m", "3h", "5d", "2w". */
export function relTime(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '';
  const d = Math.max(0, now - ms);
  const s = Math.floor(d / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  const days = Math.floor(h / 24);
  if (days < 14) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/** "just now" or "5m ago". */
export function ago(ms: number | null | undefined, now = Date.now()): string {
  const r = relTime(ms, now);
  return r === '' ? '' : r === 'now' ? 'just now' : `${r} ago`;
}

/** "1m 20s", "45s", "2h 05m". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/** "p3", or "now" for priority 0 (the `r` key). */
export function priorityText(p: number): string {
  return p <= 0 ? 'now' : `p${p}`;
}

/** "$0.12"; empty when zero so quiet rows stay quiet. */
export function fmtCost(usd: number | null | undefined): string {
  if (!usd) return '';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

/** `claude-opus-4-1-20250805` → `opus-4-1`, `opus` → `opus`, bedrock ids keep their tail. */
export function shortModel(m: string): string {
  let s = m.replace(/^(anthropic\.|us\.|eu\.)?claude-/, '');
  s = s.replace(/-\d{8}(-v\d+:\d+)?$/, '');
  return s;
}

/** "opus/high", "sonnet", "/max", or "" when the ticket relies on defaults. */
export function modelEffort(t: Pick<TicketView, 'tags'>): string {
  const tags = ticketTags(t);
  const model = tags.model ? shortModel(tags.model) : '';
  const effort = tags.effort ?? '';
  if (model && effort) return `${model}/${effort}`;
  if (model) return model;
  if (effort) return `/${effort}`;
  return '';
}

/** Labels as "#bug #docs". */
export function labelText(t: Pick<TicketView, 'labels'>): string {
  return ticketLabels(t)
    .map((l) => `#${l}`)
    .join(' ');
}

/** Custom tags (everything except model/effort) as "key=value" pairs. */
export function extraTags(t: Pick<TicketView, 'tags'>): string[] {
  const tags = ticketTags(t);
  return Object.entries(tags)
    .filter(([k]) => k !== 'model' && k !== 'effort')
    .map(([k, v]) => `${k}=${v}`);
}

/** Wrap plain text to `width` cells, breaking on spaces; long words are cut. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  if (width <= 0) return out;
  for (const para of text.split(/\r?\n/)) {
    if (para.trim() === '') {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (displayWidth(word) > width) {
        if (line) out.push(line);
        line = '';
        let rest = word;
        while (displayWidth(rest) > width) {
          const head = truncate(rest, width, '');
          out.push(head);
          rest = rest.slice(head.length);
        }
        line = rest;
        continue;
      }
      const candidate = line ? `${line} ${word}` : word;
      if (displayWidth(candidate) > width) {
        out.push(line);
        line = word;
      } else line = candidate;
    }
    if (line) out.push(line);
  }
  return out;
}

/** Name plus dim labels fitted to a column: the name is kept whole when the labels can shrink. */
export function nameCell(t: Pick<TicketView, 'name' | 'labels'>, width: number): { name: string; labels: string } {
  const labels = labelText(t);
  const name = safeText(t.name);
  if (!labels) return { name: fit(name, width), labels: '' };
  const nameW = displayWidth(name);
  const room = width - nameW - 2;
  if (room >= 4) return { name: name + '  ', labels: fit(labels, room) };
  return { name: fit(name, width), labels: '' };
}
