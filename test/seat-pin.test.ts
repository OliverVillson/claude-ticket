import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../src/cli/dispatch.ts';
import { closeDb, openDb } from '../src/db/db.ts';
import { createProject, createTicket, getTicketById } from '../src/db/queries.ts';
import { addMember, addSeat, setTicketSeat } from '../src/team/store.ts';

let root: string;
const realLog = console.log;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-pin-'));
  process.env.SALU_HOME = join(root, 'home');
  closeDb();
  console.log = () => {};
});
afterEach(() => {
  console.log = realLog;
  delete process.env.SALU_USER;
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const db = openDb();
  const p = createProject(db, { name: 'web', path: join(root, 'web') });
  addMember(db, p.id, 'Alice');
  addMember(db, p.id, 'Bob');
  const a = addSeat(db, p.id, 'a-seat', { owner: 'Alice' });
  const b = addSeat(db, p.id, 'b-seat', { owner: 'Bob' });
  const t = createTicket(db, { project_id: p.id, name: 't', query: 'q' });
  return { db, p, a, b, t };
}

describe('pinning a seat checks the sender', () => {
  test('setTicketSeat with a sender: admin any seat, member only their own, shared key none', () => {
    const { db, a, b, t } = setup();
    setTicketSeat(db, t.id, b.id, { sender: { name: 'Alice', role: 'admin' } });
    expect(getTicketById(db, t.id)?.seat_id).toBe(b.id);
    expect(() => setTicketSeat(db, t.id, a.id, { sender: { name: 'Bob', role: 'member' } })).toThrow('only its owner or an admin');
    setTicketSeat(db, t.id, b.id, { sender: { name: 'Bob', role: 'member' } });
    expect(() => setTicketSeat(db, t.id, b.id, { sender: { name: null, role: null } })).toThrow('shared key cannot pin');
    expect(() => setTicketSeat(db, t.id, b.id, { sender: undefined })).toThrow('shared key cannot pin');
  });

  test('the scheduler path (no sender) and clearing a pin are unchanged', () => {
    const { db, a, t } = setup();
    setTicketSeat(db, t.id, a.id);
    expect(getTicketById(db, t.id)?.seat_id).toBe(a.id);
    setTicketSeat(db, t.id, null, { sender: { name: null, role: null } });
    expect(getTicketById(db, t.id)?.seat_id ?? null).toBeNull();
  });

  test('a seat from another project is refused', () => {
    const { db, t } = setup();
    const other = createProject(db, { name: 'other', path: join(root, 'other') });
    addMember(db, other.id, 'Zed');
    const z = addSeat(db, other.id, 'z-seat', { owner: 'Zed' });
    expect(() => setTicketSeat(db, t.id, z.id, { sender: { name: 'Zed', role: 'admin' } })).toThrow('not on the ticket');
  });

  test('salu change --seat: a member pins only their own seat, an outsider at the shell is the admin', async () => {
    const { db, a, b, t } = setup();
    process.env.SALU_USER = 'Bob';
    await expect(dispatch(['change', 't', '--seat', 'a-seat', '--project', 'web'])).rejects.toThrow('not yours');
    expect(await dispatch(['change', 't', '--seat', 'b-seat', '--project', 'web'])).toBe(0);
    expect(getTicketById(db, t.id)?.seat_id).toBe(b.id);
    expect(await dispatch(['change', 't', '--seat', 'none', '--project', 'web'])).toBe(0);
    expect(getTicketById(db, t.id)?.seat_id ?? null).toBeNull();
    process.env.SALU_USER = 'someone-with-a-shell';
    expect(await dispatch(['change', 't', '--seat', 'a-seat', '--project', 'web'])).toBe(0);
    expect(getTicketById(db, t.id)?.seat_id).toBe(a.id);
  });
});
