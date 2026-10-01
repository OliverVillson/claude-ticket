import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CREDENTIAL_ENV, createArgs, engine, imageExists, runtime, WORKDIR } from './container.ts';
import { startEgress } from './egress.ts';
import type { Probe } from './sandbox-check.ts';

/**
 * The container half of `salu doctor --sandbox`: no model involved. It starts a throwaway container the same way
 * a ticket's is started and attacks the boundary from inside it: the private, loopback and cloud-metadata
 * addresses (in the spellings that fooled the filter before), the network that should not exist, the login this
 * machine runs on, and the list of what the host mounted in.
 */

/** Addresses the egress filter must refuse, through the proxy. */
export const EGRESS_TARGETS = [
  '169.254.169.254', // cloud metadata
  '192.168.1.1', '10.0.0.1', '172.16.0.1', '127.0.0.1', // home network and this machine
  '[::ffff:a9fe:a9fe]', '[0:0:0:0:0:ffff:a9fe:a9fe]', '[2002:a9fe:a9fe::1]', '[::ffff:10.0.0.1]', '[::1]', // other spellings
];

/** Public addresses on ports that are not web ports (ssh, mail, databases, alternates): the filter must refuse each. */
export const NON_WEB_TARGETS = ['1.1.1.1:22', '1.1.1.1:25', '1.1.1.1:3306', '1.1.1.1:5432', '1.1.1.1:8080', '1.1.1.1:6379', '1.1.1.1:53'];

/** Mount points a kernel container may have; the host contributes only /work and the egress socket directory. */
const MOUNT_OK = /^(\/|\/proc(\/.*)?|\/sys(\/.*)?|\/dev(\/.*)?|\/etc\/(hosts|hostname|resolv\.conf)|\/run\/\.containerenv|\/run\/secrets|\/run\/salu\/egress\.sock|\/work)$/;

export interface ContainerFacts {
  /** HTTP status the proxy gave for each target (0 = no answer) */
  egress: Record<string, number>;
  /** HTTP status the proxy gave for a public address on each non-web port (0 = no answer) */
  ports: Record<string, number>;
  /** exit status of a request made around the proxy: must fail, the container has no network */
  directExit: number;
  /** everything the container can see of its environment */
  envText: string;
  hostSecrets: string[];
  mountPoints: string[];
}

/** Decide the probes from the facts. Pure, so it is tested without Podman. */
export function judgeContainer(f: ContainerFacts): Probe[] {
  const open = Object.entries(f.egress).filter(([, code]) => code !== 403);
  const portsOpen = Object.entries(f.ports).filter(([, code]) => code !== 403);
  const leaked = f.hostSecrets.filter((v) => v && f.envText.includes(v));
  const extra = f.mountPoints.filter((m) => !MOUNT_OK.test(m));
  return [
    { name: 'container: the egress filter refuses private, loopback and cloud-metadata addresses', ok: open.length === 0, detail: open.length ? `not refused: ${open.map(([t, c]) => `${t} (${c || 'no answer'})`).join(', ')}` : `${Object.keys(f.egress).length} spellings all refused` },
    { name: 'container: only web ports (80, 443) are open', ok: portsOpen.length === 0 && Object.keys(f.ports).length > 0, detail: portsOpen.length ? `not refused: ${portsOpen.map(([t, code]) => `${t} (${code || 'no answer'})`).join(', ')}` : `${Object.keys(f.ports).length} non-web ports all refused` },
    { name: 'container: no network of its own', ok: f.directExit !== 0, detail: f.directExit !== 0 ? 'a request that skips the filter cannot connect' : 'the container reached the internet around the filter' },
    { name: 'container: the login this machine runs on is not inside', ok: leaked.length === 0, detail: leaked.length ? 'a credential from this machine is in the container environment' : 'no host credential in the container environment' },
    { name: 'container: only the kernel folder and the egress socket are mounted from the host', ok: extra.length === 0, detail: extra.length ? `unexpected mounts: ${extra.join(', ')}` : 'nothing else from this machine is visible' },
  ];
}

const sh = (bin: string, args: string[]) => spawnSync(bin, args, { encoding: 'utf8', timeout: 60000 });

export async function runContainerCheck(o: { bin?: string | null } = {}): Promise<Probe[]> {
  const bin = o.bin ?? engine();
  if (!bin || !imageExists(bin)) return [{ name: 'container kernel proof', ok: false, detail: 'the container kernel is not set up here: run `salu kernel setup`' }];
  const tmp = mkdtempSync(join(tmpdir(), 'salu-container-check-'));
  const work = join(tmp, 'work');
  const sockDir = join(tmp, 'run');
  mkdirSync(work);
  mkdirSync(sockDir);
  const socket = join(sockDir, 'egress.sock');
  const name = `salu-k-doctor-${process.pid}`;
  let stop: (() => void) | null = null;
  try {
    stop = await startEgress({ path: socket });
    const c = sh(bin, createArgs({ name, project: 'doctor', dir: work, runtime: runtime().name, socket, disk: null }));
    if (c.status !== 0) return [{ name: 'container kernel proof', ok: false, detail: `could not create the test container: ${(c.stderr || c.stdout).trim().split('\n').pop()}` }];
    const s = sh(bin, ['start', name]);
    if (s.status !== 0) return [{ name: 'container kernel proof', ok: false, detail: `could not start the test container: ${(s.stderr || s.stdout).trim().split('\n').pop()}` }];
    await new Promise((r) => setTimeout(r, 1500)); // the proxy forwarder inside starts with the container
    const inside = (cmd: string[]) => sh(bin, ['exec', '--workdir', WORKDIR, name, ...cmd]);
    const egress: Record<string, number> = {};
    for (const t of EGRESS_TARGETS) egress[t] = Number(inside(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', `http://${t}/`]).stdout.trim()) || 0;
    const ports: Record<string, number> = {};
    for (const t of NON_WEB_TARGETS) ports[t] = Number(inside(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '10', `http://${t}/`]).stdout.trim()) || 0;
    const direct = inside(['curl', '-s', '-o', '/dev/null', '--noproxy', '*', '--max-time', '6', 'http://1.1.1.1/']);
    const envText = inside(['sh', '-c', 'env; cat /proc/1/environ | tr "\\0" "\\n"']).stdout;
    const mounts = inside(['cat', '/proc/self/mountinfo']).stdout.split('\n').map((l) => l.split(' ')[4] ?? '').filter(Boolean);
    const hostSecrets = Object.entries(process.env).filter(([k, v]) => CREDENTIAL_ENV.test(k) && v && v.length > 8).map(([, v]) => v!);
    return judgeContainer({ egress, ports, directExit: direct.status ?? 1, envText, hostSecrets, mountPoints: mounts });
  } finally {
    sh(bin, ['rm', '-f', name]);
    stop?.();
    rmSync(tmp, { recursive: true, force: true });
  }
}
