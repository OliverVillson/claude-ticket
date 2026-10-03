import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ticketHome } from '../core/paths.ts';
import { getState, setState } from '../db/queries.ts';
import { toEpochMs } from './detect.ts';
import { formatDuration, formatResetTime } from './format.ts';
import { loadSdkQuery, readUsageRaw, usageSessionOptions } from './probe.ts';
import type { QueryLike } from './probe.ts';

/**
 * How much of the plan's usage is left: a cheap, cached snapshot for the TUI header and
 * `salu usage`. No model turn is ever made.
 *
 * Two sources, merged per window (the newer observation wins):
 *  1. `rate_limit_event`s streamed by running workers ({@link recordRateLimitEvent}). They arrive
 *     for free while work runs, carry status and (from Claude Code) utilization, and are stored in
 *     the `state` table so a TUI in another process sees them too.
 *  2. The `/usage` data (`get_usage` control request, see probe.ts), fetched on request but never
 *     more than once per {@link MIN_REFRESH_MS}, and immediately after a worker event.
 */

export const MIN_REFRESH_MS = 60_000;
/** A snapshot whose last good fetch is older than this is flagged `stale`. */
export const STALE_AFTER_MS = 5 * 60_000;

export const SNAPSHOT_STATE = {
  events: 'usage_events', // JSON: { [windowId]: StoredWindow } from worker rate_limit_events
  fetched: 'usage_fetched', // JSON: StoredFetch, the last /usage read
} as const;

/** Stable window ids. Model windows other than Opus/Sonnet/Fable are `model:<name>`. */
/** A scope names one seat's own copy of the snapshot (`seat:3`); no scope is the machine's own login, as in v1. */
const key = (base: string, scope?: string) => (scope ? `${base}:${scope}` : base);

export type UsageWindowId = 'session' | 'weekly' | 'opus' | 'sonnet' | 'fable' | 'credits' | `model:${string}`;
export type UsageWindowStatus = 'allowed' | 'warning' | 'rejected' | 'unknown';
export type UnavailableReason = 'no-subscription' | 'not-logged-in' | 'offline' | 'error';

export interface UsageWindow {
  id: UsageWindowId;
  /** Short label for a meter: "5h", "week", "Opus", "Sonnet", "Fable". */
  short: string;
  /** Full label: "Session (5 hours)", "Weekly", "Weekly · Opus". */
  label: string;
  /** Share of the window used, 0..100 rounded and clamped; null when only a status is known. */
  percentUsed: number | null;
  /** 100 - percentUsed, or null. */
  percentLeft: number | null;
  /** Same as percentUsed as a fraction, unclamped (may exceed 1). */
  utilization: number | null;
  status: UsageWindowStatus;
  /** When the window resets, epoch ms, or null when unknown. */
  resetsAt: number | null;
  /** When this window was last observed, epoch ms. */
  observedAt: number;
  source: 'usage' | 'event';
}

export interface UsageSnapshot {
  /** False when there is nothing to show: API-key auth, not logged in, offline with no earlier data. */
  available: boolean;
  /** Why it is unavailable (or why data is old), human text; null when all is well. */
  reason: string | null;
  reasonKind: UnavailableReason | null;
  /** 'pro' | 'max' | 'team' | 'enterprise' when reported. */
  plan: string | null;
  /** Session first, then weekly, then per-model, then credits. */
  windows: UsageWindow[];
  /** When the data was last refreshed from any source, epoch ms; 0 if never. */
  updatedAt: number;
  /** When `/usage` was last read successfully, epoch ms; 0 if never. */
  fetchedAt: number;
  /** True when the numbers may be out of date (last read failed or is older than STALE_AFTER_MS). */
  stale: boolean;
  /** The last refresh error, silent but reported here. */
  error: string | null;
}

/** What one `/usage` read produced. */
export interface UsageFetch {
  ok: boolean;
  at: number;
  plan: string | null;
  windows: UsageWindow[];
  reasonKind?: UnavailableReason;
  reason?: string;
}

interface StoredWindow {
  status: string;
  utilization: number | null;
  resetsAt: number | null;
  at: number;
}
interface StoredFetch {
  ok: boolean;
  at: number;
  plan: string | null;
  windows: UsageWindow[];
  reasonKind?: UnavailableReason;
  reason?: string;
  error?: string | null;
}

export type UsageFetcher = () => Promise<UsageFetch>;

// ---------------------------------------------------------------------------
// Window naming

const ORDER: string[] = ['session', 'weekly', 'opus', 'sonnet', 'fable'];

const META: Record<string, { short: string; label: string }> = {
  session: { short: '5h', label: 'Session (5 hours)' },
  weekly: { short: 'week', label: 'Weekly' },
  opus: { short: 'Opus', label: 'Weekly · Opus' },
  sonnet: { short: 'Sonnet', label: 'Weekly · Sonnet' },
  fable: { short: 'Fable', label: 'Weekly · Fable' },
  credits: { short: 'credits', label: 'Extra usage credits' },
};

/** SDK `rateLimitType` / `/usage` key to a window id. */
export function windowIdFor(type: string): UsageWindowId | null {
  switch (type) {
    case 'five_hour':
      return 'session';
    case 'seven_day':
      return 'weekly';
    case 'seven_day_opus':
      return 'opus';
    case 'seven_day_sonnet':
      return 'sonnet';
    case 'seven_day_overage_included':
      return 'fable';
    case 'overage':
      return 'credits';
    default:
      return null;
  }
}

function modelId(name: string): UsageWindowId {
  const n = name.toLowerCase().replace(/^weekly\s*[·:-]?\s*/, '').replace(/\s+limit$/, '').trim();
  if (n.includes('opus')) return 'opus';
  if (n.includes('sonnet')) return 'sonnet';
  if (n.includes('fable')) return 'fable';
  return `model:${n || '?'}`;
}

function metaFor(id: string, display?: string): { short: string; label: string } {
  if (META[id]) return META[id];
  const name = display?.trim() || id.replace(/^model:/, '');
  return { short: name.length > 8 ? name.slice(0, 8) : name, label: `Weekly · ${name}` };
}

function mkWindow(id: UsageWindowId, util: number | null, status: string | null, resetsAt: number | null, at: number, source: UsageWindow['source'], display?: string): UsageWindow {
  const { short, label } = metaFor(id, display);
  let st: UsageWindowStatus = status === 'allowed' ? 'allowed' : status === 'allowed_warning' || status === 'warning' ? 'warning' : status === 'rejected' ? 'rejected' : 'unknown';
  let u = util != null && Number.isFinite(util) ? util : null;
  if (u == null && st === 'rejected') u = 1;
  if (st === 'unknown' && u != null) st = u >= 1 ? 'rejected' : 'allowed';
  const pct = u == null ? null : Math.max(0, Math.min(100, Math.round(u * 100)));
  return { id, short, label, utilization: u, percentUsed: pct, percentLeft: pct == null ? null : 100 - pct, status: st, resetsAt, observedAt: at, source };
}

// ---------------------------------------------------------------------------
// Parsing the two sources

/** Turn a raw `get_usage` response into windows. Exported for tests. */
export function parseUsage(usage: any, now = Date.now()): UsageFetch {
  if (!usage || typeof usage !== 'object') return { ok: false, at: now, plan: null, windows: [], reasonKind: 'error', reason: 'no usage data' };
  const plan = typeof usage.subscription_type === 'string' ? usage.subscription_type : null;
  const rl = usage.rate_limits;
  if (usage.rate_limits_available === false || !rl || typeof rl !== 'object') {
    return {
      ok: false,
      at: now,
      plan,
      windows: [],
      reasonKind: 'no-subscription',
      reason: 'Plan usage cannot be read with this login (an API key, a third-party provider, or a setup-token login). Limits seen on tickets that ran on it still show.',
    };
  }
  const windows = new Map<string, UsageWindow>();
  const put = (id: UsageWindowId, r: any, display?: string) => {
    if (!r || typeof r !== 'object') return;
    const pctRaw = r.utilization;
    const util = typeof pctRaw === 'number' ? pctRaw / 100 : null;
    const resets = toEpochMs(r.resets_at);
    if (util == null && resets == null) return;
    const status = util == null ? null : util >= 1 ? 'rejected' : 'allowed';
    windows.set(id, mkWindow(id, util, status, resets, now, 'usage', display));
  };
  put('session', rl.five_hour);
  put('weekly', rl.seven_day);
  put('opus', rl.seven_day_opus);
  put('sonnet', rl.seven_day_sonnet);
  for (const r of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
    const name = String(r?.display_name ?? '');
    put(modelId(name), r, name);
  }
  const extra = rl.extra_usage;
  if (extra && typeof extra === 'object' && extra.is_enabled && typeof extra.utilization === 'number') {
    windows.set('credits', mkWindow('credits', extra.utilization / 100, extra.utilization >= 100 ? 'rejected' : 'allowed', null, now, 'usage'));
  }
  if (windows.size === 0) return { ok: false, at: now, plan, windows: [], reasonKind: 'error', reason: 'usage data lists no windows' };
  return { ok: true, at: now, plan, windows: sortWindows([...windows.values()]) };
}

/** Classify a fetch failure. */
export function classifyFetchError(e: unknown): { reasonKind: UnavailableReason; reason: string } {
  const text = e instanceof Error ? e.message : String(e);
  if (/log ?in|logged|auth|401|unauthori[sz]ed|token|credential|expired|\/login/i.test(text)) {
    return { reasonKind: 'not-logged-in', reason: 'Not logged in to Claude Code (or the login expired): run `claude` and use /login.' };
  }
  if (/ENOTFOUND|ECONN|EAI_AGAIN|network|fetch failed|offline|timed out|ETIMEDOUT/i.test(text)) {
    return { reasonKind: 'offline', reason: `Could not reach Claude (${text.split('\n')[0].slice(0, 120)}).` };
  }
  return { reasonKind: 'error', reason: `Could not read usage: ${text.split('\n')[0].slice(0, 160)}` };
}

function sortWindows(ws: UsageWindow[]): UsageWindow[] {
  const rank = (id: string) => {
    const i = ORDER.indexOf(id);
    return i >= 0 ? i : id === 'credits' ? 100 : 50;
  };
  return [...ws].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// The default fetcher (SDK) and the fake one

function fakeFetch(now = Date.now()): UsageFetch {
  let raw = process.env.SALU_FAKE_USAGE ?? '';
  if (!raw) {
    try {
      const f = join(ticketHome(), 'fake-usage');
      if (existsSync(f)) raw = readFileSync(f, 'utf8').trim();
    } catch {
      /* ignore */
    }
  }
  if (raw === 'off') return { ok: false, at: now, plan: null, windows: [], reasonKind: 'no-subscription', reason: 'fake: plan usage unavailable' };
  if (raw.startsWith('{')) {
    try {
      return parseUsage(JSON.parse(raw), now);
    } catch {
      /* fall through to the sample */
    }
  }
  const h = 3_600_000;
  return parseUsage(
    {
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 62, resets_at: new Date(now + 2 * h).toISOString() },
        seven_day: { utilization: 31, resets_at: new Date(now + 3 * 24 * h).toISOString() },
        seven_day_opus: { utilization: 44, resets_at: new Date(now + 3 * 24 * h).toISOString() },
      },
    },
    now,
  );
}

/** Read `/usage` through the SDK. Never throws. */
export function sdkFetcher(opts: { queryFn?: QueryLike; cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): UsageFetcher {
  return async () => {
    const now = Date.now();
    if (process.env.SALU_WORKER === 'fake' && !opts.queryFn) return fakeFetch(now);
    try {
      const q = opts.queryFn ?? (await loadSdkQuery());
      const so = usageSessionOptions(opts.cwd);
      if (opts.env) so.env = { ...so.env, ...opts.env };
      const raw = await readUsageRaw(q, so, opts.timeoutMs ?? 30_000);
      return parseUsage(raw, Date.now());
    } catch (e) {
      return { ok: false, at: now, plan: null, windows: [], ...classifyFetchError(e) };
    }
  };
}

// ---------------------------------------------------------------------------
// Events from workers

function readJson<T>(db: Database, key: string): T | null {
  try {
    const v = getState(db, key);
    return v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
const needsRefresh = new Set<string>();
const dbIds = new WeakMap<Database, number>();
let nextDbId = 1;
function refreshKey(db: Database, scope?: string): string {
  let id = dbIds.get(db);
  if (!id) dbIds.set(db, (id = nextDbId++));
  return `${id}|${scope ?? ''}`;
}

function notify() {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* a listener must not break a worker */
    }
  }
}

/**
 * Feed a worker's `rate_limit_event` (the whole message or just its `rate_limit_info`) into the
 * snapshot. Keeps the last event per window in the `state` table, marks the snapshot for an
 * immediate refresh, and calls subscribers. Cheap and safe to call for every message; never throws.
 */
export function recordRateLimitEvent(db: Database, msgOrInfo: any, now = Date.now(), scope?: string): boolean {
  try {
    const info = msgOrInfo?.type === 'rate_limit_event' ? msgOrInfo.rate_limit_info : msgOrInfo;
    if (!info || typeof info !== 'object' || typeof info.status !== 'string') return false;
    const stored = readJson<Record<string, StoredWindow>>(db, key(SNAPSHOT_STATE.events, scope)) ?? {};
    let changed = false;
    const put = (id: string, status: string, util: number | null, resetsAt: number | null) => {
      const prev = stored[id];
      const next = { status, utilization: util, resetsAt, at: now };
      if (!prev || prev.status !== status || prev.utilization !== util || prev.resetsAt !== resetsAt) changed = true;
      stored[id] = next;
    };
    const id = typeof info.rateLimitType === 'string' ? windowIdFor(info.rateLimitType) : null;
    if (id) {
      const util = typeof info.utilization === 'number' ? info.utilization : null;
      put(id, info.status, util, info.resetsAt != null ? toEpochMs(info.resetsAt) : null);
    }
    // Internal builds also list every window on each event.
    const uw = info.unifiedWindows;
    if (uw && typeof uw === 'object') {
      for (const [k, w] of Object.entries<any>(uw)) {
        const wid = windowIdFor(k);
        if (!wid || !w || typeof w !== 'object' || wid === id) continue;
        const util = typeof w.utilization === 'number' ? w.utilization : null;
        put(wid, util != null && util >= 1 ? 'rejected' : 'allowed', util, w.resetsAt != null ? toEpochMs(w.resetsAt) : null);
      }
    }
    if (!id && !uw) return false;
    setState(db, key(SNAPSHOT_STATE.events, scope), JSON.stringify(stored));
    needsRefresh.add(refreshKey(db, scope));
    if (changed) notify();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Building and caching the snapshot

/** Build a snapshot from what is stored, without any I/O beyond the state table. Exported for tests. */
export function buildSnapshot(db: Database, now = Date.now(), lastError: string | null = null, staleAfterMs = STALE_AFTER_MS, scope?: string): UsageSnapshot {
  const fetched = readJson<StoredFetch>(db, key(SNAPSHOT_STATE.fetched, scope));
  const events = readJson<Record<string, StoredWindow>>(db, key(SNAPSHOT_STATE.events, scope)) ?? {};
  const byId = new Map<string, UsageWindow>();
  for (const w of fetched?.ok ? fetched.windows : []) byId.set(w.id, w);
  for (const [id, e] of Object.entries(events)) {
    const cur = byId.get(id);
    if (cur && cur.observedAt >= e.at) continue;
    byId.set(id, mkWindow(id as UsageWindowId, e.utilization, e.status, e.resetsAt, e.at, 'event'));
  }
  // A window whose reset time has passed has started over.
  const windows = sortWindows(
    [...byId.values()].map((w) =>
      w.resetsAt != null && w.resetsAt <= now ? { ...mkWindow(w.id, 0, 'allowed', null, w.observedAt, w.source), short: w.short, label: w.label } : w,
    ),
  );
  const fetchedAt = fetched?.ok ? fetched.at : 0;
  const updatedAt = Math.max(fetchedAt, ...windows.map((w) => w.observedAt), 0);
  const error = lastError ?? fetched?.error ?? (fetched && !fetched.ok ? (fetched.reason ?? null) : null);
  const available = windows.length > 0;
  // Limits seen on real runs still count when the plan read is refused (an API key, or a setup-token login that cannot read usage).
  if (!available) {
    const kind: UnavailableReason = fetched?.reasonKind ?? 'error';
    return {
      available: false,
      reason: fetched?.reason ?? (fetched ? 'Usage could not be read.' : 'Usage has not been read yet.'),
      reasonKind: fetched ? kind : 'error',
      plan: fetched?.plan ?? null,
      windows: [],
      updatedAt: 0,
      fetchedAt: 0,
      stale: false,
      error,
    };
  }
  // A login that cannot read plan usage never has a fresh read to be stale against: its windows come from runs and carry their own time.
  const noSub = fetched != null && !fetched.ok && fetched.reasonKind === 'no-subscription';
  const stale = !noSub && (error != null || now - Math.max(fetchedAt, updatedAt) > staleAfterMs);
  return { available: true, reason: stale && error ? error : null, reasonKind: null, plan: fetched?.plan ?? null, windows, updatedAt, fetchedAt, stale, error };
}

export interface GetUsageOptions {
  db: Database;
  /** Fetch even inside the minimum interval (the throttle still applies unless `force`). */
  refresh?: boolean;
  /** Ignore the throttle (`salu usage --refresh`). */
  force?: boolean;
  /** Minimum time between reads. Default 60 s. */
  minIntervalMs?: number;
  fetcher?: UsageFetcher;
  now?: number;
  /** Read and keep this snapshot apart from the machine's own (one per seat: `seat:<id>`). */
  scope?: string;
}

const inflight = new Map<string, Promise<void>>();
const lastAttempt = new Map<string, { at: number; error: string | null }>();

/**
 * The usage snapshot. Always returns quickly from the cache when a read happened in the last
 * minute; otherwise reads `/usage` first (unless `refresh: false`). A worker event since the last
 * read triggers an immediate re-read. Never throws: a failed read keeps the old numbers and sets
 * `stale`/`error`.
 */
export async function getUsageSnapshot(o: GetUsageOptions): Promise<UsageSnapshot> {
  const { db } = o;
  const now = o.now ?? Date.now();
  const min = o.minIntervalMs ?? MIN_REFRESH_MS;
  const rk = refreshKey(db, o.scope);
  const last = lastAttempt.get(rk);
  const fetched = readJson<StoredFetch>(db, key(SNAPSHOT_STATE.fetched, o.scope));
  const lastAt = Math.max(last?.at ?? 0, fetched?.at ?? 0);
  const due = o.force || now - lastAt >= min;
  const eventPending = needsRefresh.has(rk) && now - lastAt >= 5_000; // a burst of events costs one read
  if (o.refresh !== false && (due || eventPending)) {
    let p = inflight.get(rk);
    if (!p) {
      needsRefresh.delete(rk);
      p = (async () => {
        const fetcher = o.fetcher ?? sdkFetcher();
        let r: UsageFetch;
        try {
          r = await fetcher();
        } catch (e) {
          r = { ok: false, at: Date.now(), plan: null, windows: [], ...classifyFetchError(e) };
        }
        lastAttempt.set(rk, { at: o.now ?? Date.now(), error: r.ok ? null : (r.reason ?? 'usage read failed') });
        const fk = key(SNAPSHOT_STATE.fetched, o.scope);
        const prev = readJson<StoredFetch>(db, fk);
        if (r.ok) setState(db, fk, JSON.stringify({ ...r, error: null } satisfies StoredFetch));
        else if (r.reasonKind === 'no-subscription' || !prev?.ok) setState(db, fk, JSON.stringify({ ...r, error: r.reason ?? null } satisfies StoredFetch));
        else setState(db, fk, JSON.stringify({ ...prev, error: r.reason ?? 'usage read failed' } satisfies StoredFetch));
        notify();
      })().finally(() => inflight.delete(rk));
      inflight.set(rk, p);
    }
    await p;
  }
  return buildSnapshot(db, o.now ?? Date.now(), null, STALE_AFTER_MS, o.scope);
}

/** Forget in-memory throttle and pending-event marks for a database (tests, `salu usage --refresh`). */
export function resetUsageCache(db: Database, scope?: string): void {
  lastAttempt.delete(refreshKey(db, scope));
  needsRefresh.delete(refreshKey(db, scope));
}

/** The cached snapshot right now, no I/O beyond the state table. For render paths. */
export function peekUsageSnapshot(db: Database, now = Date.now()): UsageSnapshot {
  return buildSnapshot(db, now, null);
}

/** Call `cb` whenever the snapshot may have changed (a worker event or a finished read). Returns the unsubscribe function. */
export function onUsageChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Keep a snapshot fresh for a long-running screen: reads `/usage` at most once a minute (and after
 * worker events), re-reads the cache every few seconds so events recorded by another process show
 * up, and calls `cb` with the new snapshot when it changed. Returns a stop function.
 */
export function watchUsage(db: Database, cb: (s: UsageSnapshot) => void, opts: { pollMs?: number; fetcher?: UsageFetcher; minIntervalMs?: number } = {}): () => void {
  let stopped = false;
  let lastJson = '';
  const push = (s: UsageSnapshot) => {
    const j = JSON.stringify(s);
    if (j === lastJson || stopped) return;
    lastJson = j;
    cb(s);
  };
  const tick = async () => {
    if (stopped) return;
    push(await getUsageSnapshot({ db, fetcher: opts.fetcher, minIntervalMs: opts.minIntervalMs }));
  };
  push(peekUsageSnapshot(db));
  void tick();
  const off = onUsageChange(() => void tick());
  const timer = setInterval(() => void tick(), opts.pollMs ?? 5_000);
  (timer as any).unref?.();
  return () => {
    stopped = true;
    off();
    clearInterval(timer);
  };
}

// ---------------------------------------------------------------------------
// Text for the header meter and the CLI

/** "▰▰▰▱▱" for a percentage: `cells` blocks, filled in proportion. */
export function usageBar(percentUsed: number | null, cells = 5): string {
  if (percentUsed == null) return '▱'.repeat(cells);
  const filled = Math.max(0, Math.min(cells, Math.round((percentUsed / 100) * cells)));
  return '▰'.repeat(filled) + '▱'.repeat(cells - filled);
}

/** "5h ▰▰▰▱▱ 62% · resets 3:45pm" (percent used). */
export function formatWindowMeter(w: UsageWindow, now = Date.now(), cells = 5): string {
  const pct = w.percentUsed == null ? (w.status === 'rejected' ? 'limit reached' : '?%') : `${w.percentUsed}%`;
  const reset = w.resetsAt != null && w.resetsAt > now ? ` · resets ${formatResetTime(w.resetsAt, now)}` : '';
  return `${w.short} ${usageBar(w.percentUsed, cells)} ${pct}${reset}`;
}

/** Header text: the 5h meter, plus the weekly meter when known; `usage n/a` when unavailable. */
export function formatUsageHeader(s: UsageSnapshot, now = Date.now(), cells = 5): string {
  if (!s.available) return 'usage n/a';
  const ws = ['session', 'weekly'].map((id) => s.windows.find((w) => w.id === id)).filter((w): w is UsageWindow => !!w);
  const shown = ws.length ? ws : s.windows.slice(0, 1);
  const parts = shown.map((w, i) => (i === 0 ? formatWindowMeter(w, now, cells) : `${w.short} ${usageBar(w.percentUsed, cells)} ${w.percentUsed ?? '?'}%`));
  return parts.join(' · ') + (s.stale ? ' (stale)' : '');
}

/** Multi-line plain text for `salu usage` (no colour). */
export function formatUsageLines(s: UsageSnapshot, now = Date.now()): string[] {
  if (!s.available) return [`usage unavailable: ${s.reason ?? 'unknown reason'}`];
  const lines = [s.plan ? `plan ${s.plan}` : null];
  const pad = Math.max(...s.windows.map((w) => w.label.length));
  for (const w of s.windows) {
    const pct = w.percentUsed == null ? 'limit reached' : `${String(w.percentUsed).padStart(3)}% used, ${w.percentLeft}% left`;
    const reset = w.resetsAt != null ? ` · resets ${formatResetTime(w.resetsAt, now)} (in ${formatDuration(w.resetsAt - now)})` : '';
    const warn = w.status === 'warning' ? ' · nearly used up' : w.status === 'rejected' ? ' · blocked' : '';
    lines.push(`${w.label.padEnd(pad)}  ${usageBar(w.percentUsed, 10)}  ${pct}${reset}${warn}`);
  }
  if (s.stale) lines.push(`(may be out of date${s.reason ? `: ${s.reason}` : ''})`);
  return lines.filter((l): l is string => l != null);
}
