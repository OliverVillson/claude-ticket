import React from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { render } from 'ink';
import { App } from '../../src/tui/app.tsx';
import { NotifScreen } from '../../src/tui/components/NotifView.tsx';
import { defaultActions } from '../../src/tui/actions.ts';
import { MOUSE_OFF, MOUSE_ON, isMouseInput, parseMouse } from '../../src/tui/mouse.ts';
import { notifGeometry, rowAt, scrollTopFor } from '../../src/tui/notif.ts';
import { countUnread, listNotifs, postLocal } from '../../src/notif/index.ts';
import { listProjects } from '../../src/db/queries.ts';
import { KEY, fakeTerminal, seedDb, sleep } from './harness.ts';

type Instance = ReturnType<typeof render>;
const open: Instance[] = [];
let noMouse: string | undefined;
beforeEach(() => {
  noMouse = process.env.SALU_NO_MOUSE;
  process.env.SALU_NO_MOUSE = '1';
});
afterEach(() => {
  while (open.length) {
    try {
      open.pop()!.unmount();
    } catch {
      /* already gone */
    }
  }
  if (noMouse === undefined) delete process.env.SALU_NO_MOUSE;
  else process.env.SALU_NO_MOUSE = noMouse;
});

const at = (x: number, y: number, b = 35, end = 'M') => `\u001b[<${b};${x};${y}${end}`;
const move = (x: number, y: number) => at(x, y, 35);
const click = (x: number, y: number) => at(x, y, 0);

function mountNotifs(db: any, props: Partial<React.ComponentProps<typeof NotifScreen>> = {}, size: [number, number] = [100, 24]) {
  const term = fakeTerminal(...size);
  let closed = 0;
  const inst = render(<NotifScreen db={db} hoverMs={80} pollMs={100} onClose={() => closed++} {...props} />, {
    stdout: term.stdout,
    stdin: term.stdin,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  open.push(inst);
  return { term, inst, closed: () => closed };
}

function seedNotifs(db: any) {
  const [web, api] = [listProjects(db)[0]!, listProjects(db)[1]!];
  postLocal(db, web.id, { type: 'ticket.done', level: 'success', title: '"fix login" is done', body: 'merged into salu/fix-login', ticket: { name: 'fix login', id: 1 }, at: Date.now() - 3000 });
  postLocal(db, api.id, { type: 'ticket.blocked', level: 'warn', title: '"pick db" is blocked', question: 'postgres or sqlite?', ticket: { name: 'pick db', id: 2 }, at: Date.now() - 2000 });
  postLocal(db, web.id, { type: 'ticket.failed', level: 'error', title: '"deploy" failed', body: 'ssh: connection refused', ticket: { name: 'deploy', id: 3 }, at: Date.now() - 1000 });
  const byTitle = (t: string) => listNotifs(db).find((n) => n.title === t)!;
  return { a: byTitle('"fix login" is done'), b: byTitle('"pick db" is blocked'), c: byTitle('"deploy" failed') };
}

describe('notification window', () => {
  test('lists unread newest first with the unread count and the selected message under the list', async () => {
    const { db } = seedDb(2);
    seedNotifs(db);
    const { term } = mountNotifs(db);
    const f = await term.waitFor((s) => s.includes('"deploy" failed'), 'first frame');
    expect(f).toContain('▌salu › all projects › notifications');
    expect(f).toContain('3 unread');
    expect(f.indexOf('"deploy" failed')).toBeLessThan(f.indexOf('"pick db" is blocked'));
    expect(f.indexOf('"pick db" is blocked')).toBeLessThan(f.indexOf('"fix login" is done'));
    expect(f).toContain('ssh: connection refused'); // the cursor is on the newest
    expect(f).toContain('hover mark read');
  });

  test('an empty window says so', async () => {
    const { db } = seedDb(1);
    const { term } = mountNotifs(db);
    const f = await term.waitFor((s) => s.includes('no unread messages'), 'empty state');
    expect(f).toContain('all read');
  });

  test('Enter marks the selected message read and it goes away', async () => {
    const { db } = seedDb(1);
    const { c } = seedNotifs(db);
    const { term } = mountNotifs(db);
    await term.waitFor((s) => s.includes('"deploy" failed'));
    await term.press(KEY.enter);
    const f = await term.waitFor((s) => !s.includes('"deploy" failed'), 'message gone');
    expect(f).toContain('2 unread');
    expect(f).toContain('"pick db" is blocked');
    expect(listNotifs(db, { unread: true }).some((n) => n.id === c.id)).toBe(false);
  });

  test('resting the mouse on a message marks it read; moving away first keeps it', async () => {
    const { db } = seedDb(1);
    const { a, b, c } = seedNotifs(db);
    const { term } = mountNotifs(db);
    await term.waitFor((s) => s.includes('"deploy" failed'));
    // Rows start at terminal row 3: c is row 3, b row 4, a row 5.
    await term.press(move(10, 4), 20);
    await term.press(move(10, 6), 20); // off to an empty row before the dwell is up
    await sleep(150);
    expect(countUnread(db)).toBe(3);
    await term.press(move(10, 4), 20);
    await term.press(move(14, 4), 20); // moving inside the same row does not restart the wait
    await term.waitFor((s) => !s.includes('"pick db" is blocked'), 'hovered message gone');
    expect(countUnread(db)).toBe(2);
    const unread = listNotifs(db, { unread: true }).map((n) => n.id).sort();
    expect(unread).toEqual([a.id, c.id].sort());
    expect(unread).not.toContain(b.id);
  });

  test('after one disappears the next is not marked until the mouse moves onto it', async () => {
    const { db } = seedDb(1);
    seedNotifs(db);
    const { term } = mountNotifs(db);
    await term.waitFor((s) => s.includes('"deploy" failed'));
    await term.press(move(10, 3), 20);
    await term.waitFor((s) => !s.includes('"deploy" failed'), 'first gone');
    await sleep(250); // the pointer has not moved: what slid under it stays unread
    expect(countUnread(db)).toBe(2);
  });

  test('a click marks read at once; the wheel moves the cursor; a read message is not hovered again', async () => {
    const { db } = seedDb(1);
    seedNotifs(db);
    const { term } = mountNotifs(db);
    await term.waitFor((s) => s.includes('"deploy" failed'));
    await term.press(at(0, 0, 65), 30); // wheel down outside anything: moves the cursor by 3, clamped
    await term.press(click(10, 4), 30);
    await term.waitFor((s) => !s.includes('"pick db" is blocked'), 'clicked message gone');
    expect(countUnread(db)).toBe(2);
    await term.press(click(10, 20), 30); // below the list: nothing
    expect(countUnread(db)).toBe(2);
  });

  test('a marks everything read; esc and q close', async () => {
    const { db } = seedDb(1);
    seedNotifs(db);
    const { term, closed } = mountNotifs(db);
    await term.waitFor((s) => s.includes('"deploy" failed'));
    await term.press('a');
    await term.waitFor((s) => s.includes('no unread messages'));
    expect(countUnread(db)).toBe(0);
    await term.press(KEY.esc, 100);
    await term.press('q');
    expect(closed()).toBe(2);
  });

  test('--all style: read messages stay in the list, dimmed, and hovering them changes nothing', async () => {
    const { db } = seedDb(1);
    const { c } = seedNotifs(db);
    const { term } = mountNotifs(db, { showRead: true });
    await term.waitFor((s) => s.includes('"deploy" failed'));
    await term.press(KEY.enter);
    await sleep(150);
    const f = term.lastFrame();
    expect(f).toContain('"deploy" failed');
    expect(listNotifs(db).find((n) => n.id === c.id)!.read_at).not.toBeNull();
  });

  test('a message that arrives while the window is open appears', async () => {
    const { db } = seedDb(1);
    const { term } = mountNotifs(db);
    await term.waitFor((s) => s.includes('no unread messages'));
    postLocal(db, listProjects(db)[0]!.id, { type: 'note', level: 'info', title: 'fresh news' });
    await term.waitFor((s) => s.includes('fresh news'), 'new message');
  });

  test('turns the mouse on for a real terminal and off again when it closes', async () => {
    delete process.env.SALU_NO_MOUSE;
    const { db } = seedDb(1);
    const { term, inst } = mountNotifs(db);
    await sleep(100);
    expect(term.frames).toContain(MOUSE_ON);
    inst.unmount();
    expect(term.frames).toContain(MOUSE_OFF);
  });
});

describe('inside the list screen', () => {
  function mountApp(db: any, size: [number, number] = [100, 24]) {
    const term = fakeTerminal(...size);
    const inst = render(<App db={db} projectId={null} actions={defaultActions(db)} pollMs={100} />, { stdout: term.stdout, stdin: term.stdin, debug: true, patchConsole: false, exitOnCtrlC: false });
    open.push(inst);
    return { term, inst };
  }

  test('the header counts unread messages; n opens the window and esc comes back', async () => {
    const { db } = seedDb(6);
    seedNotifs(db);
    const { term } = mountApp(db);
    let f = await term.waitFor((s) => s.includes('ticket 001'), 'list');
    expect(f).toContain('3 unread (n)');
    await term.press('n');
    f = await term.waitFor((s) => s.includes('notifications') && s.includes('"deploy" failed'), 'notification window');
    await term.press(KEY.enter);
    await term.waitFor((s) => s.includes('2 unread') && !s.includes('"deploy" failed'));
    await term.press(KEY.esc, 100);
    f = await term.waitFor((s) => s.includes('ticket 001'), 'back on the list');
    expect(f).toContain('2 unread (n)');
  });

  test('the command line opens it with `notif`, and a mouse report never reaches the list keys', async () => {
    const { db } = seedDb(6);
    seedNotifs(db);
    const { term } = mountApp(db);
    await term.waitFor((s) => s.includes('ticket 001'));
    await term.press(move(10, 5), 20); // stray report: nothing happens, no filter opens, nothing is typed
    expect(term.lastFrame()).not.toContain('nothing matches');
    await term.press(':');
    await term.press('notif');
    await term.press(KEY.enter, 100);
    await term.waitFor((s) => s.includes('notifications') && s.includes('"deploy" failed'), 'window from the command line');
  });
});

describe('mouse parsing and geometry', () => {
  test('parseMouse reads SGR reports with or without the leading escape', () => {
    expect(parseMouse('\u001b[<35;12;7M')).toEqual({ kind: 'move', x: 12, y: 7, button: 3 });
    expect(parseMouse('[<0;3;4M')).toEqual({ kind: 'press', x: 3, y: 4, button: 0 });
    expect(parseMouse('[<0;3;4m')).toEqual({ kind: 'release', x: 3, y: 4, button: 0 });
    expect(parseMouse('[<64;1;1M')?.kind).toBe('wheelUp');
    expect(parseMouse('[<65;1;1M')?.kind).toBe('wheelDown');
    expect(parseMouse('hello')).toBeNull();
    expect(isMouseInput('[<35;1;1M')).toBe(true);
    expect(isMouseInput('j')).toBe(false);
  });

  test('rowAt maps a terminal position to a message index', () => {
    const geo = notifGeometry(24);
    expect(geo).toEqual({ listRows: 13, detailRows: 5 });
    expect(rowAt(3, 10, geo, 0, 5, 100)).toBe(0);
    expect(rowAt(4, 10, geo, 2, 5, 100)).toBe(3);
    expect(rowAt(8, 10, geo, 0, 5, 100)).toBe(-1); // below the last message
    expect(rowAt(2, 10, geo, 0, 5, 100)).toBe(-1); // on the border
    expect(rowAt(3, 0, geo, 0, 5, 100)).toBe(-1); // left of the frame
    expect(rowAt(3 + 13, 10, geo, 0, 50, 100)).toBe(-1); // past the list area
  });

  test('short terminals drop the detail strip', () => {
    expect(notifGeometry(10).detailRows).toBe(0);
    expect(notifGeometry(10).listRows).toBe(5);
  });

  test('scrollTopFor keeps the cursor in view', () => {
    expect(scrollTopFor(0, 0, 5, 20)).toBe(0);
    expect(scrollTopFor(0, 7, 5, 20)).toBe(3);
    expect(scrollTopFor(10, 2, 5, 20)).toBe(2);
    expect(scrollTopFor(99, 19, 5, 20)).toBe(15);
  });
});
