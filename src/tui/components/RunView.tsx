import React, { useEffect, useRef, useState } from 'react';
import { Text, useAnimation, useApp, useInput, useWindowSize } from 'ink';
import type { Database } from 'bun:sqlite';
import type { TicketView } from '../../db/types.ts';
import { countTickets, getTicketById, listTickets } from '../../db/queries.ts';
import { readStatus, type OrchestratorStatus, type WorkerInfo } from '../../orchestrator/status.ts';
import type { OrchestratorEvent } from '../../orchestrator/types.ts';
import type { TuiActions } from '../actions.ts';
import { displayWidth, fit, fmtCost, fmtDuration, modelEffort, oneLine, priorityText, shortModel, truncate } from '../format.ts';
import { viewportRows } from '../layout.ts';
import { messageText, type Message } from '../messages.ts';
import { style as st } from '../style.ts';
import { SPINNER_FRAMES, paint, type Tone } from '../theme.ts';
import { Frame, hintsText, titleText, titleWidth } from './Frame.tsx';
import { pauseText, statusBadge, statusText } from './Status.tsx';

export interface RunViewProps {
  db: Database;
  projectIds?: number[];
  concurrency: number;
  stop: () => void;
  subscribe: (fn: (e: OrchestratorEvent) => void) => () => void;
  actions: TuiActions;
  pollMs?: number;
  /** lines of activity to keep */
  activityLines?: number;
}

export const RUN_HINTS: Array<[string, string]> = [
  ['q', 'stop'],
  ['p', 'pause'],
  ['ctrl-c', 'stop'],
];

const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour12: false });

/** One short line per orchestrator event, in the words `salu run --plain` uses. */
export function describeEvent(e: OrchestratorEvent): { text: string; tone: 'ok' | 'err' | 'warn' | 'dim' | 'accent' } | null {
  switch (e.type) {
    case 'start':
      return { text: `● orchestrator started · pid ${e.pid} · concurrency ${e.concurrency}${e.recovered ? ` · ${e.recovered} requeued` : ''}`, tone: 'ok' };
    case 'dispatch':
      return { text: `▶ ${e.ticket.name} ${e.resumed ? 'resuming session' : 'started'} · ${e.ticket.project} · run ${e.runId}`, tone: 'accent' };
    case 'finish': {
      const meta = `${e.durationMs != null ? `${fmtDuration(e.durationMs)} · ` : ''}${e.turns} turn${e.turns === 1 ? '' : 's'}${e.costUsd ? ` · ${fmtCost(e.costUsd)}` : ''}`;
      const msg = e.error ? ` · ${oneLine(e.error)}` : '';
      switch (e.outcome) {
        case 'done':
          return { text: `✓ ${e.ticket.name} done · ${meta}`, tone: 'ok' };
        case 'blocked':
          return { text: `? ${e.ticket.name} blocked: ${oneLine(e.error ?? '')}`, tone: 'warn' };
        case 'failed':
          return { text: `✗ ${e.ticket.name} ${e.status === 'failed' ? 'failed' : 'failed, will retry'} · ${meta}${msg}`, tone: 'err' };
        case 'rate_limited':
          return { text: `‖ ${e.ticket.name} hit the usage limit, parked with its session · ${meta}`, tone: 'warn' };
        case 'killed':
          return { text: `■ ${e.ticket.name} interrupted · ${e.status === 'paused' ? 'resumes next run' : 'back in the queue'}`, tone: 'dim' };
      }
      return null;
    }
    case 'pause':
      return { text: pauseText({ until: e.until, reason: e.reason, kind: e.kind, models: e.models, manual: !!e.manual }, Date.now()), tone: 'warn' };
    case 'probe':
      return { text: e.ok ? '… window is open' : `… window still closed${e.detail ? ` · ${oneLine(e.detail)}` : ''}`, tone: 'warn' };
    case 'resume':
      return { text: '▶ resumed dispatch', tone: 'ok' };
    case 'idle':
      return { text: '○ queue empty, waiting for tickets', tone: 'dim' };
    case 'log':
      return { text: e.level === 'info' ? oneLine(e.message) : `! ${oneLine(e.message)}`, tone: e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : 'dim' };
    case 'stop':
      return { text: '○ orchestrator stopped', tone: 'dim' };
    case 'worker':
      return null;
    default:
      return { text: oneLine(String((e as any)?.type ?? 'event')), tone: 'dim' };
  }
}

interface Activity {
  at: number;
  text: string;
  tone: 'ok' | 'err' | 'warn' | 'dim' | 'accent';
}

const TONE: Record<Activity['tone'], { tone: Tone; dim?: boolean }> = {
  ok: { tone: 'green' },
  err: { tone: 'red' },
  warn: { tone: 'magenta' },
  accent: { tone: 'accent' },
  dim: { tone: 'plain', dim: true },
};

/**
 * `salu run` foreground view: one row per active worker (name, elapsed, turns, last tool),
 * the next queued tickets, and a short activity log fed by orchestrator events. Polls the
 * database twice a second; `q` asks the orchestrator to stop and the view closes on `stop`.
 */
export function RunView(p: RunViewProps) {
  const { db } = p;
  const { exit } = useApp();
  const { columns: rawColumns, rows: termRows } = useWindowSize();
  const columns = Math.max(40, rawColumns || 80);
  const inner = columns - 4;
  const [status, setStatus] = useState<OrchestratorStatus>(() => readStatus(db));
  const [queued, setQueued] = useState<TicketView[]>([]);
  const [counts, setCounts] = useState(() => countTickets(db));
  const [activity, setActivity] = useState<Activity[]>([]);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const names = useRef(new Map<number, string>());
  const [, setTick] = useState(0);
  const keep = p.activityLines ?? 8;

  const refresh = () => {
    setStatus(readStatus(db));
    const q = listTickets(db, { status: ['paused', 'todo'] }).filter((t) => !p.projectIds?.length || p.projectIds.includes(t.project_id));
    setQueued(q.slice(0, 5));
    setCounts(countTickets(db));
    setTick((t) => t + 1);
  };

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, p.pollMs ?? 500);
    return () => clearInterval(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db]);

  useEffect(() => {
    const off = p.subscribe((e) => {
      const d = describeEvent(e);
      if (d) setActivity((a) => [...a, { at: Date.now(), ...d }].slice(-keep));
      if (e.type === 'stop') setTimeout(() => exit(), 50);
      if (e.type !== 'worker') refresh();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.subscribe]);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 3000);
    return () => clearTimeout(t);
  }, [message]);

  const { frame } = useAnimation({ interval: 200, isActive: status.workers.length > 0 && !stopping });

  useInput((input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) {
      if (stopping) return exit();
      setStopping(true);
      setMessage({ text: 'stopping: workers are interrupted, their tickets resume on the next run (press again to close now)', tone: 'info' });
      p.stop();
      return;
    }
    if (input === 'p') {
      const paused = !!status.paused;
      try {
        p.actions.togglePause(paused);
        setMessage({ text: paused ? 'resumed dispatch' : 'paused dispatch after the current workers finish', tone: 'info' });
      } catch (e: any) {
        setMessage({ text: String(e?.message ?? e), tone: 'err' });
      }
      refresh();
    }
  });

  const now = Date.now();
  const nameOf = (w: WorkerInfo): string => {
    let n = names.current.get(w.ticketId);
    if (!n) {
      n = getTicketById(db, w.ticketId)?.name ?? `#${w.ticketId}`;
      names.current.set(w.ticketId, n);
    }
    return n;
  };

  const rowsAvail = viewportRows(termRows, 5);
  const workers = status.workers;
  const nameW = Math.min(28, Math.max(12, Math.floor(inner * 0.3)));
  const summary = `${workers.length}/${p.concurrency} workers · ${counts.todo + counts.paused} queued · ${counts.done} done${counts.blocked ? ` · ${counts.blocked} blocked` : ''}${counts.failed ? ` · ${counts.failed} failed` : ''}`;
  const crumbs = ['run'];
  const badgeW = displayWidth(statusText(status, now));
  const summaryShown = truncate(summary, Math.max(0, columns - 1 - titleWidth(crumbs) - badgeW - 9));
  const headerRight = st.dim(summaryShown + '  ·  ') + statusBadge(status, now);

  const lines: string[] = [];
  if (status.paused) {
    lines.push(paint(st, 'magenta', pauseText(status.paused, now)) + (status.paused.reason && !status.paused.manual ? st.dim(` · ${oneLine(status.paused.reason)}`) : ''));
  }
  for (const w of workers) {
    const detail = [w.model ? shortModel(w.model) : '', fmtDuration(now - w.startedAt), `${w.turns} turn${w.turns === 1 ? '' : 's'}`, w.lastTool ?? (w.lastText ? oneLine(w.lastText) : '')].filter(Boolean);
    lines.push(st.accent(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]!) + ' ' + st.bold(fit(nameOf(w), nameW)) + st.dim('  ' + detail.join('  ')));
  }
  if (!workers.length) {
    lines.push(st.dim(stopping ? 'stopping…' : status.alive ? (queued.length ? 'starting workers…' : 'no tickets waiting · salu add "name" "query" "tags"') : 'orchestrator is not running'));
  }
  if (queued.length) {
    const next = queued.map((t) => `${t.name} ${priorityText(t.priority)}${modelEffort(t) ? ' ' + modelEffort(t) : ''}`).join(' · ');
    lines.push(st.dim(`○ next: ${next}`));
  }
  const room = Math.max(0, rowsAvail - lines.length - 1);
  const shown = activity.slice(-Math.min(keep, room));
  if (shown.length) {
    lines.push(st.dim('─ activity ' + '─'.repeat(Math.max(0, Math.min(inner - 11, 30)))));
    for (const a of shown) {
      const t = TONE[a.tone];
      lines.push(st.dim(clock(a.at) + ' ') + paint(st, t.tone, a.text, { dim: t.dim }));
    }
  }

  const footer = { left: message ? messageText(message) : hintsText(RUN_HINTS, columns - 2) };
  return (
    <Frame columns={columns} header={{ left: titleText(crumbs), right: headerRight }} footer={footer}>
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {l || ' '}
        </Text>
      ))}
    </Frame>
  );
}
