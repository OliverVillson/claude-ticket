import { claudeExecutableOption } from '../core/claude-bin.ts';
import { detectLimit, kindForWindow, limitFromRateLimitInfo, parseLimitText, toEpochMs } from './detect.ts';
import type { LimitHit, ProbeResult } from './types.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ticketHome } from '../core/paths.ts';

/**
 * Is the window open again? Two checks, cheapest first:
 *  1. The `/usage` data (`get_usage` control request): the plan's windows with utilization and
 *     reset time, read from the claude.ai usage endpoint without a model turn. Experimental in
 *     the SDK, so any failure falls through.
 *  2. A one-turn call on the cheapest model with a one-word prompt, no tools, no settings files.
 *     A `rate_limit_event` with status `rejected` or a limit line means still closed; a normal
 *     result means open.
 */

export type QueryLike = (args: { prompt: any; options?: any }) => AsyncIterable<any> & Record<string, any>;

export interface ProbeOptions {
  /** Folder to run the probe in. Defaults to the current folder; must exist. */
  cwd?: string;
  /**
   * Model for the turn probe. Default: the paused model for a model-specific pause, else
   * `haiku`. `null` lets Claude Code pick its default.
   */
  model?: string | null;
  /** The pause being checked; decides which usage windows count. */
  pause?: { kind?: string; models?: string[] };
  /** Whole-probe timeout. Default 120 s. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Try the `/usage` data first. Default true. */
  readUsage?: boolean;
  /** Replace the SDK's `query` (tests). */
  queryFn?: QueryLike;
  log?: (line: string) => void;
}

/** process.env without the variables that tie a child to the Claude Code session running us. */
function probeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (/^CLAUDE_CODE_(SESSION|REMOTE_SESSION|MESSAGING|WORKER_EPOCH|CHILD_SESSION)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

const PROBE_PROMPT = 'Reply with the single word: ok';
const PROBE_SYSTEM = 'Reply with exactly the word ok and nothing else.';

async function loadQuery(): Promise<QueryLike> {
  const sdk: any = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query as QueryLike;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Pick the probe model: the limited model for a model-specific pause, else the cheapest. */
export function probeModelFor(pause?: { models?: string[] }): string {
  const m = pause?.models?.[0];
  return m && m !== 'fable' ? m : m === 'fable' ? 'fable' : 'haiku';
}

/** Which `/usage` windows decide whether this pause is over. */
function windowsFor(pause?: { models?: string[] }): string[] {
  const models = (pause?.models ?? []).map((m) => m.toLowerCase());
  const w = ['five_hour', 'seven_day'];
  if (models.length === 0) return w;
  if (models.some((m) => m.includes('opus'))) w.push('seven_day_opus');
  if (models.some((m) => m.includes('sonnet'))) w.push('seven_day_sonnet');
  return w;
}

/** Interpret a `get_usage` response for this pause. Exported for tests. */
export function interpretUsage(usage: any, pause: { kind?: string; models?: string[] } | undefined, now = Date.now()): ProbeResult {
  if (!usage || typeof usage !== 'object') return { status: 'unknown', detail: 'no usage data' };
  if (usage.rate_limits_available === false || !usage.rate_limits) {
    return { status: 'unknown', detail: 'plan rate limits not available (API key or third-party provider?)' };
  }
  const rl = usage.rate_limits;
  const models = (pause?.models ?? []).map((m) => m.toLowerCase());
  const rows: { name: string; utilization: number | null; resets_at: string | null; models: string[] }[] = [];
  for (const name of windowsFor(pause)) {
    const r = rl[name];
    if (r && typeof r === 'object') rows.push({ name, utilization: r.utilization ?? null, resets_at: r.resets_at ?? null, models: kindForWindow(name).models });
  }
  for (const r of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
    const label = String(r?.display_name ?? '').toLowerCase();
    if (models.length === 0 || !label || models.some((m) => label.includes(m) || m.includes(label))) {
      rows.push({ name: `model:${label || '?'}`, utilization: r.utilization ?? null, resets_at: r.resets_at ?? null, models: label ? [label] : [] });
    }
  }
  if (rows.length === 0) return { status: 'unknown', detail: 'usage data lists no relevant window' };
  let worst: (typeof rows)[number] | null = null;
  for (const r of rows) {
    if (r.utilization == null) continue;
    const resets = toEpochMs(r.resets_at);
    if (r.utilization >= 100 && resets != null && resets > now) {
      if (!worst || (toEpochMs(worst.resets_at) ?? 0) < resets) worst = r;
    }
  }
  if (worst) {
    const { kind } = kindForWindow(worst.name);
    const hit: LimitHit = {
      kind: worst.name.startsWith('model:') ? 'model' : kind,
      models: worst.models,
      resetsAt: toEpochMs(worst.resets_at),
      source: 'usage_probe',
      raw: JSON.stringify(worst),
      utilization: worst.utilization! / 100,
    };
    return { status: 'closed', hit, detail: `${worst.name} at ${Math.round(worst.utilization!)}%` };
  }
  const known = rows.filter((r) => r.utilization != null);
  if (known.length === 0) return { status: 'unknown', detail: 'usage data has no utilization figures' };
  return { status: 'open', detail: known.map((r) => `${r.name} ${Math.round(r.utilization!)}%`).join(', ') };
}

function usageMethodOf(session: any): ((opts?: any) => Promise<any>) | null {
  if (!session || typeof session !== 'object') return null;
  for (const name of ['getUsage', 'usage']) {
    if (typeof session[name] === 'function') return session[name].bind(session);
  }
  for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(session) ?? {}).concat(Object.keys(session))) {
    if (/^usage(_|$)/i.test(name) && typeof session[name] === 'function') return session[name].bind(session);
  }
  return null;
}

/** Read the plan's usage windows without a model turn. `unknown` when the SDK cannot. */
async function readUsageProbe(q: QueryLike, options: any, pause: ProbeOptions['pause'], log?: (s: string) => void): Promise<ProbeResult> {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  // An input stream that yields nothing keeps the session open without starting a turn.
  async function* idle(): AsyncGenerator<any> {
    await gate;
  }
  const session: any = q({ prompt: idle(), options });
  try {
    const fn = usageMethodOf(session);
    if (!fn) return { status: 'unknown', detail: 'SDK session has no usage method' };
    const usage = await withTimeout(fn({ skipBehaviors: true }), 30_000, 'usage read');
    const r = interpretUsage(usage, pause);
    log?.(`usage read: ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
    return r;
  } catch (e) {
    return { status: 'unknown', detail: `usage read failed: ${errText(e)}` };
  } finally {
    release();
    try {
      session.close?.();
    } catch {
      /* ignore */
    }
  }
}

/** One cheap turn. */
async function turnProbe(q: QueryLike, options: any, log?: (s: string) => void): Promise<ProbeResult> {
  const stream = q({ prompt: PROBE_PROMPT, options: { ...options, systemPrompt: PROBE_SYSTEM } });
  let sawAllowed = false;
  try {
    for await (const m of stream) {
      const hit = detectLimit(m);
      if (hit) return { status: 'closed', hit, detail: hit.raw.slice(0, 200) };
      if (m?.type === 'rate_limit_event' && m.rate_limit_info && m.rate_limit_info.status !== 'rejected') sawAllowed = true;
      if (m?.type === 'result') {
        if (!m.is_error) return { status: 'open', detail: 'probe turn succeeded' };
        const text = [m.result, ...(Array.isArray(m.errors) ? m.errors : [])].filter(Boolean).join('; ');
        return { status: 'unknown', detail: `probe turn errored: ${text || m.subtype}` };
      }
    }
  } catch (e) {
    const hit = parseLimitText(errText(e));
    if (hit) return { status: 'closed', hit, detail: hit.raw };
    return { status: 'unknown', detail: `probe failed: ${errText(e)}` };
  } finally {
    try {
      (stream as any).close?.();
    } catch {
      /* ignore */
    }
  }
  if (sawAllowed) return { status: 'open', detail: 'rate limit status allowed' };
  return { status: 'unknown', detail: 'probe ended without a result' };
}

/**
 * With `SALU_WORKER=fake` (the orchestrator's fake runner) the probe never calls the SDK:
 * `SALU_FAKE_LIMIT_UNTIL=<epoch ms>` (or the file `<SALU_HOME>/fake-limit-until`) says
 * until when the window is closed; absent or past means open.
 */
export function fakeProbe(opts: ProbeOptions = {}, now = Date.now()): ProbeResult {
  let raw = process.env.SALU_FAKE_LIMIT_UNTIL ?? '';
  if (!raw) {
    try {
      const f = join(ticketHome(), 'fake-limit-until');
      if (existsSync(f)) raw = readFileSync(f, 'utf8').trim();
    } catch {
      /* ignore */
    }
  }
  const until = toEpochMs(raw);
  if (until != null && until > now) {
    const k = opts.pause?.kind;
    const kind = (k && k !== 'manual' ? k : 'session') as LimitHit['kind'];
    const hit: LimitHit = { kind: kind === 'unknown' ? 'session' : kind, models: opts.pause?.models ?? [], resetsAt: until, source: 'usage_probe', raw: 'fake probe' };
    return { status: 'closed', hit, detail: 'fake limit still in effect' };
  }
  return { status: 'open', detail: 'fake probe' };
}

/** Check whether the usage window is open. Never throws. */
export async function probeWindow(opts: ProbeOptions = {}): Promise<ProbeResult> {
  const log = opts.log;
  if (process.env.SALU_WORKER === 'fake' && !opts.queryFn) return fakeProbe(opts);
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 120_000);
  // A caller that only knows the model (the orchestrator's runner.probe(model)) still gets the
  // right usage windows checked: a probe on 'opus' looks at the Opus weekly window too.
  const pause = opts.pause ?? (opts.model ? { models: [opts.model] } : undefined);
  const model = opts.model === undefined ? probeModelFor(pause) : opts.model;
  const base: Record<string, any> = {
    cwd: opts.cwd ?? process.cwd(),
    abortController: ac,
    settingSources: [],
    tools: [],
    allowedTools: [],
    maxTurns: 1,
    persistSession: false, // a probe is not worth a transcript in ~/.claude/projects
    permissionMode: 'default',
    env: probeEnv(),
  };
  const exe = claudeExecutableOption();
  if (exe) base.pathToClaudeCodeExecutable = exe;
  try {
    const q = opts.queryFn ?? (await loadQuery());
    if (opts.readUsage !== false) {
      const r = await readUsageProbe(q, base, pause, log);
      if (r.status !== 'unknown') return r;
      log?.(`usage read inconclusive: ${r.detail ?? ''}`);
    }
    if (opts.signal?.aborted) return { status: 'unknown', detail: 'aborted' };
    let r = await turnProbe(q, model ? { ...base, model } : base, log);
    if (r.status === 'unknown' && model && /model/i.test(r.detail ?? '')) {
      // The cheap model may not exist on this account; try Claude Code's default once.
      log?.(`probe with model ${model} failed (${r.detail}); retrying with the default model`);
      r = await turnProbe(q, base, log);
    }
    log?.(`probe: ${r.status}${r.detail ? ` (${r.detail})` : ''}`);
    return r;
  } catch (e) {
    return { status: 'unknown', detail: `probe failed: ${errText(e)}` };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Build a `ProbeResult` from a raw `rate_limit_info`, for callers that read the headers themselves. */
export function probeResultFromRateLimitInfo(info: any): ProbeResult {
  const hit = limitFromRateLimitInfo(info);
  if (hit) return { status: 'closed', hit };
  if (info && (info.status === 'allowed' || info.status === 'allowed_warning')) return { status: 'open' };
  return { status: 'unknown' };
}
