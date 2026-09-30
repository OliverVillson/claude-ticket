/**
 * The interactive screens of the ticket CLI (Ink 7 + React 19), in the Claude Code CLI's
 * visual language. Three entry points, all lazy-loaded by the commands so `add`, `remove`
 * and `status` never pay for Ink:
 *
 *   openList({ projectId?, statuses? })            salu list
 *   openTicketForm({ ticketId?, projectId? })      salu change "name" (no flags), salu add (no args)
 *   openRunView({ projectIds?, concurrency, stop, subscribe })   salu run (foreground)
 *
 * Every screen reads the database directly (`src/db/queries.ts`, `src/orchestrator/status.ts`)
 * and polls it, so it never drifts from what the orchestrator writes.
 */
import React from 'react';
import type { Database } from 'bun:sqlite';
import { openDb } from '../db/db.ts';
import type { TicketStatus } from '../db/types.ts';
import type { OrchestratorEvent } from '../orchestrator/types.ts';
import { green, dim } from '../core/ansi.ts';
import { defaultActions, type TuiActions } from './actions.ts';
import { App, mount, type FormResult } from './app.tsx';
import { RunView } from './components/RunView.tsx';
import { loadSnapshot } from './store.ts';
import type { UsageSource } from './usage.ts';
import { peekUsageSnapshot, watchUsage } from '../usage/snapshot.ts';

export type { TuiActions, TicketInput } from './actions.ts';
export { defaultActions, PRIORITY_NOW } from './actions.ts';
export { renderPlain, renderJson } from './plain.ts';
export { loadSnapshot, snapshotKey } from './store.ts';
export type { Snapshot } from './store.ts';
export { applyFilter, parseFilter, matchesFilter } from './filter.ts';
export { tailLog, renderLogLine } from './log-tail.ts';
export { describeEvent } from './components/RunView.tsx';

interface CommonOptions {
  /** defaults to `openDb()` */
  db?: Database;
  /** override any list action (run now, pause, delete, save) */
  actions?: Partial<TuiActions>;
  pollMs?: number;
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
}

/** The cached usage snapshot and its refresher, for the header meter. */
function usageSource(db: Database): UsageSource {
  return { get: () => peekUsageSnapshot(db), subscribe: (cb) => watchUsage(db, cb) };
}

export interface OpenListOptions extends CommonOptions {
  /** start on this project; omitted = all projects (Tab cycles) */
  projectId?: number;
  /** show only these statuses (`--status`) */
  statuses?: TicketStatus[];
  /** own the whole terminal (alternate screen), default true; ignored when stdout is not a TTY */
  fullscreen?: boolean;
}

/** `salu list`: the interactive list. Resolves when the user quits. */
export async function openList(o: OpenListOptions = {}): Promise<void> {
  const db = o.db ?? openDb();
  const projectId = o.projectId ?? null;
  const initial = loadSnapshot(db, { projectId: null, statuses: o.statuses });
  await mount(
    <App db={db} projectId={projectId} statuses={o.statuses} actions={{ ...defaultActions(db), ...o.actions }} pollMs={o.pollMs} initial={initial} usage={usageSource(db)} />,
    { stdout: o.stdout, stdin: o.stdin, fullscreen: o.fullscreen ?? true },
  );
}

export interface OpenTicketFormOptions extends CommonOptions {
  /** edit this ticket; omitted = add a new one */
  ticketId?: number;
  /** project for a new ticket; omitted = the default project */
  projectId?: number;
  /** print the "✓ updated …" line afterwards (default true) */
  announce?: boolean;
}

/**
 * `salu change "name"` with no flags (or `salu add` with no arguments): the inline form
 * on its own. Resolves with what happened once the form closes.
 */
export async function openTicketForm(o: OpenTicketFormOptions = {}): Promise<FormResult> {
  const db = o.db ?? openDb();
  const result = await mount<FormResult>(
    <App db={db} projectId={o.projectId ?? null} actions={{ ...defaultActions(db), ...o.actions }} form={{ ticketId: o.ticketId, projectId: o.projectId }} />,
    { stdout: o.stdout, stdin: o.stdin },
  );
  const out = o.stdout ?? process.stdout;
  if (o.announce !== false) {
    if (result?.action === 'saved') out.write(`${green('✓')} updated #${result.ticket.id} ${result.ticket.name}\n`);
    else if (result?.action === 'added') out.write(`${green('✓')} added #${result.ticket.id} ${result.ticket.name}\n`);
    else out.write(`${dim('cancelled, nothing changed')}\n`);
  }
  return result ?? null;
}

export interface OpenRunViewOptions extends CommonOptions {
  projectIds?: number[];
  concurrency: number;
  /** asks the orchestrator to stop; the view closes when it emits `stop` */
  stop: () => void;
  /** orchestrator events feed the activity log; returns the unsubscribe function */
  subscribe: (fn: (e: OrchestratorEvent) => void) => () => void;
}

/** `salu run` foreground view. Resolves after the orchestrator reports `stop` (or q twice). */
export async function openRunView(o: OpenRunViewOptions): Promise<void> {
  const db = o.db ?? openDb();
  await mount(
    <RunView db={db} projectIds={o.projectIds} concurrency={o.concurrency} stop={o.stop} subscribe={o.subscribe} actions={{ ...defaultActions(db), ...o.actions }} pollMs={o.pollMs} />,
    { stdout: o.stdout, stdin: o.stdin, exitOnCtrlC: false },
  );
}
