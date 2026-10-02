import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green, red } from '../../core/ansi.ts';
import { ticketHome } from '../../core/paths.ts';
import { generateReleaseKey, publicOfSeed, SIG, signSums, SUMS, verifyDir, verifyFile } from '../../release/sign.ts';
import { RELEASE_PUBKEYS } from '../../release/key.ts';
import { confirm, helpIf } from './_shared.ts';

const HELP = `salu release keygen | sign <tag|folder> | verify <folder>

Signed releases: a release carries SHA256SUMS and SHA256SUMS.sig. The public key is built into salu, so a box checks
what it downloads before it runs anything.

  salu release keygen             once: make the signing key (~/.salu/release.key) and print its public half
  salu release sign v1.2.0        download the release, check its files, sign SHA256SUMS, upload SHA256SUMS.sig (needs gh)
        --quick                   sign what SHA256SUMS says without downloading every file first
  salu release sign <folder>      sign the SHA256SUMS in a folder (what the release workflow does)
        the key is read from SALU_RELEASE_KEY, else --key FILE, else ~/.salu/release.key
  salu release verify <file> <file.sig>    check one file against its own signature (install-box.sh)
  salu release verify <folder> [--require a,b] [--json]
                                  check the signature and every file in the folder against the built-in key;
                                  exit 0 only if all is well. Run it with the installed salu, never a downloaded one.`;

const keyFile = (p: Parsed) => flagStr(p, 'key') || join(ticketHome(), 'release.key');

function loadSeed(p: Parsed): string {
  if (process.env.SALU_RELEASE_KEY?.trim()) return process.env.SALU_RELEASE_KEY.trim();
  const f = keyFile(p);
  if (!existsSync(f)) throw new CliError(`no signing key: run salu release keygen once (or set SALU_RELEASE_KEY, or pass --key FILE). Looked for ${f}`);
  return readFileSync(f, 'utf8').trim();
}

function signFolder(dir: string, seed: string): number {
  if (!existsSync(join(dir, SUMS))) throw new CliError(`${join(dir, SUMS)} not found`);
  rmSync(join(dir, SIG), { force: true });
  writeFileSync(join(dir, SIG), signSums(readFileSync(join(dir, SUMS)), seed) + '\n');
  // install-box.sh also gets a signature of its own: the box's update handler checks it before running the script
  if (existsSync(join(dir, 'install-box.sh'))) writeFileSync(join(dir, 'install-box.sh.sig'), signSums(readFileSync(join(dir, 'install-box.sh')), seed) + '\n');
  // check what was just signed: every file here matches, under the key we signed with
  const r = verifyDir(dir, { pubs: [publicOfSeed(seed)] });
  if (!r.ok) {
    rmSync(join(dir, SIG), { force: true });
    rmSync(join(dir, 'install-box.sh.sig'), { force: true });
    throw new CliError(`not signed: ${r.message}`);
  }
  return r.files.length;
}

export async function release(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const [sub = '', target] = p.positional;
  switch (sub) {
    case 'keygen': {
      const out = keyFile(p);
      if (existsSync(out)) throw new CliError(`${out} already exists: it is your signing key. Move it away first if you really want a new one.`);
      const k = generateReleaseKey();
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, k.seed + '\n', { mode: 0o600 });
      chmodSync(out, 0o600);
      console.log(`${green('✓')} signing key saved to ${out} ${dim('(back it up; anyone with it can sign releases)')}`);
      console.log(`\npublic key (goes into src/release/key.ts):\n  ${k.pub}\n`);
      console.log(dim('Sign each release with:   salu release sign <tag>'));
      console.log(dim(`Or let GitHub sign it:    gh secret set SALU_RELEASE_KEY < ${out.replace(homedir(), '~')}`));
      return 0;
    }
    case 'sign': {
      if (!target) throw new CliError('salu release sign <tag|folder>');
      const seed = loadSeed(p);
      if (existsSync(target) && statSync(target).isDirectory()) {
        const n = signFolder(target, seed);
        console.log(`${green('✓')} signed ${SUMS} (${n} file(s) checked) → ${join(target, SIG)}`);
        return 0;
      }
      if (!/^v\d/.test(target)) throw new CliError(`"${target}" is neither a folder nor a release tag like v1.2.0`);
      const repo = process.env.SALU_REPO || 'OliverVillson/salu';
      const dir = mkdtempSync(join(tmpdir(), 'salu-sign-'));
      try {
        const quick = flagBool(p, 'quick');
        const dl = spawnSync('gh', ['release', 'download', target, '--repo', repo, '--dir', dir, ...(quick ? ['--pattern', SUMS, '--pattern', 'install-box.sh'] : [])], { stdio: ['ignore', 'inherit', 'inherit'] });
        if (dl.status !== 0) throw new CliError('could not download the release with gh (is it installed and logged in? gh auth login)');
        rmSync(join(dir, SIG), { force: true });
        rmSync(join(dir, 'install-box.sh.sig'), { force: true });
        const lines = readFileSync(join(dir, SUMS), 'utf8').trim().split('\n');
        console.log(`${target} lists ${lines.length} file(s); you are about to vouch for all of them:`);
        for (const l of lines) console.log(dim(`  ${l.slice(0, 12)}  ${l.slice(66)}`));
        if (quick) console.log(dim('(--quick: the files themselves were not downloaded and checked)'));
        if (!(await confirm(p, 'Sign this release?'))) return 1;
        if (quick) {
          // only the checksum list and the installer were downloaded: check the installer against the list, then sign both
          const want = new Map(lines.map((l) => [l.slice(66).trim(), l.slice(0, 64)]));
          const got = createHash('sha256').update(readFileSync(join(dir, 'install-box.sh'))).digest('hex');
          if (want.get('install-box.sh') !== got) throw new CliError('install-box.sh does not match SHA256SUMS: not signing');
          writeFileSync(join(dir, SIG), signSums(readFileSync(join(dir, SUMS)), seed) + '\n');
          writeFileSync(join(dir, 'install-box.sh.sig'), signSums(readFileSync(join(dir, 'install-box.sh')), seed) + '\n');
        } else signFolder(dir, seed);
        const up = spawnSync('gh', ['release', 'upload', target, join(dir, SIG), join(dir, 'install-box.sh.sig'), '--repo', repo, '--clobber'], { stdio: ['ignore', 'inherit', 'inherit'] });
        if (up.status !== 0) throw new CliError('signed, but the upload failed: run it again');
        console.log(`${green('✓')} ${target} is signed`);
        return 0;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    case 'verify': {
      if (!target) throw new CliError('salu release verify <folder> [--require a,b]  or  salu release verify <file> <file.sig>');
      if (p.positional[2]) {
        const f = verifyFile(target, p.positional[2]);
        console.log(`${f.ok ? green('✓') : red('✗')} ${f.message}`);
        return f.ok ? 0 : 1;
      }
      const need = (flagStr(p, 'require') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const r = verifyDir(target, { require: need });
      if (flagBool(p, 'json')) console.log(JSON.stringify({ ...r, keys: RELEASE_PUBKEYS.length }));
      else console.log(`${r.ok ? green('✓') : red('✗')} ${r.message}`);
      return r.ok ? 0 : 1;
    }
    default:
      throw new CliError(`unknown release command "${sub}"\n\n${HELP}`);
  }
}
