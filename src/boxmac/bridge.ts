import { join } from 'node:path';
import { ticketHome } from '../core/paths.ts';
import { sendCommand, waitReply, type BoxConfig as ClientConfig } from '../control/client.ts';
import { gitTransport } from '../control/transport.ts';
import type { ControlApi } from './control.ts';
import type { BoxConfig } from './state.ts';

/** The real ControlApi: signed commands through the git control repo (src/control). */
export function toClientConfig(cfg: BoxConfig): ClientConfig {
  if (!cfg.macKey || !cfg.boxKey || !cfg.sealPub || !(cfg.repoHttps ?? cfg.repoSsh)) {
    throw new Error(`box "${cfg.box}" is not fully paired. Run: salu box add ${cfg.host}`);
  }
  return { box: cfg.box, macKey: Buffer.from(cfg.macKey, 'base64'), boxKey: Buffer.from(cfg.boxKey, 'base64'), sealPub: Buffer.from(cfg.sealPub, 'base64') };
}

const hint = (m: string) => (/could not sign in/i.test(m) ? `${m} If you use gh, run: gh auth setup-git` : m);

export const realControlApi: ControlApi = {
  async call(cfg, verb, args, o = {}) {
    try {
      const client = toClientConfig(cfg);
      const t = gitTransport({ url: (cfg.repoHttps ?? cfg.repoSsh)!, dir: join(ticketHome(), 'boxes', `${cfg.box}-control`) });
      const id = await sendCommand(t, client, verb, args, o.secrets);
      const r = await waitReply(t, client, id, { timeoutMs: o.timeoutMs });
      return { ok: r.ok, message: r.message, data: r.data };
    } catch (e) {
      return { ok: false, message: hint(e instanceof Error ? e.message : String(e)) };
    }
  },
};
