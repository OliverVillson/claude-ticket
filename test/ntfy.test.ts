import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clickUrl, loadNtfy, newTopic, ntfyArgs, saveNtfy, publishNtfy } from '../src/sync/ntfy.ts';
import { githubRepo, tokenUrl } from '../src/sync/phone.ts';

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
  test('tapping a notification opens the phone app on the ticket, or its inbox', () => {
    expect(clickUrl({ project: 'e2e-first', ticket: { id: 12, name: 'x', ref: '1790000000000-0a1b2c3d' } })).toBe('salu://ticket/e2e-first/12?ref=1790000000000-0a1b2c3d');
    expect(clickUrl({ project: 'my web', ticket: { id: 3, name: 'x' } })).toBe('salu://ticket/my%20web/3');
    expect(clickUrl({ project: 'p', ticket: { id: 3, name: 'x', ref: 'bad ref\r\nX: 1' } })).toBe('salu://ticket/p/3');
    expect(clickUrl({ project: 'p' })).toBe('salu://inbox?project=p');
    const args = ntfyArgs({ title: '@/etc/passwd', level: 'info', project: 'p', type: 'note', ticket: { id: 1, name: 'n' } }, { topic: 'abcdefgh1234', server: 'https://ntfy.sh' });
    expect(args).toContain('Click: salu://ticket/p/1');
    expect(args[args.indexOf('@/etc/passwd') - 1]).toBe('--data-raw'); // curl must not read a file named in a title
  });
  test('a publish reaches the server with the title and the click link', async () => {
    type Got = { body: string; click: string | null; title: string | null };
    let got = null as Got | null;
    const server = Bun.serve({ port: 0, async fetch(req) { got = { body: await req.text(), click: req.headers.get('click'), title: req.headers.get('title') }; return new Response('{}'); } });
    try {
      const cfg = { topic: 'abcdefgh1234', server: `http://127.0.0.1:${server.port}` };
      // the same curl publishNtfy runs, but async: publishNtfy's spawnSync would block this test's server
      const code = await Bun.spawn(['curl', ...ntfyArgs({ title: 'ticket #4 done', level: 'success', project: 'web', type: 'ticket.done', ticket: { id: 4, name: 'x' } }, cfg)]).exited;
      expect(code).toBe(0);
      got!.title = Buffer.from(got!.title!, 'latin1').toString('utf8'); // header bytes are UTF-8, as ntfy reads them
      expect(got).toEqual({ body: 'ticket #4 done', click: 'salu://ticket/web/4', title: 'salu · web' });
    } finally {
      server.stop(true);
    }
  });
});

describe('salu remote phone', () => {
  test('reads owner/name from any GitHub remote form', () => {
    for (const u of ['https://github.com/OliverVillson/e2e-first.git', 'git@github.com:OliverVillson/e2e-first.git', 'ssh://git@github.com/OliverVillson/e2e-first', 'https://x-access-token@github.com/OliverVillson/e2e-first/']) {
      expect(githubRepo(u)).toEqual({ owner: 'OliverVillson', repo: 'e2e-first' });
    }
    expect(githubRepo('https://gitlab.com/a/b.git')).toBeNull();
    expect(githubRepo('/srv/git/web.git')).toBeNull();
  });
  test('the token link fills in the owner and Contents write', () => {
    const u = new URL(tokenUrl('OliverVillson', 'e2e-first'));
    expect(u.origin + u.pathname).toBe('https://github.com/settings/personal-access-tokens/new');
    expect(u.searchParams.get('target_name')).toBe('OliverVillson');
    expect(u.searchParams.get('contents')).toBe('write');
    expect(u.searchParams.get('expires_in')).toBe('90');
    expect(u.searchParams.get('name')!.length).toBeLessThanOrEqual(40);
  });
});

