import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'install-box.sh');
const run = (...args: string[]) => Bun.spawnSync(['bash', SCRIPT, ...args], { stdout: 'pipe', stderr: 'pipe' });

describe('install-box.sh', () => {
  test('is valid bash', () => {
    expect(Bun.spawnSync(['bash', '-n', SCRIPT]).exitCode).toBe(0);
  });

  test('--check only reports and changes nothing', () => {
    const r = run('--check');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain('salu box: profile');
  });

  test('rejects unknown options and profiles', () => {
    expect(run('--bogus').exitCode).toBe(2);
    expect(run('--check', '--profile', 'moon').exitCode).toBe(2);
  });
});
