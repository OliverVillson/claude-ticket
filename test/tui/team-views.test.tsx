import React from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { render } from 'ink';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { App } from '../../src/tui/app.tsx';
import { defaultActions } from '../../src/tui/actions.ts';
import { createProject, createTicket, updateTicket } from '../../src/db/queries.ts';
import { addMember, addSeat, setTicketSeat } from '../../src/team/store.ts';
import { feed } from '../team-views.test.ts';
import { KEY, fakeTerminal, seedDb } from './harness.ts';

const open: Array<ReturnType<typeof render>> = [];
afterEach(() => {
  while (open.length) {
    try {
      open.pop()!.unmount();
    } catch {
      /* gone */
    }
  }
});

describe('team views in the TUI', () => {
  test('list shows who added each ticket and the seat meters; detail shows the seat', async () => {
    const { db, home } = seedDb(0);
    const p = createProject(db, { name: 'shop', path: join(home, 'shop') });
    addMember(db, p.id, 'Alice');
    addMember(db, p.id, 'Bob');
    const a = addSeat(db, p.id, 'alice-team', { owner: 'Alice' });
    const b = addSeat(db, p.id, 'bob-team', { owner: 'Bob' });
    await feed(db, p.id, 'alice-team', 38);
    await feed(db, p.id, 'bob-team', 81);
    const mk = (name: string, by: string, seat: typeof a, status: 'running' | 'todo' | 'done') => {
      const t = createTicket(db, { project_id: p.id, name, query: name, labels: [`by-${by}`] });
      updateTicket(db, t.id, { status });
      setTicketSeat(db, t.id, seat.id);
    };
    mk('fix login redirect', 'alice', a, 'running');
    mk('dark mode toggle', 'bob', b, 'running');
    mk('upload size limit', 'bob', a, 'todo'); // bob borrows alice's seat
    mk('update readme', 'alice', a, 'done');

    const term = fakeTerminal(200, 20);
    open.push(render(<App projectId={null} actions={defaultActions(db)} pollMs={100} db={db} />, { stdout: term.stdout, stdin: term.stdin, debug: true, patchConsole: false, exitOnCtrlC: false }));
    const list = await term.waitFor((f) => f.includes('fix login redirect'), 'list');
    expect(list).toContain('Bob @Alice');
    expect(list).toContain('62% left');
    expect(list).toContain('19% left');

    await term.press(KEY.tab, 100);
    await term.press(KEY.enter, 200);
    const detail = await term.waitFor((f) => f.includes('seat '), 'detail');
    expect(detail).toMatch(/by (alice|Alice)\s+seat alice-team .*62% left/);
    if (process.env.SALU_TEAM_SHOTS) {
      mkdirSync(process.env.SALU_TEAM_SHOTS, { recursive: true });
      writeFileSync(join(process.env.SALU_TEAM_SHOTS, 'tui-list.ansi'), term.frames.find((f) => f.includes('fix login redirect') && f.includes('62% left')) ?? '');
      writeFileSync(join(process.env.SALU_TEAM_SHOTS, 'tui-detail.ansi'), term.frames[term.frames.length - 1]!);
    }
  });
});
