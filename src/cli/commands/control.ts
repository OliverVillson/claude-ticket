import { join } from 'node:path';
import { CliError } from '../../core/errors.ts';
import type { Parsed } from '../args.ts';

const HELP = `salu control <command>     the box listens to your Mac through a private git repo
  salu control watch [--once] [--interval S]   run the listener (the salu-control service does this)
  salu control unit [--user U]                 print the systemd unit`;

export async function control(p: Parsed): Promise<number> {
  const [sub] = p.positional;
  if (sub === 'unit') {
    const { controlUnit } = await import('../../control/service.ts');
    process.stdout.write(controlUnit({ user: typeof p.flags.user === 'string' ? p.flags.user : undefined }));
    return 0;
  }
  if (sub !== 'watch') {
    console.log(HELP);
    return sub === undefined || p.flags.help ? 0 : 1;
  }
  const { loadBoxState, boxDir } = await import('../../control/keys.ts');
  const { gitTransport } = await import('../../control/transport.ts');
  const { runWatcher } = await import('../../control/watcher.ts');
  const { handlers, heartbeatData } = await import('../../control/handlers.ts');
  let st;
  try {
    st = loadBoxState();
  } catch (e: any) {
    throw new CliError(e.message);
  }
  const t = gitTransport({ url: st.url, sshKey: st.deployKey, dir: join(boxDir(), 'control-repo') });
  const secs = Number(typeof p.flags.interval === 'string' ? p.flags.interval : 5);
  const w = runWatcher(t, handlers, {
    box: st.box, macKey: st.macKey, boxKey: st.boxKey, sealKey: st.sealKey,
    intervalMs: Math.max(1, secs) * 1000,
    handledFile: join(boxDir(), 'handled'),
    heartbeat: heartbeatData,
    onError: (e) => console.error(`control: ${(e as Error).message}`),
    onHandled: (id, verb, ok) => console.log(`control: ${verb} ${id} ${ok ? 'ok' : 'failed'}`),
  });
  if (p.flags.once) {
    await w.tick();
    w.stop();
    return 0;
  }
  await new Promise(() => {});
  return 0;
}
