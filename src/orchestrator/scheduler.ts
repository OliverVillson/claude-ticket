/**
 * The dispatch loop. Deterministic code, no model calls of its own.
 *
 * Wakes on a worker exit, on the wake file the CLI touches after any change, or on the heartbeat.
 * Each tick: write the heartbeat, reconcile running workers with the database, ask the usage hooks
 * whether dispatch is held, then claim tickets into free slots and start one worker per ticket.
 */
import type { Denial } from '../core/tools.ts';
import type { Database } from 'bun:sqlite';
import { statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { recordRemoteEvent } from '../sync/events.ts';
import { isRemoteOut } from '../sync/store.ts';
import { addTurn, claimNextTicket, createRun, listTurns, markFollowUpsDelivered, pendingFollowUps, finishRun, getProjectById, getProjectByName, getState, inheritedProject, getTicketById, listProjects, listTickets, setState, updateTicket, type TicketPatch } from '../db/queries.ts';
import { STATE, type Run, type TicketStatus, type TicketView } from '../db/types.ts';
import { CliError } from '../core/errors.ts';
import { ticketBranch } from '../core/branch.ts';
import { kernelPath, sandboxOn } from '../core/kernel.ts';
import { logsDir, ticketHome, wakeFile } from '../core/paths.ts';
import { clearPause, resolveHooks, type UsageHooks } from './gate.ts';
import { clearAllWorkerInfo, clearWorkerInfo, HEARTBEAT_MS, readStatus, setPause, writeWorkerInfo, type PauseInfo } from './status.ts';
import { runWorker as defaultRunWorker, selectRunner, type RunWorkerParams } from './worker.ts';
import type { EventListener, OrchestratorEvent, WorkerLive, WorkerResult, WorkerRunner } from './types.ts';
import { recordRateLimitEvent } from '../usage/index.ts';

export const DEFAULT_CONCURRENCY = 2;
/** A ticket is marked `failed` once this many attempts have failed. */
export const DEFAULT_MAX_ATTEMPTS = 2;
const LIVE_WRITE_MIN_MS = 250;
/** How often the wake file's mtime is checked (see `startWatcher`). */
export const WAKE_POLL_MS = 150;

export type RunWorkerFn = (p: RunWorkerParams) => Promise<WorkerResult>;

export interface SchedulerOptions {
  db: Database;
  /** Only dispatch tickets of these projects. Default: every project. */
  projectIds?: number[];
  /** Global cap on running workers. Default: the `concurrency` state key, else SALU_CONCURRENCY, else 2. */
  concurrency?: number;
  hooks?: Partial<UsageHooks>;
  /** The worker runner. Default: `selectRunner()` (the SDK, or the fake with SALU_WORKER=fake). */
  runner?: WorkerRunner;
  /** Injected stream consumer (tests). */
  runWorker?: RunWorkerFn;
  onEvent?: EventListener;
  signal?: AbortSignal;
  heartbeatMs?: number;
  maxAttempts?: number;
  /** Stop once no ticket is left to run and no worker is running (scripts, tests). */
  exitWhenEmpty?: boolean;
  /** Folder holding the wake file. Default: SALU_HOME. */
  home?: string;
  /** Folder for run logs. Default: SALU_HOME/logs. */
  logs?: string;
}

interface Active {
  ticket: TicketView;
  run: Run;
  abort: AbortController;
  startedAt: number;
  live: WorkerLive;
  lastLiveWrite: number;
  promise: Promise<void>;
}

/** What to show on a blocked ticket: the permission it needs first (if the worker was refused something), then the worker's own words. */
export function needsPermission(denials: Denial[] | undefined, message: string | null): string | null {
  if (!denials?.length) return message;
  const rules = [...new Set(denials.map((d) => d.rule))].join(', ');
  return `needs permission: ${rules}${message ? ` · ${message}` : ''}`;
}

export class Orchestrator {
  readonly db: Database;
  private readonly opts: SchedulerOptions;
  private readonly hooks: UsageHooks;
  private readonly runWorkerFn: RunWorkerFn;
  private runner: WorkerRunner | null;
  private readonly listeners = new Set<EventListener>();
  private readonly active = new Map<number, Active>();
  private wakeResolve: (() => void) | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private watcher: FSWatcher | null = null;
  private wakePoll: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  /** Set when a worker could not start Claude Code at all; ends the run after the workers in flight. */
  private envProblem: string | null = null;
  private started = false;
  private lastPauseKey: string | null = null;
  private resuming = false;
  private wasIdle = false;
  private readonly heartbeatMs: number;
  private readonly maxAttempts: number;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
    this.db = opts.db;
    this.hooks = resolveHooks(opts.hooks);
    this.runWorkerFn = opts.runWorker ?? defaultRunWorker;
    this.runner = opts.runner ?? null;
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (opts.onEvent) this.listeners.add(opts.onEvent);
    opts.signal?.addEventListener('abort', () => this.stop('aborted'), { once: true });
  }

  // ---------------------------------------------------------------------------------------------
  // Public surface
  // ---------------------------------------------------------------------------------------------

  on(l: EventListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Number of workers running right now. */
  get running(): number {
    return this.active.size;
  }

  /** Tickets currently running, with their live summaries. */
  get workers(): { ticket: TicketView; live: WorkerLive; startedAt: number; run: Run }[] {
    return [...this.active.values()].map((a) => ({ ticket: a.ticket, live: a.live, startedAt: a.startedAt, run: a.run }));
  }

  /** The global concurrency cap as it stands now. */
  get concurrency(): number {
    if (this.opts.concurrency && this.opts.concurrency > 0) return this.opts.concurrency;
    const fromState = Number(getState(this.db, STATE.concurrency));
    if (Number.isInteger(fromState) && fromState > 0) return fromState;
    const fromEnv = Number(process.env.SALU_CONCURRENCY);
    if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
    return DEFAULT_CONCURRENCY;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /** Make the loop run a tick now. Safe from anywhere. */
  wake(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    const r = this.wakeResolve;
    this.wakeResolve = null;
    r?.();
  }

  /** Hold dispatch by hand. Running workers are left alone. Same state as `salu pause`. */
  pause(p: { until: number | null; reason: string; kind: string; models?: string[]; manual?: boolean } = { until: null, reason: 'paused', kind: 'manual', manual: true }): void {
    setPause(this.db, p);
    this.wake();
  }

  /** Lift any pause and dispatch right away. Same as `salu resume`. */
  resume(): void {
    clearPause(this.db);
    this.wake();
  }

  /** Ask the loop to stop: workers are interrupted and their tickets go back to `todo` with their session kept. */
  stop(reason = 'stopped'): void {
    if (this.stopping) return;
    this.stopping = true;
    this.log('info', `stopping (${reason})${this.active.size ? `; interrupting ${this.active.size} worker${this.active.size === 1 ? '' : 's'}` : ''}`);
    for (const a of this.active.values()) a.abort.abort();
    this.wake();
  }

  /** Run until `stop()` (or, with `exitWhenEmpty`, until the queue is drained). */
  async start(): Promise<void> {
    if (this.started) throw new Error('orchestrator already started');
    this.started = true;
    const db = this.db;
    const st = readStatus(db);
    if (st.alive && st.pid && st.pid !== process.pid) {
      throw new CliError(`an orchestrator is already running (pid ${st.pid}); \`salu stop\` ends it`);
    }
    if (!this.runner) this.runner = await selectRunner();
    const now = Date.now();
    setState(db, STATE.pid, process.pid);
    setState(db, STATE.startedAt, now);
    setState(db, STATE.heartbeat, now);
    clearAllWorkerInfo(db);
    const recovered = this.recoverStale();
    this.startWatcher();
    this.emit({ type: 'start', pid: process.pid, concurrency: this.concurrency, recovered });
    if (recovered) this.log('info', `${recovered} ticket${recovered === 1 ? '' : 's'} left running by an earlier orchestrator went back to the queue`);

    try {
      while (true) {
        let sleepMs = this.heartbeatMs;
        try {
          sleepMs = this.tick();
        } catch (e: any) {
          this.log('error', String(e?.message ?? e));
        }
        if (this.stopping && this.active.size === 0) break;
        if (!this.stopping && this.opts.exitWhenEmpty && this.active.size === 0 && !this.resuming && this.queuedCount() === 0) break;
        await this.sleep(sleepMs);
      }
      if (this.active.size) await this.drainWorkers(15_000);
    } finally {
      this.watcher?.close();
      this.watcher = null;
      if (this.wakePoll) clearInterval(this.wakePoll);
      this.wakePoll = null;
      clearAllWorkerInfo(db);
      if (Number(getState(db, STATE.pid)) === process.pid) {
        setState(db, STATE.pid, null);
        setState(db, STATE.heartbeat, null);
        setState(db, STATE.startedAt, null);
      }
      this.emit({ type: 'stop' });
    }
  }

  // ---------------------------------------------------------------------------------------------
  // The loop
  // ---------------------------------------------------------------------------------------------

  /** One pass. Returns how long to sleep before the next one unless woken. */
  private tick(): number {
    const db = this.db;
    const now = Date.now();
    setState(db, STATE.heartbeat, now);
    this.reconcile();
    if (this.stopping) return this.heartbeatMs;

    let sleepMs = this.heartbeatMs;
    let excludeModels: string[] | null = null; // null = dispatch everything
    const pause = this.hooks.currentPause(db, now);
    if (pause) {
      const key = JSON.stringify(pause);
      if (key !== this.lastPauseKey) {
        this.lastPauseKey = key;
        this.emit({ type: 'pause', until: pause.until, reason: pause.reason ?? 'paused', kind: pause.kind ?? 'unknown', models: pause.models, manual: pause.manual });
      }
      if (!pause.manual && pause.until != null && pause.until <= now) {
        this.confirmResume(pause, now);
      } else if (!pause.manual && pause.until != null) {
        sleepMs = Math.max(50, Math.min(sleepMs, pause.until - now + 5));
      }
      if (pause.models.length === 0) return sleepMs; // everything held
      excludeModels = pause.models;
    } else if (this.lastPauseKey !== null) {
      this.lastPauseKey = null;
      this.emit({ type: 'resume' });
    }

    this.dispatch(excludeModels);

    const idle = this.active.size === 0 && !pause && this.queuedCount() === 0;
    if (idle && !this.wasIdle) this.emit({ type: 'idle' });
    this.wasIdle = idle;
    return sleepMs;
  }

  /** Start workers into free slots, honouring the global cap and each project's own cap. */
  private dispatch(excludeModels: string[] | null): void {
    const db = this.db;
    const cap = this.concurrency;
    let guard = 0;
    while (this.active.size < cap && guard++ < 100) {
      const projects = listProjects(db).filter((p) => !this.opts.projectIds || this.opts.projectIds.includes(p.id));
      if (projects.length === 0) return;
      const eligible = projects.filter((p) => p.concurrency == null || p.concurrency <= 0 || this.runningIn(p.id) < p.concurrency).map((p) => p.id);
      if (eligible.length === 0) return;
      const t = claimNextTicket(db, {
        projectIds: this.opts.projectIds || eligible.length < projects.length ? eligible : undefined,
        excludeModels: excludeModels ?? undefined,
      });
      if (!t) return;
      this.launch(t);
    }
  }

  private launch(t: TicketView): void {
    const db = this.db;
    const base = getProjectById(db, t.project_id);
    const project = base ? inheritedProject(db, base) : null;
    const run = createRun(db, t.id, null);
    const logPath = join(this.opts.logs ?? logsDir(), slug(t.project), `${t.id}-${run.id}.jsonl`);
    db.run('UPDATE runs SET log_path = ? WHERE id = ?', [logPath, run.id]);
    run.log_path = logPath;
    const resumed = !!t.session_id;
    const pending = pendingFollowUps(db, t.id);
    const followUp = pending.length ? pending.map((x) => x.body) : undefined;
    if (pending.length) markFollowUpsDelivered(db, t.id);
    const abort = new AbortController();
    const startedAt = Date.now();
    const live: WorkerLive = { turns: 0, lastTool: null, lastText: null, model: null, sessionId: t.session_id };
    const entry: Active = { ticket: t, run, abort, startedAt, live, lastLiveWrite: 0, promise: Promise.resolve() };
    this.active.set(t.id, entry);
    this.writeLive(entry, true);
    this.emit({ type: 'dispatch', ticket: t, runId: run.id, resumed });

    entry.promise = this.runWorkerFn({
      ticket: t,
      project,
      logPath,
      runner: this.runner!,
      resume: resumed ? t.session_id : null,
      followUp,
      history: followUp && !resumed ? listTurns(db, t.id).filter((x) => x.delivered).map((x) => ({ role: x.role, body: x.body })) : undefined,
      resumeReason: t.error ? t.error : 'it was paused or the orchestrator restarted',
      abort,
      onRateLimit: (info) => recordRateLimitEvent(this.db, info),
      onLive: (l) => {
        entry.live = l;
        this.writeLive(entry, false);
        this.emit({ type: 'worker', ticket: t, turns: l.turns, lastTool: l.lastTool, text: l.lastText ?? undefined, model: l.model });
      },
    })
      .catch(
        (e): WorkerResult => ({
          outcome: abort.signal.aborted ? 'killed' : 'failed',
          sessionId: entry.live.sessionId,
          costUsd: 0,
          turns: entry.live.turns,
          message: String(e?.message ?? e),
          limit: null,
          subtype: 'error',
          resumable: false,
        }),
      )
      .then((result) => this.onExit(entry, result))
      .catch((e) => this.log('error', `exit handler: ${String(e?.message ?? e)}`));
  }

  /** The salu/<ticket> branch a finished ticket committed on, if the project folder (or its kernel copy) has one. */
  private branchFor(t: TicketView): string | null {
    try {
      const sandboxed = getProjectByName(this.db, t.project)?.sandbox && sandboxOn();
      return ticketBranch(sandboxed ? kernelPath(t.project) : t.project_path, t.name);
    } catch {
      return null;
    }
  }

  /** Persist a worker's outcome: the run row, then the ticket's status, cost and session; then wake. */
  private onExit(entry: Active, result: WorkerResult): void {
    const db = this.db;
    const t = entry.ticket;
    this.active.delete(t.id);
    clearWorkerInfo(db, t.id);
    const now = Date.now();
    if (result.outcome === 'done' || result.outcome === 'blocked') {
      const reply = (result.text ?? '').trim() || result.message?.trim();
      if (reply) addTurn(db, t.id, 'assistant', reply);
    }
    finishRun(db, entry.run.id, { outcome: result.outcome, turns: result.turns, cost_usd: result.costUsd });

    const fresh = getTicketById(db, t.id);
    let status: TicketStatus | null = null;
    if (fresh && fresh.status === 'running') {
      const patch: TicketPatch = {
        session_id: result.sessionId ?? fresh.session_id,
        cost_usd: (fresh.cost_usd ?? 0) + (result.costUsd ?? 0),
      };
      switch (result.outcome) {
        case 'done':
          patch.status = 'done';
          patch.summary = result.summary ?? null;
          patch.branch = this.branchFor(t);
          patch.finished_at = now;
          patch.error = null;
          break;
        case 'blocked':
          patch.status = 'blocked';
          patch.error = needsPermission(result.denials, result.message);
          patch.denied = result.denials?.length ? JSON.stringify(result.denials) : null;
          break;
        case 'rate_limited':
          // Parked with its session; not an attempt the ticket should be blamed for.
          patch.status = 'paused';
          patch.error = null;
          patch.attempts = Math.max(0, fresh.attempts - 1);
          break;
        case 'killed':
          patch.status = 'todo';
          patch.error = null;
          patch.attempts = Math.max(0, fresh.attempts - 1);
          break;
        case 'failed':
          if (result.subtype === 'environment') {
            // The machine, not the ticket: no attempt burned, no failure recorded, and nothing else
            // is dispatched until the problem is fixed (the reason stays on the ticket).
            patch.status = 'todo';
            patch.attempts = Math.max(0, fresh.attempts - 1);
            patch.error = result.message;
            this.envProblem = result.message;
            break;
          }
          if (fresh.attempts >= this.maxAttempts) {
            patch.status = 'failed';
            patch.finished_at = now;
          } else {
            patch.status = 'todo';
            if (!result.resumable) patch.session_id = null; // start clean next time
          }
          patch.error = result.message;
          if (patch.status === 'failed') patch.denied = result.denials?.length ? JSON.stringify(result.denials) : null;
          break;
      }
      // A follow-up sent while the worker was busy: the ticket goes straight back to the queue.
      if ((patch.status === 'done' || patch.status === 'blocked') && pendingFollowUps(db, t.id).length) {
        patch.status = 'todo';
        patch.attempts = 0;
        patch.finished_at = null;
      }
      status = patch.status ?? null;
      updateTicket(db, t.id, patch);
    }

    if (this.envProblem && !this.stopping) {
      this.log('error', `${this.envProblem} The ticket went back to todo; run \`salu run\` again once this is fixed.`);
      this.emit({ type: 'environment', message: this.envProblem });
      this.stop('environment problem');
    }
    if (result.outcome === 'rate_limited' && result.limit && !this.stopping) {
      try {
        const r = this.hooks.onLimitHit(db, result.limit, fresh ?? t, now);
        if (r && typeof (r as Promise<void>).then === 'function') (r as Promise<void>).catch((e) => this.log('error', `onLimitHit: ${String(e?.message ?? e)}`));
      } catch (e: any) {
        this.log('error', `onLimitHit: ${String(e?.message ?? e)}`);
      }
    }
    this.emit({ type: 'finish', ticket: fresh ?? t, outcome: result.outcome, costUsd: result.costUsd, turns: result.turns, error: result.outcome === 'done' ? undefined : result.message ?? undefined, status, durationMs: now - entry.startedAt });
    this.wake();
  }

  /** The pause's reset time has passed: let the usage hooks confirm and clear it, once at a time. */
  private confirmResume(pause: PauseInfo, now: number): void {
    if (this.resuming) return;
    this.resuming = true;
    Promise.resolve()
      .then(() => this.hooks.resumeIfDue(this.db, pause, this.runner!, now))
      .then((r) => {
        this.emit({ type: 'probe', ok: r.resumed, detail: r.detail });
        if (!r.resumed && this.hooks.currentPause(this.db, Date.now())?.until === pause.until) {
          // The hook neither cleared nor extended the pause: back off a little so we do not spin.
          setPause(this.db, { until: Date.now() + 60_000, reason: pause.reason ?? 'usage limit', kind: pause.kind ?? 'unknown', models: pause.models, manual: false });
        }
      })
      .catch((e) => {
        this.log('error', `resume check failed: ${String(e?.message ?? e)}`);
        setPause(this.db, { until: Date.now() + 60_000, reason: pause.reason ?? 'usage limit', kind: pause.kind ?? 'unknown', models: pause.models, manual: false });
      })
      .finally(() => {
        this.resuming = false;
        this.wake();
      });
  }

  /** Stop workers whose ticket was removed or moved out of `running` by hand. */
  private reconcile(): void {
    for (const [id, a] of this.active) {
      const t = getTicketById(this.db, id);
      if (!t || t.status !== 'running') {
        if (!a.abort.signal.aborted) {
          this.log('info', `${a.ticket.name}: ${t ? `status changed to ${t.status}` : 'ticket removed'}, stopping its worker`);
          a.abort.abort();
        }
      } else if (Date.now() - a.lastLiveWrite > this.heartbeatMs) this.writeLive(a, true);
    }
  }

  /** Tickets left `running` by a dead orchestrator go back to the queue; their session is kept so they resume. */
  private recoverStale(): number {
    let n = 0;
    for (const t of listTickets(this.db, { status: 'running' })) {
      updateTicket(this.db, t.id, { status: 'todo', attempts: Math.max(0, t.attempts - 1), error: t.error ?? 'the orchestrator restarted' });
      n++;
    }
    return n;
  }

  private queuedCount(): number {
    // Tickets sent to a box (salu remote) only show as queued here; this machine never runs them.
    const rows = listTickets(this.db, { status: ['todo', 'paused'] }).filter((r) => !isRemoteOut(this.db, r.id));
    return this.opts.projectIds ? rows.filter((r) => this.opts.projectIds!.includes(r.project_id)).length : rows.length;
  }

  private runningIn(projectId: number): number {
    let n = 0;
    for (const a of this.active.values()) if (a.ticket.project_id === projectId) n++;
    return n;
  }

  private writeLive(a: Active, force: boolean): void {
    const now = Date.now();
    if (!force && now - a.lastLiveWrite < LIVE_WRITE_MIN_MS) return;
    a.lastLiveWrite = now;
    writeWorkerInfo(this.db, {
      ticketId: a.ticket.id,
      runId: a.run.id,
      startedAt: a.startedAt,
      turns: a.live.turns,
      lastTool: a.live.lastTool,
      lastText: a.live.lastText,
      model: a.live.model,
      sessionId: a.live.sessionId,
      updatedAt: now,
    });
  }

  /**
   * Wake on changes to the wake file the CLI touches after every write. `fs.watch` catches content
   * writes but not the mtime-only `utimes` that `wakeOrchestrator()` does on an existing file (Bun
   * and Node on Linux), so the file's mtime is also checked a few times a second; both routes
   * lead to `wake()`.
   */
  private startWatcher(): void {
    const home = this.opts.home ?? ticketHome();
    const file = this.opts.home ? join(this.opts.home, 'wake') : wakeFile();
    try {
      this.watcher = watch(home, { persistent: false }, (_event, filename) => {
        if (!filename || String(filename) === 'wake') this.wake();
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
    let last = mtime(file);
    this.wakePoll = setInterval(() => {
      const m = mtime(file);
      if (m !== last) {
        last = m;
        this.wake();
      }
    }, WAKE_POLL_MS);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((res) => {
      this.wakeResolve = res;
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = null;
        this.wakeResolve = null;
        res();
      }, Math.max(1, ms));
    });
  }

  private async drainWorkers(timeoutMs: number): Promise<void> {
    const pending = [...this.active.values()].map((a) => a.promise);
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, timeoutMs))]);
    // Anything still marked running after the grace period is parked so the next run resumes it.
    for (const [id, a] of [...this.active]) {
      this.active.delete(id);
      clearWorkerInfo(this.db, id);
      const t = getTicketById(this.db, id);
      if (t && t.status === 'running') updateTicket(this.db, id, { status: 'todo', attempts: Math.max(0, t.attempts - 1), error: null });
      finishRun(this.db, a.run.id, { outcome: 'killed', turns: a.live.turns, cost_usd: null });
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.emit({ type: 'log', level, message });
  }

  private emit(e: OrchestratorEvent): void {
    recordRemoteEvent(this.db, e); // messages for `salu notif` when this machine is a project's box
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a broken listener must not stop the loop */
      }
    }
  }
}

function mtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Folder-safe project name for log paths. */
export function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
}
