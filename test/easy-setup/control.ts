/** The control channel under test: the real src/control/ once piece 1 has landed, else the reference in ref-control.ts. */
import * as ref from './ref-control.ts';

async function real() {
  try {
    const [seal, message, transport, watcher, client] = await Promise.all(['seal', 'message', 'transport', 'watcher', 'client'].map((n) => import(`../../src/control/${n}.ts`)));
    return { ...seal, ...message, ...transport, ...watcher, ...client };
  } catch {
    return null;
  }
}
const r = await real();
export const usingRealControl = r !== null;
export const control = (r ?? ref) as typeof ref;

/** The real verb handlers (piece 3), when they exist. */
export async function realHandlers(): Promise<any | null> {
  try {
    return await import('../../src/box/handlers/index.ts');
  } catch {
    return null;
  }
}
