/**
 * Watch the dog: `bun run src/tui/dog/demo.ts` (Ctrl-C to quit). Runs across the terminal,
 * then curls up to sleep, forever. NO_COLOR=1 shows the ASCII fallback; --mini the compact one.
 */
import { detectColorLevel } from '../../ui/theme.ts';
import { dogWidth, renderDog, renderTrack } from './render.ts';
import { DOG_FPS, Ticker } from './ticker.ts';

const size = process.argv.includes('--mini') ? 'mini' : 'full';
const level = detectColorLevel(process.env, true);
const rows = renderDog(0, { size, level }).length;
const width = Math.min(process.stdout.columns || 60, 70);
const lap = 60; // ticks per run across
const cycle = lap + 30; // then sleep 3s

const ticker = new Ticker(DOG_FPS);
process.stdout.write('\u001b[?25l');
let first = true;
const stop = ticker.subscribe((t) => {
  const p = t % cycle;
  const lines =
    p < lap
      ? renderTrack(t, width, p / lap, { size, level })
      : renderDog(t, { mode: 'sleep', size, level }).map((l) => ' '.repeat(Math.max(0, (width - dogWidth(size, level, 'sleep')) / 2 | 0)) + l);
  if (!first) process.stdout.write(`\u001b[${rows}A`);
  first = false;
  for (let i = 0; i < rows; i++) process.stdout.write(`\u001b[2K${lines[i] ?? ''}\n`);
});
const quit = () => { stop(); process.stdout.write('\u001b[?25h'); process.exit(0); };
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
