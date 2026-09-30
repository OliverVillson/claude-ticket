#!/usr/bin/env bun
/**
 * Puts a `ticket` command on your PATH.
 *
 *   bun run install-cli                 install (or refresh) the launcher
 *   bun run install-cli --binary        also compile dist/ticket and install that instead
 *   bun run install-cli --dir ~/bin     choose the folder yourself
 *   bun run uninstall-cli               remove it
 *
 * `bun link` is not enough: newer Bun versions only register the package and never put its
 * binary on PATH. The default install is a small launcher script that runs this checkout with
 * the Bun that ran this script, so `git pull` updates it and there is nothing to rebuild.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';

const MARKER = '# claude-ticket launcher';
const repo = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const value = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const home = process.env.HOME || homedir();
const onPath = (process.env.PATH || '').split(delimiter).filter(Boolean).map((p) => resolve(p));

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first folder that is already on PATH and writable; ~/.bun/bin is where `bun` itself lives. */
export function pickDir(): { dir: string; onPath: boolean } {
  const candidates = [
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin') : '',
    join(home, '.bun', 'bin'),
    dirname(process.execPath),
    join(home, '.local', 'bin'),
    join(home, 'bin'),
  ].filter(Boolean);
  for (const c of candidates) {
    const d = resolve(c);
    if (onPath.includes(d) && existsSync(d) && writable(d)) return { dir: d, onPath: true };
  }
  const fallback = resolve(join(home, '.local', 'bin'));
  return { dir: fallback, onPath: onPath.includes(fallback) };
}

/** True when `file` is something this script installed, or a symlink into this checkout. */
function isOurs(file: string): boolean {
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) {
      const dest = resolve(dirname(file), readlinkSync(file));
      return dest.startsWith(repo) || dest.includes(`${'/'}claude-ticket${'/'}`); // also stale `bun link` symlinks
    }
    return st.size < 10_000_000 ? readFileSync(file, 'utf8').includes(MARKER) : false;
  } catch {
    return false;
  }
}

const dirArg = value('dir');
const chosen = dirArg ? { dir: resolve(dirArg.replace(/^~/, home)), onPath: onPath.includes(resolve(dirArg.replace(/^~/, home))) } : pickDir();
const target = join(chosen.dir, 'ticket');

if (flag('uninstall')) {
  if (!existsSync(target) && !lstatSafe(target)) console.log(`nothing to remove at ${target}`);
  else if (isOurs(target) || flag('force')) {
    unlinkSync(target);
    console.log(`removed ${target}`);
  } else {
    console.error(`${target} was not installed by this script; pass --force to remove it`);
    process.exit(1);
  }
  process.exit(0);
}

function lstatSafe(f: string) {
  try {
    return lstatSync(f);
  } catch {
    return null;
  }
}

if (lstatSafe(target) && !isOurs(target) && !flag('force')) {
  console.error(`${target} already exists and was not installed by this script.\nRemove it, or pass --force to replace it.`);
  process.exit(1);
}

mkdirSync(chosen.dir, { recursive: true });
if (lstatSafe(target)) unlinkSync(target);

if (flag('binary')) {
  const out = join(repo, 'dist', 'ticket');
  const build = Bun.spawnSync([process.execPath, 'run', 'build'], { cwd: repo, stdout: 'inherit', stderr: 'inherit' });
  if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
  await Bun.write(target, Bun.file(out));
  chmodSync(target, 0o755);
} else {
  const script = `#!/bin/sh\n${MARKER}\nexec "${process.execPath}" "${join(repo, 'src', 'index.ts')}" "$@"\n`;
  writeFileSync(target, script);
  chmodSync(target, 0o755);
}

console.log(`✓ installed ${target}`);
if (!chosen.onPath) {
  const shell = (process.env.SHELL || '').endsWith('zsh') ? '~/.zshrc' : '~/.bashrc';
  console.log(`\n${chosen.dir} is not on your PATH. Add it, then open a new terminal:\n\n  echo 'export PATH="${chosen.dir}:$PATH"' >> ${shell}\n`);
} else {
  console.log('try it:  ticket "?"');
}
