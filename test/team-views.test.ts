import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/cli/dispatch.ts';
import { closeDb, openDb } from '../src/db/db.ts';
import { createProject, createTicket } from '../src/db/queries.ts';
import { addMember, addSeat, setTicketSeat } from '../src/team/store.ts';
import { listKeys } from '../src/team/keys.ts';
import { inviteBlock, loadTeam, meterText, ticketWho } from '../src/team/view.ts';
import { parseUsage, seatUsage } from '../src/usage/index.ts';
import { stripAnsi } from '../src/core/ansi.ts';
import { renderPlain } from '../src/tui/plain.ts';
import { loadSnapshot } from '../src/tui/store.ts';
import { seatStrip } from '../src/tui/components/ListView.tsx';

let root: string;
let out: string[];
const realLog = console.log;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-tv-'));
  process.env.SALU_HOME = join(root, 'home');
  closeDb();
  out = [];
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
});
afterEach(() => {
  console.log = realLog;
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

const H = 3_600_000;
export const rawUsage = (five: number) => ({ subscription_type: 'team', rate_limits_available: true, rate_limits: { five_hour: { utilization: five, resets_at: new Date(Date.now() + 2 * H).toISOString() }, seven_day: { utilization: 10, resets_at: new Date(Date.now() + 70 * H).toISOString() } } });
/** Give a seat a cached 5-hour reading, the way `salu usage` does. */
export async function feed(db: ReturnType<typeof openDb>, projectId: number, label: string, five: number) {
  const seat = loadTeam(db, projectId).seats.find((s) => s.label === label)!;
  await seatUsage(db, seat, { fetcher: async () => parseUsage(rawUsage(five)), force: true });
}

async function setup() {
  const db = openDb();
  const p = createProject(db, { name: 'web', path: join(root, 'web') });
  addMember(db, p.id, 'Alice');
  addMember(db, p.id, 'Bob');
  const seat = addSeat(db, p.id, 'alice-team', { owner: 'Alice' });
  await feed(db, p.id, 'alice-team', 38);
  const t = createTicket(db, { project_id: p.id, name: 'fix-login', query: 'x', labels: ['by-bob'] });
  setTicketSeat(db, t.id, seat.id);
  return { db, p, t };
}

describe('team views', () => {
  test('author, seat and meter for a ticket (borrowed seat names its owner)', async () => {
    const { db, p, t } = await setup();
    const w = ticketWho({ ...t, seat_id: loadTeam(db, p.id).seats[0]!.id }, loadTeam(db, p.id));
    expect(w).toMatchObject({ author: 'Bob', seat: 'alice-team', seatOwner: 'Alice' });
    expect(meterText(w.meter!)).toContain('62% left');
    expect(meterText({ percentUsed: null, resetsAt: null })).toBe('n/a');
  });

  test('a project without a team shows nothing extra', async () => {
    const db = openDb();
    const p = createProject(db, { name: 'plain', path: join(root, 'plain') });
    createTicket(db, { project_id: p.id, name: 'a', query: 'x' });
    expect(await dispatch(['list', '--plain'])).toBe(0);
    expect(out.join('\n')).not.toMatch(/\bby\b/);
    expect(Object.keys(loadSnapshot(db).teams)).toEqual([]);
  });

  test('salu list shows by and seat; --json carries who', async () => {
    await setup();
    expect(await dispatch(['list', '--plain'])).toBe(0);
    const text = stripAnsi(out.join('\n'));
    expect(text).toMatch(/by\s+seat/);
    expect(text).toContain('Bob');
    expect(text).toContain('alice-team');
    expect(text).toContain('62% left');
    out.length = 0;
    await dispatch(['list', '--json']);
    expect(JSON.parse(out.join('\n'))[0].who).toMatchObject({ author: 'Bob', seat: 'alice-team' });
  });

  test('salu team and salu seat show the meter', async () => {
    await setup();
    await dispatch(['team']);
    await dispatch(['seat']);
    const text = stripAnsi(out.join('\n'));
    expect(text).toMatch(/Alice\s+admin\s+alice-team\s+.*62% left\s+0/);
    expect(text).toMatch(/Bob\s+member\s+-\s+-\s+1/);
    expect(text).toMatch(/alice-team\s+Alice\s+team\s+.*62% left/);
  });

  test('salu team invite adds the person, prints a join block and mints a personal key only when asked', async () => {
    const { db, p } = await setup();
    db.query('INSERT INTO remotes (project_id, url, role, name) VALUES (?, ?, ?, ?)').run(p.id, 'https://github.com/o/web', 'client', '');
    await dispatch(['team', 'invite', 'Cy']);
    const plain = out.join('\n');
    expect(plain).toContain('export SALU_USER="Cy"');
    expect(plain).toContain('salu remote add "web" https://github.com/o/web --key <your key:');
    expect(listKeys(db, p.id).map((k) => k.member)).toEqual([]);
    expect(loadTeam(db, p.id).members.map((m) => m.name)).toContain('Cy');
    out.length = 0;
    await dispatch(['team', 'invite', 'Cy', '--with-key']);
    expect(listKeys(db, p.id).map((k) => k.member)).toEqual(['Cy']);
    expect(out.join('\n')).toMatch(/--key \S{16,}/);
    expect(inviteBlock({ project: 'p', name: 'n', url: null, key: null })).toContain('<the project git url>');
  });

  test('the TUI list has a by column and the pane title carries the seat meters', async () => {
    const { db } = await setup();
    const snap = loadSnapshot(db);
    const text = stripAnsi(renderPlain(snap, { width: 100 }));
    expect(text).toMatch(/by/);
    expect(text).toContain('Bob');
    expect(stripAnsi(seatStrip(snap.teams, snap.tickets, 60))).toContain('Alice');
    expect(seatStrip(snap.teams, snap.tickets, 60)).toContain('62% left');
  });
});

import { parseMessageFile } from '../src/sync/format.ts';
import { recordRemoteEvent } from '../src/sync/events.ts';
import { setRemote } from '../src/sync/store.ts';

describe('phone wire', () => {
  test('ticket.started carries the seat; the parser keeps it and clamps junk', async () => {
    const { db, p, t } = await setup();
    setRemote(db, { project_id: p.id, url: 'x', role: 'box', name: '' });
    recordRemoteEvent(db, { type: 'dispatch', ticket: { ...t, seat_id: loadTeam(db, p.id).seats[0]!.id }, resumed: false } as any);
    const row = db.query<{ body: string }, []>("SELECT body FROM remote_messages WHERE body LIKE '%ticket.started%'").get()!;
    const m = parseMessageFile(row.body)!;
    expect(m.seat).toEqual({ label: 'alice-team', owner: 'Alice', left: 62 });
    const bad = parseMessageFile(JSON.stringify({ ...JSON.parse(row.body), seat: { label: 'x\u0007y', left: 900 } }))!;
    expect(bad.seat).toEqual({ label: 'xy', left: 100 });
  });
});
