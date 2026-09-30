/**
 * The hidden commands from a shell (`salu matrix`, `salu dojjan`, `salu eskil`). A terminal gets
 * the animation: the rain on the alternate screen, the dog drawn in place and left asleep. Pipes
 * (and the TUI's command line, which captures output) get one line.
 */
import { eggDogLines, eggFrames, eggMs, eggWords, type EggKind } from './eggs.ts';
import { makeRain, rainLines } from './rain.ts';
import { colorsWanted, makeStyle } from './style.ts';
import { supportsUnicode } from '../ui/glyphs.ts';
import { isEmbedded } from '../cli/commands/_shared.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function playEgg(kind: EggKind, out: NodeJS.WriteStream = process.stdout): Promise<number> {
  // Pipes, and the TUI command line when something follows the word (the app plays the bare word itself).
  if (!out.isTTY || isEmbedded()) {
    console.log(kind === 'rain' ? 'wake up, neo' : eggWords(kind));
    return 0;
  }
  const st = makeStyle(colorsWanted());
  if (kind === 'rain') {
    const rain = makeRain(out.columns || 80, out.rows || 24, Date.now(), supportsUnicode());
    const leave = () => out.write('\u001b[?25h\u001b[?1049l');
    process.once('SIGINT', () => {
      leave();
      process.exit(130);
    });
    out.write('\u001b[?1049h\u001b[?25l');
    const start = Date.now();
    for (let t = 0; t < eggMs('rain'); t = Date.now() - start) {
      out.write('\u001b[H' + rainLines(rain, t, st).join('\r\n'));
      await wait(33);
    }
    leave();
    return 0;
  }
  let drawn = 0;
  for (const f of eggFrames(kind)) {
    const lines = eggDogLines(f, st);
    if (drawn) out.write(`\u001b[${drawn}A`);
    out.write(lines.map((l) => '\r\u001b[2K' + l).join('\n') + '\n');
    drawn = lines.length;
    await wait(f.ms);
  }
  return 0;
}
