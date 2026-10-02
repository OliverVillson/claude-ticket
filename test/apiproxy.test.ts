import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { API_PLACEHOLDER, apiPathAllowed, cleanApiPath, apiSocketPath, kernelAuthMode, placeholderEnv, startApiProxy, upstreamHeaders } from '../src/core/apiproxy.ts';
import { containerAuthEnv } from '../src/core/container.ts';

describe('api proxy', () => {
  test('only model calls pass', () => {
    expect(apiPathAllowed('/v1/messages')).toBe(true);
    expect(apiPathAllowed('/v1/messages?beta=true')).toBe(true);
    expect(apiPathAllowed('/v1/messages/count_tokens')).toBe(true);
    expect(apiPathAllowed('/v1/messages/../models')).toBe(false);
    expect(apiPathAllowed('/v1/models')).toBe(false);
    expect(apiPathAllowed('/api/oauth/profile')).toBe(false);
  });
  test('the path that is checked is the path that is sent; each project has its own socket folder', () => {
    expect(cleanApiPath('/v1/messages#/../models')).toBe('/v1/messages');
    expect(cleanApiPath('/v1/messages?beta=true#x')).toBe('/v1/messages?beta=true');
    expect(cleanApiPath('http://evil/v1/messages')).toBeNull();
    expect(dirname(apiSocketPath('web'))).not.toBe(dirname(apiSocketPath('api')));
    expect(apiSocketPath('web')).toContain('/p/');
  });
  test('client auth is replaced by the real token', () => {
    const h = upstreamHeaders({ authorization: 'Bearer ' + API_PLACEHOLDER, 'x-api-key': 'x', 'anthropic-beta': 'a' }, 'sk-ant-oat-real');
    expect(h.authorization).toBe('Bearer sk-ant-oat-real');
    expect(h['x-api-key']).toBeUndefined();
    expect(h['anthropic-beta']).toBe('a,oauth-2025-04-20');
    const k = upstreamHeaders({ authorization: 'Bearer p' }, 'sk-ant-api03-real');
    expect(k['x-api-key']).toBe('sk-ant-api03-real');
    expect(k.authorization).toBeUndefined();
  });
  test('socket mode: the container gets a placeholder, env mode the token', () => {
    const tok = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-real' };
    const s = containerAuthEnv(tok, 'socket');
    expect(JSON.stringify(s)).not.toContain('sk-ant-oat-real');
    expect(s.CLAUDE_CODE_OAUTH_TOKEN).toBe(API_PLACEHOLDER);
    expect(s.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe('0');
    expect(containerAuthEnv(tok, 'env')).toEqual(tok);
    expect(placeholderEnv({ ANTHROPIC_API_KEY: 'k' }).ANTHROPIC_API_KEY).toBe(API_PLACEHOLDER);
    expect(kernelAuthMode({} as any)).toBe('socket');
    expect(kernelAuthMode({ SALU_KERNEL_AUTH: 'env' } as any)).toBe('env');
  });
  test('forwards a model call with the real token, refuses the rest', async () => {
    let seen: Record<string, any> = {};
    const up = createServer((req, res) => {
      seen = req.headers;
      let b = '';
      req.on('data', (d) => (b += d)).on('end', () => res.end('echo:' + b));
    });
    await new Promise<void>((r) => up.listen(0, '127.0.0.1', r));
    const port = (up.address() as any).port;
    const sock = join(mkdtempSync(join(tmpdir(), 'salu-api-')), 'api.sock');
    const stop = await startApiProxy({ path: sock, token: () => 'sk-ant-oat-real', host: '127.0.0.1', port, plain: true });
    try {
      const post = (path: string) => fetch('http://localhost' + path, { method: 'POST', body: 'hi', headers: { authorization: 'Bearer ' + API_PLACEHOLDER }, unix: sock } as any);
      const ok = await post('/v1/messages');
      expect(await ok.text()).toBe('echo:hi');
      expect(seen.authorization).toBe('Bearer sk-ant-oat-real');
      expect(seen['content-length']).toBe('2'); // framing is kept: a strict upstream must see the body
      expect((await post('/v1/models')).status).toBe(403);
      const get = await fetch('http://localhost/v1/messages', { unix: sock } as any);
      expect(get.status).toBe(405);
    } finally {
      stop();
      up.close();
    }
  });
});

describe('runner homes', () => {
  test('containers and the kernel login are per home; the sweep only touches this home', async () => {
    const { containerName, tokenFile, sweepStaleContainers, createArgs } = await import('../src/core/container.ts');
    const keep = { h: process.env.SALU_HOME, t: process.env.SALU_KERNEL_TOKEN_FILE };
    try {
      delete process.env.SALU_HOME;
      delete process.env.SALU_KERNEL_TOKEN_FILE;
      expect(containerName('web')).toBe('salu-k-web');
      process.env.SALU_HOME = '/var/lib/salu/a';
      const a = containerName('web');
      process.env.SALU_HOME = '/var/lib/salu/b';
      expect(containerName('web')).not.toBe(a);
      expect(createArgs({ name: 'n', project: 'web', dir: '/d' }).join(' ')).toContain('salu.home=/var/lib/salu/b');
      process.env.SALU_KERNEL_TOKEN_FILE = '/var/lib/salu/kernel-token';
      expect(tokenFile()).toBe('/var/lib/salu/kernel-token');
      const fake = join(mkdtempSync(join(tmpdir(), 'salu-sw-')), 'podman');
      const { writeFileSync, chmodSync, readFileSync } = await import('node:fs');
      writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${fake}.log\n`);
      chmodSync(fake, 0o755);
      sweepStaleContainers(fake);
      expect(readFileSync(fake + '.log', 'utf8')).toContain('--filter label=salu.home=/var/lib/salu/b');
    } finally {
      for (const [k, v] of [['SALU_HOME', keep.h], ['SALU_KERNEL_TOKEN_FILE', keep.t]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });
});
