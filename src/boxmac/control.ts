import type { BoxConfig } from './state.ts';
import { CliError } from '../core/errors.ts';

export type Verb = 'ping' | 'status' | 'login.set' | 'project.create' | 'project.remove' | 'update';
export interface ControlReply {
  ok: boolean;
  message: string;
  data?: any;
}

/**
 * The only thing the Mac commands need from the control channel (docs/control-channel.md):
 * send one signed command and wait for its answer. Secrets are sealed to the box by the control module.
 */
export interface ControlApi {
  call(cfg: BoxConfig, verb: Verb, args: object, o?: { secrets?: Record<string, Buffer>; timeoutMs?: number }): Promise<ControlReply>;
}

let current: ControlApi | null = null;

/** Tests (and the integration with src/control once it lands) install the real implementation here. */
export function setControlApi(api: ControlApi | null): void {
  current = api;
}

export function controlApi(): ControlApi {
  if (current) return current;
  throw new CliError('this build cannot talk to a box yet (the control channel is not part of it). Update salu and try again: salu update');
}
