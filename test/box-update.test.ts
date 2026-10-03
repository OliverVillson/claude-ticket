import { describe, expect, test } from 'bun:test';
import { updateBox } from '../src/boxmac/update.ts';
import type { ControlApi, ControlReply } from '../src/boxmac/control.ts';

const cfg: any = { box: 'salubox' };
const st = (version: string, update?: string, ok = true, doctor: string[] = []): ControlReply => ({ ok, message: `salu ${version}`, data: { version, update, doctor } });

function run(script: Array<ControlReply | 'down'>, version?: string) {
  const sent: Array<{ verb: string; args: object }> = [];
  const out: string[] = [];
  let i = 0;
  const api: ControlApi = {
    call: async (_c, verb, args) => {
      sent.push({ verb, args });
      if (verb === 'update') return { ok: true, message: 'running' };
      const r = script[Math.min(i++, script.length - 1)]!;
      if (r === 'down') throw new Error('no answer');
      return r;
    },
  };
  return { sent, out, go: () => updateBox({ control: () => api, say: (l) => out.push(l), sleep: async () => {}, pollMs: 0, waitMs: 50 }, cfg, version) };
}

describe('salu box update', () => {
  test('waits through the restart, then prints before and after and the check', async () => {
    const t = run([st('1.2.0'), st('1.2.0'), 'down', st('1.3.0', 'update finished')]);
    const r = await t.go();
    expect(r.ok).toBe(true);
    expect(t.sent.map((s) => s.verb)).toEqual(['status', 'update', 'status', 'status', 'status']);
    const text = t.out.join('\n');
    expect(text).toContain('1.2.0 -> 1.3.0');
    expect(text).toContain('✓ update finished');
  });
  test('a refused (unsigned) update is reported and fails', async () => {
    const t = run([st('1.2.0'), st('1.2.0', "update refused: the installer's signature did not verify, so it was not run")]);
    const r = await t.go();
    expect(r.ok).toBe(false);
    expect(t.out.join('\n')).toContain('✗ update refused');
    expect(t.out.join('\n')).toContain('1.2.0 -> 1.2.0');
  });
  test('failing doctor lines are shown and the exit is not ok', async () => {
    const t = run([st('1.2.0'), st('1.3.0', 'update finished', false, ['✓ podman', '✗ gVisor missing'])]);
    expect((await t.go()).ok).toBe(false);
    expect(t.out.join('\n')).toContain('✗ gVisor missing');
  });
  test('passes a version through', async () => {
    const t = run([st('1.2.0'), st('1.2.1', 'update finished')], 'v1.2.1');
    await t.go();
    expect(t.sent.find((s) => s.verb === 'update')!.args).toEqual({ version: 'v1.2.1' });
  });
  test('gives up with a clear line when the box never reports an end', async () => {
    const t = run([st('1.2.0'), 'down']);
    const r = await t.go();
    expect(r.ok).toBe(false);
    expect(t.out.join('\n')).toContain('no final answer');
  });
});
