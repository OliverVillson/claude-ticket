/**
 * Foreground views for `ticket run`, with no Ink dependency so the orchestrator stays light.
 *
 * `attachPlainView` prints one line per event (logs, `--plain`, `--detach`).
 * `attachLiveView` keeps a small panel at the bottom of the terminal and redraws it in place, so
 * scrollback above it stays intact. The Ink run view in `src/tui` replaces it when present.
 */
import type { Database } from 'bun:sqlite';
import { countTickets } from '../db/queries.ts';
import { bold, cyan, dim, gray, green, magenta, red, yellow } from '../core/ansi.ts';
import { formatClock, formatCost, formatDuration, truncate } from '../core/format.ts';
import { labelForKind } from '../usage/index.ts';
import type { LimitKind } from '../usage/types.ts';
import type { Orchestrator } from './scheduler.ts';
import type { OrchestratorEvent } from './types.ts';

function stamp(): string {
  return dim(new Date().toLocaleTimeString(undefined, { hour12: false }));
}

interface PauseLike {
  until: number | null;
  reason: string | null;
  kind: string | null;
  models: string[];
  manual?: boolean;
}

export function describePause(p: PauseLike, now = Date.now()): string {
  if (p.manual) return 'paused by hand — `ticket resume` continues';
  const label = labelForKind((p.kind ?? 'unknown') as LimitKind, p.models);
  const scope = p.models.length ? ` for ${p.models[0]} tickets` : '';
  if (p.until == null) return `${label} reached${scope}`;
  const remaining = p.until - now;
  if (remaining <= 0) return `${label}${scope} — checking whether the window is open`;
  const days = p.kind === 'weekly' && remaining > 36 * 3600_000 ? ' (a weekly limit can mean days)' : '';
  return `${label} reached${scope} — resumes ${formatClock(p.until)} (in ${formatDuration(remaining)})${days}`;
}

/** One line per event, for logs and non-TTY output. Null for events the line view skips. */
export function formatEvent(e: OrchestratorEvent): string | null {
  switch (e.type) {
    case 'start':
      return `${green('●')} orchestrator started ${dim(`pid ${e.pid}, up to ${e.concurrency} at a time`)}`;
    case 'dispatch':
      return `${cyan('▶')} ${bold(e.ticket.name)} ${dim(`${e.resumed ? 'resuming session' : 'started'} · ${e.ticket.project} · run ${e.runId}`)}`;
    case 'finish': {
      const meta = dim(`${formatDuration(e.durationMs ?? 0)} · ${e.turns} turn${e.turns === 1 ? '' : 's'} · ${formatCost(e.costUsd)}`);
      const n = bold(e.ticket.name);
      switch (e.outcome) {
        case 'done':
          return `${green('✓')} ${n} done ${meta}`;
        case 'blocked':
          return `${yellow('?')} ${n} blocked ${meta}\n    ${yellow(truncate(e.error ?? '', 200))}`;
        case 'failed':
          return `${red('✗')} ${n} ${e.status === 'failed' ? 'failed' : 'failed, will retry'} ${meta}${e.error ? `\n    ${red(truncate(e.error, 200))}` : ''}`;
        case 'rate_limited':
          return `${magenta('‖')} ${n} hit a usage limit, parked with its session ${meta}`;
        case 'killed':
          return `${gray('■')} ${n} interrupted ${dim('(back in the queue, session kept)')} ${meta}`;
      }
      return null;
    }
    case 'pause':
      return `${magenta('‖')} ${describePause(e)}`;
    case 'resume':
      return `${green('▶')} resumed dispatch`;
    case 'probe':
      return `${e.ok ? green('✓') : magenta('…')} window check: ${e.ok ? 'open' : 'still closed'}${e.detail ? dim(` — ${truncate(e.detail, 120)}`) : ''}`;
    case 'idle':
      return dim('○ queue empty, waiting for tickets (ticket add …)');
    case 'log':
      return e.level === 'error' ? `${red('!')} ${e.message}` : e.level === 'warn' ? `${yellow('!')} ${e.message}` : dim(e.message);
    case 'stop':
      return `${gray('○')} orchestrator stopped`;
    default:
      return null;
  }
}

export function attachPlainView(orch: Orchestrator, out: NodeJS.WritableStream = process.stdout): () => void {
  return orch.on((e) => {
    const line = formatEvent(e);
    if (line) out.write(`${stamp()} ${line}\n`);
  });
}

/** In-place panel: header, one row per worker, recent events, key hint. Redrawn twice a second. */
export function attachLiveView(orch: Orchestrator, db: Database, out: NodeJS.WriteStream = process.stdout): () => void {
  const recent: string[] = [];
  let drawn = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastPause: PauseLike | null = null;

  const width = () => Math.max(40, out.columns || 100);
  const push = (s: string) => {
    for (const l of s.split('\n')) recent.push(`${stamp()} ${l}`);
    while (recent.length > 8) recent.shift();
  };

  const render = () => {
    const now = Date.now();
    const counts = countTickets(db);
    const workers = orch.workers;
    const lines: string[] = [];
    const state = stopped ? gray('○ stopped') : lastPause ? magenta('‖ paused') : green('● running');
    lines.push(
      `${state} ${dim('·')} ${bold(`${workers.length}/${orch.concurrency}`)} workers ${dim('·')} ${counts.todo + counts.paused} queued ${dim('·')} ${green(String(counts.done))} done` +
        (counts.blocked ? ` ${dim('·')} ${yellow(`${counts.blocked} blocked`)}` : '') +
        (counts.failed ? ` ${dim('·')} ${red(`${counts.failed} failed`)}` : ''),
    );
    if (lastPause) lines.push(`  ${magenta(describePause(lastPause, now))}`);
    for (const w of workers) {
      const detail = [w.live.model ?? '', formatDuration(now - w.startedAt).padStart(7), `${w.live.turns} turn${w.live.turns === 1 ? '' : 's'}`.padStart(9), w.live.lastTool ?? w.live.lastText ?? ''].filter(Boolean).join('  ');
      lines.push(truncate(`  ${cyan('●')} ${bold(w.ticket.name.padEnd(24))} ${dim(detail)}`, width()));
    }
    if (workers.length === 0 && !stopped) lines.push(dim(counts.todo + counts.paused ? '  starting workers…' : '  no tickets waiting — ticket add "name" "query" "tags"'));
    if (recent.length) {
      lines.push(dim('  recent'));
      for (const r of recent) lines.push(truncate(`  ${r}`, width()));
    }
    lines.push(dim(stopped ? '' : '  q or Ctrl-C stops; running tickets resume on the next `ticket run`'));

    let buf = '';
    if (drawn) buf += `\u001b[${drawn}A`; // back to the top of the last panel
    for (const l of lines) buf += `\u001b[2K${l}\n`;
    for (let i = lines.length; i < drawn; i++) buf += '\u001b[2K\n';
    if (drawn > lines.length) buf += `\u001b[${drawn - lines.length}A`;
    drawn = lines.length;
    out.write(buf);
  };

  const off = orch.on((e) => {
    if (e.type === 'pause') lastPause = e;
    else if (e.type === 'resume') lastPause = null;
    else if (e.type === 'stop') stopped = true;
    if (e.type !== 'worker') {
      const line = formatEvent(e);
      if (line) push(line);
    }
    render();
  });
  timer = setInterval(render, 500);

  // Keys: q / Esc / Ctrl-C stop.
  const stdin = process.stdin;
  const onKey = (buf: Buffer) => {
    const k = buf.toString();
    if (k === 'q' || k === '\u001b' || k === '\u0003') orch.stop(k === '\u0003' ? 'Ctrl-C' : 'q pressed');
  };
  let rawSet = false;
  if (stdin.isTTY) {
    try {
      stdin.setRawMode(true);
      rawSet = true;
      stdin.resume();
      stdin.on('data', onKey);
    } catch {
      /* no raw mode: Ctrl-C still works through SIGINT */
    }
  }
  render();

  return () => {
    off();
    if (timer) clearInterval(timer);
    timer = null;
    if (rawSet) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    stdin.off('data', onKey);
    stdin.pause();
    stopped = true;
    render();
  };
}
