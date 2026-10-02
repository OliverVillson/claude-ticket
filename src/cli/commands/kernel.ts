import { join } from 'node:path';
import { runnerRoot } from '../../core/runner.ts';
import { saveBoxLogin } from '../../box/login.ts';
import { spawnSync } from 'node:child_process';
import type { Parsed } from '../args.ts';
import { flagBool, flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { resolveProject } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green, red } from '../../core/ansi.ts';
import { podmanCwd, boxAdmit, idleMinutes, startStats, startsLog, buildImage, containerName, engine, ensureContainer, GVISOR_PLATFORMS, gvisorPlatform, imageExists, kernelStatus, KERNEL_IMAGE, kvmUsable, resetContainerReadyCache, runtime, saveToken, setGvisorPlatform, tokenFile, type GvisorPlatform } from '../../core/container.ts';
import { kernelPath, prepareKernel, requireHuman } from '../../core/kernel.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu kernel [status|setup|login|reset|shell|platform|bench]

The container kernel: every ticket runs inside a rootless Podman container (with gVisor when installed) that
has only the project's kernel folder, no logins and no home network. Installs persist per project.

  salu kernel                 what is ready and what is missing
  salu kernel setup           build the kernel image (a large download, once)
  salu kernel login [--box] [token]   save the Claude token agents use inside the container; --box saves the one box login (kernel and every runner project; get one with \`claude setup-token\`);
                              without an argument it is read from the terminal, or from stdin when piped
  salu kernel reset [project] delete a project's container (installed packages go; the kernel folder stays)
  salu kernel shell [project] open a shell in a project's container, for you to look around
  salu kernel platform [systrap|kvm|ptrace|default]
                              how gVisor intercepts system calls: show or choose it (kvm needs VT-x and /dev/kvm;
                              it takes effect when a project's container next starts, which this command forces)
  salu kernel bench           time a file-heavy workload on each platform that can run here, to choose between them

How many tickets run at once defaults to what the machine's memory carries (16 GB: 3, at 4 GB per container).
Override with --concurrency, SALU_CONCURRENCY, or SALU_KERNEL_MEMORY (the per-container limit).

Install the container runtime on a Linux box with: sudo scripts/install-kernel-runtime.sh`;

async function readToken(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stdout.write('Paste the token (input is hidden): ');
    process.stdin.setRawMode?.(true);
    return await new Promise((resolve) => {
      let s = '';
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      const on = (c: string) => {
        for (const ch of c) {
          if (ch === '\r' || ch === '\n') {
            process.stdin.setRawMode?.(false);
            process.stdin.off('data', on);
            process.stdin.pause();
            process.stdout.write('\n');
            return resolve(s);
          }
          if (ch === '\u0003') process.exit(130);
          if (ch === '\u007f') s = s.slice(0, -1);
          else s += ch;
        }
      };
      process.stdin.on('data', on);
    });
  }
  return await new Response(Bun.stdin.stream()).text();
}

export async function kernel(p: Parsed): Promise<number> {
  if (helpIf(p, HELP)) return 0;
  const [sub = 'status', ...rest] = p.positional;
  switch (sub) {
    case 'status': {
      const s = kernelStatus();
      const line = (ok: boolean, text: string) => console.log(`${ok ? green('✓') : red('✗')} ${text}`);
      line(!!s.engine, s.engine ? `Podman at ${s.engine}` : 'Podman not found');
      line(s.gvisor, s.gvisor ? `gVisor (runsc) in use, platform ${gvisorPlatform() ?? 'default'}` : 'gVisor not installed (containers share the host kernel)');
      line(s.image, s.image ? `image ${KERNEL_IMAGE}` : `image ${KERNEL_IMAGE} not built`);
      line(s.token, s.token ? 'agents have a Claude login of their own' : 'agents have no Claude login of their own yet (salu kernel login)');
      line(s.mode === 'container', s.mode === 'container' ? 'tickets run in a container' : s.mode === 'refused' ? 'tickets will FAIL here until the container kernel is ready (SALU_KERNEL_REQUIRE=1 or the container is set up but incomplete)' : 'tickets run in the weaker fence, not in a container');
      const st = startStats();
      const idle = idleMinutes();
      console.log(`  ${dim(`containers unload ${idle === null ? 'never' : idle === 0 ? 'as soon as their last ticket ends' : `after ${idle} idle minutes`} (SALU_KERNEL_IDLE_MINUTES) and start again with the next ticket`)}`);
      if (st) console.log(`  ${dim(`start time over ${st.count} starts: median ${(st.medianMs / 1000).toFixed(1)} s, worst ${(st.maxMs / 1000).toFixed(1)} s (${startsLog()})`)}`);
      if (s.mode === 'container') {
        const a = boxAdmit();
        console.log(`  ${dim(`${a.running} of at most ${a.limit} tickets running on this box; ${a.ok ? 'the next one can start now' : `the next one waits: ${a.reason}`}`)}`);
      }
      for (const pr of s.problems) console.log(`  ${dim(pr)}`);
      return s.mode !== 'container' ? 1 : 0;
    }
    case 'setup': {
      requireHuman('kernel setup');
      const bin = engine();
      if (!bin) throw new CliError('Podman was not found. On Linux run: sudo scripts/install-kernel-runtime.sh');
      if (process.platform !== 'linux') throw new CliError('the container kernel runs on Linux for now (home server or VPS). On a Mac, workers use the fenced mode.');
      buildImage(bin, (l) => console.log(dim(l)));
      resetContainerReadyCache();
      console.log(`${green('✓')} kernel image ready. Next: salu kernel login`);
      return 0;
    }
    case 'login': {
      requireHuman('kernel login');
      const box = flagBool(p, 'box'); // the one login runner projects read (/var/lib/salu/kernel-token); a boolean flag, so never in rest
      const token = (rest[0] ?? (await readToken())).trim();
      if (!token) throw new CliError('no token given. Run `claude setup-token` and paste the result.');
      const file = box ? join(runnerRoot(), 'kernel-token') : tokenFile();
      try {
        if (box) saveBoxLogin(token); // the one box login: the kernel proxy and every runner project's orchestrator
        else saveToken(token, file);
      } catch (e: any) {
        throw new CliError(`could not write ${file}: ${e.message}${box ? ' (run it as the user that owns the runner folder: sudo -u salu salu kernel login --box)' : ''}`);
      }
      console.log(`${green('✓')} saved to ${file} ${dim('(only you can read it; agents inside the container can, so use a token you can revoke)')}`);
      return 0;
    }
    case 'platform': {
      const want = rest[0];
      const cur = gvisorPlatform();
      if (!want) {
        console.log(`gVisor platform: ${cur ?? 'default (systrap)'}${kvmUsable() ? ' · kvm is available here' : ' · kvm is not available here (/dev/kvm)'}`);
        return 0;
      }
      requireHuman('kernel platform');
      if (want === 'default') setGvisorPlatform(null);
      else if ((GVISOR_PLATFORMS as readonly string[]).includes(want)) {
        if (want === 'kvm' && !kvmUsable()) throw new CliError('kvm is not usable here: turn on VT-x in the BIOS, make sure /dev/kvm exists, and add this user to the kvm group (then log in again).');
        setGvisorPlatform(want as GvisorPlatform);
      } else throw new CliError(`unknown platform "${want}": systrap, kvm, ptrace or default`);
      const bin = engine();
      if (bin) spawnSync(bin, ['stop', '--filter', 'label=salu.kernel=1', '-t', '5'], { stdio: 'ignore', cwd: podmanCwd() }); // restarted with the new platform on the next ticket
      console.log(`${green('✓')} gVisor platform ${want}; running containers were stopped and start again with the next ticket`);
      return 0;
    }
    case 'bench': {
      const bin = engine();
      if (!bin) throw new CliError('Podman was not found.');
      if (!runtime().gvisor) throw new CliError('gVisor is not installed: sudo scripts/install-kernel-runtime.sh');
      if (!imageExists(bin)) throw new CliError('the kernel image is not built: salu kernel setup');
      const work = 'mkdir /tmp/b && cd /tmp/b && i=0 && while [ $i -lt 4000 ]; do echo x > f$i; i=$((i+1)); done && find . -type f | wc -l >/dev/null && tar cf - . | tar xf - -C /tmp && rm -rf /tmp/b /tmp/f*';
      const modes: [string, string | null, string[]][] = [['gVisor systrap', 'systrap', ['--runtime', runtime().name!]]];
      if (kvmUsable()) modes.push(['gVisor kvm', 'kvm', ['--runtime', runtime().name!]]);
      modes.push(['no gVisor (host kernel)', null, []]);
      console.log(dim('4000 small files created, listed, copied and removed; best of 3 runs'));
      for (const [label, plat, rt] of modes) {
        const times: number[] = [];
        for (let i = 0; i < 3; i++) {
          const t0 = performance.now();
          const r = spawnSync(bin, ['run', '--rm', '--network', 'none', ...rt, '--entrypoint', 'sh', KERNEL_IMAGE, '-c', work], { stdio: 'ignore', cwd: podmanCwd(), env: { ...process.env, ...(plat ? { SALU_GVISOR_PLATFORM: plat } : {}) } });
          if (r.status !== 0) {
            times.length = 0;
            break;
          }
          times.push((performance.now() - t0) / 1000);
        }
        console.log(`${times.length ? green('✓') : red('✗')} ${label.padEnd(26)} ${times.length ? Math.min(...times).toFixed(2) + ' s' : 'did not run'}`);
      }
      console.log(dim('Pick with: salu kernel platform systrap|kvm   (your npm install and test runs are the real test)'));
      return 0;
    }
    case 'reset':
    case 'shell': {
      requireHuman(`kernel ${sub}`);
      const bin = engine();
      if (!bin) throw new CliError('Podman was not found.');
      const project = resolveProject(openDb(), rest[0] ?? flagStr(p, 'project'));
      const name = containerName(project.name);
      if (sub === 'reset') {
        spawnSync(bin, ['rm', '-f', name], { stdio: 'ignore', cwd: podmanCwd() });
        console.log(`${green('✓')} removed the container of "${project.name}"; the next ticket starts a fresh one`);
        return 0;
      }
      ensureContainer(project.name, prepareKernel(project.name, project.path), bin);
      return spawnSync(bin, ['exec', '-it', '--workdir', '/work', name, 'bash'], { stdio: 'inherit', cwd: podmanCwd() }).status ?? 0;
    }
    default:
      throw new CliError(`unknown kernel command "${sub}"\n\n${HELP}`);
  }
}

export { kernelPath };
