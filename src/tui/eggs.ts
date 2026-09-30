/**
 * Hidden commands. Typed on the TUI command line (or after `salu` in a shell) they play a short
 * animation and leave no trace: they are not in help, tab completion or the command history.
 *   matrix  digital rain washes down the screen for two seconds
 *   dojjan  the sleeping dog wakes, barks twice and dozes off again
 *   eskil   the sleeping dog yawns
 * Pure helpers; the app and eggs-cli.ts own the timers.
 */
import { BARK_FRAMES, YAWN_FRAMES, type EggFrame } from './dog/sprites.ts';
import { renderSprite } from './dog/render.ts';
import { RAIN_MS } from './rain.ts';
import type { Style } from './style.ts';

export type EggKind = 'rain' | 'bark' | 'yawn';
export type DogEgg = Exclude<EggKind, 'rain'>;

const WORDS: Record<string, EggKind> = { matrix: 'rain', dojjan: 'bark', eskil: 'yawn' };

/** The egg a command line asks for: one of the words alone, any case, `salu` in front allowed. */
export function eggFor(line: string): EggKind | null {
  const words = line.trim().toLowerCase().split(/\s+/);
  if (words[0] === 'salu') words.shift();
  return words.length === 1 ? WORDS[words[0]!] ?? null : null;
}

export function eggFrames(kind: DogEgg): EggFrame[] {
  return kind === 'bark' ? BARK_FRAMES : YAWN_FRAMES;
}

/** How long an egg plays, in ms. */
export function eggMs(kind: EggKind): number {
  return kind === 'rain' ? RAIN_MS : eggFrames(kind).reduce((n, f) => n + f.ms, 0);
}

/** The frame showing `ms` into a dog egg, or null once it has finished. */
export function eggFrameAt(kind: DogEgg, ms: number): EggFrame | null {
  let t = Math.max(0, ms);
  for (const f of eggFrames(kind)) {
    if (t < f.ms) return f;
    t -= f.ms;
  }
  return null;
}

/** Room for the words beside the dog's head. */
const SAY_W = 6;

/**
 * A dog egg frame as lines of one width: the sprite (or its ASCII version at level 0) with the
 * frame's words beside the head, and as much room on the left so the dog stays where the
 * sleeping dog is when the lines are centred.
 */
export function eggDogLines(frame: EggFrame, st: Style): string[] {
  const art = st.level === 0 ? frame.ascii : renderSprite(frame.px, st.level);
  const gap = ' '.repeat(SAY_W + 1);
  return art.map((l, i) => {
    const say = i === 1 && frame.say ? ' ' + st.bold(st.text(frame.say)) + ' '.repeat(SAY_W - frame.say.length) : gap;
    return gap + l + say;
  });
}

/** One-line version, for when the dog is not on screen: what the dog says, or nothing. */
export function eggWords(kind: DogEgg): string {
  return kind === 'bark' ? 'WOOF! WOOF!' : 'yaaawn';
}
