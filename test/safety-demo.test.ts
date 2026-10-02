import { describe, expect, test } from 'bun:test';
import { attempts, type Ctx } from '../src/core/safety-demo.ts';

const ctx: Ctx = { token: 'sk-ant-oat01-REALTOKEN', canaryText: 'SALU-CANARY-abc', canaryPath: '/tmp/x/host-secret.txt', hostKernel: '6.8.0', hostGone: (p) => p, kernelFolder: '/nonexistent' };
const by = (title: RegExp) => attempts().find((a) => title.test(a.title))!;
const run = (a: ReturnType<typeof by>, out: string) => a.judge({ status: 0, out }, ctx);

describe('safety demo judging', () => {
  test('the environment attempt passes on a placeholder and fails if the real token shows', () => {
    const a = by(/environment$/);
    expect(run(a, 'CLAUDE_CODE_OAUTH_TOKEN=ssh-placeholder\n').ok).toBe(true);
    expect(run(a, `CLAUDE_CODE_OAUTH_TOKEN=${ctx.token}\n`).ok).toBe(false);
    expect(run(a, '').ok).toBe(false); // nothing printed proves nothing
  });
  test('a leaked canary fails the file attempts', () => {
    expect(run(by(/box's disk/), `${ctx.canaryText}\nfound: 1\n`).ok).toBe(false);
    expect(run(by(/box's disk/), 'cat: x: No such file or directory\nfound: 0\n').ok).toBe(true);
  });
  test('the symlink only passes when it lands in the container root', () => {
    expect(run(by(/symlink/), 'cat: nope\nits /etc/hostname: salu-kernel\n').ok).toBe(true);
    expect(run(by(/symlink/), 'its /etc/hostname: salubox\n').ok).toBe(false);
  });
  test('network attempts demand a 403 for every target', () => {
    const a = by(/metadata/);
    expect(run(a, '169.254.169.254 403\n').ok).toBe(true);
    expect(run(a, '169.254.169.254 200\n').ok).toBe(false);
    expect(run(a, '169.254.169.254 000\n').ok).toBe(false); // no answer proves nothing about the filter
  });
  test('the proxy socket refuses every non-model path', () => {
    const a = by(/host proxy/);
    expect(run(a, 'GET:/v1/oauth/token 405\nPOST:/v1/oauth/token 403\nPOST:/v1/organizations 403\n').ok).toBe(true);
    expect(run(a, 'GET:/v1/oauth/token 405\nPOST:/v1/oauth/token 200\nPOST:/v1/organizations 403\n').ok).toBe(false);
  });
  test('a direct connection must fail', () => {
    expect(run(by(/directly/), 'curl exit: 7\n').ok).toBe(true);
    expect(run(by(/directly/), '<html>\ncurl exit: 0\n').ok).toBe(false);
  });
  test('the web control is skipped, not failed, when this machine has no internet', () => {
    const v = run(by(/public web/), 'http_code 403\n');
    expect(v.skip).toBe(true);
  });
  test('every attempt has a group, a command and a judge', () => {
    for (const a of attempts()) {
      expect(a.group && a.title && a.cmd).toBeTruthy();
      expect(typeof a.judge).toBe('function');
    }
  });
});
