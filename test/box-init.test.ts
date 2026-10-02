import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boxInit, defaultBoxName } from '../src/box/init.ts';

describe('salu box init', () => {
  test('makes the deploy, seal and box keys once; running again changes nothing', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'salu-box-')), 'box');
    const a = boxInit({ name: 'salubox', dir, version: '9.9.9' });
    expect(a.box).toBe('salubox');
    expect(a.deployPub).toMatch(/^ssh-ed25519 \S+/);
    expect(Buffer.from(a.sealPub, 'base64').length).toBe(32);
    expect(Buffer.from(a.boxKey, 'base64').length).toBe(32);
    expect(Buffer.from(readFileSync(join(dir, 'seal.key'), 'utf8').trim(), 'base64').length).toBe(32);
    for (const f of ['deploy', 'seal.key', 'box.key']) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const b = boxInit({ dir, version: '9.9.9' });
    expect(b).toEqual(a);
  });

  test('refuses a name outside [a-z0-9-]{1,32} or a different name for an existing box', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'salu-box-')), 'box');
    expect(() => boxInit({ name: 'Bad_Name', dir, version: '1' })).toThrow('not allowed');
    boxInit({ name: 'one', dir, version: '1' });
    expect(() => boxInit({ name: 'two', dir, version: '1' })).toThrow('already named');
  });

  test('host names become legal box names', () => {
    expect(defaultBoxName('Oliver-HP_OMEN.local')).toBe('oliver-hp-omen-local');
    expect(defaultBoxName('!!!')).toBe('salubox');
    expect(defaultBoxName('x'.repeat(40))).toHaveLength(32);
  });
});

describe('salu box connect arguments', () => {
  test('a lone - is a value (--mac-key -), not a positional', async () => {
    const { parseArgs } = await import('../src/cli/args.ts');
    const p = parseArgs(['box', 'connect', '--url', 'u', '--mac-key', '-']);
    expect(p.flags['mac-key']).toBe('-');
    expect(p.positional).toEqual(['box', 'connect']);
  });
});
