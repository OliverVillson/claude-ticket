import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GVISOR_PLATFORMS, gvisorPlatform, memoryConcurrency, parseMemory, setGvisorPlatform, DOCKERFILE, checkDisk, claudeAuthEnv, requireKernelAuth, containerName, containerReady, containerSpawner, createArgs, engine, execArgs, runtime, saveToken } from '../src/core/container.ts';
import { judgeContainer } from '../src/core/container-check.ts';
import { createEgressServer, domainAllowed, isBlockedAddress, WEB_PORTS } from '../src/core/egress.ts';
import { workerSdkOptions } from '../src/orchestrator/worker.ts';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'salu-ctr-'));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('container arguments', () => {
  test('the container gets only its kernel folder and the egress socket, no network, no extra rights', () => {
    const a = createArgs({ name: 'salu-k-web', project: 'web', dir: '/home/u/.salu/kernel/web', runtime: 'runsc', socket: '/home/u/.salu/run/egress.sock' });
    const joined = a.join(' ');
    expect(a[0]).toBe('create');
    expect(a).toContain('--network');
    expect(a[a.indexOf('--network') + 1]).toBe('none');
    expect(a[a.indexOf('--runtime') + 1]).toBe('runsc');
    expect(a[a.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(joined).toContain('no-new-privileges');
    expect(a.filter((x, i) => a[i - 1] === '-v')).toEqual(['/home/u/.salu/kernel/web:/work:rw', '/home/u/.salu/run/egress.sock:/run/salu/egress.sock:rw']); // the only host mounts
    expect(joined).not.toMatch(/--privileged|--network host|--pid host|--userns host|docker\.sock|--cap-add[^ ]* (ALL|SYS_ADMIN|NET_ADMIN|SYS_PTRACE)/);
    expect(a).toContain('--memory');
    expect(a).toContain('--pids-limit');
    expect(a.at(-1)).toBe('localhost/salu-kernel:1');
    expect(joined).toContain('HTTPS_PROXY=http://127.0.0.1:3128');
  });

  test('no runtime flag without gVisor; exec reads its environment from a file', () => {
    expect(createArgs({ name: 'n', project: 'p', dir: '/d' })).not.toContain('--runtime');
    const e = execArgs('salu-k-web', '/tmp/env', ['claude', '--print']);
    expect(e).toEqual(['exec', '-i', '--workdir', '/work', '--env-file', '/tmp/env', 'salu-k-web', 'claude', '--print']);
    expect(containerName('My Web!')).toBe('salu-k-my-web');
  });

  test('gVisor and Podman are picked up when present', () => {
    expect(runtime({}, (c) => (c === 'runsc' ? '/usr/local/bin/runsc' : null))).toEqual({ name: 'runsc', gvisor: true });
    expect(runtime({}, () => null)).toEqual({ name: null, gvisor: false });
    expect(engine({}, (c) => (c === 'podman' ? '/usr/bin/podman' : null))).toBe('/usr/bin/podman');
    expect(engine({}, () => null)).toBeNull();
  });

  test('the image has the tools and the socket forwarder', () => {
    expect(DOCKERFILE).toContain('claude-code');
    expect(DOCKERFILE).toContain('UNIX-CONNECT:/run/salu/egress.sock');
    expect(DOCKERFILE).toContain('build-essential');
  });

  test('not ready on a Mac or when switched off', () => {
    expect(containerReady({ platform: 'darwin', fresh: true })).toBe(false);
    expect(containerReady({ platform: 'linux', env: { SALU_CONTAINER: 'off' }, fresh: true })).toBe(false);
  });
});

describe('Claude login for the container', () => {
  test('only the saved kernel token is used, never the login this machine runs on', () => {
    const f = join(root, 'tok');
    saveToken('tok-123', f);
    expect(readFileSync(f, 'utf8').trim()).toBe('tok-123');
    expect(claudeAuthEnv({}, f)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-123' });
    // the orchestrator's own token and key in the environment are ignored
    expect(claudeAuthEnv({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'main-login' }, f)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'tok-123' });
    expect(claudeAuthEnv({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 'main-login' }, join(root, 'none'))).toEqual({});
    const k = join(root, 'apikey');
    saveToken('sk-ant-api03-xyz', k);
    expect(claudeAuthEnv({}, k)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api03-xyz' });
  });

  test('no kernel token means no container run, with the way to get one', () => {
    expect(() => requireKernelAuth(join(root, 'none'))).toThrow(/salu kernel login/);
    expect(() => containerSpawner('web', join(root, 'k'), { bin: '/bin/true' })({ command: 'c', args: [], env: {}, signal: new AbortController().signal })).toThrow(/salu kernel login/);
  });
});

describe('running claude in the container', () => {
  test('claude runs through podman exec with a private env file that holds no host secrets and is removed', async () => {
    const log = join(root, 'calls.log');
    const fake = join(root, 'podman');
    writeFileSync(fake, `#!/bin/sh
echo "$@" >> ${log}
case "$1" in
  inspect) echo running; exit 0 ;;
  exec) for a in "$@"; do case "$prev" in --env-file) cp "$a" ${root}/seen-env; ls -l "$a" | cut -c1-10 > ${root}/seen-mode;; esac; prev="$a"; done; cat; exit 0 ;;
esac
exit 0
`);
    chmodSync(fake, 0o755);
    const spawnFn = containerSpawner('web', join(root, 'k'), { bin: fake, auth: { CLAUDE_CODE_OAUTH_TOKEN: 'secret-token' } });
    const p = spawnFn({
      command: '/host/claude',
      args: ['/host/cli.js', '--output-format', 'stream-json'],
      env: { PATH: '/bin', GITHUB_TOKEN: 'ghp', DATABASE_URL: 'x', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', ANTHROPIC_MODEL: 'm', SALU_TICKET_ID: '7', CLAUDE_CODE_OAUTH_TOKEN: 'main-orchestrator-login', ANTHROPIC_API_KEY: 'main-key' },
      signal: new AbortController().signal,
    });
    p.stdin.end('hello\n');
    const out: string[] = [];
    p.stdout.on('data', (d: Buffer) => out.push(d.toString()));
    await new Promise<void>((res) => p.on('exit', () => res()));
    expect(out.join('')).toBe('hello\n');
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('exec -i --workdir /work --env-file');
    expect(calls).toContain('salu-k-web claude --output-format stream-json'); // the host script path was dropped
    expect(calls).not.toContain('secret-token'); // never on a command line
    const env = readFileSync(join(root, 'seen-env'), 'utf8');
    expect(env).toContain('CLAUDE_CODE_OAUTH_TOKEN=secret-token');
    expect(env).toContain('ANTHROPIC_MODEL=m');
    expect(env).not.toMatch(/GITHUB_TOKEN|DATABASE_URL|PATH/);
    expect(env).not.toMatch(/main-orchestrator-login|main-key/); // the box's own login never goes in
    expect(readFileSync(join(root, 'seen-mode'), 'utf8').trim()).toBe('-rw-------');
    await new Promise((r) => setTimeout(r, 2300));
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('salu-env-')).length).toBe(0); // deleted
  });

  test('worker options for a container: prompts off, spawn hook set, no OS sandbox or path hooks', () => {
    const t: any = { id: 1, name: 't', query: 'q', tags: '{}', labels: '[]', priority: 3, status: 'todo', attempts: 0, project: 'web', project_path: '/work', project_id: 1 };
    const o = workerSdkOptions(t, null, { container: { project: 'web', dir: join(root, 'k') } });
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(typeof o.spawnClaudeCodeProcess).toBe('function');
    expect(o.sandbox).toBeUndefined();
    expect(o.hooks).toBeUndefined();
    expect(o.cwd).toBe(join(root, 'k'));
    expect(o.env?.GITHUB_TOKEN).toBeUndefined();
  });
});

describe('egress filter', () => {
  test('private, local, link-local, metadata and mapped addresses are blocked; public ones are not', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.100.100.100', '0.0.0.0', '224.0.0.1', '198.18.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '::ffff:a00:1', '64:ff9b::a00:1', 'not-an-ip'])
      expect([ip, isBlockedAddress(ip)]).toEqual([ip, true]);
    for (const ip of ['8.8.8.8', '1.1.1.1', '140.82.112.3', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700::1111', '::ffff:8.8.8.8'])
      expect([ip, isBlockedAddress(ip)]).toEqual([ip, false]);
  });

  test('every spelling of a private address is blocked: expanded, mapped, 6to4, NAT64, Teredo, ISATAP, zone ids', () => {
    for (const ip of ['0:0:0:0:0:ffff:0a00:0001', '0000:0000:0000:0000:0000:ffff:a9fe:a9fe', '2002:0a00:0001::1', '2002:a9fe:a9fe::1', '2002:c0a8:0101::', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::10.0.0.1', '::a9fe:a9fe', '64:ff9b::a9fe:a9fe', '64:ff9b:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '::5efe:192.168.1.1', '::200:5efe:10.0.0.1', 'fe80::1%eth0', 'fec0::1', 'ff02::1'])
      expect([ip, isBlockedAddress(ip)]).toEqual([ip, true]);
    for (const ip of ['2002:0808:0808::1', '0:0:0:0:0:ffff:0808:0808', '64:ff9b::808:808', '2606:4700::1111'])
      expect([ip, isBlockedAddress(ip)]).toEqual([ip, false]);
  });

  test('a project allow-list is enforced on names, and bare addresses are refused when one is set', async () => {
    expect(domainAllowed('github.com', ['github.com'])).toBe(true);
    expect(domainAllowed('api.github.com', ['github.com'])).toBe(false);
    expect(domainAllowed('registry.npmjs.org', ['*.npmjs.org'])).toBe(true);
    expect(domainAllowed('npmjs.org', ['*.npmjs.org'])).toBe(false);
    expect(domainAllowed('evil-npmjs.org', ['*.npmjs.org'])).toBe(false);
    expect(domainAllowed('anything.example', ['*'])).toBe(true);
    await withProxy({ allowedDomains: ['github.com'], lookup: async () => ['93.184.216.34'], isBlocked: () => false }, async (port) => {
      expect(await ask(port, 'CONNECT evil.example:443 HTTP/1.1\r\n\r\n')).toContain('403');
      expect(await ask(port, 'CONNECT 93.184.216.34:443 HTTP/1.1\r\n\r\n')).toContain('403'); // a bare address is not a name on the list
      expect(await ask(port, 'GET http://evil.example/ HTTP/1.1\r\nHost: evil.example\r\n\r\n')).toContain('403');
    });
  });

  async function withProxy<T>(opts: Parameters<typeof createEgressServer>[0], fn: (port: number) => Promise<T>): Promise<T> {
    const server = createEgressServer(opts);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      return await fn((server.address() as any).port);
    } finally {
      server.close();
    }
  }
  const ask = (port: number, req: string) =>
    new Promise<string>((resolve) => {
      const s = connect({ port, host: '127.0.0.1' }, () => s.write(req));
      let buf = '';
      s.on('data', (d) => (buf += d.toString()));
      s.on('close', () => resolve(buf));
      s.on('error', () => resolve(buf));
      setTimeout(() => s.destroy(), 1500);
    });

  test('refuses private targets, bad ports, and names that resolve to a private address', async () => {
    await withProxy({ lookup: async (h) => (h === 'rebind.example' ? ['93.184.216.34', '192.168.1.5'] : h === 'ok.example' ? ['93.184.216.34'] : [h]) }, async (port) => {
      expect(await ask(port, 'CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n')).toContain('403');
      expect(await ask(port, 'CONNECT 192.168.1.1:443 HTTP/1.1\r\n\r\n')).toContain('403');
      expect(await ask(port, 'CONNECT localhost:22 HTTP/1.1\r\n\r\n')).toContain('403');
      expect(await ask(port, 'CONNECT rebind.example:443 HTTP/1.1\r\n\r\n')).toContain('403'); // one private answer refuses the name
      expect(await ask(port, 'CONNECT ok.example:25 HTTP/1.1\r\n\r\n')).toContain('403'); // mail port
      expect(await ask(port, 'GET http://10.0.0.1/ HTTP/1.1\r\nHost: 10.0.0.1\r\n\r\n')).toContain('403');
      expect(await ask(port, 'garbage\r\n\r\n')).toContain('400');
    });
  });

  test('passes allowed traffic through, for CONNECT tunnels and plain HTTP', async () => {
    const echo = createServer((c) => c.on('data', (d) => (d.toString().startsWith('GET ') ? c.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi') : c.write(d))));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    const eport = (echo.address() as any).port;
    try {
      await withProxy({ lookup: async () => ['127.0.0.1'], isBlocked: () => false, ports: 'any' }, async (port) => {
        const tunnel = await new Promise<string>((resolve) => {
          const s = connect({ port, host: '127.0.0.1' }, () => s.write(`CONNECT test.example:${eport} HTTP/1.1\r\n\r\n`));
          let buf = '';
          let sent = false;
          s.on('data', (d) => {
            buf += d.toString();
            if (!sent && buf.includes('200 Connection Established')) {
              sent = true;
              s.write('ping');
            }
            if (buf.endsWith('ping')) s.end();
          });
          s.on('close', () => resolve(buf));
          setTimeout(() => s.destroy(), 1500);
        });
        expect(tunnel).toContain('200 Connection Established');
        expect(tunnel.endsWith('ping')).toBe(true);
        const plain = await ask(port, `GET http://test.example:${eport}/x?y=1 HTTP/1.1\r\nHost: test.example\r\nProxy-Connection: keep-alive\r\n\r\n`);
        expect(plain).toContain('200 OK');
        expect(plain.endsWith('hi')).toBe(true);
      });
    } finally {
      echo.close();
    }
  });
  test('only web ports are open, with no setting to widen it; mail stays closed even when a test opens every port', async () => {
    expect(WEB_PORTS).toEqual([80, 443]);
    await withProxy({ lookup: async () => ['93.184.216.34'] }, async (port) => {
      expect(await ask(port, 'CONNECT ok.example:22 HTTP/1.1\r\n\r\n')).toContain('only web ports');
      expect(await ask(port, 'CONNECT ok.example:8080 HTTP/1.1\r\n\r\n')).toContain('only web ports');
      expect(await ask(port, 'CONNECT 93.184.216.34:3306 HTTP/1.1\r\n\r\n')).toContain('403');
      expect(await ask(port, 'GET http://ok.example:3000/ HTTP/1.1\r\nHost: ok.example\r\n\r\n')).toContain('403');
    });
    process.env.SALU_EGRESS_PORTS = 'any'; // the old setting is gone: it changes nothing
    try {
      await withProxy({ lookup: async () => ['93.184.216.34'] }, async (port) => {
        expect(await ask(port, 'CONNECT ok.example:22 HTTP/1.1\r\n\r\n')).toContain('only web ports');
      });
    } finally {
      delete process.env.SALU_EGRESS_PORTS;
    }
    await withProxy({ lookup: async () => ['93.184.216.34'], ports: 'any' }, async (port) => {
      expect(await ask(port, 'CONNECT ok.example:25 HTTP/1.1\r\n\r\n')).toContain('is closed');
    });
  });
});

describe('disk, limits and the container proof', () => {
  test('containers get file and shm limits and a size limit when asked', () => {
    const a = createArgs({ name: 'n', project: 'p', dir: '/d', disk: '20g' });
    expect(a).toContain('nofile=4096:8192');
    expect(a).toContain('256m');
    expect(a.join(' ')).toContain('--storage-opt size=20g');
    expect(createArgs({ name: 'n', project: 'p', dir: '/d', disk: null }).join(' ')).not.toContain('--storage-opt');
  });

  test('a ticket is refused when the project is over its disk limit or the box is nearly full', () => {
    expect(() => checkDisk('/x', { limitGb: 10, used: () => 11e9, free: () => 100e9 })).toThrow(/over the 10 GB limit/);
    expect(() => checkDisk('/x', { limitGb: 10, used: () => 1e9, free: () => 2e9 })).toThrow(/free/);
    expect(() => checkDisk('/x', { limitGb: 10, used: () => 1e9, free: () => 100e9 })).not.toThrow();
  });

  test('the container proof fails on a leaked address, a network, a host login or an extra mount', () => {
    const good = { egress: { '169.254.169.254': 403, '[::1]': 403 }, ports: { '1.1.1.1:22': 403, '1.1.1.1:25': 403 }, directExit: 7, envText: 'PATH=/usr/bin\nHTTP_PROXY=x', hostSecrets: ['main-login-token'], mountPoints: ['/', '/proc', '/work', '/run/salu/egress.sock', '/dev/pts'] };
    expect(judgeContainer(good).every((p) => p.ok)).toBe(true);
    expect(judgeContainer({ ...good, egress: { ...good.egress, '[2002:a9fe:a9fe::1]': 200 } }).filter((p) => !p.ok).map((p) => p.name)).toEqual(['container: the egress filter refuses private, loopback and cloud-metadata addresses']);
    expect(judgeContainer({ ...good, ports: { ...good.ports, '1.1.1.1:3306': 502 } }).filter((p) => !p.ok).map((p) => p.name)).toEqual(['container: only web ports (80, 443) are open']);
    expect(judgeContainer({ ...good, ports: {} }).filter((p) => !p.ok).length).toBe(1); // no port probe at all is a failure
    expect(judgeContainer({ ...good, directExit: 0 }).filter((p) => !p.ok).length).toBe(1);
    expect(judgeContainer({ ...good, envText: 'CLAUDE_CODE_OAUTH_TOKEN=main-login-token' }).filter((p) => !p.ok).length).toBe(1);
    expect(judgeContainer({ ...good, mountPoints: [...good.mountPoints, '/host/home'] }).filter((p) => !p.ok).length).toBe(1);
  });

});

describe('concurrency and gVisor platform', () => {
  const GiB = 1024 ** 3;
  test('the default number of tickets follows memory: (RAM - 3 GiB) / container limit, 1 to 8', () => {
    expect(memoryConcurrency(16 * GiB, {})).toBe(3);
    expect(memoryConcurrency(15.5 * GiB, {})).toBe(3); // a "16 GB" laptop reports a bit less
    expect(memoryConcurrency(8 * GiB, {})).toBe(1);
    expect(memoryConcurrency(4 * GiB, {})).toBe(1); // never below one
    expect(memoryConcurrency(128 * GiB, {})).toBe(8); // capped
    expect(memoryConcurrency(16 * GiB, { SALU_KERNEL_MEMORY: '2g' })).toBe(6);
    expect(memoryConcurrency(16 * GiB, { SALU_KERNEL_MEMORY: '1024m' })).toBe(8);
    expect(memoryConcurrency(16 * GiB, { SALU_KERNEL_MEMORY: 'junk' })).toBe(3);
    expect(parseMemory('4g')).toBe(4 * GiB);
    expect(parseMemory('512m')).toBe(512 * 1024 ** 2);
    expect(parseMemory('nope')).toBeNull();
  });

  test('the gVisor platform comes from the environment, then the file; bad values are ignored; default is unset', () => {
    const f = join(root, 'cfg', 'gvisor-platform');
    expect(gvisorPlatform({}, f)).toBeNull();
    setGvisorPlatform('kvm', f);
    expect(gvisorPlatform({}, f)).toBe('kvm');
    expect(gvisorPlatform({ SALU_GVISOR_PLATFORM: 'ptrace' }, f)).toBe('ptrace');
    expect(gvisorPlatform({ SALU_GVISOR_PLATFORM: 'kvm; rm -rf /' }, join(root, 'none'))).toBeNull();
    setGvisorPlatform(null, f);
    expect(gvisorPlatform({}, f)).toBeNull();
    expect(GVISOR_PLATFORMS).toEqual(['systrap', 'kvm', 'ptrace']);
  });
});

