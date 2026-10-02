import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { egressSocketPath } from './egress.ts';
import { tokenFile } from './container.ts';

/**
 * The login stays on this side. In socket mode (the default) the container's Claude Code gets only a
 * placeholder token and talks to Anthropic through a unix socket mounted into it; this proxy swaps the real
 * kernel token in and forwards the call to api.anthropic.com over TLS. The token is never in the container's
 * environment, files or memory, so an agent (which has root there) has nothing to take or send out.
 * Only the model calls pass: /v1/messages and /v1/messages/count_tokens. Anything else is refused.
 */

export const API_PLACEHOLDER = 'ssh-placeholder';
export const API_SOCKET_IN = '/run/salu/api.sock';
export const API_HOST = 'api.anthropic.com';

export function apiSocketPath(): string {
  return process.env.SALU_API_SOCKET || join(dirname(egressSocketPath()), 'api.sock');
}

export type KernelAuthMode = 'env' | 'socket';
/** How the container logs in. `socket` (default): the token never enters it. `env` (SALU_KERNEL_AUTH=env): the kernel token is in its environment. */
export function kernelAuthMode(env: NodeJS.ProcessEnv = process.env): KernelAuthMode {
  return env.SALU_KERNEL_AUTH === 'env' ? 'env' : 'socket';
}

/** Is this a call the container may make? (path only, no query games: "?" and fragments are cut before matching) */
export function apiPathAllowed(url: string | undefined): boolean {
  const p = (url ?? '').split(/[?#]/)[0]!;
  return p === '/v1/messages' || p === '/v1/messages/count_tokens';
}

/** Request headers for Anthropic: the client's own auth is dropped, the real token goes in. */
export function upstreamHeaders(h: IncomingHttpHeaders, token: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (v === undefined || ['host', 'connection', 'authorization', 'x-api-key', 'proxy-authorization'].includes(key)) continue; // the body is piped unchanged, so its framing headers go with it
    out[key] = Array.isArray(v) ? v.join(', ') : v;
  }
  out.host = API_HOST;
  if (/^sk-ant-api/.test(token)) out['x-api-key'] = token;
  else {
    out.authorization = `Bearer ${token}`;
    const beta = (out['anthropic-beta'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!beta.includes('oauth-2025-04-20')) beta.push('oauth-2025-04-20');
    out['anthropic-beta'] = beta.join(',');
  }
  return out;
}

export interface ApiProxyOptions {
  /** the real token, read on every call so `salu kernel login` takes effect without a restart */
  token?: () => string;
  host?: string;
  port?: number;
  /** tests: speak plain http to this upstream instead of TLS */
  plain?: boolean;
  log?: (l: string) => void;
}

export function createApiProxy(o: ApiProxyOptions = {}): Server {
  const token = o.token ?? (() => (existsSync(tokenFile()) ? readFileSync(tokenFile(), 'utf8').trim() : ''));
  const log = o.log ?? (() => {});
  return createServer(async (req, res) => {
    const deny = (code: number, why: string) => {
      log(`refused ${req.method} ${req.url}: ${why}`);
      res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message: `salu: ${why}` } }));
    };
    if (req.method !== 'POST') return deny(405, 'only POST');
    if (!apiPathAllowed(req.url)) return deny(403, 'only the model calls are allowed through');
    const t = token();
    if (!t) return deny(401, 'no kernel token: run `salu kernel login`');
    const send = o.plain ? (await import('node:http')).request : httpsRequest;
    const up = send({ host: o.host ?? API_HOST, port: o.port ?? 443, method: 'POST', path: req.url, headers: upstreamHeaders(req.headers, t) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => (res.headersSent ? res.destroy() : deny(502, `upstream: ${e.message}`)));
    res.on('close', () => up.destroy());
    req.pipe(up);
  });
}

export function startApiProxy(o: ApiProxyOptions & { path?: string } = {}): Promise<() => void> {
  const path = o.path ?? apiSocketPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) unlinkSync(path);
  const server = createApiProxy(o);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      resolve(() => {
        server.close();
        try {
          unlinkSync(path);
        } catch {
          /* gone already */
        }
      });
    });
  });
}

/** What the container's Claude Code gets instead of the token (socket mode). */
export function placeholderEnv(token: Record<string, string>): Record<string, string> {
  const key = 'ANTHROPIC_API_KEY' in token ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN';
  return { [key]: API_PLACEHOLDER, ANTHROPIC_UNIX_SOCKET: API_SOCKET_IN, ANTHROPIC_BASE_URL: 'http://localhost', CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' };
}
