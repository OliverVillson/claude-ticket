/**
 * One ticket = one Claude Code session.
 *
 * `sdkRunner` starts it through the Agent SDK; `runWorker` consumes any runner's stream, writes
 * every message to the run's JSONL log, keeps a live summary for the status view, and classifies
 * how the session ended. Nothing here touches the database; the scheduler does that.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { Project, TicketView } from '../db/types.ts';
import { ticketTags } from '../db/types.ts';
import type { Effort, Permission } from '../core/tags.ts';
import { workerEnv as scrubParentSession } from '../core/env.ts';
import { detectLimit, parseLimitText, probeWindow } from '../usage/index.ts';
import type { LimitHit } from '../usage/types.ts';
import { CLAUDE_MISSING, EnvironmentError, claudeExecutableOption, environmentProblem, runningCompiled } from '../core/claude-bin.ts';
import { DEFAULT_EFFORT, DEFAULT_MODEL } from '../core/tags.ts';
import { kernelOptions, prepareKernel, sandboxOn, scrubSecrets } from '../core/kernel.ts';
import { DEFAULT_TOOLS, denialsFrom, toolsToSdk } from '../core/tools.ts';
import { buildPrompt, buildResumePrompt, parseTrailer, systemAppend } from './prompt.ts';
import type { WorkerInput, WorkerLive, WorkerResult, WorkerRunner } from './types.ts';

export const DEFAULT_MAX_TURNS = 50;
export const DEFAULT_PERMISSION: Permission = (process.env.SALU_DEFAULT_PERMISSION as Permission) || 'acceptEdits';

/**
 * Variables a Claude Code session sets for its own children. A worker that inherits them thinks it
 * is that session: `CLAUDE_CODE_SESSION_ID` alone makes every worker report (and resume) the
 * parent's session id, so `salu run` started from inside Claude Code would give all tickets one
 * shared session. Auth and config variables are left alone.
 */
export const SESSION_ENV_VARS = [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_WORKER_EPOCH',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_AFTER_LAST_COMPACT',
  'CLAUDE_PID',
] as const;

/** `process.env` without the parent session's identity, plus the given extras. */
export function workerEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env = scrubParentSession(); // core helper: broader scrub, SALU_INHERIT_CLAUDE_ENV=1 opts out
  if (process.env.SALU_INHERIT_CLAUDE_ENV !== '1') for (const k of SESSION_ENV_VARS) delete env[k];
  return { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: 'salu/0.1.0', SALU_KERNEL_WORKER: '1', ...extra };
}

export interface EffectiveSettings {
  model: string | null;
  effort: Effort | null;
  permission: Permission;
  tools: string;
  maxTurns: number;
}

/** Ticket tags first, then the project's defaults, then ours. */
export function effectiveSettings(t: TicketView, project: Project | null): EffectiveSettings {
  const tags = ticketTags(t);
  const maxTurns = Number(tags['max-turns']);
  return {
    model: tags.model ?? project?.default_model ?? DEFAULT_MODEL,
    effort: ((tags.effort ?? project?.default_effort) as Effort | undefined) ?? (DEFAULT_EFFORT as Effort),
    permission: (tags.permission as Permission | undefined) ?? DEFAULT_PERMISSION,
    tools: tags.tools ?? project?.default_tools ?? DEFAULT_TOOLS,
    maxTurns: Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS,
  };
}

/** Pure mapping from a ticket to Agent SDK options, so it can be tested without spawning anything. */
export function workerSdkOptions(t: TicketView, project: Project | null, extra: { resume?: string | null; abort?: AbortController; kernel?: string } = {}): Options {
  const s = effectiveSettings(t, project);
  const opts: Options = {
    cwd: extra.kernel ?? t.project_path,
    maxTurns: s.maxTurns,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(t) },
    // Unattended: anything that would prompt is denied at once with a message telling the worker
    // so; it then works around it or ends with `TICKET: blocked`.
    permissionPrompts: 'none',
    persistSession: true,
    includePartialMessages: false,
    abortController: extra.abort,
    title: `ticket #${t.id} ${t.name}`,
    env: workerEnv({ TICKET_ID: String(t.id), TICKET_NAME: t.name, TICKET_PROJECT: t.project }),
  };
  const exe = claudeExecutableOption();
  if (exe) opts.pathToClaudeCodeExecutable = exe;
  if (s.model) opts.model = s.model;
  if (s.effort) opts.effort = s.effort;
  switch (s.permission) {
    case 'bypass':
      opts.permissionMode = 'bypassPermissions';
      opts.allowDangerouslySkipPermissions = true;
      break;
    case 'dontAsk':
      opts.permissionMode = 'dontAsk';
      break;
    case 'plan':
      opts.permissionMode = 'plan';
      break;
    case 'default':
      opts.permissionMode = 'default';
      break;
    default:
      opts.permissionMode = 'acceptEdits';
  }
  Object.assign(opts, toolsToSdk(s.tools, s.permission));
  if (extra.kernel) {
    // The kernel: OS sandbox around shell commands, secret paths closed to the file tools, no logins in the environment.
    const k = kernelOptions(extra.kernel);
    opts.sandbox = k.sandbox;
    opts.disallowedTools = [...(opts.disallowedTools ?? []), ...k.disallowedTools];
    opts.env = scrubSecrets(opts.env ?? {});
    opts.hooks = { ...opts.hooks, ...k.hooks };
  }
  if (extra.resume) opts.resume = extra.resume;
  return opts;
}

/** Append one JSON line to a log file, creating the folder on first use. Never throws: a log must not kill a worker. */
export function appendLogLine(path: string, value: unknown): void {
  try {
    appendFileSync(path, JSON.stringify(value) + '\n');
  } catch (e: any) {
    if (e?.code !== 'ENOENT') return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(value) + '\n');
    } catch {
      /* ignore */
    }
  }
}

/** Short label for a tool call, for the live view (`Bash: bun test`, `Edit: db.ts`). */
export function describeTool(name: string, input: any): string {
  const i = input ?? {};
  const one = (s: unknown, n = 60) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  switch (name) {
    case 'Bash':
      return `Bash: ${one(i.command)}`;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${name}: ${i.file_path ? basename(String(i.file_path)) : ''}`.trim();
    case 'Glob':
    case 'Grep':
      return `${name}: ${one(i.pattern, 40)}`;
    case 'Task':
    case 'Agent':
      return `Agent: ${one(i.description ?? i.prompt, 50)}`;
    case 'WebFetch':
      return `WebFetch: ${one(i.url, 50)}`;
    case 'WebSearch':
      return `WebSearch: ${one(i.query, 50)}`;
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'planning';
    default:
      return name;
  }
}

/** `Bash(bun test)`-style label, as `salu log` prints tool calls. */
export function describeToolCall(name: string, input: any): string {
  const d = describeTool(name, input);
  const i = d.indexOf(': ');
  return i > 0 ? `${d.slice(0, i)}(${d.slice(i + 2)})` : d;
}

function firstLine(s: string | null | undefined, n = 120): string {
  return (s ?? '').trim().split('\n')[0]!.slice(0, n);
}

/**
 * The typed `rate_limit_event` carries the exact reset time; the limit text only has a clock time
 * to the minute. Keep the typed one when both arrive, and never replace a known reset time with an unknown one.
 */
export function betterHit(current: LimitHit | null, next: LimitHit): boolean {
  if (!current) return true;
  if (current.source === 'rate_limit_event' && next.source !== 'rate_limit_event') return current.resetsAt == null && next.resetsAt != null;
  if (next.source === 'rate_limit_event') return true;
  return current.resetsAt == null && next.resetsAt != null;
}

export function promptFor(input: WorkerInput): string {
  return input.resume ? buildResumePrompt(input.ticket, input.resumeReason ?? 'it was paused or the orchestrator restarted') : buildPrompt(input.ticket);
}

// -------------------------------------------------------------------------------------------------
// The real runner
// -------------------------------------------------------------------------------------------------

export const sdkRunner: WorkerRunner = {
  name: 'sdk',
  async *run(input) {
    // The compiled binary has no claude of its own: fail with instructions, not the SDK's error.
    if (runningCompiled() && !claudeExecutableOption()) throw new EnvironmentError(process.env.SALU_CLAUDE_PATH ? `SALU_CLAUDE_PATH points to ${process.env.SALU_CLAUDE_PATH}, which is not an executable file` : CLAUDE_MISSING);
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const kernel = input.project?.sandbox && sandboxOn() ? prepareKernel(input.ticket.project, input.ticket.project_path) : undefined;
    const ticket = kernel ? { ...input.ticket, project_path: kernel } : input.ticket;
    const options = workerSdkOptions(ticket, input.project, { resume: input.resume, abort: input.abort, kernel });
    input = { ...input, ticket };
    const stderr: string[] = [];
    options.stderr = (data: string) => {
      const text = data.trim();
      if (text) stderr.push(text);
    };
    yield { type: 'ticket_start', ts: Date.now(), ticket_id: input.ticket.id, name: input.ticket.name, project: input.ticket.project, resume: !!options.resume, runner: 'sdk', options: { model: options.model ?? null, effort: options.effort ?? null, permissionMode: options.permissionMode, maxTurns: options.maxTurns, cwd: options.cwd } };
    const q = query({ prompt: promptFor(input), options });
    try {
      for await (const m of q) {
        while (stderr.length) yield { type: 'stderr', text: stderr.shift(), ts: Date.now() };
        yield m;
      }
    } catch (e) {
      // The process's own explanation (bad flag, not logged in, ...) is on stderr; log it before rethrowing.
      while (stderr.length) yield { type: 'stderr', text: stderr.shift(), ts: Date.now() };
      throw e;
    }
    while (stderr.length) yield { type: 'stderr', text: stderr.shift(), ts: Date.now() };
  },
  async probe(model) {
    const r = await probeWindow({ model: model ?? undefined, cwd: process.env.TMPDIR || '/tmp' });
    if (r.status === 'closed' && r.hit) return r.hit;
    if (r.status === 'open') return 'ok';
    // Inconclusive: report it as an unknown limit with no time so the caller backs off briefly.
    return { kind: 'unknown', resetsAt: null, models: [], source: 'usage_probe', raw: r.detail ?? 'probe inconclusive' };
  },
};

/** The runner the environment asks for: `SALU_WORKER=fake` for tests, the SDK otherwise. */
export async function selectRunner(): Promise<WorkerRunner> {
  if (process.env.SALU_WORKER === 'fake') return (await import('./fake.ts')).fakeRunner;
  return sdkRunner;
}

// -------------------------------------------------------------------------------------------------
// Consuming a runner's stream
// -------------------------------------------------------------------------------------------------

export interface RunWorkerParams extends WorkerInput {
  /** JSONL file every message is appended to. */
  logPath: string;
  runner: WorkerRunner;
  onLive?: (live: WorkerLive) => void;
  /** Called with every `rate_limit_info` the session streams (status, utilization, reset time). */
  onRateLimit?: (info: any) => void;
}

/**
 * Run one ticket to the end of its session and say how it went. Never throws: a crash of the SDK
 * or of the `claude` process is a `failed` result (or `killed` when we aborted it).
 */
export async function runWorker(p: RunWorkerParams): Promise<WorkerResult> {
  const { ticket: t, abort } = p;
  const live: WorkerLive = { turns: 0, lastTool: null, lastText: null, model: null, sessionId: p.resume };
  const emitLive = () => p.onLive?.({ ...live });

  let result: any = null;
  let limit: LimitHit | null = null;
  let lastApiError: string | null = null;
  let crash: string | null = null;
  let lastStderr: string | null = null;
  let lastMsgId: string | null = null;

  try {
    for await (const m of p.runner.run(p)) {
      appendLogLine(p.logPath, m);
      if (m?.type === 'stderr' && m.text) lastStderr = firstLine(String(m.text), 200);
      if (m?.type === 'rate_limit_event' && m.rate_limit_info) {
        try {
          p.onRateLimit?.(m.rate_limit_info);
        } catch {
          /* a usage meter must not break a worker */
        }
      }
      const hit = detectLimit(m);
      if (hit && betterHit(limit, hit)) limit = hit;
      switch (m?.type) {
        case 'system':
          if (m.subtype === 'init') {
            live.sessionId = m.session_id ?? live.sessionId;
            live.model = m.model ?? live.model;
            emitLive();
          } else if (m.subtype === 'api_retry') {
            lastApiError = m.error ?? lastApiError;
          }
          break;
        case 'assistant': {
          if (m.parent_tool_use_id) break; // a subagent's message; we count the main loop's turns
          if (m.error) lastApiError = m.error;
          // The SDK streams one assistant message per content block; a turn is one API response.
          const msgId = m.message?.id;
          if (!msgId || msgId !== lastMsgId) live.turns++;
          lastMsgId = msgId ?? null;
          const content: any[] = Array.isArray(m.message?.content) ? m.message.content : [];
          for (const block of content) {
            if (block?.type === 'tool_use') live.lastTool = describeTool(block.name, block.input);
            else if (block?.type === 'text' && String(block.text).trim()) live.lastText = firstLine(String(block.text));
          }
          emitLive();
          break;
        }
        case 'result':
          result = m;
          live.sessionId = m.session_id ?? live.sessionId;
          break;
        default:
          break;
      }
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e).split('\n')[0]!;
    const envProblem = abort.signal.aborted ? null : e instanceof EnvironmentError || e?.code === 'SALU_ENV' ? String(e.message) : environmentProblem(`${msg} ${lastStderr ?? ''}`);
    if (envProblem) {
      appendLogLine(p.logPath, { type: 'worker_error', ts: Date.now(), error: envProblem, environment: true });
      return { sessionId: live.sessionId ?? p.resume ?? null, costUsd: 0, turns: live.turns, limit: null, resumable: true, outcome: 'failed', message: envProblem, subtype: 'environment' };
    }
    crash = abort.signal.aborted ? 'aborted' : lastStderr && !msg.includes(lastStderr) ? `${msg}: ${lastStderr}` : msg;
    appendLogLine(p.logPath, { type: 'worker_error', ts: Date.now(), error: crash });
  }

  const sessionId = live.sessionId ?? p.resume ?? null;
  const base = { sessionId, costUsd: Number(result?.total_cost_usd ?? 0) || 0, turns: Number(result?.num_turns ?? live.turns) || 0, limit: null as LimitHit | null, resumable: false, denials: denialsFrom(result?.permission_denials) };

  if (abort.signal.aborted) return { ...base, outcome: 'killed', message: 'stopped by the orchestrator', subtype: 'aborted' };

  const text: string = result ? (result.subtype === 'success' ? String(result.result ?? '') : (result.errors ?? []).join('\n')) : '';
  const isError = !result || result.is_error || result.subtype !== 'success';

  // A usage limit: the typed event, the limit text in the result or the crash, or a 429 the CLI gave up on.
  if (isError && (limit || parseLimitText(text) || parseLimitText(crash) || lastApiError === 'rate_limit')) {
    const hit: LimitHit = limit ?? parseLimitText(text) ?? parseLimitText(crash) ?? { kind: 'unknown', resetsAt: null, models: [], source: 'error_text', raw: firstLine(text || crash || 'rate limited by the API', 200) };
    return { ...base, outcome: 'rate_limited', message: firstLine(hit.raw, 200), limit: hit, subtype: result?.subtype ?? 'error', resumable: true };
  }

  // Logged out, expired login, bad key: nothing the ticket can fix. The scheduler re-queues it and stops the run.
  if (isError) {
    const env = environmentProblem(`${lastApiError === 'authentication_failed' ? 'authentication_failed ' : ''}${text} ${crash ?? ''}`);
    if (env) {
      appendLogLine(p.logPath, { type: 'worker_error', ts: Date.now(), error: env, environment: true });
      return { ...base, outcome: 'failed', message: env, subtype: 'environment', resumable: true };
    }
  }

  const trailer = parseTrailer(text);
  if (trailer?.kind === 'blocked') return { ...base, outcome: 'blocked', message: trailer.message || 'the worker needs a human decision', subtype: result?.subtype ?? null };
  if (trailer?.kind === 'failed') return { ...base, outcome: 'failed', message: trailer.message || 'the worker gave up', subtype: result?.subtype ?? null };

  if (result && result.subtype === 'success' && !result.is_error) {
    return { ...base, outcome: 'done', message: trailer ? trailer.message || null : firstLine(text, 200) || null, subtype: 'success' };
  }
  if (!result) return { ...base, outcome: 'failed', message: crash ?? 'the worker ended without a result', subtype: 'error' };

  const resumable = result.subtype === 'error_max_turns' || result.subtype === 'error_max_budget_usd';
  const reason = result.subtype === 'error_max_turns' ? `ran out of turns (${result.num_turns})` : result.subtype === 'error_max_budget_usd' ? 'ran out of budget' : firstLine(text || String(result.subtype), 200);
  return { ...base, outcome: 'failed', message: reason, subtype: result.subtype, resumable };
}
