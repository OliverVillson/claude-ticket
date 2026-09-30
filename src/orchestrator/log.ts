/**
 * Renders a run's JSONL log (raw Agent SDK messages plus our own `ticket_start` / `stderr` /
 * `worker_error` lines) the way `salu log` shows it, close to Claude Code's `-p` output:
 * assistant text, dimmed `⏺ Tool(args)` lines, a result line with cost and turns.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import type { Run, TicketView } from '../db/types.ts';
import { openDb } from '../db/db.ts';
import { getTicketById } from '../db/queries.ts';
import { bold, dim, gray, green, magenta, red } from '../core/ansi.ts';
import { formatClock, formatCost, formatDuration } from '../core/format.ts';
import { parseTrailer } from './prompt.ts';
import { describeToolCall } from './worker.ts';

export interface RenderLogOptions {
  follow?: boolean;
  raw?: boolean;
  ticket?: TicketView;
  run?: Run;
  out?: NodeJS.WritableStream;
  /** Poll interval while following. */
  pollMs?: number;
  /** While following, keep waiting for more lines as long as this returns true. Default: the ticket is still `running`. */
  keepFollowing?: () => boolean;
}

function first(s: string, n = 200): string {
  return s.replace(/\r/g, '').trim().split('\n')[0]!.slice(0, n);
}

/** Render one logged message. Returns null for messages the view skips. */
export function renderLine(m: any): string | null {
  if (!m || typeof m !== 'object') return null;
  switch (m.type) {
    case 'ticket_start': {
      const o = m.options ?? {};
      const parts = [o.model && `model ${o.model}`, o.effort && `effort ${o.effort}`, o.permissionMode && `permissions ${o.permissionMode}`, o.maxTurns && `max ${o.maxTurns} turns`].filter(Boolean);
      return dim(`── ${m.resume ? 'resuming' : 'starting'} #${m.ticket_id} ${m.name} · ${m.project}${parts.length ? ' · ' + parts.join(' · ') : ''} · ${formatClock(m.ts)}`);
    }
    case 'system':
      if (m.subtype === 'init') return dim(`── session ${m.session_id} · ${m.model} · Claude Code ${m.claude_code_version}`);
      if (m.subtype === 'api_retry') return dim(`   retrying API call (${m.error}, attempt ${m.attempt}/${m.max_retries})`);
      return null;
    case 'assistant': {
      if (m.parent_tool_use_id) return null;
      const out: string[] = [];
      for (const b of m.message?.content ?? []) {
        if (b.type === 'text' && String(b.text).trim()) out.push(`${bold('⏺')} ${String(b.text).trim()}`);
        else if (b.type === 'tool_use') out.push(dim(`⏺ ${describeToolCall(b.name, b.input)}`));
      }
      if (m.error) out.push(red(`api error: ${m.error}`));
      return out.length ? out.join('\n') : null;
    }
    case 'user': {
      if (m.parent_tool_use_id) return null;
      const content = m.message?.content;
      if (!Array.isArray(content)) return null;
      const out: string[] = [];
      for (const b of content) {
        if (b.type !== 'tool_result') continue;
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n') : '';
        const line = first(text || '(no output)', 160);
        out.push(b.is_error ? red(`  ⎿ ${line}`) : gray(`  ⎿ ${line}`));
      }
      return out.length ? out.join('\n') : null;
    }
    case 'rate_limit_event': {
      const i = m.rate_limit_info ?? {};
      if (i.status !== 'rejected') return null;
      return magenta(`‖ usage limit (${i.rateLimitType ?? 'unknown'}) — resets ${i.resetsAt ? formatClock(i.resetsAt < 1e12 ? i.resetsAt * 1000 : i.resetsAt) : 'unknown'}`);
    }
    case 'result': {
      const ok = m.subtype === 'success' && !m.is_error;
      const text = m.subtype === 'success' ? String(m.result ?? '') : (m.errors ?? []).join('\n');
      const trailer = parseTrailer(text);
      const head = ok
        ? green(`✓ ${trailer ? `TICKET: ${trailer.kind}${trailer.message ? ' ' + trailer.message : ''}` : 'finished'}`)
        : red(`✗ ${m.subtype}${text ? ': ' + first(text, 200) : ''}`);
      return `${head} ${dim(`· ${m.num_turns} turn${m.num_turns === 1 ? '' : 's'} · ${formatCost(m.total_cost_usd)} · ${formatDuration(m.duration_ms)}`)}`;
    }
    case 'stderr':
      return dim(`  stderr: ${first(String(m.text ?? ''), 200)}`);
    case 'worker_error':
      return red(`✗ worker error: ${m.error}`);
    default:
      return null;
  }
}

function header(t?: TicketView, run?: Run): string {
  if (!t) return '';
  const when = run ? ` · run ${run.id} · ${formatClock(run.started_at)}${run.outcome ? ` · ${run.outcome}` : ''}` : '';
  return `${bold(t.name)} ${dim(`#${t.id} · ${t.project}${when}`)}`;
}

/**
 * Print a run's log. With `follow`, keep tailing until the log has a `result` line, the ticket
 * is no longer `running`, or `keepFollowing()` returns false.
 */
export async function renderLog(path: string, o: RenderLogOptions = {}): Promise<void> {
  const out = o.out ?? process.stdout;
  const write = (s: string) => out.write(s + '\n');
  if (o.ticket && !o.raw) write(header(o.ticket, o.run));
  if (!existsSync(path)) {
    if (!o.follow) return void write(dim('no log written yet'));
    write(dim('waiting for the worker to start writing…'));
  }
  let offset = 0;
  let partial = '';
  let sawResult = false;
  const emit = (line: string) => {
    if (!line.trim()) return;
    let m: any = null;
    try {
      m = JSON.parse(line);
    } catch {
      /* not JSON: shown as is */
    }
    if (m?.type === 'result') sawResult = true;
    if (o.raw) return write(line);
    if (!m) return write(dim(line));
    const r = renderLine(m);
    if (r) write(r);
  };
  const readNew = () => {
    if (!existsSync(path)) return;
    const size = statSync(path).size;
    if (size < offset) offset = 0; // truncated
    if (size === offset) return;
    const fd = openSync(path, 'r');
    try {
      const len = size - offset;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, offset);
      offset = size;
      partial += buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    const lines = partial.split('\n');
    partial = lines.pop() ?? '';
    for (const l of lines) emit(l);
  };
  readNew();
  if (!o.follow) {
    if (partial) emit(partial);
    return;
  }
  const poll = o.pollMs ?? 250;
  const stillRunning =
    o.keepFollowing ??
    (() => {
      if (!o.ticket) return true;
      try {
        return getTicketById(openDb(), o.ticket.id)?.status === 'running';
      } catch {
        return true;
      }
    });
  let quiet = 0;
  while (!sawResult) {
    await Bun.sleep(poll);
    readNew();
    if (!stillRunning()) {
      if (++quiet * poll > 1000) break; // give the last lines a moment to land
    } else quiet = 0;
  }
  readNew();
  if (partial) emit(partial);
}
