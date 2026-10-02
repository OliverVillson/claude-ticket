/**
 * The handlers `salu control watch` runs. `ping` is built in. The rest are filled in by the box handlers
 * (src/box/handlers): they replace the entries of `handlers` below, nothing else in src/control changes.
 */
import { createHandlers } from '../box/handlers/index.ts';
import { realDeps } from '../box/deps.ts';
import { heartbeatSource } from '../box/heartbeat-data.ts';
import type { Handlers } from './watcher.ts';

const deps = realDeps();

/** The box's verbs (src/box/handlers); `ping` is among them. */
export const handlers: Handlers = createHandlers(deps);

/** The body of the heartbeat the box rewrites every minute: version, disk, tickets, each project's state. */
export const heartbeatData: () => Record<string, unknown> = heartbeatSource(deps);
