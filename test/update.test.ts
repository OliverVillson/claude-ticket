import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../src/core/errors.ts';
import { compareVersions, isCompiledBinary, performUpdate, type UpdateOptions } from '../src/cli/commands/update.ts';

const script = (v: string) => `#!/bin/sh\necho "salu ${v}"\n`;
const sha = (s: string) => new Bun.CryptoHasher('sha256').update(s).digest('hex');
const ASSET = `salu-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

let server: ReturnType<typeof Bun.serve>;
let latest = 'v1.0.0';
let hasRelease = true;
let corrupt = false;
let dir: string;
let target: string;
const lines: string[] = [];
const saved = { url: process.env.SALU_RELEASES_URL, path: process.env.PATH };

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === '/releases/latest') {
        return hasRelease ? new Response(null, { status: 302, headers: { location: `/releases/tag/${latest}` } }) : new Response('nope', { status: 404 });
      }
      const m = /^\/releases\/download\/(v[^/]+)\/(.+)$/.exec(path);
      if (!m) return new Response('not found', { status: 404 });
      const body = script(m[1]!.slice(1));
      if (m[2] === ASSET) return new Response(corrupt ? script('0.0.0-evil') : body);
      if (m[2] === `${ASSET}.sha256`) return new Response(`${sha(body)}  ${ASSET}\n`);
      return new Response('not found', { status: 404 });
    },
  });
  process.env.SALU_RELEASES_URL = `http://localhost:${server.port}/releases`;
});
afterAll(() => {
  server.stop(true);
  if (saved.url === undefined) delete process.env.SALU_RELEASES_URL;
  else process.env.SALU_RELEASES_URL = saved.url;
  process.env.PATH = saved.path;
});
beforeEach(() => {
  latest = 'v1.0.0';
  hasRelease = true;
  corrupt = false;
  lines.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'salu-update-'));
  target = join(dir, 'salu');
  writeFileSync(target, script('0.1.0'));
  chmodSync(target, 0o755);
});

const opts = (o: Partial<UpdateOptions> = {}): UpdateOptions => ({
  check: false,
  execPath: target,
  current: '0.1.0',
  platform: process.platform,
  arch: process.arch,
  log: (l) => lines.push(l),
  ...o,
});
const run = () => Bun.spawnSync([target, '--version']).stdout.toString().trim();

describe('versions', () => {
  test('compares numerically, not as strings', () => {
    expect(compareVersions('v0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBeLessThan(0);
  });
  test('tells a compiled binary from bun running source', () => {
    expect(isCompiledBinary('/home/me/.local/bin/salu')).toBe(true);
    expect(isCompiledBinary('/home/me/.bun/bin/bun')).toBe(false);
  });
});

describe('salu update', () => {
  test('installs the latest release in place and leaves no temp files', async () => {
    expect(await performUpdate(opts())).toBe(0);
    expect(run()).toBe('salu 1.0.0');
    expect(readdirSync(dir)).toEqual(['salu']);
    expect(lines.join('\n')).toContain('0.1.0 → v1.0.0');
  });

  test('says so when already up to date and changes nothing', async () => {
    await performUpdate(opts({ current: '1.0.0' }));
    expect(lines.join('\n')).toContain('already up to date');
    expect(run()).toBe('salu 0.1.0');
  });

  test('--check only reports', async () => {
    await performUpdate(opts({ check: true }));
    expect(lines.join('\n')).toContain('update available: 0.1.0 → v1.0.0');
    expect(run()).toBe('salu 0.1.0');
  });

  test('a pinned version can roll back', async () => {
    await performUpdate(opts({ current: '2.0.0', version: '1.5.0' }));
    expect(run()).toBe('salu 1.5.0');
  });

  test('a checksum mismatch keeps the old binary and cleans up', async () => {
    corrupt = true;
    await expect(performUpdate(opts())).rejects.toThrow(/checksum mismatch/);
    expect(run()).toBe('salu 0.1.0');
    expect(readdirSync(dir)).toEqual(['salu']);
  });

  test('a pinned version must look like a version', async () => {
    await expect(performUpdate(opts({ version: 'banana' }))).rejects.toThrow(/not a version/);
    expect(run()).toBe('salu 0.1.0');
  });

  test('running from source gives the source-install hint', async () => {
    await expect(performUpdate(opts({ execPath: '/home/me/.bun/bin/bun' }))).rejects.toThrow(/git pull/);
  });

  test('no published release is a friendly error', async () => {
    hasRelease = false;
    process.env.PATH = dir; // no gh here
    const err = await performUpdate(opts()).catch((e) => e);
    process.env.PATH = saved.path;
    expect(err).toBeInstanceOf(CliError);
    expect(err.message).toContain('could not find a published release');
  });

  test('falls back to gh for a private repo', async () => {
    hasRelease = false; // anonymous lookup fails
    const bin = join(dir, 'fakebin');
    mkdirSync(bin);
    const asset = script('2.0.0');
    writeFileSync(join(bin, 'asset'), asset);
    writeFileSync(join(bin, 'asset.sha256'), `${sha(asset)}  ${ASSET}\n`);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "release view") echo v2.0.0 ;;
  "release download")
    while [ $# -gt 0 ]; do case "$1" in --dir) d="$2";; --pattern) p="$2";; esac; shift; done
    case "$p" in *.sha256) cp "${bin}/asset.sha256" "$d/$p" ;; *) cp "${bin}/asset" "$d/$p" ;; esac ;;
  *) exit 1 ;;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);
    process.env.PATH = `${bin}:${saved.path}`;
    try {
      await performUpdate(opts());
    } finally {
      process.env.PATH = saved.path;
    }
    expect(run()).toBe('salu 2.0.0');
  });
});
