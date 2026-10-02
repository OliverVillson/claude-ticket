import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { API_PLACEHOLDER, apiPathAllowed, kernelAuthMode, placeholderEnv, startApiProxy, upstreamHeaders } from '../src/core/apiproxy.ts';
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
    expect(kernelAuthMode({} as any)).toBe('env');
    expect(kernelAuthMode({ SALU_KERNEL_AUTH: 'socket' } as any)).toBe('socket');
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
      expect((await post('/v1/models')).status).toBe(403);
      const get = await fetch('http://localhost/v1/messages', { unix: sock } as any);
      expect(get.status).toBe(405);
    } finally {
      stop();
      up.close();
    }
  });
});
