import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadNtfy, newTopic, saveNtfy, publishNtfy } from '../src/sync/ntfy.ts';

let home: string;
const saved = { ...process.env };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'salu-ntfy-'));
  process.env.SALU_HOME = home;
  delete process.env.SALU_NTFY_TOPIC;
  delete process.env.SALU_NTFY_SERVER;
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(home, { recursive: true, force: true });
});

describe('ntfy', () => {
  test('not set up means no config and no publish', () => {
    expect(loadNtfy()).toBeNull();
    expect(publishNtfy({ title: 'x', level: 'info', project: 'p', type: 'note' })).toBeNull();
  });
  test('save, load, env wins, bad topics rejected', () => {
    const t = newTopic();
    expect(t).toMatch(/^salu-[0-9a-f]{24}$/);
    saveNtfy(t, 'https://ntfy.example.com/');
    expect(loadNtfy()).toEqual({ topic: t, server: 'https://ntfy.example.com' });
    process.env.SALU_NTFY_TOPIC = 'another-topic-1234';
    expect(loadNtfy()?.topic).toBe('another-topic-1234');
    expect(() => saveNtfy('no spaces/allowed')).toThrow();
    process.env.SALU_NTFY_TOPIC = 'bad topic';
    expect(loadNtfy()).toBeNull();
  });
  test('an unreachable server returns an error instead of throwing', () => {
    const err = publishNtfy({ title: 'x', level: 'warn', project: 'p', type: 'note' }, { topic: 'abcdefgh1234', server: 'http://127.0.0.1:1' });
    expect(typeof err).toBe('string');
  });
});
