import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boxProblems, renderEnvFile, renderSyncUnit, renderUnit, requireRunnerName, validRunnerName } from '../src/core/runner.ts';

const ENTRY = join(import.meta.dir, '..', 'src', 'index.ts');

describe('runner files', () => {
  const unit = renderUnit({ bin: '/usr/local/bin/salu', user: 'salu', home: '/home/salu', root: '/var/lib/salu', etc: '/etc/salu' });

  test('the unit is one orchestrator per project instance, restarts, starts on boot and never queues the backlog', () => {
    expect(unit).toContain('ExecStart=/usr/local/bin/salu run --plain --no-queue %i');
    expect(unit).toContain('Environment=SALU_HOME=/var/lib/salu/%i');
    expect(unit).toContain('EnvironmentFile=-/etc/salu/%i.env');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('WantedBy=multi-user.target');
    expect(unit).toContain('User=salu');
  });

  test('the sync unit runs `remote sync --watch` in the same home and restarts', () => {
    const sync = renderSyncUnit({ bin: '/usr/local/bin/salu', user: 'salu', home: '/home/salu', root: '/var/lib/salu', etc: '/etc/salu' });
    expect(sync).toContain('ExecStart=/usr/local/bin/salu remote sync --watch');
    expect(sync).toContain('Environment=SALU_HOME=/var/lib/salu/%i');
    expect(sync).toContain('GIT_TERMINAL_PROMPT=0');
    expect(sync).toContain('Restart=always');
    expect(sync).toContain('WantedBy=multi-user.target');
  });

  describe('unit hardening', () => {
    const o = { bin: '/usr/local/bin/salu', user: 'salu', home: '/home/salu', root: '/var/lib/salu', etc: '/etc/salu' };
    const sync = renderSyncUnit(o);

    test('both units confine the service to its own project folder and an empty home', () => {
      for (const u of [unit, sync]) {
        for (const d of ['NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=tmpfs', 'TemporaryFileSystem=/var/lib/salu:ro', 'BindPaths=/var/lib/salu/%i', 'ReadWritePaths=/var/lib/salu/%i', 'PrivateTmp=yes', 'CapabilityBoundingSet=\n', 'RestrictSUIDSGID=yes', 'UMask=0077']) expect(u).toContain(d);
      }
    });

    test('least privilege: the orchestrator gets the Claude login but no ssh keys, sync the reverse', () => {
      expect(unit).toContain('/home/salu/.claude');
      expect(unit).not.toContain('.ssh');
      expect(sync).toContain('/home/salu/.ssh');
      expect(sync).not.toContain('.claude');
    });

    test('nothing that breaks bubblewrap or Bun is set', () => {
      for (const u of [unit, sync]) for (const bad of ['RestrictNamespaces', 'SystemCallFilter', 'ProtectKernelTunables', 'ProtectProc', 'ProcSubset', 'PrivateDevices', 'MemoryDenyWriteExecute']) expect(u).not.toContain(bad);
      expect(unit).toContain('AF_NETLINK'); // bubblewrap sets up its network namespace over netlink
    });

    test('--no-harden renders the plain units, and paths with spaces are refused', () => {
      expect(renderUnit({ ...o, harden: false })).not.toContain('ProtectSystem');
      expect(renderSyncUnit({ ...o, harden: false })).not.toContain('NoNewPrivileges');
      expect(() => renderUnit({ ...o, home: '/home/a b' })).toThrow();
    });
  });

  test('project names are safe for systemd and paths', () => {
    for (const ok of ['web', 'my-app_2']) expect(validRunnerName(ok)).toBe(true);
    for (const bad of ['', 'Web', '../x', 'a b', '-x', 'a/b']) expect(validRunnerName(bad)).toBe(false);
    expect(() => requireRunnerName('../etc')).toThrow();
  });

  test('env file: subscription has no key, api-key carries it, unsafe keys are refused', () => {
    const sub = renderEnvFile({ auth: 'subscription', sandbox: true });
    expect(sub).toContain('SALU_AUTH=subscription');
    expect(sub).not.toContain('ANTHROPIC_API_KEY');
    expect(renderEnvFile({ auth: 'api-key', apiKey: 'sk-x', sandbox: false })).toContain('ANTHROPIC_API_KEY=sk-x');
    expect(() => renderEnvFile({ auth: 'api-key', apiKey: 'a b', sandbox: true })).toThrow();
    expect(() => renderEnvFile({ auth: 'api-key', sandbox: true })).toThrow();
  });
});

describe('boxProblems', () => {
  const ok = { linux: true, systemd: true, root: true, claude: true, sandbox: { ok: true }, unitInstalled: true };
  test('a ready box has none', () => expect(boxProblems(ok)).toEqual([]));
  test('each gap is named', () => {
    const p = boxProblems({ ...ok, claude: false, sandbox: { ok: false, problem: 'install bubblewrap' }, unitInstalled: false });
    expect(p.join('\n')).toMatch(/Claude Code/);
    expect(p.join('\n')).toMatch(/bubblewrap/);
    expect(p.join('\n')).toMatch(/salu runner setup/);
  });
});

const HAS_REMOTE = Bun.spawnSync([process.execPath, ENTRY, 'remote', '--help']).exitCode === 0;

describe('salu runner (fake systemctl)', () => {
  function box() {
    const d = mkdtempSync(join(tmpdir(), 'salu-runner-'));
    const calls = join(d, 'calls.log');
    const fake = join(d, 'systemctl');
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${calls}"\n[ "$1" = is-active ] && echo active\nexit 0\n`);
    chmodSync(fake, 0o755);
    const env = {
      ...process.env,
      NO_COLOR: '1',
      SALU_RUNNER_ROOT: join(d, 'var'),
      SALU_RUNNER_ETC: join(d, 'etc'),
      SALU_RUNNER_UNIT_DIR: join(d, 'units'),
      SALU_SYSTEMCTL: fake,
      SALU_RUNNER_USER: process.env.USER || 'root',
      SALU_HOME: join(d, 'caller-home'),
    };
    const run = async (...args: string[]) => {
      const p = Bun.spawn([process.execPath, ENTRY, 'runner', ...args], { stdout: 'pipe', stderr: 'pipe', env });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out, err };
    };
    return { d, env, run, calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8') : '') };
  }

  test('add registers the project in its own home, writes a private env file and enables the service', async () => {
    const b = box();
    const r = await b.run('add', 'web', '--no-sandbox');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(existsSync(join(b.d, 'units', 'salu-runner@.service'))).toBe(true);
    expect(existsSync(join(b.d, 'var', 'web', 'tickets.db'))).toBe(true);
    expect(existsSync(join(b.d, 'caller-home', 'tickets.db'))).toBe(false); // the caller's own salu was not touched
    const env = join(b.d, 'etc', 'web.env');
    expect(statSync(env).mode & 0o777).toBe(0o600);
    expect(readFileSync(env, 'utf8')).toContain('SALU_SANDBOX=off');
    expect(b.calls()).toContain('enable --now salu-runner@web.service');
    // a second project is a separate home and a separate service
    expect((await b.run('add', 'api', '--no-sandbox')).code).toBe(0);
    expect(existsSync(join(b.d, 'var', 'api', 'tickets.db'))).toBe(true);
    expect(b.calls()).toContain('enable --now salu-runner@api.service');
    const l = await b.run('list');
    expect(l.out).toContain('web');
    expect(l.out).toContain('api');
    expect(l.out).toContain('active');
  });

  test('without `salu remote` (older builds) add runs the orchestrator only and says so', async () => {
    if (HAS_REMOTE) return;
    const b = box();
    const r = await b.run('add', 'web', '--no-sandbox');
    expect(r.out).toContain('git sync is not in this salu build');
    expect(b.calls()).not.toContain('salu-sync@');
  });

  test.skipIf(!HAS_REMOTE)('add also registers the box remote and enables, controls and removes the sync service', async () => {
    const b = box();
    const bare = join(b.d, 'web.git');
    Bun.spawnSync(['git', 'init', '-q', '--bare', bare]);
    const r = await b.run('add', 'web', '--no-sandbox', '--remote', bare);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    // a bad explicit --remote is an error, not a silent skip
    const bad = await b.run('add', 'bad', '--no-sandbox', '--remote', join(b.d, 'nope.git'));
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('git sync');
    expect(existsSync(join(b.d, 'var', 'bad'))).toBe(false);
    // no url at all: orchestrator only, and it says why
    const none = await b.run('add', 'nourl', '--no-sandbox');
    expect(none.code).toBe(0);
    expect(none.out).toContain('no git sync');
    expect(existsSync(join(b.d, 'units', 'salu-sync@.service'))).toBe(true);
    expect(readFileSync(join(b.d, 'etc', 'web.env'), 'utf8')).toContain('SALU_RUNNER_SYNC=1');
    expect(b.calls()).toContain('enable --now salu-runner@web.service salu-sync@web.service');
    await b.run('restart', 'web');
    expect(b.calls()).toContain('restart salu-runner@web.service salu-sync@web.service');
    await b.run('remove', 'web', '--yes');
    expect(b.calls()).toContain('disable --now salu-runner@web.service salu-sync@web.service');
    // --no-sync: orchestrator only
    await b.run('add', 'api', '--no-sandbox', '--no-sync');
    expect(b.calls()).toContain('enable --now salu-runner@api.service\n');
  });

  test('add refuses a repeat, bad names, and api-key without a key', async () => {
    const b = box();
    expect((await b.run('add', 'web', '--no-sandbox')).code).toBe(0);
    expect((await b.run('add', 'web', '--no-sandbox')).err).toContain('already exists');
    expect((await b.run('add', '../x', '--no-sandbox')).err).toContain('cannot be a runner project name');
    const r = await b.run('add', 'k', '--no-sandbox', '--auth', 'api-key');
    expect(r.code).toBe(1);
    expect(r.err).toContain('needs the key');
  });

  test('an api key goes only into the root env file, never onto a command line', async () => {
    const b = box();
    const keyFile = join(b.d, 'key');
    writeFileSync(keyFile, 'sk-ant-test123\n');
    expect((await b.run('add', 'web', '--no-sandbox', '--api-key-file', keyFile)).code).toBe(0);
    const env = readFileSync(join(b.d, 'etc', 'web.env'), 'utf8');
    expect(env).toContain('SALU_AUTH=api-key');
    expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-test123');
    expect(b.calls()).not.toContain('sk-ant');
  });

  test('stop, restart and remove --purge drive systemd and delete the data', async () => {
    const b = box();
    await b.run('add', 'web', '--no-sandbox');
    expect((await b.run('restart', 'web')).code).toBe(0);
    expect(b.calls()).toContain('restart salu-runner@web.service');
    expect((await b.run('remove', 'web', '--purge', '--yes')).code).toBe(0);
    expect(b.calls()).toContain('disable --now salu-runner@web.service');
    expect(existsSync(join(b.d, 'var', 'web'))).toBe(false);
    expect(existsSync(join(b.d, 'etc', 'web.env'))).toBe(false);
  });
});

describe('salu run --no-queue', () => {
  test('a restart starts the orchestrator without queueing the backlog', async () => {
    const d = mkdtempSync(join(tmpdir(), 'salu-noqueue-'));
    const env = { ...process.env, SALU_HOME: d, SALU_WORKER: 'fake', SALU_NO_TUI: '1', NO_COLOR: '1' };
    const sh = async (...a: string[]) => {
      const p = Bun.spawn([process.execPath, ENTRY, ...a], { stdout: 'pipe', stderr: 'pipe', env, cwd: d });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { out, err, code: await p.exited };
    };
    await sh('add', 'one', '--project', 'p');
    const p = Bun.spawn([process.execPath, ENTRY, 'run', '--plain', '--no-queue'], { stdout: 'pipe', stderr: 'pipe', env, cwd: d });
    await Bun.sleep(1500);
    p.kill('SIGTERM');
    await p.exited;
    const list = await sh('list', '--plain');
    expect(list.out).toContain('backlog');
    expect(list.out).not.toMatch(/done|running|todo/);
  });
});

describe('crash recovery (what systemd Restart=always relies on)', () => {
  test('SIGKILL mid-ticket, restart: the ticket goes back to the queue, runs again and finishes', async () => {
    const d = mkdtempSync(join(tmpdir(), 'salu-crash-'));
    const env = { ...process.env, SALU_HOME: d, SALU_WORKER: 'fake', SALU_NO_TUI: '1', NO_COLOR: '1' };
    const sh = async (...a: string[]) => {
      const p = Bun.spawn([process.execPath, ENTRY, ...a], { stdout: 'pipe', stderr: 'pipe', env, cwd: d });
      const [out] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      return out;
    };
    await sh('add', 'slow', 'FAKE:sleep 600000 then FAKE:done', '--project', 'p', '--queue');
    const first = Bun.spawn([process.execPath, ENTRY, 'run', '--plain', '--no-queue'], { stdout: 'pipe', stderr: 'pipe', env, cwd: d });
    let out = '';
    for (let i = 0; i < 40 && !/running/.test(out); i++) {
      await Bun.sleep(250);
      out = await sh('list', '--plain');
    }
    expect(out).toMatch(/running/);
    first.kill('SIGKILL'); // a crash: no chance to clean up
    await first.exited;
    await sh('change', 'slow', '--query', 'FAKE:done'); // the retry can finish quickly
    const second = Bun.spawn([process.execPath, ENTRY, 'run', '--plain', '--no-queue'], { stdout: 'pipe', stderr: 'pipe', env, cwd: d });
    for (let i = 0; i < 60 && !/done/.test(out); i++) {
      await Bun.sleep(250);
      out = await sh('list', '--plain');
    }
    second.kill('SIGTERM');
    await second.exited;
    expect(out).toMatch(/done/);
  }, 30_000);
});
