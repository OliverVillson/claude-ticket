import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, useApp, useInput, useStdout, useWindowSize } from 'ink';
import type { Database } from 'bun:sqlite';
import { countUnread, fetchInBackground, listNotifs, markAllRead, markRead, type Notif } from '../../notif/index.ts';
import { clampCursor } from '../layout.ts';
import { displayWidth } from '../format.ts';
import { MOUSE_OFF, MOUSE_ON, isMouseInput, parseMouse } from '../mouse.ts';
import { NOTIF_LEFT_COLS, detailLines, notifGeometry, renderNotifRow, rowAt, scrollTopFor } from '../notif.ts';
import { style as st } from '../style.ts';
import { Frame, hintsText, titleText } from './Frame.tsx';

/** How long the pointer has to rest on an unread message before it counts as read. */
export const HOVER_MS = 600;

export const NOTIF_HINTS: Array<[string, string]> = [
  ['hover', 'mark read'],
  ['↑↓', 'move'],
  ['⏎', 'mark read'],
  ['a', 'mark all read'],
  ['esc', 'close'],
];

export interface NotifScreenProps {
  db: Database;
  /** only this project's messages */
  projectId?: number;
  /** keep read messages in the list (dimmed) instead of letting them go */
  showRead?: boolean;
  /** dwell time before hover marks a message read */
  hoverMs?: number;
  pollMs?: number;
  /** called when the user closes the window (esc, q) */
  onClose: () => void;
  /** crumb in front of "notifications" when shown inside the list screen */
  scopeName?: string | null;
}

function load(db: Database, o: { projectId?: number; showRead?: boolean }): Notif[] {
  return listNotifs(db, { unread: !o.showRead, projectId: o.projectId });
}

const keyOf = (xs: Notif[]) => xs.map((n) => `${n.id}${n.read_at ? 'r' : 'u'}`).join(',');

/** How often the window asks the git transport for new messages while it is open. */
export const FETCH_MS = 30_000;

/**
 * The notification window: unread messages from the project orchestrators, newest first.
 * Resting the mouse on one marks it read and it goes away; Enter does the same from the keyboard.
 */
export function NotifScreen(p: NotifScreenProps) {
  const { db } = p;
  const { stdout } = useStdout();
  const { columns: rawColumns, rows: rawRows } = useWindowSize();
  const columns = Math.max(40, rawColumns || 80);
  const termRows = rawRows || 24;
  const geo = notifGeometry(termRows);
  const hoverMs = p.hoverMs ?? HOVER_MS;

  const [items, setItems] = useState<Notif[]>(() => load(db, p));
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const keyRef = useRef(keyOf(items));
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  cursorRef.current = cursor;
  const topRef = useRef(0);
  const [unread, setUnread] = useState(() => countUnread(db));
  const [, setTick] = useState(0);

  const refresh = useCallback(() => {
    const next = load(db, p);
    const k = keyOf(next);
    setUnread(countUnread(db));
    if (k === keyRef.current) return;
    keyRef.current = k;
    setItems(next);
    itemsRef.current = next;
    setCursor((c) => clampCursor(c, next.length));
  }, [db, p.projectId, p.showRead]);

  useEffect(() => {
    const i = setInterval(refresh, p.pollMs ?? 1000);
    return () => clearInterval(i);
  }, [refresh, p.pollMs]);
  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 30_000); // ages tick forward
    return () => clearInterval(i);
  }, []);
  // New messages from a box: ask the git transport now and every FETCH_MS (in the background).
  useEffect(() => {
    void fetchInBackground(db);
    const i = setInterval(() => void fetchInBackground(db), FETCH_MS);
    return () => clearInterval(i);
  }, [db]);

  // Ask the terminal for mouse events while this window is open. Real terminals only; pipes and
  // the test streams are left alone. SALU_NO_MOUSE=1 keeps it off (keyboard still does everything).
  useEffect(() => {
    if (!stdout?.isTTY || process.env.SALU_NO_MOUSE) return;
    const off = () => stdout.write(MOUSE_OFF);
    stdout.write(MOUSE_ON);
    process.on('exit', off);
    return () => {
      process.off('exit', off);
      off();
    };
  }, [stdout]);

  // Hover: a message the pointer rests on for `hoverMs` is marked read.
  const hover = useRef<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const cancelHover = () => {
    if (hover.current) clearTimeout(hover.current.timer);
    hover.current = null;
  };
  useEffect(() => cancelHover, []);
  const readOne = (id: string) => {
    markRead(db, [id]);
    refresh();
  };
  const startHover = (n: Notif) => {
    if (n.read_at != null) return cancelHover();
    if (hover.current?.id === n.id) return;
    cancelHover();
    hover.current = {
      id: n.id,
      timer: setTimeout(() => {
        hover.current = null;
        readOne(n.id);
      }, hoverMs),
    };
  };

  const count = items.length;
  const safe = clampCursor(cursor, count);
  const top = scrollTopFor(topRef.current, safe, geo.listRows, count);
  topRef.current = top;
  const selected = items[safe];

  useInput((input, key) => {
    const m = parseMouse(input);
    if (m) {
      const list = itemsRef.current;
      if (m.kind === 'wheelUp' || m.kind === 'wheelDown') {
        cancelHover();
        return setCursor((c) => clampCursor(clampCursor(c, list.length) + (m.kind === 'wheelUp' ? -3 : 3), list.length));
      }
      const i = rowAt(m.y, m.x, geo, topRef.current, list.length, columns);
      if (i < 0) return cancelHover();
      if (m.kind === 'press' && m.button === 0) {
        cancelHover();
        setCursor(i);
        return readOne(list[i]!.id);
      }
      if (m.kind === 'move') {
        setCursor(i);
        startHover(list[i]!);
      }
      return;
    }
    if (isMouseInput(input)) return;
    if (key.escape || input === 'q') return p.onClose();
    if (key.upArrow || input === 'k') return setCursor((c) => clampCursor(clampCursor(c, itemsRef.current.length) - 1, itemsRef.current.length));
    if (key.downArrow || input === 'j') return setCursor((c) => clampCursor(clampCursor(c, itemsRef.current.length) + 1, itemsRef.current.length));
    if (key.pageUp) return setCursor((c) => clampCursor(c - geo.listRows, itemsRef.current.length));
    if (key.pageDown) return setCursor((c) => clampCursor(c + geo.listRows, itemsRef.current.length));
    if (key.home || input === 'g') return setCursor(0);
    if (key.end || input === 'G') return setCursor(clampCursor(itemsRef.current.length - 1, itemsRef.current.length));
    if (key.return) {
      const n = itemsRef.current[clampCursor(cursorRef.current, itemsRef.current.length)];
      if (n) readOne(n.id);
      return;
    }
    if (input === 'a') {
      cancelHover();
      markAllRead(db, p.projectId);
      refresh();
    }
  });

  const now = Date.now();
  const inner = Math.max(16, columns - 4);
  const shown = items.slice(top, top + geo.listRows);
  const lines: React.ReactNode[] = [];
  if (!count) {
    lines.push(
      <Text key="empty" wrap="truncate-end">
        {st.accent('▌') + st.text(p.showRead ? ' no messages' : ' no unread messages') + st.dim(' · orchestrators post here when a ticket finishes, is blocked, or fails')}
      </Text>,
    );
  }
  shown.forEach((n, i) => {
    lines.push(
      <Text key={n.id} wrap="truncate-end">
        {renderNotifRow(n, { width: inner, now, selected: top + i === safe, style: st })}
      </Text>,
    );
  });
  while (lines.length < geo.listRows) lines.push(<Text key={`pad${lines.length}`}> </Text>);
  if (geo.detailRows) {
    lines.push(<Text key="rule">{st.dim('─'.repeat(inner))}</Text>);
    const d = selected ? detailLines(selected, inner, geo.detailRows, now) : [];
    for (let i = 0; i < geo.detailRows; i++)
      lines.push(
        <Text key={`d${i}`} wrap="truncate-end">
          {i === 0 && d[0] ? st.text(d[0]) : st.base(d[i] ?? ' ')}
        </Text>,
      );
  }

  const crumbs = [p.scopeName ?? 'all projects', 'notifications'];
  const right = st.dim(unread ? `${unread} unread` : 'all read');
  const footerLeft = hintsText(NOTIF_HINTS, Math.max(10, columns - 2 - displayWidth(`${unread} unread`) - 3));
  return (
    <Frame columns={columns} header={{ left: titleText(crumbs), right }} footer={{ left: footerLeft }}>
      {lines}
    </Frame>
  );
}

/** Left edge of the list, for tests that aim the mouse. */
export const NOTIF_TEXT_COL = NOTIF_LEFT_COLS + 1;

/** The window mounted by itself (`salu notif`): closing it ends the program. */
export function NotifStandalone(p: Omit<NotifScreenProps, 'onClose'>) {
  const { exit } = useApp();
  return <NotifScreen {...p} onClose={() => exit()} />;
}
