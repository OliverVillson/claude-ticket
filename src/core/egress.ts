import { createServer, connect, isIP, type Server, type Socket } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ticketHome } from './paths.ts';

/**
 * The egress filter for kernel containers. A container has no network of its own (`--network none`); its
 * HTTP(S) traffic goes through this proxy, over a unix socket mounted into it. The proxy resolves each name
 * itself and refuses private, loopback, link-local and cloud-metadata addresses, so an agent can use the
 * whole internet but cannot reach your home network, this machine, or a cloud provider's metadata service.
 * It connects to the address it checked, so DNS rebinding does not help the agent.
 */

export function egressSocketPath(): string {
  return process.env.SALU_EGRESS_SOCKET || join(ticketHome(), 'run', 'egress.sock');
}

const v4 = (ip: string) => ip.split('.').map(Number);

/** True for every address a container must not reach: not part of the public internet. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b, c] = v4(ip) as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT, also Tailscale
      (a === 169 && b === 254) || // link-local, cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (kind === 6) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]!);
    const hex = s.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1]!, 16), lo = parseInt(hex[2]!, 16);
      return isBlockedAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff') || s.startsWith('2001:db8');
  }
  return true; // not an address at all
}

const BLOCKED_PORTS = new Set([25, 465, 587]); // outgoing mail

export interface EgressOptions {
  lookup?: (host: string) => Promise<string[]>;
  isBlocked?: (ip: string) => boolean;
  log?: (line: string) => void;
}

const defaultLookup = async (host: string) => (isIP(host) ? [host] : (await dnsLookup(host, { all: true })).map((a) => a.address));

/** A forward proxy (CONNECT and plain HTTP) that applies isBlockedAddress. Listen on a unix socket or a port. */
export function createEgressServer(o: EgressOptions = {}): Server {
  const lookup = o.lookup ?? defaultLookup;
  const blocked = o.isBlocked ?? isBlockedAddress;
  const log = o.log ?? (() => {});

  /** The address to connect to, or a reason it is refused. */
  async function target(host: string, port: number): Promise<{ ip: string } | { refuse: string }> {
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { refuse: 'bad target' };
    if (BLOCKED_PORTS.has(port)) return { refuse: `port ${port} is closed` };
    let ips: string[];
    try {
      ips = await lookup(host.replace(/^\[|\]$/g, ''));
    } catch {
      return { refuse: 'name not found' };
    }
    if (!ips.length) return { refuse: 'name not found' };
    if (ips.some(blocked)) return { refuse: 'private or local address' }; // any bad answer refuses the name
    return { ip: ips[0]! };
  }

  return createServer((client: Socket) => {
    client.on('error', () => client.destroy());
    let buf = Buffer.alloc(0);
    const onData = async (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        if (buf.length > 16384) client.destroy();
        return;
      }
      client.off('data', onData);
      client.pause();
      const head = buf.subarray(0, end).toString('latin1');
      const rest = buf.subarray(end + 4);
      const [first, ...headers] = head.split('\r\n');
      const m = first!.match(/^([A-Z]+) (\S+) HTTP\/1\.[01]$/);
      const refuse = (code: number, why: string) => {
        log(`refused ${first}: ${why}`);
        client.end(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      if (!m) return refuse(400, 'Bad Request');
      const [, method, uri] = m;
      let host: string, port: number, forward: Buffer | null = null;
      if (method === 'CONNECT') {
        const hp = uri!.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
        if (!hp) return refuse(400, 'Bad Request');
        host = hp[1]!;
        port = Number(hp[2]);
      } else {
        let u: URL;
        try {
          u = new URL(uri!);
        } catch {
          return refuse(400, 'Bad Request');
        }
        if (u.protocol !== 'http:') return refuse(400, 'Bad Request');
        host = u.hostname;
        port = Number(u.port || 80);
        const hs = headers.filter((h) => !/^(proxy-[^:]*|connection|keep-alive):/i.test(h));
        forward = Buffer.concat([Buffer.from(`${method} ${u.pathname}${u.search} HTTP/1.1\r\n${hs.join('\r\n')}\r\nConnection: close\r\n\r\n`, 'latin1'), rest]);
      }
      const t = await target(host, port);
      if ('refuse' in t) return refuse(403, `Forbidden (${t.refuse})`);
      const upstream = connect({ host: t.ip, port });
      upstream.on('error', () => (client.writable ? refuse(502, 'Bad Gateway') : client.destroy()));
      upstream.on('connect', () => {
        if (method === 'CONNECT') {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (rest.length) upstream.write(rest);
        } else upstream.write(forward!);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
    };
    client.on('data', onData);
  });
}

/** Start the proxy on the egress socket (0600). Returns a stop function. */
export function startEgress(o: EgressOptions & { path?: string } = {}): Promise<() => void> {
  const path = o.path ?? egressSocketPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) unlinkSync(path);
  const server = createEgressServer(o);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      // A rootless container reaches the socket as the same user; nobody else needs to.
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
