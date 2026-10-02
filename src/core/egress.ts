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
  return process.env.SALU_EGRESS_SOCKET || join(ticketHome(), 'run', 'egress', 'egress.sock');
}

const v4 = (ip: string) => ip.split('.').map(Number);

/** An IPv6 address as 16 bytes (zone ids and any spelling: compressed, expanded, with a dotted tail), or null. */
export function ipv6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  if (isIP(s) !== 6) return null;
  const tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const [a, b, c, d] = v4(tail[2]!) as [number, number, number, number];
    s = `${tail[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    out.push(n >> 8, n & 255);
  }
  return out.length === 16 ? out : null;
}

/**
 * True for every address a container must not reach: not part of the public internet. Every spelling of an
 * address is turned into its bytes first, and any IPv6 form that carries an IPv4 address (mapped, compatible,
 * NAT64, 6to4, ISATAP) is judged by the IPv4 address inside it. Teredo and anything else unusual is refused.
 */
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
    const x = ipv6Bytes(ip);
    if (!x) return true;
    const inner = (o: number) => isBlockedAddress(`${x[o]}.${x[o + 1]}.${x[o + 2]}.${x[o + 3]}`);
    const zeros = (from: number, to: number) => x.slice(from, to).every((v) => v === 0);
    if (zeros(0, 10) && x[10] === 255 && x[11] === 255) return inner(12); // ::ffff:a.b.c.d (any spelling)
    if (zeros(0, 12)) return true; // :: and ::1, and the old IPv4-compatible form ::a.b.c.d
    if (x[0] === 0 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b && zeros(4, 12)) return inner(12); // NAT64 64:ff9b::/96
    if (x[0] === 0x00 && x[1] === 0x64 && x[2] === 0xff && x[3] === 0x9b) return true; // 64:ff9b:1::/48, local-use NAT64
    if (x[0] === 0x20 && x[1] === 0x02) return inner(2); // 6to4
    if (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0 && x[3] === 0) return true; // Teredo
    if ((x[8] === 0 || x[8] === 2) && x[9] === 0 && x[10] === 0x5e && x[11] === 0xfe) return inner(12); // ISATAP, in any prefix
    if ((x[0]! & 0xfe) === 0xfc) return true; // fc00::/7 unique local
    if (x[0] === 0xfe && (x[1]! & 0xc0) >= 0x80) return true; // fe80::/10 link-local and fec0::/10 site-local
    if (x[0] === 0xff) return true; // multicast
    if (x[0] === 0x20 && x[1] === 0x01 && x[2] === 0x0d && x[3] === 0xb8) return true; // documentation
    if (x[0] === 0x01 && zeros(1, 8)) return true; // 100::/64 discard
    return false;
  }
  return true; // not an address at all
}

/** Does a host match an allow-list entry: `a.com` (that name), `*.a.com` (any subdomain of it), or `*` (everything)? */
export function domainAllowed(host: string, list: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return list.some((raw) => {
    const d = raw.toLowerCase();
    if (d === '*') return true;
    if (d.startsWith('*.')) return h.endsWith(d.slice(1)) && h.length > d.length - 1;
    return h === d;
  });
}

const BLOCKED_PORTS = new Set([25, 465, 587]); // outgoing mail, closed even when every port is open

/** Ports agents may reach: web only. This is the rule, not a default; there is no setting to widen it. */
export const WEB_PORTS = [80, 443];

export interface EgressOptions {
  lookup?: (host: string) => Promise<string[]>;
  isBlocked?: (ip: string) => boolean;
  log?: (line: string) => void;
  /** names agents may reach (SALU_SANDBOX_DOMAINS); `['*']` or nothing means any public site */
  allowedDomains?: string[];
  /** tests only: ports to allow instead of the web ports */
  ports?: number[] | 'any';
}

const defaultLookup = async (host: string) => (isIP(host) ? [host] : (await dnsLookup(host, { all: true })).map((a) => a.address));

/** A forward proxy (CONNECT and plain HTTP) that applies isBlockedAddress. Listen on a unix socket or a port. */
export function createEgressServer(o: EgressOptions = {}): Server {
  const lookup = o.lookup ?? defaultLookup;
  const blocked = o.isBlocked ?? isBlockedAddress;
  const log = o.log ?? (() => {});
  const allow = o.allowedDomains ?? ['*'];
  const ports = o.ports ?? WEB_PORTS;

  /** The address to connect to, or a reason it is refused. */
  async function target(host: string, port: number): Promise<{ ip: string } | { refuse: string }> {
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return { refuse: 'bad target' };
    if (BLOCKED_PORTS.has(port)) return { refuse: `port ${port} is closed` };
    if (ports !== 'any' && !ports.includes(port)) return { refuse: `only web ports (${WEB_PORTS.join(', ')}) are open` };
    // a project's allow-list is checked on the name asked for, before anything is resolved; a bare address is not a name
    if (!allow.includes('*') && (isIP(host.replace(/^\[|\]$/g, '')) || !domainAllowed(host, allow))) return { refuse: 'not on this project\'s allowed sites' };
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
