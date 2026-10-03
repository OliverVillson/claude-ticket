import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { dispatch } from '../src/cli/dispatch.ts';
import { closeDb, openDb } from '../src/db/db.ts';
import { createProject, createTicket, getTicketById } from '../src/db/queries.ts';
import { addMember, addSeat, getMember, listMembers, listSeats, removeMember, setLend, setRole, setSeatDisabled, setTicketSeat, usableSeats, removeSeat } from '../src/team/store.ts';

let root: string;
let logs: string[];
const realLog = console.log;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-team-'));
  process.env.SALU_HOME = join(root, 'home');
  closeDb();
  logs = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
});
afterEach(() => {
  console.log = realLog;
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

const proj = () => createProject(openDb(), { name: 'web', path: join(root, 'web') });

describe('team roster', () => {
  test('the first person owns the project; later ones are members', () => {
    const db = openDb();
    const p = proj();
    expect(addMember(db, p.id, 'Alice').role).toBe('admin');
    expect(addMember(db, p.id, 'Bob').role).toBe('member');
    expect(addMember(db, p.id, 'Cy', 'admin').role).toBe('admin');
    expect(listMembers(db, p.id).map((m) => m.name)).toEqual(['Alice', 'Cy', 'Bob']);
    expect(() => addMember(db, p.id, 'alice')).toThrow('already');
  });

  test('a project always keeps an admin', () => {
    const db = openDb();
    const p = proj();
    addMember(db, p.id, 'Alice');
    addMember(db, p.id, 'Bob');
    expect(() => setRole(db, p.id, 'Alice', 'member')).toThrow('needs an admin');
    expect(() => removeMember(db, p.id, 'Alice')).toThrow('only admin');
    setRole(db, p.id, 'Bob', 'admin');
    setRole(db, p.id, 'Alice', 'member');
    expect(getMember(db, p.id, 'alice')?.role).toBe('member');
  });

  test('removing a member switches their seats off and stops lending', () => {
    const db = openDb();
    const p = proj();
    addMember(db, p.id, 'Alice');
    addMember(db, p.id, 'Bob');
    addSeat(db, p.id, 'bob-team', { owner: 'Bob' });
    setLend(db, p.id, 'bob-team', true, 30);
    removeMember(db, p.id, 'Bob');
    const s = listSeats(db, p.id)[0]!;
    expect(s.disabled).toBe(1);
    expect(s.lend).toBe(0);
    expect(s.owner).toBeNull();
  });
});

describe('seats', () => {
  test('a seat needs a known owner and a unique label', () => {
    const db = openDb();
    const p = proj();
    addMember(db, p.id, 'Alice');
    expect(() => addSeat(db, p.id, 's', { owner: 'Zed' })).toThrow('not on this project');
    addSeat(db, p.id, 'alice-team', { owner: 'Alice', plan: 'enterprise' });
    expect(() => addSeat(db, p.id, 'ALICE-TEAM')).toThrow('already exists');
    expect(() => addSeat(db, p.id, 'x', { plan: 'gold' as never })).toThrow('plan is one of');
  });

  test('lending is off by default, capped when on, and never for a switched-off seat', () => {
    const db = openDb();
    const p = proj();
    addMember(db, p.id, 'Alice');
    addSeat(db, p.id, 'a', { owner: 'Alice' });
    expect(listSeats(db, p.id)[0]!.lend).toBe(0);
    expect(setLend(db, p.id, 'a', true).lend_cap_pct).toBe(50);
    expect(setLend(db, p.id, 'a', true, 20).lend_cap_pct).toBe(20);
    expect(() => setLend(db, p.id, 'a', true, 0)).toThrow('1 to 100');
    expect(setLend(db, p.id, 'a', false).lend_cap_pct).toBeNull();
    setSeatDisabled(db, p.id, 'a', true);
    expect(() => setLend(db, p.id, 'a', true)).toThrow('switched off');
  });

  test('usableSeats: your own, plus teammates that lend, never switched off', () => {
    const db = openDb();
    const p = proj();
    addMember(db, p.id, 'Alice');
    addMember(db, p.id, 'Bob');
    addSeat(db, p.id, 'a', { owner: 'Alice' });
    addSeat(db, p.id, 'b', { owner: 'Bob' });
    expect(usableSeats(db, p.id, 'bob').map((s) => s.label)).toEqual(['b']);
    setLend(db, p.id, 'a', true);
    expect(usableSeats(db, p.id, 'bob').map((s) => s.label)).toEqual(['a', 'b']);
    setSeatDisabled(db, p.id, 'a', true);
    expect(usableSeats(db, p.id, 'bob').map((s) => s.label)).toEqual(['b']);
    expect(usableSeats(db, p.id, null)).toEqual([]);
  });

  test('a ticket remembers its seat, and forgets it when the seat goes', () => {
    const db = openDb();
    const p = proj();
    addMember(db, p.id, 'Alice');
    const s = addSeat(db, p.id, 'a', { owner: 'Alice' });
    const t = createTicket(db, { project_id: p.id, name: 't', query: 'q' });
    expect(getTicketById(db, t.id)?.seat_id ?? null).toBeNull();
    setTicketSeat(db, t.id, s.id);
    expect(getTicketById(db, t.id)?.seat_id).toBe(s.id);
    removeSeat(db, p.id, 'a');
    expect(getTicketById(db, t.id)?.seat_id ?? null).toBeNull();
  });
});

describe('migration', () => {
  test('a v1.2.0 database gains the team tables and keeps its tickets', () => {
    const db = openDb();
    const p = proj();
    createTicket(db, { project_id: p.id, name: 'old', query: 'q' });
    db.exec('DROP TABLE seats; DROP TABLE members; ALTER TABLE tickets DROP COLUMN seat_id;');
    closeDb();
    const again = openDb();
    expect(again.query('SELECT name FROM tickets').all()).toEqual([{ name: 'old' }]);
    expect(listMembers(again, p.id)).toEqual([]);
    expect(again instanceof Database).toBe(true);
  });
});

describe('salu team / salu seat', () => {
  test('the commands work end to end', async () => {
    const db = openDb();
    proj();
    expect(await dispatch(['team', 'add', 'Alice', '--project', 'web'])).toBe(0);
    expect(await dispatch(['team', 'add', 'Bob', '--project', 'web'])).toBe(0);
    expect(await dispatch(['seat', 'add', 'bob-team', '--owner', 'Bob', '--plan', 'team', '--project', 'web'])).toBe(0);
    expect(await dispatch(['seat', 'lend', 'bob-team', 'on', '--cap', '25', '--project', 'web'])).toBe(0);
    logs = [];
    await dispatch(['team', '--project', 'web']);
    expect(logs.join('\n')).toContain('Alice');
    expect(logs.join('\n')).toMatch(/Alice\s+admin/);
    logs = [];
    await dispatch(['seat', '--project', 'web']);
    expect(logs.join('\n')).toContain('yes, up to 25%');
    logs = [];
    await dispatch(['seat', 'list', '--json', '--project', 'web']);
    expect(JSON.parse(logs.join('\n'))[0].owner).toBe('Bob');
    expect(await dispatch(['team', 'rm', 'Bob', '--yes', '--project', 'web'])).toBe(0);
    expect(listMembers(db, 1).map((m) => m.name)).toEqual(['Alice']);
    await expect(dispatch(['team', 'role', 'Alice', 'member', '--project', 'web'])).rejects.toThrow('needs an admin');
  });

  test('--help prints usage', async () => {
    await dispatch(['team', '--help']);
    await dispatch(['seat', '--help']);
    expect(logs.join('\n')).toContain('salu team add');
    expect(logs.join('\n')).toContain('salu seat lend');
  });
});
