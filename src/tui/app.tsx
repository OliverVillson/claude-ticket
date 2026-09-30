import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, render, useAnimation, useApp, useInput, useWindowSize } from 'ink';
import type { Database } from 'bun:sqlite';
import type { TicketStatus, TicketView } from '../db/types.ts';
import { ticketLabels, ticketTags } from '../db/types.ts';
import { getProjectById, getTicketById } from '../db/queries.ts';
import { formatTags } from '../core/tags.ts';
import type { TuiActions } from './actions.ts';
import { applyFilter } from './filter.ts';
import { priorityText } from './format.ts';
import { clampCursor, computeLayout, scrollTop, viewportRows } from './layout.ts';
import { ancestorsOf, buildRows, pathNames, renderTreeRow, revealed, subtreeIds, treeKey, type TreeKey } from './tree.ts';
import { tailLog, type LogLine } from './log-tail.ts';
import { loadDetail, loadSnapshot, snapshotKey, type Snapshot, type TicketDetail } from './store.ts';
import { DetailView } from './components/DetailView.tsx';
import { FormView, type FormValues } from './components/FormView.tsx';
import { HelpView } from './components/HelpView.tsx';
import { style as st } from './style.ts';
import { CommandLine } from './components/CommandLine.tsx';
import { ResultView } from './components/ResultView.tsx';
import { LIST_HINTS, ListView, listInnerWidth } from './components/ListView.tsx';
import type { Message } from './messages.ts';
import { runCommand } from './command.ts';
import { complete } from './complete.ts';

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
}

export type FormResult = { action: 'added' | 'saved'; ticket: TicketView } | { action: 'cancelled' } | null;

type Mode = 'list' | 'detail' | 'form' | 'help' | 'result';

/** Lines around the ticket rows: header, two border lines, footer, the command line, plus one spare for the cursor. */
const CHROME_LINES = 6;

/** Terminals at least this wide get the project tree beside the tickets; narrower ones get one pane. */
export const TWO_PANE_MIN_COLUMNS = 104;

export const TICKET_PANE_HINTS: Array<[string, string]> = [['↑↓', 'move'], ['tab', 'switch pane'], ...LIST_HINTS.filter(([k]) => k !== 'tab' && k !== '↑↓')];

export const TREE_HINTS: Array<[string, string]> = [
  ['↑↓', 'project'],
  ['→', 'open'],
  ['←', 'back'],
  ['a', 'add project'],
  ['d', 'remove'],
  ['tab', 'switch pane'],
  [':', 'command'],
  ['?', 'help'],
  ['q', 'quit'],
];

function formValuesFor(t: TicketView | null | undefined): FormValues {
  if (!t) return { name: '', query: '', tags: '', priority: '3' };
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
  const [form, setForm] = useState<{ mode: 'add' | 'edit'; ticket?: TicketView; projectId?: number; initial: FormValues } | null>(() => {
    if (!p.form) return null;
    const t = p.form.ticketId != null ? getTicketById(db, p.form.ticketId) : null;
    return { mode: t ? 'edit' : 'add', ticket: t ?? undefined, projectId: t?.project_id ?? p.form.projectId, initial: formValuesFor(t) };
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [, setTick] = useState(0);

  // Command line (`:`): same dispatcher as the shell CLI, with history and tab completion.
  const [cmdEditing, setCmdEditing] = useState(false);
  const [cmdValue, setCmdValue] = useState('');
  const [cmdNonce, setCmdNonce] = useState(0);
  const [cmdBusy, setCmdBusy] = useState(false);
  const cmdHistory = useRef<string[]>([]);
  const cmdIdx = useRef(-1);
  const cmdDraft = useRef('');
  const [result, setResult] = useState<{ command: string; lines: string[]; ok: boolean; offset: number } | null>(null);

  // ----- derived -------------------------------------------------------------------------
  const scopeIds = useMemo(() => subtreeIds(snapshot.projects, scope), [snapshot.projects, scope]);
  const scoped = useMemo(() => (scopeIds ? snapshot.tickets.filter((t) => scopeIds.has(t.project_id)) : snapshot.tickets), [snapshot.tickets, scopeIds]);
  const scopedCounts = useMemo(() => {
    const c = { todo: 0, running: 0, done: 0, failed: 0, blocked: 0, paused: 0 } as Snapshot['counts'];
    for (const t of scoped) c[t.status]++;
    return c;
  }, [scoped]);
  const visible = useMemo(() => applyFilter(scoped, filter), [scoped, filter]);
  const safeCursor = clampCursor(cursor, visible.length);
  const selected: TicketView | undefined = visible[safeCursor];
  selectedIdRef.current = selected?.id ?? null;
  const scopeName = scope == null ? null : snapshot.projects.find((pr) => pr.id === scope)?.name ?? null;
  const scopeCrumbs = pathNames(snapshot.projects, scope);
  const rowsAvail = viewportRows(termRows, CHROME_LINES);
  const overflow = visible.length > rowsAvail;
  const rows = overflow ? Math.max(1, rowsAvail - 1) : rowsAvail;
  const top = scrollTop(topRef.current, safeCursor, rows, visible.length);
  topRef.current = top;
  const leftW = twoPane ? Math.max(22, Math.min(32, Math.round(columns * 0.26))) : 0;
  const showProjectCol = scopeIds == null || scopeIds.size > 1;
  const layout = useMemo(() => computeLayout(twoPane ? columns - leftW - 8 : listInnerWidth(columns), { showProject: showProjectCol }), [columns, twoPane, leftW, showProjectCol]);
  const now = Date.now();
  const working = snapshot.status.workers.length > 0 || snapshot.tickets.some((t) => t.status === 'running');
  const anyRunningVisible = (mode === 'list' && working) || (mode === 'list' ? visible.slice(top, top + rows).some((t) => t.status === 'running') : mode === 'detail' && selected?.status === 'running');
  const { frame } = useAnimation({ interval: 200, isActive: anyRunningVisible });

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
    if (mode !== 'detail' || selectedId == null) return;
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
    if (r.focusTickets) setPane('tickets');
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
      const input = { projectId, name: v.name, query: v.query, tags: v.tags, priority: v.priority };
      const edit = form.mode === 'edit' && !!form.ticket;
      const t = edit ? actions.update(form.ticket!, input) : actions.create(input);
      selectedIdRef.current = t.id;
      say(edit ? `saved "${t.name}"` : `added "${t.name}"`);
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
  };

  const execute = async (line: string) => {
    const text = line.trim();
    if (!text || cmdBusy) return;
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
        else if (key.tab) tabComplete();
        return; // the TextField consumes the rest
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
        if (input === 'e' || input === 'r' || input === 'g' || input === 'G' || key.pageUp || key.pageDown || key.home || key.end) return;
      }
      if (twoPane && mode === 'list' && pane === 'tickets' && key.leftArrow) return setPane('tree');
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
        if (selected) doRunNow(selected);
        return;
      }
      if (input === 'p') return doTogglePause();
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
      if (key.tab) return twoPane ? setPane('tree') : cycleScope(key.shift ? -1 : 1);
      if (input === '?') return setMode('help');
      if (key.escape) {
        if (filter) setFilter('');
        else exit();
      }
    },
    { isActive: mode !== 'form' },
  );

  // ----- render --------------------------------------------------------------------------
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
        onSubmit={submitForm}
        onCancel={() => closeForm({ action: 'cancelled' })}
        onChange={() => formError && setFormError(null)}
      />
    );
  }
  if (mode === 'result' && result) {
    return <ResultView columns={columns} rows={rowsAvail} scopeName={scopeName} command={result.command} lines={result.lines} ok={result.ok} offset={result.offset} />;
  }
  if (mode === 'help') return <HelpView columns={columns} scopeName={scopeName} />;
  if (mode === 'detail' && detail) {
    return (
      <DetailView columns={columns} rows={rowsAvail + 2} detail={detail} log={log} scopeName={scopeName} now={now} spinner={frame} confirm={confirm} message={message} />
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
  return (
    <Box flexDirection="column">
    <ListView
      working={working}
      sidebar={sidebar}
      ticketFocus={!twoPane || pane === 'tickets'}
      crumbs={scopeCrumbs}
      projectConfirm={projConfirm ? `remove project "${projConfirm.name}" and its tickets?` : null}
      hints={twoPane ? (pane === 'tree' ? TREE_HINTS : TICKET_PANE_HINTS) : undefined}
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
    <CommandLine columns={columns} focused={cmdEditing} value={cmdValue} onChange={setCmdValue} busy={cmdBusy} nonce={cmdNonce} />
    </Box>
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
