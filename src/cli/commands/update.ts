import { accessSync, chmodSync, constants, existsSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Parsed } from '../args.ts';
import { flagBool } from '../args.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green } from '../../core/ansi.ts';
import { VERSION } from '../dispatch.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu update [version] [--check]

Updates salu to the latest GitHub release: downloads the binary for this platform, verifies its
SHA-256 and swaps it in place (the old binary is kept if anything fails).

  salu update              install the latest release
  salu update v0.2.0       install (or roll back to) a specific version
  salu update --check      only report whether a newer release exists

Installed from source (bun link / install-cli)? Update with \`git pull && bun install\` instead.
Private repo: sign in with \`gh auth login\` (or set GITHUB_TOKEN) and salu downloads through gh.
Environment: SALU_REPO (owner/repo), SALU_RELEASES_URL (override the releases URL prefix).`;

export interface UpdateOptions {
  /** requested version ("v0.2.0" / "0.2.0"), or undefined for the latest */
  version?: string;
  check: boolean;
  execPath: string;
  current: string;
  platform: string;
  arch: string;
  log: (line: string) => void;
}

/** "v1.2.3" / "1.2.3-rc.1" → [1,2,3]; anything unparsable → undefined. */
export function parseVersion(v: string): number[] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [0, 0, 0];
  const y = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

const repo = () => process.env.SALU_REPO || 'OliverVillson/claude-ticket';
const releasesUrl = () => (process.env.SALU_RELEASES_URL || `https://github.com/${repo()}/releases`).replace(/\/$/, '');

/** True when this process is a compiled salu binary (not `bun src/index.ts` or a bun-link launcher). */
export function isCompiledBinary(execPath: string): boolean {
  return !/^bun(-\w+)?(\.exe)?$/i.test(basename(execPath));
}

async function gh(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const p = Bun.spawn(['gh', ...args], { stdout: 'pipe', stderr: 'pipe', env: process.env });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { ok: (await p.exited) === 0, out: out.trim(), err: err.trim() };
  } catch {
    return { ok: false, out: '', err: 'gh is not installed' };
  }
}

/** Latest release tag: follow github.com/<repo>/releases/latest's redirect (no API rate limit), else ask gh. */
async function latestTag(): Promise<{ tag: string; viaGh: boolean }> {
  try {
    const res = await fetch(`${releasesUrl()}/latest`, { redirect: 'manual' });
    const m = /\/tag\/([^/?#]+)/.exec(res.headers.get('location') ?? '');
    if (m) return { tag: decodeURIComponent(m[1]!), viaGh: false };
  } catch {
    /* fall through to gh */
  }
  const r = await gh(['release', 'view', '--repo', repo(), '--json', 'tagName', '-q', '.tagName']);
  if (r.ok && r.out) return { tag: r.out, viaGh: true };
  throw new CliError(
    `could not find a published release of ${repo()}.\n` +
      '  • no release yet? the maintainer needs to push a version tag (git tag v0.1.0 && git push --tags)\n' +
      '  • private repo? run `gh auth login` (or set GITHUB_TOKEN) and try again',
  );
}

async function download(tag: string, asset: string, dest: string, viaGh: boolean): Promise<void> {
  if (!viaGh) {
    const res = await fetch(`${releasesUrl()}/download/${tag}/${asset}`);
    if (res.ok) {
      await Bun.write(dest, res);
      return;
    }
    if (res.status !== 404 || !(process.env.GITHUB_TOKEN || (await gh(['auth', 'status'])).ok)) {
      throw new CliError(`download failed: ${res.status} ${res.statusText} (${asset} in ${tag})`);
    }
  }
  const dir = dirname(dest);
  const r = await gh(['release', 'download', tag, '--repo', repo(), '--pattern', asset, '--dir', dir, '--clobber']);
  if (!r.ok) throw new CliError(`could not download ${asset} from ${tag}: ${r.err || 'gh failed'}`);
  renameSync(join(dir, asset), dest);
}

async function sha256(file: string): Promise<string> {
  const h = new Bun.CryptoHasher('sha256');
  h.update(await Bun.file(file).arrayBuffer());
  return h.digest('hex');
}

export async function performUpdate(o: UpdateOptions): Promise<number> {
  if (!isCompiledBinary(o.execPath)) {
    throw new CliError(
      'this salu is running from source (bun link / install-cli), so it has no binary to replace.\n' +
        'Update it with `git pull && bun install` in the checkout, or install the binary: curl -fsSL https://raw.githubusercontent.com/' +
        `${repo()}/main/scripts/install.sh | bash`,
    );
  }
  const os = o.platform === 'darwin' ? 'darwin' : o.platform === 'linux' ? 'linux' : undefined;
  const arch = o.arch === 'arm64' ? 'arm64' : o.arch === 'x64' ? 'x64' : undefined;
  if (!os || !arch) throw new CliError(`no prebuilt salu for ${o.platform}/${o.arch}`);
  const asset = `salu-${os}-${arch}`;

  let tag: string;
  let viaGh = false;
  if (o.version) {
    if (!parseVersion(o.version)) throw new CliError(`"${o.version}" is not a version like v0.2.0`);
    tag = o.version.startsWith('v') ? o.version : `v${o.version}`;
  } else {
    ({ tag, viaGh } = await latestTag());
  }

  const cmp = compareVersions(tag, o.current);
  if (cmp === 0) {
    o.log(`${green('✓')} salu ${o.current} is already up to date`);
    return 0;
  }
  if (!o.version && cmp < 0) {
    o.log(`${green('✓')} salu ${o.current} is newer than the latest release (${tag})`);
    return 0;
  }
  if (o.check) {
    o.log(`update available: ${o.current} → ${tag}   ${dim('run `salu update` to install it')}`);
    return 0;
  }

  const dir = dirname(o.execPath);
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    throw new CliError(`cannot write to ${dir}. Re-run with permission (sudo salu update) or reinstall into your home folder with the install script.`);
  }

  const tmp = join(dir, `.salu-update-${process.pid}`);
  const cleanup = () => {
    for (const f of [tmp, `${tmp}.sha256`]) if (existsSync(f)) unlinkSync(f);
  };
  try {
    o.log(`downloading ${asset} ${tag}…`);
    await download(tag, asset, tmp, viaGh);
    await download(tag, `${asset}.sha256`, `${tmp}.sha256`, viaGh);
    const want = (await Bun.file(`${tmp}.sha256`).text()).trim().split(/\s+/)[0];
    const got = await sha256(tmp);
    if (!want || want !== got) throw new CliError(`checksum mismatch for ${asset} (expected ${want || 'none'}, got ${got}); nothing was changed`);
    chmodSync(tmp, 0o755);
    const probe = Bun.spawnSync([tmp, '--version'], { stdout: 'pipe', stderr: 'pipe' });
    const said = probe.stdout.toString().trim();
    if (probe.exitCode !== 0 || !said.startsWith('salu ')) throw new CliError('the downloaded binary does not run on this machine; nothing was changed');
    renameSync(tmp, o.execPath); // atomic; the running process keeps its old inode, so this is safe while salu runs
  } catch (e) {
    cleanup();
    throw e;
  }
  cleanup();
  o.log(`${green('✓')} updated salu ${o.current} → ${tag}`);
  o.log(dim('restart salu to use it (a running orchestrator keeps the old version until `salu stop` and `salu run`)'));
  return 0;
}

export async function update(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  if (p.positional.length > 1) throw new CliError(HELP);
  return performUpdate({
    version: p.positional[0],
    check: flagBool(p, 'check'),
    execPath: process.execPath,
    current: VERSION,
    platform: process.platform,
    arch: process.arch,
    log: (l) => console.log(l),
  });
}
