import type { Project, RunOutcome, TicketStatus, TicketView } from '../db/types.ts';
import type { LimitHit } from '../usage/types.ts';

/**
 * Events the loop emits. The shape is the contract in INTERFACES.md (the TUI's run view
 * subscribes to them); fields beyond the contract are optional extras.
 */
export type OrchestratorEvent =
  | { type: 'start'; pid: number; concurrency: number; recovered?: number }
  | { type: 'dispatch'; ticket: TicketView; runId: number; resumed: boolean }
  | { type: 'worker'; ticket: TicketView; turns: number; lastTool: string | null; text?: string; model?: string | null }
  | { type: 'finish'; ticket: TicketView; outcome: RunOutcome; costUsd: number; turns: number; error?: string; status?: TicketStatus | null; durationMs?: number }
  | { type: 'pause'; until: number | null; reason: string; kind: string; models: string[]; manual?: boolean }
  | { type: 'resume' }
  | { type: 'probe'; ok: boolean; detail?: string }
  | { type: 'idle' }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'stop' };

export type EventListener = (e: OrchestratorEvent) => void;

/** How one worker run ended. Same values as `RunOutcome` in the runs table. */
export type WorkerOutcome = RunOutcome;

export interface WorkerResult {
  outcome: WorkerOutcome;
  /** Claude Code session id, kept on the ticket so a later run can resume it. */
  sessionId: string | null;
  costUsd: number;
  turns: number;
  /** The question (blocked), the reason (failed) or the limit text (rate_limited). */
  message: string | null;
  /** The usage-limit hit when outcome is rate_limited. */
  limit: LimitHit | null;
  /** SDK result subtype (`success`, `error_max_turns`, ...) or `aborted` / `error`. */
  subtype: string | null;
  /** True when a retry should resume the same session (ran out of turns or budget). */
  resumable: boolean;
}

/** What the orchestrator knows about a running worker while it streams. */
export interface WorkerLive {
  turns: number;
  lastTool: string | null;
  lastText: string | null;
  model: string | null;
  sessionId: string | null;
}

/** What a runner gets for one worker session. */
export interface WorkerInput {
  ticket: TicketView;
  project: Project | null;
  /** Session id to resume, or null for a fresh session. */
  resume: string | null;
  /** Why the session is resumed, for the resume prompt. */
  resumeReason?: string;
  abort: AbortController;
}

/**
 * Something that runs one ticket as a stream of Agent-SDK-shaped messages, and can check whether
 * the usage window is open. `sdkRunner` is the real one; `fakeRunner` (TICKET_WORKER=fake) is for tests.
 */
export interface WorkerRunner {
  readonly name: 'sdk' | 'fake';
  run(input: WorkerInput): AsyncIterable<any>;
  probe(model?: string | null): Promise<'ok' | LimitHit>;
}
