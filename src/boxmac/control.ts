import type { BoxConfig } from './state.ts';

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

/** Tests install a fake here. */
export function setControlApi(api: ControlApi | null): void {
  current = api;
}

import { realControlApi } from './bridge.ts';
export function controlApi(): ControlApi {
  return current ?? realControlApi;
}
