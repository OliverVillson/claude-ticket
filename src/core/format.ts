import { bold, cyan, dim, gray, green, magenta, red, stripAnsi, yellow } from './ansi.ts';
import type { TicketStatus } from '../db/types.ts';
import { GLYPHS } from '../ui/glyphs.ts';

export function statusColor(s: TicketStatus | string): (x: string) => string {
  switch (s) {
    case 'running':
      return cyan;
    case 'done':
      return green;
    case 'failed':
      return red;
    case 'blocked':
      return yellow;
    case 'paused':
      return magenta;
    default:
      return gray;
  }
}

export function statusIcon(s: TicketStatus | string): string {
  switch (s) {
    case 'backlog':
    case 'running':
    case 'done':
    case 'failed':
    case 'blocked':
    case 'paused':
      return GLYPHS[s];
    default:
      return GLYPHS.todo;
  }
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

export function formatAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '';
  return `${formatDuration(now - ts)} ago`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

export function formatCost(usd: number | null | undefined): string {
  if (!usd) return '$0.00';
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

export function truncate(s: string, width: number): string {
  s = s.replace(/\s+/g, ' ');
  if (width <= 1) return s.slice(0, width);
  const plain = stripAnsi(s);
  if (plain.length <= width) return s;
  return plain.slice(0, width - 1) + '…';
}

export interface Column {
  key: string;
  title: string;
  width?: number;
  align?: 'left' | 'right';
  max?: number;
}

/** Render rows as an aligned plain-text table (header dimmed). Values may contain ANSI codes. */
export function table(columns: Column[], rows: Record<string, string>[]): string {
  const widths = columns.map((c) => {
    const w = Math.max(c.title.length, ...rows.map((r) => stripAnsi(r[c.key] ?? '').length));
    return Math.min(c.width ?? w, c.max ?? w);
  });
  const line = (cells: string[], style: (s: string) => string = (s) => s) =>
    cells
      .map((cell, i) => {
        const w = widths[i]!;
        const t = truncate(cell, w);
        const pad = w - stripAnsi(t).length;
        return columns[i]!.align === 'right' ? ' '.repeat(pad) + style(t) : style(t) + ' '.repeat(pad);
      })
      .join('  ')
      .replace(/\s+$/, '');
  const out = [line(columns.map((c) => c.title), dim)];
  for (const r of rows) out.push(line(columns.map((c) => r[c.key] ?? '')));
  return out.join('\n');
}

export function heading(s: string): string {
  return bold(s);
}
