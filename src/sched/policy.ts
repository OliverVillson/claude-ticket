import type { Database } from 'bun:sqlite';
import { effectiveModel, getProjectById, getState, inheritedProject, listTickets, setState, updateTicket } from '../db/queries.ts';
import { ticketLabels, ticketTags, type TicketView } from '../db/types.ts';
import { DEFAULT_EFFORT } from '../core/tags.ts';
import type { UsageSnapshot, UsageWindow } from '../usage/snapshot.ts';
import { dailyBudgetUsd, estimateTicket, readStats, SCHED_STATE, spentLast24h, type Estimate, type SchedMode } from './stats.ts';

/**
 * The token-aware part of dispatch: pick which queued ticket to start so the plan is spent on
 * purpose. Pure decisions live here; the orchestrator only asks `chooseTicket` and `routeQueued`.
 * Running workers are never touched: this only decides what may START.
 */

/** Percent of the 5-hour window kept free, so a rough estimate cannot push a run into the wall. */
export const SESSION_MARGIN = 5;
/** `SALU_SCHED_MARGIN` / `SALU_SCHED_RESERVE` override the two numbers above (0..100); used to prove the hold on a real window. */
const envPct = (name: string, fallback: number): number => {
  const v = Number(process.env[name]);
  return process.env[name] != null && process.env[name] !== '' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : fallback;
};
/** Percent of the weekly window kept for priority-0 ("run now") tickets. */
export const WEEKLY_RESERVE = 15;
/** After this many later tickets started ahead of it, a ticket that does not fit is waited for instead. */
export const MAX_SKIPS = 3;
/** An estimate above this is bigger than a whole window; waiting would never help, so it is let through. */
const WHOLE_WINDOW = 90;

export interface Planned {
  ticket: TicketView;
  model: string;
  effort: string;
  est: Estimate;
}

export interface SchedLast {
  at: number;
  seat?: string;
  mode: SchedMode;
  /** Ticket the policy would start (advise mode: not necessarily the one that started). */
  wouldPick: string | null;
  /** Why the queue is held, with when it can start. */
  hold: { until: number | null; reason: string } | null;
  /** Tickets passed over and why. */
  skipped: { name: string; why: string }[];
  /** Routing the policy would apply or applied. */
  routed: { name: string; model: string; why: string; applied: boolean }[];
}

/** Whose plan a decision draws on. One seat today; a seat-aware scheduler asks `decide` once per seat and takes the best. */
export const SELF_SEAT = 'self';

export interface Decision {
  seat: string;
  pick: TicketView | null;
  hold: { until: number | null; reason: string } | null;
  skipped: { id: number; name: string; why: string }[];
}

export function plan(db: Database, t: TicketView, stats = readStats(db)): Planned {
  const tags = ticketTags(t);
  const base = getProjectById(db, t.project_id);
  const proj = base ? inheritedProject(db, base) : null;
  const model = effectiveModel(db, t) ?? 'claude-opus-5-5';
  const effort = tags.effort ?? proj?.default_effort ?? DEFAULT_EFFORT;
  const est = estimateTicket(db, model, effort, stats);
  // A paused ticket resumes its session: roughly half its work is already paid for.
  if (t.session_id) return { ticket: t, model, effort, est: { ...est, usd: est.usd / 2, pct: est.pct == null ? null : est.pct / 2 } };
  return { ticket: t, model, effort, est };
}

const win = (snap: UsageSnapshot, id: string): UsageWindow | undefined => (snap.available ? snap.windows.find((w) => w.id === id) : undefined);
const used = (w: UsageWindow | undefined): number | null => (w?.percentUsed == null ? null : w.percentUsed);

/** Does this ticket fit what is left? `why` says which limit it would cross; `until` is when that limit resets. */
export function fits(db: Database, p: Planned, snap: UsageSnapshot, now: number): { ok: true } | { ok: false; why: string; until: number | null } {
  const urgent = p.ticket.priority === 0;
  if (snap.available) {
    const margin = envPct('SALU_SCHED_MARGIN', SESSION_MARGIN);
    const pct = p.est.pct;
    if (pct != null && pct >= WHOLE_WINDOW) return { ok: true }; // bigger than a whole window: waiting would never help
    const session = win(snap, 'session');
    const us = used(session);
    if (pct == null) {
      // No percent learned yet: the cost is unknown, but a window that is already full is not a place to start.
      if (session && (session.status === 'rejected' || (us != null && us >= 100 - margin)))
        return { ok: false, why: `the 5-hour window is ${us != null ? `${Math.round(us)}% used` : 'full'}`, until: session.resetsAt ?? null };
      return { ok: true };
    }
    if (us != null && us + pct > 100 - margin)
      return { ok: false, why: `needs about ${Math.round(pct)}% of the 5-hour window, ${Math.round(us)}% is used`, until: session?.resetsAt ?? null };
    const weekly = win(snap, 'weekly');
    const uw = used(weekly);
    const reserve = urgent ? 0 : envPct('SALU_SCHED_RESERVE', WEEKLY_RESERVE);
    if (uw != null && uw + pct > 100 - reserve)
      return { ok: false, why: `would dip into the ${reserve}% weekly reserve (${Math.round(uw)}% of the week is used)`, until: weekly?.resetsAt ?? null };
    return { ok: true };
  }
  const budget = dailyBudgetUsd();
  if (budget != null) {
    const spent = spentLast24h(db, now);
    if (spent + p.est.usd > budget && spent > 0) return { ok: false, why: `needs about $${p.est.usd.toFixed(2)}, $${spent.toFixed(2)} of the $${budget.toFixed(2)} daily budget is spent`, until: now + 3_600_000 };
  }
  return { ok: true };
}

function readSkips(db: Database): Record<string, number> {
  try {
    const v = JSON.parse(getState(db, SCHED_STATE.skips) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/**
 * Walk the queue in dispatch order and take the first ticket that fits. A ticket that does not fit
 * is passed over, but only {@link MAX_SKIPS} times: after that nothing starts ahead of it and the
 * queue waits for the window it needs. When nothing fits the queue is held until the earliest reset.
 */
export function decide(db: Database, candidates: TicketView[], snap: UsageSnapshot, now = Date.now(), seat = SELF_SEAT): Decision {
  const stats = readStats(db);
  const skips = readSkips(db);
  const skipped: Decision['skipped'] = [];
  let earliest: number | null = null;
  for (const c of candidates) {
    const p = plan(db, c, stats);
    const f = fits(db, p, snap, now);
    if (f.ok) return { seat, pick: c, hold: null, skipped };
    skipped.push({ id: c.id, name: c.name, why: f.why });
    if (f.until != null && (earliest == null || f.until < earliest)) earliest = f.until;
    if ((skips[String(c.id)] ?? 0) >= MAX_SKIPS) break; // starved long enough: wait for it
  }
  const first = skipped[0];
  if (!first) return { seat, pick: null, hold: null, skipped }; // nothing queued: nothing to hold
  return { seat, pick: null, hold: { until: earliest, reason: `${first.name} ${first.why}` }, skipped };
}

/** Count a pass-over for each ticket that a later one was started ahead of; clear a started ticket's count. */
export function noteStarted(db: Database, d: Decision, startedId: number): void {
  const skips = readSkips(db);
  delete skips[String(startedId)];
  for (const s of d.skipped) skips[String(s.id)] = (skips[String(s.id)] ?? 0) + 1;
  setState(db, SCHED_STATE.skips, JSON.stringify(skips));
}

// -------------------------------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------------------------

const LIGHT_LABELS = new Set(['docs', 'doc', 'chore', 'typo', 'lint', 'format', 'rename', 'comment']);
const HEAVY = /\b(refactor\w*|migrat\w*|architect\w*|redesign\w*|rewrite|security|race|concurren\w*|performance|debug\w*|investigat\w*|design)\b/i;
/** Opus window use above which new Opus tickets are better spent on Sonnet. */
export const OPUS_PRESSURE = 85;
/** Sonnet has to have this much room left for pressure routing to help. */
const SONNET_ROOM = 70;

/**
 * Should this ticket run on Sonnet instead of the default? Returns the reason or null. Conservative on
 * purpose: it never touches a ticket that names a model, a project with its own default, a priority-0
 * ticket, a resumed session, harder effort, or `route=off`, and a ticket is only routed for a reason
 * the log can state in a few words.
 */
export function routeFor(db: Database, t: TicketView, snap: UsageSnapshot): { model: string; why: string } | null {
  const tags = ticketTags(t);
  if (tags.model || tags.route === 'off' || t.priority === 0 || t.session_id) return null;
  if (tags.effort && ['high', 'xhigh', 'max'].includes(tags.effort)) return null;
  const base = getProjectById(db, t.project_id);
  if (base && inheritedProject(db, base).default_model) return null;
  if (snap.available) {
    const op = win(snap, 'opus');
    const so = win(snap, 'sonnet');
    const opusFull = op && (op.status === 'rejected' || (op.percentUsed ?? 0) >= OPUS_PRESSURE);
    const sonnetRoom = !so || so.status !== 'rejected' && (so.percentUsed ?? 0) < SONNET_ROOM;
    if (opusFull && sonnetRoom) return { model: 'sonnet', why: `opus-window-${Math.round(op!.percentUsed ?? 100)}pct` };
  }
  const labels = ticketLabels(t).map((l) => l.toLowerCase());
  if (labels.some((l) => LIGHT_LABELS.has(l)) && t.query.length <= 400 && !HEAVY.test(t.query)) return { model: 'sonnet', why: 'light-task' };
  return null;
}

/**
 * Route queued tickets. In `on` mode the model is written to the ticket (`model=sonnet`, `routed=<why>`)
 * so it shows everywhere a model tag does; in `advise` mode nothing changes and the suggestions are returned.
 */
export function routeQueued(db: Database, snap: UsageSnapshot, mode: SchedMode, queued: TicketView[] = listTickets(db, { status: ['todo'] })): SchedLast['routed'] {
  const out: SchedLast['routed'] = [];
  if (mode === 'off') return out;
  for (const t of queued) {
    const r = routeFor(db, t, snap);
    if (!r) continue;
    if (mode === 'on') updateTicket(db, t.id, { tags: JSON.stringify({ ...ticketTags(t), model: r.model, routed: r.why }) });
    out.push({ name: t.name, model: r.model, why: r.why, applied: mode === 'on' });
  }
  return out;
}

export function saveLast(db: Database, l: SchedLast): void {
  setState(db, SCHED_STATE.last, JSON.stringify(l));
}

export function readLast(db: Database): SchedLast | null {
  try {
    return JSON.parse(getState(db, SCHED_STATE.last) ?? 'null');
  } catch {
    return null;
  }
}
