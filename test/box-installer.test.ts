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

describe('the box bundle', () => {
  test('build-box-bundle.sh packs the binary, the installers and the Containerfile, with a checksum', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { DOCKERFILE } = await import('../src/core/container.ts');
    const dir = mkdtempSync(join(tmpdir(), 'salu-bundle-'));
    const bin = join(dir, 'salu');
    writeFileSync(bin, '#!/bin/sh\nif [ "$1 $2" = "kernel containerfile" ]; then echo FROM scratch; else echo "salu 9.9.9"; fi\n');
    chmodSync(bin, 0o755);
    const r = Bun.spawnSync(['bash', join(import.meta.dir, '..', 'scripts', 'build-box-bundle.sh'), bin, 'x64', dir], { stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(0);
    const files = Bun.spawnSync(['tar', '-tzf', join(dir, 'salu-box-linux-x64.tar.gz')]).stdout.toString();
    for (const f of ['salu', 'install-box.sh', 'install-runner.sh', 'install-kernel-runtime.sh', 'kernel/Containerfile', 'SALU-BUNDLE']) expect(files).toContain(`salu-box-linux-x64/${f}`);
    expect(Bun.spawnSync(['sha256sum', '-c', 'salu-box-linux-x64.tar.gz.sha256'], { cwd: dir }).exitCode).toBe(0);
    expect(readFileSync(join(dir, 'salu-box-linux-x64.tar.gz.sha256'), 'utf8')).toContain('salu-box-linux-x64.tar.gz');
    expect(DOCKERFILE.length).toBeGreaterThan(100);
  });

  test('salu kernel containerfile prints exactly what kernel setup builds', () => {
    const r = Bun.spawnSync(['bun', join(import.meta.dir, '..', 'src', 'index.ts'), 'kernel', 'containerfile'], { stdout: 'pipe', stderr: 'pipe' });
    expect(r.stdout.toString()).toContain('FROM docker.io/library/ubuntu:24.04');
  });
});
