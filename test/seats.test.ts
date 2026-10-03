import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { startApiProxy, apiSocketPath } from '../src/core/apiproxy.ts';
import { containerName, createArgs, containerSpawner } from '../src/core/container.ts';
import { projectSocketDir } from '../src/core/egress.ts';
import { readSeatToken, removeSeatToken, requireSeatAuth, requireSeatId, saveSeatToken, seatTokenFile, seatsWithLogin, seatKey } from '../src/core/seats.ts';

const env = (dir: string) => ({ SALU_SEATS_DIR: dir }) as NodeJS.ProcessEnv;

describe('seat logins', () => {
  test('ids are safe in paths; tokens are private and per seat', () => {
    const d = mkdtempSync(join(tmpdir(), 'salu-seats-'));
    for (const bad of ['', '../x', 'a/b', 'A', 'a b', '-a', 'x'.repeat(33)]) expect(() => requireSeatId(bad)).toThrow();
    saveSeatToken('ann', 'sk-ant-oat-ann-token', env(d));
    saveSeatToken('bob', 'sk-ant-oat-bob-token', env(d));
    expect(readSeatToken('ann', env(d))).toBe('sk-ant-oat-ann-token');
    expect(readSeatToken('bob', env(d))).toBe('sk-ant-oat-bob-token');
    expect(seatsWithLogin(env(d))).toEqual(['ann', 'bob']);
    expect((Bun.file(seatTokenFile('ann', env(d))) as any).size).toBeGreaterThan(0);
    expect(() => saveSeatToken('ann', 'bad token', env(d))).toThrow(/token/);
    expect(removeSeatToken('bob', env(d))).toBe(true);
    expect(readSeatToken('bob', env(d))).toBe('');
  });
  test('a seat with no login refuses; it never falls back to another seat or the box login', () => {
    const d = mkdtempSync(join(tmpdir(), 'salu-seats-'));
    saveSeatToken('ann', 'sk-ant-oat-ann-token', env(d));
    expect(() => requireSeatAuth('bob', env(d))).toThrow(/seat "bob" has no login/);
    expect(requireSeatAuth('ann', env(d))).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-ann-token' });
    const prev = process.env.SALU_SEATS_DIR;
    process.env.SALU_SEATS_DIR = d;
    try {
      expect(() => containerSpawner('web', '/tmp/x', { seat: 'bob', bin: '/bin/false' })({ env: {}, args: [], signal: new AbortController().signal } as any)).toThrow(/seat "bob"/);
    } finally {
      if (prev === undefined) delete process.env.SALU_SEATS_DIR;
      else process.env.SALU_SEATS_DIR = prev;
    }
  });
  test('each seat has its own container, label and socket folder, outside every project folder', () => {
    const a = containerName('web', 'ann');
    const b = containerName('web', 'bob');
    expect(new Set([containerName('web'), a, b]).size).toBe(3);
    expect(a.startsWith('salu-ks-')).toBe(true);
    expect(containerName('web', 'ann')).toBe(a);
    for (const bad of ['../x', 'a/b', 'A']) {
      expect(() => seatKey('web', bad)).toThrow();
      expect(() => containerName('web', bad)).toThrow();
      expect(() => projectSocketDir('web', bad)).toThrow();
    }
    expect(seatKey('a-b', 'c')).not.toBe(seatKey('a', 'b-c'));
    expect(dirname(projectSocketDir('web', 'ann'))).toBe(dirname(projectSocketDir('web', 'bob')));
    expect(projectSocketDir('web', 'ann')).not.toBe(projectSocketDir('web', 'bob'));
    expect(projectSocketDir('web', 'ann').startsWith(projectSocketDir('web') + '/')).toBe(false);
    expect(projectSocketDir('web').startsWith(projectSocketDir('web', 'ann'))).toBe(false);
    const args = createArgs({ name: a, project: 'web', seat: 'ann', dir: '/k/web' });
    const mounts = args.filter((x) => x.includes(':/run/salu'));
    expect(mounts).toEqual([`${projectSocketDir('web', 'ann')}:/run/salu:rw`]);
    expect(args).toContain('salu.seat=ann');
    expect(args.join(' ')).not.toContain('sk-ant');
  });
  test('two seats, two proxies: each call carries only its own seat token', async () => {
    const d = mkdtempSync(join(tmpdir(), 'salu-seats-'));
    saveSeatToken('ann', 'sk-ant-oat-ann-token', env(d));
    saveSeatToken('bob', 'sk-ant-oat-bob-token', env(d));
    process.env.SALU_SEATS_DIR = d;
    const seen: string[] = [];
    const up = createServer((req, res) => {
      seen.push(String(req.headers.authorization));
      res.end('ok');
    });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
    const port = (up.address() as any).port;
    const root = mkdtempSync(join(tmpdir(), 'salu-sock-'));
    const sa = join(root, 'ann', 'api.sock');
    const sb = join(root, 'bob', 'api.sock');
    const stops = [await startApiProxy({ path: sa, seat: 'ann', host: '127.0.0.1', port, plain: true }), await startApiProxy({ path: sb, seat: 'bob', host: '127.0.0.1', port, plain: true })];
    const call = (sock: string) => fetch('http://localhost/v1/messages', { method: 'POST', body: 'x', headers: { authorization: 'Bearer ssh-placeholder', 'x-api-key': 'sneaky' }, unix: sock } as any);
    try {
      await call(sa);
      await call(sb);
      expect(seen).toEqual(['Bearer sk-ant-oat-ann-token', 'Bearer sk-ant-oat-bob-token']);
      removeSeatToken('bob', env(d)); // revoked while running: the next call is refused, not served by anyone else's login
      const r = await call(sb);
      expect(r.status).toBe(401);
      expect(await r.text()).toContain('seat bob has no login');
      expect(seen.length).toBe(2);
      expect(apiSocketPath('web', 'ann')).toContain('/s/');
    } finally {
      stops.forEach((s) => s());
      up.close();
      delete process.env.SALU_SEATS_DIR;
    }
  });
});
