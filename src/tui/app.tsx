import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, render, useAnimation, useApp, useInput, useWindowSize } from 'ink';
import type { Database } from 'bun:sqlite';
import type { TicketStatus, TicketView } from '../db/types.ts';
import { ticketLabels, ticketTags } from '../db/types.ts';
import { getProjectById, getTicketById, latestRun, listRuns } from '../db/queries.ts';
import { formatTags } from '../core/tags.ts';
import type { TuiActions } from './actions.ts';
import { applyFilter } from './filter.ts';
import { displayWidth, priorityText, truncate } from './format.ts';
import { blinkOn, withWritingCursor } from './blink.ts';
import { clampCursor, computeLayout, scrollTop, viewportRows } from './layout.ts';
import { activityLines, idleLines, pickTarget, visibleWindow } from './activity.ts';
import { statSync } from 'node:fs';
import { ancestorsOf, buildRows, pathNames, renderTreeRow, revealed, subtreeIds, treeKey, type TreeKey } from './tree.ts';
import { tailLog, type LogLine } from './log-tail.ts';
import { loadDetail, loadSnapshot, snapshotKey, type Snapshot, type TicketDetail } from './store.ts';
import type { UsageSnapshot, UsageSource } from './usage.ts';
import { DEEPER_CELLS } from './deeper.ts';
import { ticketDenials } from '../core/allow.ts';
import { PropsView } from './components/PropsView.tsx';
import { DetailView } from './components/DetailView.tsx';
import { FormView, type FormValues } from './components/FormView.tsx';
import { ReplyView } from './components/ReplyView.tsx';
import { HelpView } from './components/HelpView.tsx';
import { style as st } from './style.ts';
import { CommandLine } from './components/CommandLine.tsx';
import { ResultView } from './components/ResultView.tsx';
import { NotifScreen } from './components/NotifView.tsx';
import { isMouseInput } from './mouse.ts';
import { fetchInBackground } from '../notif/index.ts';
import { LIST_HINTS, ListView, listInnerWidth } from './components/ListView.tsx';
import type { Message } from './messages.ts';
import { runCommand } from './command.ts';
import { complete } from './complete.ts';
import { eggDogLines, eggFor, eggFrameAt, eggMs, eggWords, type EggKind } from './eggs.ts';
import { makeRain, rainLines } from './rain.ts';
import { supportsUnicode } from '../ui/glyphs.ts';

export interface AppProps {
  db: Database;
  /** project to start on; null = all projects */
  projectId: number | null;
  /** only these statuses (`salu list --status`) */
  statuses?: TicketStatus[];
  actions: TuiActions;
  /** database poll interval; the view only re-renders when something changed */
  pollMs?: number;
  /** first snapshot, loaded before Ink mounts so the first frame paints at once */
  initial?: Snapshot;
  /**
   * Open straight into the add/edit form and exit when it closes (`salu change "name"`
   * with no flags). The app exits with the saved ticket, or null when cancelled.
   */
  form?: { ticketId?: number; projectId?: number };
  /** cached usage snapshots for the header meter; without it the meter is hidden */
  usage?: UsageSource;
}

export type FormResult = { action: 'added' | 'saved'; ticket: TicketView } | { action: 'cancelled' } | null;

type Mode = 'list' | 'detail' | 'props' | 'form' | 'help' | 'result' | 'reply' | 'notif';

/** Lines around the panes: header, two border lines, the boxed command line (3), the hint bar, plus one spare. */
const CHROME_LINES = 8;

/** Terminals at least this tall get the live-activity area between the panes and the command line. */
export const ACTIVITY_MIN_ROWS = 28;

/** Terminals at least this wide get the project tree beside the tickets; narrower ones get one pane. */
export const TWO_PANE_MIN_COLUMNS = 104;

export const TICKET_PANE_HINTS: Array<[string, string]> = [['↑↓', 'move'], ['tab', 'switch pane'], ...LIST_HINTS.filter(([k]) => k !== 'tab' && k !== '↑↓')];

export const COMMAND_HINTS: Array<[string, string]> = [
  ['⏎', 'run'],
  ['tab', 'complete or next window'],
  ['⇧tab', 'previous window'],
  ['↑↓', 'history'],
  ['esc', 'back to the lists'],
];

export const TREE_HINTS: Array<[string, string]> = [
  ['↑↓', 'project'],
  ['→', 'expand'],
  ['←', 'collapse'],
  ['a', 'add project'],
  ['d', 'remove'],
  ['tab', 'switch pane'],
  [':', 'command'],
  ['?', 'help'],
  ['q', 'quit'],
];

function formValuesFor(t: TicketView | null | undefined): FormValues {
  if (!t) return { name: '', query: '', tags: '', priority: '3', queue: true };
  return { name: t.name, query: t.query, tags: formatTags(ticketTags(t), ticketLabels(t)), priority: priorityText(t.priority).replace(/^p/, '') };
}

export function App(p: AppProps) {
  const { db, actions } = p;
  const { exit } = useApp();
  const { columns: rawColumns, rows: termRows } = useWindowSize();
  const columns = Math.max(40, rawColumns || 80);
  const standaloneForm = !!p.form;

  const [scope, setScope] = useState<number | null>(p.projectId);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const [snapshot, setSnapshot] = useState<Snapshot>(() => p.initial ?? loadSnapshot(db, { projectId: null, statuses: p.statuses }));
  const keyRef = useRef<string>(snapshotKey(snapshot));

  const [cursor, setCursor] = useState(0);
  const topRef = useRef(0);
  const treeTopRef = useRef(0);
  const selectedIdRef = useRef<number | null>(null);

  const twoPane = columns >= TWO_PANE_MIN_COLUMNS && !standaloneForm;
  const [pane, setPane] = useState<'tree' | 'tickets'>('tree');
  const [expanded, setExpanded] = useState<Set<number>>(() => revealed(p.initial?.projects ?? [], new Set(), p.projectId));
  const [projConfirm, setProjConfirm] = useState<{ id: number; name: string } | null>(null);

  const [filter, setFilter] = useState('');
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const [filterEditing, setFilterEditing] = useState(false);

  const [mode, setMode] = useState<Mode>(standaloneForm ? 'form' : 'list');
  const [confirm, setConfirm] = useState<TicketView | null>(null);
  const [allowAsk, setAllowAsk] = useState<{ ticket: TicketView; rules: string[] } | null>(null);
  const [form, setForm] = useState<{ mode: 'add' | 'edit'; ticket?: TicketView; projectId?: number; initial: FormValues } | null>(() => {
    if (!p.form) return null;
    const t = p.form.ticketId != null ? getTicketById(db, p.form.ticketId) : null;
    return { mode: t ? 'edit' : 'add', ticket: t ?? undefined, projectId: t?.project_id ?? p.form.projectId, initial: formValuesFor(t) };
  });
  const [replyError, setReplyError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [, setTick] = useState(0);
  const [usageSnap, setUsageSnap] = useState<UsageSnapshot | null | undefined>(() => (p.usage ? p.usage.get() : undefined));
  useEffect(() => {
    if (!p.usage) return;
    setUsageSnap(p.usage.get());
    return p.usage.subscribe(setUsageSnap);
  }, [p.usage]);

  // Command line (`:`): same dispatcher as the shell CLI, with history and tab completion.
  const [cmdEditing, setCmdEditing] = useState(false);
  const [cmdValue, setCmdValue] = useState('');
  const [cmdNonce, setCmdNonce] = useState(0);
  const [cmdBusy, setCmdBusy] = useState(false);
  const cmdHistory = useRef<string[]>([]);
  const cmdIdx = useRef(-1);
  const cmdDraft = useRef('');
  const [result, setResult] = useState<{ command: string; lines: string[]; ok: boolean; offset: number } | null>(null);

  // Easter eggs (eggs.ts): what is playing, since when, and how far in. The view underneath keeps
  // all its state, so it is back exactly as it was when the egg ends.
  const [egg, setEgg] = useState<{ kind: EggKind; start: number } | null>(null);
  const [eggAt, setEggAt] = useState(0);
  useEffect(() => {
    if (!egg) return;
    const total = eggMs(egg.kind);
    const i = setInterval(() => {
      const t = Date.now() - egg.start;
      if (t >= total) setEgg(null);
      else setEggAt(t);
    }, egg.kind === 'rain' ? 33 : 50);
    return () => clearInterval(i);
  }, [egg]);

  // ----- derived -------------------------------------------------------------------------
  const scopeIds = useMemo(() => subtreeIds(snapshot.projects, scope), [snapshot.projects, scope]);
  const scoped = useMemo(() => (scopeIds ? snapshot.tickets.filter((t) => scopeIds.has(t.project_id)) : snapshot.tickets), [snapshot.tickets, scopeIds]);
  const scopedCounts = useMemo(() => {
    const c = { backlog: 0, todo: 0, running: 0, done: 0, failed: 0, blocked: 0, paused: 0 } as Snapshot['counts'];
    for (const t of scoped) c[t.status]++;
    return c;
  }, [scoped]);
  const visible = useMemo(() => applyFilter(scoped, filter), [scoped, filter]);
  const safeCursor = clampCursor(cursor, visible.length);
  const selected: TicketView | undefined = visible[safeCursor];
  selectedIdRef.current = selected?.id ?? null;
  const scopeName = scope == null ? null : snapshot.projects.find((pr) => pr.id === scope)?.name ?? null;
  const scopeCrumbs = pathNames(snapshot.projects, scope);
  const showActivity = (termRows || 24) >= ACTIVITY_MIN_ROWS;
  const actH = showActivity ? Math.min(14, Math.max(4, Math.floor(((termRows || 24) - CHROME_LINES) * 0.4))) : 0;
  const rowsAvail = viewportRows(termRows, CHROME_LINES + (showActivity ? actH + 2 : 0));
  const textRows = viewportRows(termRows, 6);
  const overflow = visible.length > rowsAvail;
  const rows = overflow ? Math.max(1, rowsAvail - 1) : rowsAvail;
  const top = scrollTop(topRef.current, safeCursor, rows, visible.length);
  topRef.current = top;
  const leftW = twoPane ? Math.max(22, Math.min(32, Math.round(columns * 0.26))) : 0;
  const showProjectCol = scopeIds == null || scopeIds.size > 1;
  const layout = useMemo(() => computeLayout((twoPane ? columns - leftW - 8 : listInnerWidth(columns)) - DEEPER_CELLS, { showProject: showProjectCol }), [columns, twoPane, leftW, showProjectCol]);
  const now = Date.now();
  const working = snapshot.status.workers.length > 0 || snapshot.tickets.some((t) => t.status === 'running');
  const anyRunningVisible = (mode === 'list' && working) || (mode === 'list' ? visible.slice(top, top + rows).some((t) => t.status === 'running') : mode === 'detail' && selected?.status === 'running');
  const { frame } = useAnimation({ interval: 200, isActive: anyRunningVisible });

  // Live activity: follow one running ticket's worker log (the file `salu log` reads). The file is
  // stat'ed twice a second and only re-read when it grew, and only while there is a target.
  const [pinnedId, setPinnedId] = useState<number | null>(null);
  const [actBack, setActBack] = useState(0);
  const [actLog, setActLog] = useState<LogLine[]>([]);
  const target = useMemo(() => (showActivity ? pickTarget(snapshot.tickets, selected, pinnedId) : null), [showActivity, snapshot.tickets, selected, pinnedId]);
  const targetId = target?.id ?? null;
  const targetStamp = target ? `${target.updated_at}:${target.attempts}` : '';
  const logPath = useMemo(() => (targetId == null ? null : latestRun(db, targetId)?.log_path ?? null), [db, targetId, targetStamp]);
  useEffect(() => setActBack(0), [targetId]);
  useEffect(() => {
    if (!logPath) return setActLog([]);
    let last = -1;
    const load = () => {
      let size = -1;
      try {
        size = statSync(logPath).size;
      } catch {
        /* not written yet */
      }
      if (size === last) return;
      last = size;
      setActLog(tailLog(logPath, 400));
    };
    load();
    const i = setInterval(load, 500);
    return () => clearInterval(i);
  }, [logPath]);
  const actInner = Math.max(10, columns - 4);
  const actAll = useMemo(() => activityLines(actLog, actInner, st), [actLog, actInner]);

  // ----- data refresh --------------------------------------------------------------------
  const refresh = useCallback(
    (force = false) => {
      const snap = loadSnapshot(db, { projectId: null, statuses: p.statuses });
      const key = snapshotKey(snap);
      if (!force && key === keyRef.current) return;
      keyRef.current = key;
      setSnapshot(snap);
      const vis = applyFilter(snap.tickets, filterRef.current);
      const id = selectedIdRef.current;
      const idx = id == null ? -1 : vis.findIndex((t) => t.id === id);
      setCursor((c) => (idx >= 0 ? idx : clampCursor(c, vis.length)));
    },
    [db, p.statuses],
  );

  useEffect(() => {
    if (standaloneForm) return;
    const i = setInterval(() => refresh(), p.pollMs ?? 1000);
    return () => clearInterval(i);
  }, [refresh, p.pollMs, standaloneForm]);

  // The badge in the header counts messages already fetched; ask the git transport for new ones now and then.
  useEffect(() => {
    if (standaloneForm) return;
    void fetchInBackground(db);
    const i = setInterval(() => void fetchInBackground(db), 60_000);
    return () => clearInterval(i);
  }, [db, standaloneForm]);

  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 3000);
    return () => clearTimeout(t);
  }, [message]);

  // Detail: reload the ticket, its latest run and the log tail every second while open.
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if ((mode !== 'detail' && mode !== 'props' && mode !== 'reply') || selectedId == null) return;
    const load = () => {
      const t = getTicketById(db, selectedId);
      if (!t) {
        setMode('list');
        return;
      }
      const d = loadDetail(db, t);
      setDetail(d);
      setLog(tailLog(d.run?.log_path, 10));
    };
    load();
    const i = setInterval(load, 1000);
    return () => clearInterval(i);
  }, [mode, selectedId, db]);

  // ----- helpers -------------------------------------------------------------------------
  const say = (text: string, tone: Message['tone'] = 'ok') => setMessage({ text, tone });
  const move = (delta: number) => setCursor((c) => clampCursor(clampCursor(c, visible.length) + delta, visible.length));
  const moveTo = (i: number) => setCursor(clampCursor(i, visible.length));

  const selectScope = (next: number | null) => {
    if (next === scopeRef.current) return;
    scopeRef.current = next;
    setScope(next);
    selectedIdRef.current = null;
    setCursor(0);
    topRef.current = 0;
  };

  const cycleScope = (dir: 1 | -1) => {
    const all = new Set(snapshot.projects.map((pr) => pr.id));
    const ids = buildRows(snapshot.projects, all).map((r) => r.id);
    const i = Math.max(0, ids.indexOf(scope));
    selectScope(ids[(i + dir + ids.length) % ids.length] ?? null);
  };

  const treeStep = (key: TreeKey) => {
    const r = treeKey(snapshot.projects, { selected: scope, expanded }, key);
    if (r.expanded !== expanded) setExpanded(r.expanded);
    selectScope(r.selected);
  };

  const removeProject = async (proj: { id: number; name: string }) => {
    setProjConfirm(null);
    const parent = ancestorsOf(snapshot.projects, proj.id)[0] ?? null;
    const r = await runCommand(`remove project ${JSON.stringify(proj.name)} --yes`);
    if (r.ok) selectScope(parent);
    say((r.lines.join(' ').replace(/^[✓✗]\s*/, '') || `removed ${proj.name}`).slice(0, 200), r.ok ? 'ok' : 'err');
    refresh(true);
  };

  const openForm = (kind: 'add' | 'edit') => {
    if (kind === 'edit' && !selected) return;
    const t = kind === 'edit' ? selected : undefined;
    setFormError(null);
    setForm({ mode: kind, ticket: t, initial: formValuesFor(t) });
    setMode('form');
  };

  const formProjectId = (): number | null => {
    if (form?.ticket) return form.ticket.project_id;
    if (form?.projectId != null) return form.projectId;
    if (scope != null) return scope;
    const def = snapshot.projects.find((pr) => pr.is_default) ?? snapshot.projects[0];
    return def?.id ?? null;
  };

  const closeForm = (result: FormResult) => {
    setForm(null);
    if (standaloneForm) exit(result);
    else setMode('list');
  };

  const submitForm = (v: FormValues) => {
    if (!form) return;
    const projectId = formProjectId();
    if (projectId == null) {
      setFormError('no projects yet: run `salu add project "name"` first');
      return;
    }
    try {
      const input = { projectId, name: v.name, query: v.query, tags: v.tags, priority: v.priority, queue: v.queue };
      const edit = form.mode === 'edit' && !!form.ticket;
      const t = edit ? actions.update(form.ticket!, input) : actions.create(input);
      selectedIdRef.current = t.id;
      say(t.status === 'todo' ? `${edit ? 'saved' : 'added'} "${t.name}" and queued it` : edit ? `saved "${t.name}"` : `added "${t.name}" to the backlog · u queues it`);
      closeForm({ action: edit ? 'saved' : 'added', ticket: t });
      if (!standaloneForm) refresh(true);
    } catch (e: any) {
      setFormError(String(e?.message ?? e));
    }
  };

  const doDelete = (t: TicketView) => {
    try {
      actions.remove(t);
      say(`deleted "${t.name}"`);
    } catch (e: any) {
      say(String(e?.message ?? e), 'err');
    }
    setConfirm(null);
    if (mode === 'detail') setMode('list');
    refresh(true);
  };

  const doRunNow = (t: TicketView) => {
    if (t.status === 'running') {
      say(`"${t.name}" is already running`, 'info');
      return;
    }
    try {
      actions.runNow(t);
      say(snapshot.status.alive ? `"${t.name}" runs next` : `"${t.name}" runs next · start the orchestrator with: salu run`, snapshot.status.alive ? 'ok' : 'info');
    } catch (e: any) {
      say(String(e?.message ?? e), 'err');
    }
    refresh(true);
  };

  const doToggleQueue = (t: TicketView) => {
    if (t.status === 'running' || t.status === 'paused') {
      say(`"${t.name}" is ${t.status}; it can't be queued or unqueued`, 'info');
      return;
    }
    try {
      const r = actions.toggleQueue(t);
      say(r === 'queued' ? `"${t.name}" queued${snapshot.status.alive ? '' : ' · start the orchestrator with: salu run'}` : `"${t.name}" back in the backlog`, 'ok');
    } catch (e: any) {
      say(String(e?.message ?? e), 'err');
    }
    refresh(true);
  };

  const doResolve = (t: TicketView) => {
    if (t.status === 'running') return say(`"${t.name}" is running; wait for it to finish`, 'info');
    if (t.status === 'done') return say(`"${t.name}" is already resolved · r replies and brings it back`, 'info');
    try {
      actions.resolve(t);
      say(`"${t.name}" resolved · r replies and brings it back`, 'ok');
    } catch (e: any) {
      say(String(e?.message ?? e), 'err');
    }
    refresh(true);
  };

  const doAllow = (t: TicketView): string | null => {
    try {
      const rules = actions.allow(t);
      say(`allowed ${rules.join(', ')} for "${t.name}" · queued again${snapshot.status.alive ? '' : ' · start the orchestrator with: salu run'}`, 'ok');
      refresh(true);
      return null;
    } catch (e: any) {
      const m = String(e?.message ?? e);
      say(m, 'err');
      return m;
    }
  };

  const doTogglePause = () => {
    const paused = !!snapshot.status.paused;
    try {
      actions.togglePause(paused);
      say(paused ? 'resumed dispatch' : 'paused dispatch after the current workers finish', 'info');
    } catch (e: any) {
      say(String(e?.message ?? e), 'err');
    }
    refresh(true);
  };

  const setCmd = (v: string) => {
    setCmdValue(v);
    setCmdNonce((n) => n + 1);
  };

  const recall = (older: boolean) => {
    const h = cmdHistory.current;
    if (!h.length) return;
    if (older) {
      if (cmdIdx.current === -1) {
        cmdDraft.current = cmdValue;
        cmdIdx.current = h.length - 1;
      } else cmdIdx.current = Math.max(0, cmdIdx.current - 1);
    } else {
      if (cmdIdx.current === -1) return;
      cmdIdx.current++;
      if (cmdIdx.current >= h.length) {
        cmdIdx.current = -1;
        return setCmd(cmdDraft.current);
      }
    }
    setCmd(h[cmdIdx.current]!);
  };

  const tabComplete = () => {
    const r = complete(cmdValue, { projects: snapshot.projects.map((pr) => pr.name), tickets: snapshot.tickets.map((t) => t.name) });
    if (r.value !== cmdValue) setCmd(r.value);
    if (r.options.length > 1) say(r.options.slice(0, 12).join('  ') + (r.options.length > 12 ? '  …' : ''), 'info');
    return r.value !== cmdValue || r.options.length > 1;
  };

  /** Tab / Shift+Tab out of the command line back to the lists. */
  const leaveCommand = (back: boolean) => {
    setCmdEditing(false);
    setPane(back || !twoPane ? 'tickets' : 'tree');
  };

  const execute = async (line: string) => {
    const text = line.trim();
    if (!text || cmdBusy) return;
    const hidden = eggFor(text);
    if (hidden) {
      // Not a command: nothing in the history, nothing in the footer, the prompt just clears.
      setCmd('');
      cmdIdx.current = -1;
      if (hidden !== 'rain' && !showActivity) return say(eggWords(hidden), 'info');
      setEggAt(0);
      return setEgg({ kind: hidden, start: Date.now() });
    }
    cmdHistory.current.push(text);
    cmdIdx.current = -1;
    setCmdValue('');
    setCmdNonce((n) => n + 1);
    setCmdBusy(true);
    try {
      const r = await runCommand(text);
      if (r.quit) return exit();
      if (r.openForm) {
        setCmdEditing(false);
        return openForm('add');
      }
      if (r.openNotif) {
        setCmdEditing(false);
        return setMode('notif');
      }
      refresh(true);
      if (r.lines.length > 1) {
        setResult({ command: text, lines: r.lines, ok: r.ok, offset: 0 });
        setMode('result');
      } else {
        say(r.lines[0]?.replace(/^[✓✗]\s*/, '').replace(/^error:\s*/, '') || 'done', r.ok ? 'ok' : 'err');
      }
    } finally {
      setCmdBusy(false);
    }
  };

  // ----- keys ----------------------------------------------------------------------------
  useInput(
    (input, key) => {
      if (isMouseInput(input)) return; // a stray mouse report (the notification window turns the mouse on)
      if (egg?.kind === 'rain') return setEgg(null); // any key ends the rain
      if (mode === 'help') {
        setMode('list');
        return;
      }
      if (mode === 'result') {
        if (key.upArrow || input === 'k') setResult((r) => (r ? { ...r, offset: Math.max(0, r.offset - 1) } : r));
        else if (key.downArrow || input === 'j') setResult((r) => (r ? { ...r, offset: Math.min(Math.max(0, r.lines.length - rowsAvail), r.offset + 1) } : r));
        else setMode('list');
        return;
      }
      if (cmdEditing) {
        if (key.escape || (key.ctrl && input === 'c')) {
          setCmdEditing(false);
          setCmd('');
          cmdIdx.current = -1;
        } else if (key.return) void execute(cmdValue);
        else if (key.upArrow) recall(true);
        else if (key.downArrow) recall(false);
        else if (key.tab) {
          // Tab completes while there is something to complete, otherwise it moves the focus on.
          if (!key.shift && cmdValue.trim() && tabComplete()) return;
          leaveCommand(!!key.shift);
        }
        return; // the TextField consumes the rest
      }
      if (allowAsk) {
        if (input === 'y' || input === 'Y' || key.return) doAllow(allowAsk.ticket);
        setAllowAsk(null);
        return;
      }
      if (projConfirm) {
        if (input === 'y' || input === 'Y' || key.return) void removeProject(projConfirm);
        else setProjConfirm(null);
        return;
      }
      if (confirm) {
        if (input === 'y' || input === 'Y' || key.return) doDelete(confirm);
        else setConfirm(null);
        return;
      }
      if (filterEditing) {
        if (key.escape) {
          setFilter('');
          setFilterEditing(false);
        } else if (key.return || key.tab) setFilterEditing(false);
        else if (key.upArrow) move(-1);
        else if (key.downArrow) move(1);
        return; // the TextField consumes the rest
      }
      // Two-pane: the project tree owns the arrows while it has the focus.
      if (twoPane && mode === 'list' && pane === 'tree') {
        if (key.upArrow || input === 'k') return treeStep('up');
        if (key.downArrow || input === 'j') return treeStep('down');
        if (key.rightArrow || input === 'l') return treeStep('right');
        if (key.leftArrow || input === 'h') return treeStep('left');
        if (key.tab && key.shift) return setCmdEditing(true);
        if (key.return || key.tab) return setPane('tickets');
        if (input === 'a') {
          setCmdEditing(true);
          return setCmd('add project ');
        }
        if (input === 'd' || input === 'x') {
          const proj = scope == null ? null : snapshot.projects.find((pr) => pr.id === scope);
          if (proj) setProjConfirm({ id: proj.id, name: proj.name });
          else say('pick a project to remove', 'info');
          return;
        }
        if (input === 'e' || input === 'r' || input === 'u' || input === 'g' || input === 'G' || key.pageUp || key.pageDown || key.home || key.end) return;
      }
      // Only tab and shift-tab move between windows. Right on a ticket opens its properties;
      // a narrow terminal (one pane) cycles projects with < and >.
      if (mode === 'list' && !twoPane && (input === '<' || input === ',')) return cycleScope(-1);
      if (mode === 'list' && !twoPane && (input === '>' || input === '.')) return cycleScope(1);
      if (mode === 'list' && (!twoPane || pane === 'tickets') && key.rightArrow) {
        if (selected) setMode('props');
        return;
      }
      if (mode === 'list' && showActivity && input === '[') return setActBack((b) => Math.min(b + 5, Math.max(0, actAll.length - actH)));
      if (mode === 'list' && showActivity && input === ']') return setActBack((b) => Math.max(0, b - 5));
      if (mode === 'list' && showActivity && input === 'f') {
        if (pinnedId != null) {
          setPinnedId(null);
          return say('following the running ticket again', 'info');
        }
        if (target) {
          setPinnedId(target.id);
          return say(`pinned to "${target.name}"`, 'info');
        }
        return;
      }
      // Shared navigation (list and detail).
      if (key.upArrow || input === 'k') return move(-1);
      if (key.downArrow || input === 'j') return move(1);
      if (key.pageUp || (key.ctrl && input === 'u')) return move(-rows);
      if (key.pageDown || (key.ctrl && input === 'd')) return move(rows);
      if (key.home || input === 'g') return moveTo(0);
      if (key.end || input === 'G') return moveTo(visible.length - 1);
      if (input === 'e') return openForm('edit');
      if (input === 'd') {
        if (selected) setConfirm(selected);
        return;
      }
      if (input === 'r') {
        if (mode === 'detail' && selected && (selected.status === 'done' || selected.status === 'blocked' || selected.status === 'failed')) {
          setReplyError(null);
          setMode('reply');
        } else if (selected) doRunNow(selected);
        return;
      }
      if (input === 'a' && mode === 'list' && selected && ticketDenials(selected).length) {
        setAllowAsk({ ticket: selected, rules: [...new Set(ticketDenials(selected).map((d) => d.rule))] });
        return;
      }
      if (input === 'x') {
        if (selected) doResolve(selected);
        return;
      }
      if (input === 'u') {
        if (selected) doToggleQueue(selected);
        return;
      }
      if (input === 'p') return doTogglePause();
      if (input === 'n' && mode === 'list') return setMode('notif');
      if (input === 'q' || (key.ctrl && input === 'c')) return exit();

      if (mode === 'detail') {
        if (key.escape || key.return) setMode('list');
        return;
      }
      // List only.
      if (key.return) {
        if (selected) setMode('detail');
        return;
      }
      if (input === 'a') return openForm('add');
      if (input === '/') return setFilterEditing(true);
      if (input === ':') return setCmdEditing(true);
      if (key.tab) return key.shift && twoPane ? setPane('tree') : setCmdEditing(true);
      if (input === '?') return setMode('help');
      if (key.escape) {
        if (filter) setFilter('');
        else exit();
      }
    },
    { isActive: mode !== 'form' && mode !== 'props' && mode !== 'reply' && mode !== 'notif' },
  );

  // ----- render --------------------------------------------------------------------------
  const rainSeed = egg?.kind === 'rain' ? egg.start : 0;
  const rain = useMemo(() => (rainSeed ? makeRain(columns, Math.max(1, (termRows || 24) - 1), rainSeed, supportsUnicode()) : null), [rainSeed, columns, termRows]);
  if (rain) return <Text>{rainLines(rain, eggAt, st).join('\n')}</Text>;
  if (mode === 'form' && form) {
    const pid = formProjectId();
    const projectName = snapshot.projects.find((pr) => pr.id === pid)?.name ?? (pid != null ? getProjectById(db, pid)?.name : null) ?? scopeName ?? 'no project';
    return (
      <FormView
        columns={columns}
        mode={form.mode}
        projectName={projectName}
        initial={form.initial}
        error={formError}
        canQueue={form.mode === 'add' || form.ticket?.status === 'backlog'}
        onSubmit={submitForm}
        onCancel={() => closeForm({ action: 'cancelled' })}
        onChange={() => formError && setFormError(null)}
      />
    );
  }
  if (mode === 'result' && result) {
    return <ResultView columns={columns} rows={textRows} scopeName={scopeName} command={result.command} lines={result.lines} ok={result.ok} offset={result.offset} />;
  }
  if (mode === 'props' && detail && selected && detail.ticket.id === selected.id) {
    const save = async (flag: string, value: string): Promise<string | null> => {
      const r = await runCommand(`change --id ${detail.ticket.id} --${flag} ${JSON.stringify(value)}`);
      if (!r.ok) return (r.lines.join(' ').replace(/^[✓✗]\s*/, '') || 'could not save').slice(0, 200);
      const t = getTicketById(db, detail.ticket.id);
      if (t) setDetail(loadDetail(db, t));
      refresh(true);
      return null;
    };
    return <PropsView columns={columns} detail={detail} projects={snapshot.projects.map((pr) => pr.name)} now={now} rows={viewportRows(termRows, 4)} loadRuns={(id) => listRuns(db, id)} onSave={save}
        onAllow={() => {
          const err = doAllow(detail.ticket);
          if (!err) {
            const t = getTicketById(db, detail.ticket.id);
            if (t) setDetail(loadDetail(db, t));
          }
          return err;
        }}
        onClose={() => setMode('list')}
      />;
  }
  if (mode === 'notif')
    return (
      <NotifScreen
        db={db}
        scopeName={scopeName}
        onClose={() => {
          setMode('list');
          refresh(true);
        }}
      />
    );
  if (mode === 'reply' && detail && selected && detail.ticket.id === selected.id) {
    return (
      <ReplyView
        columns={columns}
        rows={viewportRows(termRows, 4)}
        ticket={selected}
        turns={detail.turns}
        error={replyError}
        onChange={() => replyError && setReplyError(null)}
        onCancel={() => setMode('detail')}
        onSubmit={(msg) => {
          try {
            const t = actions.reply(selected, msg);
            say(t.status === 'running' ? `sent to "${t.name}": the next turn` : `sent to "${t.name}" and queued it`);
            setMode('detail');
            refresh(true);
          } catch (e: any) {
            setReplyError(String(e?.message ?? e));
          }
        }}
      />
    );
  }
  if (mode === 'help') return <HelpView columns={columns} scopeName={scopeName} />;
  if (mode === 'detail' && detail) {
    return (
      <DetailView columns={columns} rows={viewportRows(termRows, 4)} detail={detail} log={log} scopeName={scopeName} now={now} spinner={frame} confirm={confirm} message={message} />
    );
  }
  let sidebar: { width: number; lines: string[] } | undefined;
  if (twoPane) {
    const rowsAll = buildRows(snapshot.projects, expanded);
    const own = new Map<number, number>();
    for (const t of snapshot.tickets) own.set(t.project_id, (own.get(t.project_id) ?? 0) + 1);
    const countOf = (id: number | null) => {
      const ids = subtreeIds(snapshot.projects, id);
      if (!ids) return snapshot.tickets.length;
      let n = 0;
      for (const i of ids) n += own.get(i) ?? 0;
      return n;
    };
    const sel = Math.max(0, rowsAll.findIndex((r) => r.id === scope));
    const height = Math.max(1, rowsAvail);
    const from = scrollTop(treeTopRef.current, sel, height, rowsAll.length);
    treeTopRef.current = from;
    sidebar = {
      width: leftW,
      lines: rowsAll.slice(from, from + height).map((r) => renderTreeRow(r, { st, selected: r.id === scope, focused: pane === 'tree', width: leftW, count: countOf(r.id) })),
    };
  }
  let activity: { title: string; lines: string[]; height: number } | undefined;
  if (showActivity) {
    let lines: string[];
    let back = 0;
    const eggFrame = egg && egg.kind !== 'rain' ? eggFrameAt(egg.kind, eggAt) : null;
    if (eggFrame) lines = idleLines(actInner, actH, st, 0, { lines: eggDogLines(eggFrame, st), say: eggFrame.say });
    else if (!target) lines = idleLines(actInner, actH, st, 0);
    else if (actAll.length === 0) lines = [st.dim('waiting for the worker…')];
    else {
      const w = visibleWindow(actAll, actH, actBack);
      lines = w.lines;
      back = w.back;
    }
    // While the worker runs, a blinking cursor after its newest output (not when scrolled back).
    if (target?.status === 'running' && back === 0 && !eggFrame) lines = withWritingCursor(lines, actInner, actH, blinkOn(frame), st, displayWidth);
    const keys = pinnedId != null ? 'f unpin' : 'f pin';
    const title = target ? `activity · ${truncate(target.name, 30)}${pinnedId != null ? ' (pinned)' : ''}${back ? ` · ↑${back}` : ''} · ${keys} · [ ] scroll` : 'activity';
    activity = { title: truncate(title, Math.max(8, actInner - 6)), lines, height: actH };
  }
  return (
    <ListView
      sidebar={sidebar}
      activity={activity}
      commandFocus={cmdEditing}
      unread={snapshot.unread}
      command={<CommandLine columns={columns} focused={cmdEditing} value={cmdValue} onChange={setCmdValue} busy={cmdBusy} nonce={cmdNonce} />}
      working={working}
      usage={usageSnap}
      ticketFocus={!twoPane || pane === 'tickets'}
      crumbs={scopeCrumbs}
      projectConfirm={projConfirm ? `remove project "${projConfirm.name}" and its tickets?` : allowAsk ? `Allow ${allowAsk.rules.join(', ')} for "${allowAsk.ticket.name}" and queue it again?` : null}
      hints={cmdEditing ? COMMAND_HINTS : twoPane ? (pane === 'tree' ? TREE_HINTS : TICKET_PANE_HINTS) : LIST_HINTS}
      columns={columns}
      rows={rowsAvail}
      tickets={visible}
      total={scoped.length}
      cursor={safeCursor}
      top={top}
      layout={layout}
      scopeName={scopeName}
      statuses={p.statuses}
      counts={scopedCounts}
      status={snapshot.status}
      filter={filter}
      filterEditing={filterEditing}
      onFilterChange={(v) => {
        setFilter(v);
        setCursor(0);
      }}
      confirm={confirm}
      message={message}
      now={now}
      spinner={frame}
    />
  );
}

export interface MountOptions {
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  /** Ink's default: Ctrl-C exits. The run view turns this off and asks the orchestrator to stop instead. */
  exitOnCtrlC?: boolean;
  /** take over the whole terminal like `claude` does (alternate screen); the shell is restored on exit */
  fullscreen?: boolean;
}

const LEAVE_ALT_SCREEN = '\u001b[?1049l\u001b[?25h';

/** Mount a screen and resolve with the value passed to `exit()` when it closes. */
export async function mount<T = unknown>(node: React.ReactElement, opts: MountOptions = {}): Promise<T | undefined> {
  const out = opts.stdout ?? process.stdout;
  // Only a real terminal gets the alternate screen; pipes and test streams stay inline.
  const fullscreen = !!opts.fullscreen && !!out.isTTY;
  // Safety net for hard exits (uncaught crash, process.exit): Ink restores on a clean unmount,
  // this covers the rest. Leaving the alternate screen twice is harmless.
  const restore = () => out.write(LEAVE_ALT_SCREEN);
  if (fullscreen) process.on('exit', restore);
  const instance = render(node, {
    alternateScreen: fullscreen,
    stdout: out,
    stdin: opts.stdin ?? process.stdin,
    exitOnCtrlC: opts.exitOnCtrlC ?? true,
    patchConsole: true,
    maxFps: 30,
  });
  try {
    return (await instance.waitUntilExit()) as T | undefined;
  } finally {
    instance.cleanup();
    if (fullscreen) process.off('exit', restore);
  }
}
