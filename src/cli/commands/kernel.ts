import { spawnSync } from 'node:child_process';
import type { Parsed } from '../args.ts';
import { flagStr } from '../args.ts';
import { openDb } from '../../db/db.ts';
import { resolveProject } from '../../core/resolve.ts';
import { CliError } from '../../core/errors.ts';
import { dim, green, red } from '../../core/ansi.ts';
import { buildImage, containerName, engine, ensureContainer, kernelStatus, KERNEL_IMAGE, resetContainerReadyCache, saveToken, tokenFile } from '../../core/container.ts';
import { kernelPath, prepareKernel, requireHuman } from '../../core/kernel.ts';
import { helpIf } from './_shared.ts';

const HELP = `salu kernel [status|setup|login|reset|shell]

The container kernel: every ticket runs inside a rootless Podman container (with gVisor when installed) that
has only the project's kernel folder, no logins and no home network. Installs persist per project.

  salu kernel                 what is ready and what is missing
  salu kernel setup           build the kernel image (a large download, once)
  salu kernel login [token]   save the Claude token agents use inside the container (get one with \`claude setup-token\`);
                              without an argument it is read from the terminal, or from stdin when piped
  salu kernel reset [project] delete a project's container (installed packages go; the kernel folder stays)
  salu kernel shell [project] open a shell in a project's container, for you to look around

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
      line(s.gvisor, s.gvisor ? 'gVisor (runsc) in use' : 'gVisor not installed (containers share the host kernel)');
      line(s.image, s.image ? `image ${KERNEL_IMAGE}` : `image ${KERNEL_IMAGE} not built`);
      line(s.token, s.token ? 'agents have a Claude login of their own' : 'agents have no Claude login of their own yet (salu kernel login)');
      line(s.mode === 'container', s.mode === 'container' ? 'tickets run in a container' : s.mode === 'refused' ? 'tickets will FAIL here until the container kernel is ready (SALU_KERNEL_REQUIRE=1 or the container is set up but incomplete)' : 'tickets run in the weaker fence, not in a container');
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
      const token = (rest[0] ?? (await readToken())).trim();
      if (!token) throw new CliError('no token given. Run `claude setup-token` and paste the result.');
      saveToken(token);
      console.log(`${green('✓')} saved to ${tokenFile()} ${dim('(only you can read it; agents inside the container can, so use a token you can revoke)')}`);
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
        spawnSync(bin, ['rm', '-f', name], { stdio: 'ignore' });
        console.log(`${green('✓')} removed the container of "${project.name}"; the next ticket starts a fresh one`);
        return 0;
      }
      ensureContainer(project.name, prepareKernel(project.name, project.path), bin);
      return spawnSync(bin, ['exec', '-it', '--workdir', '/work', name, 'bash'], { stdio: 'inherit' }).status ?? 0;
    }
    default:
      throw new CliError(`unknown kernel command "${sub}"\n\n${HELP}`);
  }
}

export { kernelPath };
