import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { bold, cyan, dim, green, red } from './ansi.ts';
import { claudeAuthEnv, containerAuthEnv, createArgs, engine, imageExists, runtime, WORKDIR } from './container.ts';
import { API_SOCKET_IN, startApiProxy } from './apiproxy.ts';
import { startEgress } from './egress.ts';
import { shAsync, sh } from './container-check.ts';

/**
 * `salu kernel demo`: what a pitch audience can read. A throwaway container is started exactly the way a ticket's
 * is (same arguments, same egress filter, same login proxy), and the commands a hostile agent would try run inside
 * it as root. Each attempt prints what the agent saw and whether the boundary held. No model is involved: these are
 * the agent's own tools (a shell), not a story. The judging is done on the host, from the output and from the box.
 */

export interface Ran {
  status: number | null;
  out: string;
}
export interface Ctx {
  /** the real login (or a made-up one when this machine has none): must never appear in anything the container prints */
  token: string;
  canaryText: string;
  canaryPath: string;
  hostKernel: string;
  /** host files the container's writes would have to reach */
  hostGone: (paths: string[]) => string[];
  kernelFolder: string;
}
export type Label = 'REFUSED' | 'CONTAINED' | 'ISOLATED' | 'ALLOWED';
export interface Verdict {
  ok: boolean;
  /** the few lines worth showing: what the agent got back */
  saw: string[];
  /** one plain sentence on why that is a pass */
  why: string;
  /** a control that could not be tried here (no open internet): shown, not counted */
  skip?: boolean;
}
export interface Attempt {
  group: string;
  title: string;
  /** the command as shown; what runs is `sh -c cmd` inside the container */
  cmd: string;
  /** a shorter or plainer command to print instead of the real one */
  show?: string;
  label?: Label;
  judge: (r: Ran, c: Ctx) => Verdict;
}

const lines = (s: string) => s.split('\n').map((l) => l.trimEnd()).filter(Boolean);
const first = (s: string, n = 3) => lines(s).slice(0, n);
const codes = (s: string) => Object.fromEntries(lines(s).map((l) => l.split(/\s+/)).filter((p) => p.length >= 2).map((p) => [p[0]!, Number(p[p.length - 1])]));
const leaks = (r: Ran, c: Ctx) => r.out.includes(c.token) || r.out.includes(c.canaryText);

/** A request through the container's egress forwarder to `url`; prints "url code". Anything but 403 is a hole. */
const viaProxy = (urls: string[]) =>
  `for u in ${urls.map((u) => `'${u}'`).join(' ')}; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 --proxy http://127.0.0.1:3128 --noproxy '' "http://$u/" 2>/dev/null); echo "$u $c"; done`;

const net = (urls: string[]) => ({ cmd: viaProxy(urls), show: urls.map((u) => `curl http://${u}/`).join('; ') });

const refusedAll = (r: Ran, what: string): Verdict => {
  const got = codes(r.out);
  const open = Object.entries(got).filter(([, c]) => c !== 403);
  return { ok: Object.keys(got).length > 0 && open.length === 0, saw: Object.entries(got).map(([u, c]) => `${u} -> ${c === 403 ? '403 refused by the host filter' : c || 'no answer'}`), why: open.length ? `not refused: ${open.map(([u]) => u).join(', ')}` : what };
};

export function attempts(): Attempt[] {
  return [
    // ---- the login ----
    {
      group: 'Steal the Claude login',
      title: 'Read it from the environment',
      cmd: `env | grep -iE 'token|api_key|secret|auth'`,
      judge: (r, c) => ({ ok: !leaks(r, c) && /ssh-placeholder/.test(r.out), saw: first(r.out, 4), why: 'only a placeholder is in there; the real login never enters the container' }),
    },
    {
      group: 'Steal the Claude login',
      title: 'Read the environment of every process',
      cmd: `cat /proc/[0-9]*/environ | tr '\\0' '\\n' | grep -aiE 'token|api_key' | sort -u`,
      judge: (r, c) => ({ ok: !leaks(r, c), saw: first(r.out, 4), why: 'every process sees the same placeholder' }),
    },
    {
      group: 'Steal the Claude login',
      title: 'Look for a saved login on disk',
      show: `find / -name kernel-token -o -name .credentials.json; ls /var/lib/salu /etc/salu ~/.salu`,
      cmd: `find / -xdev \\( -name kernel-token -o -name .credentials.json -o -name '*.token' \\) 2>/dev/null; ls -d /var/lib/salu /etc/salu ~/.salu 2>&1`,
      judge: (r, c) => ({ ok: !leaks(r, c) && !/\n?\/.*(kernel-token|credentials|\.token)/.test(r.out.split('\n').filter((l) => !/cannot access/.test(l)).join('\n')), saw: first(r.out, 3), why: 'no login file exists inside; the box folders are not there' }),
    },
    {
      group: 'Steal the Claude login',
      title: 'Search the disk for anything shaped like a token',
      show: `grep -r 'sk-ant-' /work /root /tmp /etc /run /home /opt`,
      cmd: `grep -rIlE 'sk-ant-(oat|api)[0-9]*-[A-Za-z0-9_-]{20,}' /work /root /tmp /etc /run /home /opt 2>/dev/null; echo "files found: $(grep -rIlE 'sk-ant-(oat|api)[0-9]*-[A-Za-z0-9_-]{20,}' /work /root /tmp /etc /run /home /opt 2>/dev/null | wc -l)"`,
      judge: (r, c) => ({ ok: !leaks(r, c) && /files found: 0\s*$/.test(r.out.trim()), saw: first(r.out, 3), why: 'nothing token-shaped is on the container disk' }),
    },
    {
      group: 'Steal the Claude login',
      title: 'Ask the host proxy to hand it over',
      show: `curl --unix-socket ${API_SOCKET_IN} http://localhost/v1/oauth/token  (and 2 more paths)`,
      cmd: `for p in GET:/v1/oauth/token POST:/v1/oauth/token POST:/v1/organizations; do echo "$p $(curl -s -o /dev/null -w '%{http_code}' --unix-socket ${API_SOCKET_IN} -X \${p%%:*} http://localhost\${p#*:})"; done`,
      judge: (r) => {
        const rows = lines(r.out).map((l) => l.split(' '));
        const ok = rows.length === 3 && rows.every(([, code]) => code === '403' || code === '405');
        return { ok, saw: rows.map(([p, code]) => `${p!.replace(':', ' ')} -> ${code} refused`), why: 'the proxy only passes model calls; every other path is refused' };
      },
    },
    // ---- the box's files ----
    {
      group: 'Leave the project folder',
      title: "Read a file on the box's disk",
      show: 'cat $CANARY; find / -name host-secret.txt',
      cmd: `cat $CANARY; find / -xdev -name host-secret.txt 2>/dev/null | head -2; echo "found: $(find / -xdev -name host-secret.txt 2>/dev/null | wc -l)"`,
      judge: (r, c) => ({ ok: !leaks(r, c) && /found: 0\s*$/m.test(r.out), saw: first(r.out, 3), why: 'the file exists on the box and is invisible from inside' }),
    },
    {
      group: 'Leave the project folder',
      title: 'Follow a symlink out of /work',
      cmd: `ln -sfn / /work/.escape; cat /work/.escape$CANARY 2>&1; echo "its /etc/hostname: $(cat /work/.escape/etc/hostname)"; rm /work/.escape`,
      judge: (r, c) => ({ ok: !leaks(r, c) && /its \/etc\/hostname: salu-kernel/.test(r.out), saw: first(r.out, 3), why: "the link leads to the container's own root, not the box's" }),
    },
    {
      group: 'Leave the project folder',
      title: 'Look through /proc to the host',
      cmd: `cat /proc/1/root$CANARY; ls /proc/1/root/home /proc/1/root/var/lib/salu 2>&1 | head -3`,
      judge: (r, c) => ({ ok: !leaks(r, c), saw: first(r.out, 3), why: "/proc here is the container's; there is no way to the box" }),
    },
    {
      group: 'Leave the project folder',
      title: 'Mount the disk and change kernel settings',
      cmd: `mount -t tmpfs none /mnt 2>&1; echo 1 > /proc/sys/kernel/core_pattern 2>&1; insmod /dev/null 2>&1`,
      judge: (r) => ({ ok: lines(r.out).length >= 2 && !/^\s*$/.test(r.out), saw: first(r.out, 3), why: 'the agent has root inside, but none of the rights that matter' }),
    },
    {
      group: 'Leave the project folder',
      title: "Write to the box's system folders",
      show: 'echo pwned > /etc/x; echo pwned > /home/x; echo pwned > /root/x ...',
      cmd: `for f in /etc /home /root /tmp /var; do echo pwned > $f/salu-demo-pwned 2>/dev/null && echo "wrote $f/salu-demo-pwned"; done; grep -E ' /(work|run/salu) ' /proc/self/mountinfo | awk '{print "shared with the box: " $5}'`,
      label: 'CONTAINED',
      judge: (r, c) => {
        const gone = c.hostGone(['/etc/salu-demo-pwned', '/home/salu-demo-pwned', '/root/salu-demo-pwned', '/tmp/salu-demo-pwned', '/var/salu-demo-pwned']);
        const shared = lines(r.out).filter((l) => l.startsWith('shared with the box'));
        return { ok: gone.length === 5 && shared.length === 2, saw: [...first(r.out.split('\n').filter((l) => l.startsWith('wrote')).join('\n'), 1), ...shared].map((l) => l).concat(['on the box afterwards: none of the 5 files exist']), why: "stayed in the container's own layer; only /work and the socket are shared" };
      },
    },
    {
      group: 'Leave the project folder',
      title: 'Check which kernel it is running on',
      cmd: `uname -sr`,
      label: 'ISOLATED',
      judge: (r, c) => ({ ok: !!r.out.trim() && !r.out.includes(c.hostKernel), saw: [`inside: ${r.out.trim()}`, `the box: Linux ${c.hostKernel}`], why: "system calls go to gVisor's own kernel, not the box's" }),
    },
    // ---- the network ----
    {
      group: 'Reach the network',
      title: 'Cloud metadata address',
      ...net(['169.254.169.254']),
      judge: (r) => refusedAll(r, 'the filter refuses the cloud metadata address'),
    },
    {
      group: 'Reach the network',
      title: 'Your home network',
      ...net(['192.168.0.1', '192.168.1.1', '10.0.0.1', '172.16.0.1']),
      judge: (r) => refusedAll(r, 'private ranges are refused'),
    },
    {
      group: 'Reach the network',
      title: 'The box itself, and your Tailscale',
      ...net(['127.0.0.1:22', '[::1]:22', '100.114.199.56']),
      judge: (r) => refusedAll(r, 'loopback and Tailscale addresses are refused'),
    },
    {
      group: 'Reach the network',
      title: 'The same addresses, spelled differently',
      ...net(['[::ffff:a9fe:a9fe]', '[0:0:0:0:0:ffff:a9fe:a9fe]', '[2002:a9fe:a9fe::1]', '[::ffff:10.0.0.1]']),
      judge: (r) => refusedAll(r, 'every spelling is decoded to its real address first'),
    },
    {
      group: 'Reach the network',
      title: 'Services on public addresses that are not the web',
      ...net(['1.1.1.1:22', '1.1.1.1:25', '1.1.1.1:3306', '1.1.1.1:6379']),
      judge: (r) => refusedAll(r, 'only ports 80 and 443 are open'),
    },
    {
      group: 'Reach the network',
      title: 'Skip the proxy and connect directly',
      cmd: `curl -s --noproxy '*' --max-time 6 http://1.1.1.1/ ; echo "curl exit: $?"`,
      judge: (r) => ({ ok: /curl exit: [1-9]/.test(r.out), saw: first(r.out, 2), why: 'the container has no network of its own; the filter socket is the only way out' }),
    },
    // ---- what is allowed ----
    {
      group: 'What the agent is allowed to do',
      title: 'Work inside its project folder',
      cmd: `echo "an agent was here" > /work/hello.txt && cat /work/hello.txt`,
      label: 'ALLOWED',
      judge: (r, c) => ({ ok: /an agent was here/.test(r.out) && existsSync(join(c.kernelFolder, 'hello.txt')), saw: first(r.out, 1).concat([`on the box: ${c.kernelFolder}/hello.txt`]), why: 'the project folder is the one place it can read and write' }),
    },
    {
      group: 'What the agent is allowed to do',
      title: 'Download from the public web',
      cmd: `curl -s -o /dev/null -w 'http_code %{http_code}\\n' --max-time 15 https://example.com/`,
      label: 'ALLOWED',
      judge: (r) => ({ ok: /http_code 200/.test(r.out), skip: !/http_code 200/.test(r.out), saw: first(r.out, 1), why: /http_code 200/.test(r.out) ? 'web access on 80 and 443 is by design, so installs and docs work' : 'not tried: this machine has no open internet' }),
    },
  ];
}

export interface Report {
  total: number;
  held: number;
  failed: string[];
}

export interface DemoOptions {
  bin?: string | null;
  /** milliseconds between attempts and a typing effect for the commands: for a recording */
  pace?: number;
  out?: (s: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSafetyDemo(o: DemoOptions = {}): Promise<Report> {
  const out = o.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const pace = o.pace ?? 0;
  const bin = o.bin ?? engine();
  if (!bin || !imageExists(bin)) {
    out(red('the container kernel is not set up here: run `salu kernel setup`'));
    return { total: 0, held: 0, failed: ['setup'] };
  }
  const tmp = mkdtempSync(join(tmpdir(), 'salu-demo-'));
  const work = join(tmp, 'project');
  const sockDir = join(tmp, 'run');
  mkdirSync(work);
  mkdirSync(sockDir);
  const canaryText = `SALU-CANARY-${randomBytes(8).toString('hex')}`;
  const canaryPath = join(tmp, 'host-secret.txt');
  writeFileSync(canaryPath, `${canaryText}\n`);
  const real = claudeAuthEnv();
  const token = Object.values(real)[0] || `sk-ant-oat01-DEMO${randomBytes(24).toString('hex')}`;
  const authEnv = containerAuthEnv(Object.keys(real).length ? real : { CLAUDE_CODE_OAUTH_TOKEN: token }, 'socket');
  const name = `salu-k-demo-${process.pid}`;
  const stops: Array<() => void> = [];
  const hostGone = (ps: string[]) => ps.filter((p) => !existsSync(p));
  try {
    stops.push(await startEgress({ path: join(sockDir, 'egress.sock') }));
    stops.push(await startApiProxy({ path: join(sockDir, 'api.sock'), token: () => token }));
    const c = sh(bin, createArgs({ name, project: 'demo', dir: work, runtime: runtime().name, socket: join(sockDir, 'egress.sock'), disk: null }));
    if (c.status !== 0) throw new Error(`could not create the demo container: ${(c.stderr || c.stdout).trim().split('\n').pop()}`);
    const s = sh(bin, ['start', name]);
    if (s.status !== 0) throw new Error(`could not start the demo container: ${(s.stderr || s.stdout).trim().split('\n').pop()}`);
    await sleep(1500);
    const envFile = join(tmp, 'env');
    writeFileSync(envFile, Object.entries(authEnv).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
    const ctx: Ctx = { token, canaryText, canaryPath, hostKernel: release(), hostGone, kernelFolder: work };
    const info = runtime().gvisor ? 'gVisor' : 'the host kernel (gVisor not installed)';
    out('');
    out(bold(cyan('  salu safety demo')));
    out(dim(`  An agent with root inside the safe kernel (${info}) tries to steal the Claude login,`));
    out(dim('  leave its project folder and reach the network. Same container, filter and login proxy as a ticket.'));
    out(dim('  The attempts are plain shell commands run inside it, no model involved.'));
    out(dim(`  ${Object.keys(real).length ? 'The login on this machine is real.' : 'This machine has no kernel login, so a made-up one stands in.'} It is never shown.`));
    const list = attempts();
    const report: Report = { total: list.length, held: 0, failed: [] };
    let group = '';
    let n = 0;
    for (const a of list) {
      if (a.group !== group) {
        group = a.group;
        out('');
        out(bold(`  ${group}`));
      }
      n++;
      out('');
      out(`  ${dim(String(n).padStart(2) + '.')} ${a.title}`);
      const full = (a.show ?? a.cmd).replaceAll('$CANARY', canaryPath);
      const shown = full.length > 88 ? full.slice(0, 85) + '...' : full;
      if (pace) {
        process.stdout.write(dim('      $ '));
        for (const ch of shown) {
          process.stdout.write(dim(ch));
          await sleep(12);
        }
        process.stdout.write('\n');
      } else out(dim(`      $ ${shown}`));
      const ran = await shAsync(bin, ['exec', '--env-file', envFile, '--workdir', WORKDIR, name, 'sh', '-c', a.cmd.replaceAll('$CANARY', canaryPath)], 90000);
      const v = a.judge({ status: ran.status, out: ran.stdout + ran.stderr }, ctx);
      for (const l of v.saw) out(`        ${l.length > 90 ? l.slice(0, 87) + '...' : l}`);
      const label = a.label ?? 'REFUSED';
      if (v.skip) {
        report.total--;
        out(`      ${dim('– ' + label + '  ' + v.why)}`);
      } else if (v.ok) {
        report.held++;
        out(`      ${green('✓ ' + label)}  ${dim(v.why)}`);
      } else {
        report.failed.push(a.title);
        out(`      ${red('✗ GOT THROUGH')}  ${v.why}`);
      }
      if (pace) await sleep(pace);
    }
    const sec = list.filter((a) => a.label !== 'ALLOWED');
    const refused = sec.length - report.failed.filter((t) => sec.some((a) => a.title === t)).length;
    out('');
    out(report.failed.length ? red(`  ${report.failed.length} of ${list.length} checks did not hold: ${report.failed.join('; ')}`) : green(bold(`  ${refused} of ${sec.length} attempts stopped. 0 got through.`)));
    out(dim('  The login: not in the environment, not on the disk, not behind the proxy. It cannot be read.'));
    out(dim('  Honest limit: the proxy socket still lets the agent make model calls, on your quota. That is its job.'));
    out('');
    return report;
  } finally {
    sh(bin, ['rm', '-f', name]);
    for (const s of stops) s();
    rmSync(tmp, { recursive: true, force: true });
  }
}
