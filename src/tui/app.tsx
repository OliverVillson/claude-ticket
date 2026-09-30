import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { render, useAnimation, useApp, useInput, useWindowSize } from 'ink';
import type { Database } from 'bun:sqlite';
import type { TicketStatus, TicketView } from '../db/types.ts';
import { ticketLabels, ticketTags } from '../db/types.ts';
import { getProjectById, getTicketById } from '../db/queries.ts';
import { formatTags } from '../core/tags.ts';
import type { TuiActions } from './actions.ts';
import { applyFilter } from './filter.ts';
import { priorityText } from './format.ts';
import { clampCursor, computeLayout, scrollTop, viewportRows } from './layout.ts';
import { tailLog, type LogLine } from './log-tail.ts';
import { loadDetail, loadSnapshot, snapshotKey, type Snapshot, type TicketDetail } from './store.ts';
import { DetailView } from './components/DetailView.tsx';
import { FormView, type FormValues } from './components/FormView.tsx';
import { HelpView } from './components/HelpView.tsx';
import { ListView, listInnerWidth } from './components/ListView.tsx';
import type { Message } from './messages.ts';

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

type Mode = 'list' | 'detail' | 'form' | 'help';

/** Lines around the ticket rows: header, two border lines, footer, plus one spare for the cursor. */
const CHROME_LINES = 5;

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

  const [snapshot, setSnapshot] = useState<Snapshot>(() => p.initial ?? loadSnapshot(db, { projectId: p.projectId, statuses: p.statuses }));
  const keyRef = useRef<string>(snapshotKey(snapshot));

  const [cursor, setCursor] = useState(0);
  const topRef = useRef(0);
  const selectedIdRef = useRef<number | null>(null);

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

  // ----- derived -------------------------------------------------------------------------
  const visible = useMemo(() => applyFilter(snapshot.tickets, filter), [snapshot, filter]);
  const safeCursor = clampCursor(cursor, visible.length);
  const selected: TicketView | undefined = visible[safeCursor];
  selectedIdRef.current = selected?.id ?? null;
  const scopeName = scope == null ? null : snapshot.projects.find((pr) => pr.id === scope)?.name ?? null;
  const rowsAvail = viewportRows(termRows, CHROME_LINES);
  const overflow = visible.length > rowsAvail;
  const rows = overflow ? Math.max(1, rowsAvail - 1) : rowsAvail;
  const top = scrollTop(topRef.current, safeCursor, rows, visible.length);
  topRef.current = top;
  const layout = useMemo(() => computeLayout(listInnerWidth(columns), { showProject: scope == null }), [columns, scope]);
  const now = Date.now();
  const anyRunningVisible = mode === 'list' ? visible.slice(top, top + rows).some((t) => t.status === 'running') : mode === 'detail' && selected?.status === 'running';
  const { frame } = useAnimation({ interval: 200, isActive: anyRunningVisible });

  // ----- data refresh --------------------------------------------------------------------
  const refresh = useCallback(
    (force = false) => {
      const snap = loadSnapshot(db, { projectId: scopeRef.current, statuses: p.statuses });
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

  const cycleScope = (dir: 1 | -1) => {
    const ids: Array<number | null> = [null, ...snapshot.projects.map((pr) => pr.id)];
    const i = ids.indexOf(scope);
    const next = ids[(i + dir + ids.length) % ids.length] ?? null;
    scopeRef.current = next;
    setScope(next);
    selectedIdRef.current = null;
    setCursor(0);
    topRef.current = 0;
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

  // ----- keys ----------------------------------------------------------------------------
  useInput(
    (input, key) => {
      if (mode === 'help') {
        setMode('list');
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
      if (key.tab) return cycleScope(key.shift ? -1 : 1);
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
  if (mode === 'help') return <HelpView columns={columns} scopeName={scopeName} />;
  if (mode === 'detail' && detail) {
    return (
      <DetailView columns={columns} rows={rowsAvail + 1} detail={detail} log={log} scopeName={scopeName} now={now} spinner={frame} confirm={confirm} message={message} />
    );
  }
  return (
    <ListView
      columns={columns}
      rows={rowsAvail}
      tickets={visible}
      total={snapshot.tickets.length}
      cursor={safeCursor}
      top={top}
      layout={layout}
      scopeName={scopeName}
      statuses={p.statuses}
      counts={snapshot.counts}
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
}

/** Mount a screen and resolve with the value passed to `exit()` when it closes. */
export async function mount<T = unknown>(node: React.ReactElement, opts: MountOptions = {}): Promise<T | undefined> {
  const instance = render(node, {
    stdout: opts.stdout ?? process.stdout,
    stdin: opts.stdin ?? process.stdin,
    exitOnCtrlC: opts.exitOnCtrlC ?? true,
    patchConsole: true,
    maxFps: 30,
  });
  try {
    return (await instance.waitUntilExit()) as T | undefined;
  } finally {
    instance.cleanup();
  }
}
