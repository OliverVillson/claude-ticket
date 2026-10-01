import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/box-tests.sh against a stand-in `salu`, so the runner's reporting, exit status and --only are tested
// without a box. The real checks (containers, tickets) run on the box.
const script = join(import.meta.dir, '..', 'scripts', 'box-tests.sh');

function run(args: string[], salu: string) {
  const dir = mkdtempSync(join(tmpdir(), 'salu-box-test-'));
  const bin = join(dir, 'salu');
  writeFileSync(bin, salu);
  chmodSync(bin, 0o755);
  const r = Bun.spawnSync(['bash', script, ...args], { env: { ...process.env, SALU: bin, HOME: dir, SALU_BOX_TESTS_REPORT: join(dir, 'report.txt') }, stdout: 'pipe', stderr: 'pipe' });
  rmSync(dir, { recursive: true, force: true });
  return { out: r.stdout.toString(), code: r.exitCode };
}

const NOT_READY = `#!/bin/sh
case "$*" in
  --version) echo "salu 0.0.0" ;;
  "kernel status") echo "✗ tickets will FAIL here until the container kernel is ready"; exit 1 ;;
  "kernel platform") echo "gVisor platform: default (systrap) · kvm is not available here (/dev/kvm)" ;;
  *) exit 0 ;;
esac
`;

describe('box-tests.sh', () => {
  test('--list names every test with its kind', () => {
    const { out, code } = run(['--list'], NOT_READY);
    expect(code).toBe(0);
    expect(out).toContain('4.8  tickets');
    expect(out).toContain('1.2  manual');
  });

  test('--only runs just the named tests and reports a pass', () => {
    const { out, code } = run(['--only', '2.4,4.7'], NOT_READY);
    expect(code).toBe(0);
    expect(out).toMatch(/PASS\s+2\.4/);
    expect(out).toMatch(/PASS\s+4\.7/);
    expect(out).toContain('passed 2, failed 0');
  });

  test('a failing check gives exit status 1 and shows in the summary', () => {
    const { out, code } = run(['--only', '5.1'], NOT_READY);
    expect(code).toBe(1);
    expect(out).toMatch(/FAIL\s+5\.1/);
    expect(out).toContain('failed 1');
  });

  test('ticket tests are not run without --tickets and say so', () => {
    const { out } = run(['--only', '4.8,1.2'], NOT_READY);
    expect(out).toMatch(/SKIP\s+4\.8/);
    expect(out).toContain('needs --tickets');
    expect(out).toMatch(/MANUAL\s+1\.2/);
  });
});
