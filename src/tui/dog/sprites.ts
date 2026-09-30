/**
 * Pixel-art frames for the salu dog. One character per pixel; render.ts packs two pixel rows
 * into one terminal row with the half blocks ▀ ▄ █, so pixels come out square. Palette letters
 * map to salu greens only:
 *   A accent (bright body)   M ok (shading, near legs, tail)   D chrome (far legs, nose, ear tip)
 *   T text (pale: tail tip, paws)   . transparent
 * Sleeping frames may also hold the letters z and Z: each takes a whole cell (its pixel below
 * must be '.') and is drawn as the letter itself, z dim and Z pale, so the snores stay sharp.
 * The dog faces right. Every frame in a set has the same size. Check changes by eye:
 * `bun run src/tui/dog/sheet.ts` in a terminal, or rasterise it with scripts/ansi2png.py.
 */
export type Pixel = 'A' | 'T' | 'M' | 'D' | '.' | 'z' | 'Z';

/**
 * Run cycle, 24 x 12 pixels (24 cells by 6 rows): a lean dog with a pointed ear, an eye, a
 * snout with a dark nose and a raised tail. Far legs are dim so the two pairs read apart.
 * Frames: stretched in the air, front paw lands, gathered (body bobs up a pixel, feet off the
 * ground), back legs push off.
 */
export const RUN: string[][] = [
  [
    '..................D.....',
    '.................AA.....',
    '.T...............AAAA...',
    '..M.............AA.AAAA.',
    '..MM............AAAAAAAD',
    '...MM...AAAAAAAAAAAA....',
    '....MAAAAAAAAAAAAAAA....',
    '.....AAAAMMMMMAAAAAA....',
    '.....MAAM......MAAM.....',
    '.....MMDD........MMD....',
    '...MMDD............MMD..',
    '.MM.D................MM.',
  ],
  [
    '..................D.....',
    '.................AA.....',
    '.T...............AAAA...',
    '..M.............AA.AAAA.',
    '..MM............AAAAAAAD',
    '...MM...AAAAAAAAAAAA....',
    '....MAAAAAAAAAAAAAAA....',
    '.....AAAAMMMMMAAAAAA....',
    '.....MAAM......MAAM.....',
    '.....D.M.......D.M......',
    '....D...M.....D..M......',
    '...D.....MM..D...MM.....',
  ],
  [
    '.................AA.....',
    '.T...............AAAA...',
    '..M.............AA.AAAA.',
    '..MM............AAAAAAAD',
    '...MM...AAAAAAAAAAAA....',
    '....MAAAAAAAAAAAAAAA....',
    '.....AAAAMMMMMAAAAAA....',
    '.....MAAM......MAAM.....',
    '.......MD.......DM......',
    '........MDD...DDM.......',
    '.........MMD.DMM........',
    '...........M.M..........',
  ],
  [
    '..................D.....',
    '.................AA.....',
    '.T...............AAAA...',
    '..M.............AA.AAAA.',
    '..MM............AAAAAAAD',
    '...MM...AAAAAAAAAAAA....',
    '....MAAAAAAAAAAAAAAA....',
    '.....AAAAMMMMMAAAAAA....',
    '.....MAAM......MAAM.....',
    '......M.D.......D.MM....',
    '......M..D......D...MM..',
    '....MM...D.......D......',
  ],
];
export const WIDTH = 24;

/**
 * Sleeping dog, 26 x 12 pixels (26 cells by 6 rows): the same dog lying down, the same head with
 * its eye shut, front paws stretched out, a hind paw tucked under, tail curled round the back,
 * and z's drifting up from the head. The body is a shade darker so the head reads first. Frame 0 is the still picture
 * (the TUI does not animate the idle state); frame 1 moves the snores up.
 */
const SLEEP_BODY = [
  '..................D.......',
  '.................AA.......',
  '.................AAAA.....',
  '................AADDAAA...',
  '................AAAAAAAD..',
  '......MMMMMMMMMMAAAAA.....',
  '....MMMMMDMMMMMMMAAA......',
  '..T.MMMMDMMMMMMMMMM.......',
  '.T.MMMMDMMMMMMMMMMM.......',
  '.TTTMMMTTTTT...MMTTTTTTTT.',
];
export const SLEEP_WIDTH = 26;
export const SLEEP: string[][] = [
  ['.......................Z..', '..........................', '..................D..z....', ...SLEEP_BODY.slice(1)],
  ['......................z..Z', '..........................', ...SLEEP_BODY],
];

/**
 * The small dog, 12 x 4 pixels, drawn once and used twice: as braille dots on ONE terminal line
 * (the header; 2 x 4 dots per cell, 6 cells) and as half blocks on two lines ('mini', 12 cells).
 * At four pixels tall every pixel counts: tail tip, pointed ear, head with snout, a body, and
 * four legs that gallop (stretched, landing, gathered, pushing off).
 */
const TINY_TOP = ['X.........X.', '.X.......XXX', '..XXXXXXXX..'];
export const TINY_RUN: string[][] = [
  [...TINY_TOP, '.X.X....X.X.'],
  [...TINY_TOP, '..X.X..X..X.'],
  [...TINY_TOP, '...XX..XX...'],
  [...TINY_TOP, '..X.X....XX.'],
];
/** Lying down with the head up, 14 x 4: the snore gets a cell of its own (a braille cell holds dots or a letter). */
export const TINY_SLEEP: string[][] = [
  ['.........X..z.', '........XXXX..', 'X.XXXXXXXX....', '.XXXXXXXXXXX..'],
  ['.........X...Z', '........XXXX..', 'X.XXXXXXXX....', '.XXXXXXXXXXX..'],
];
export const TINY_WIDTH = 12;
export const TINY_SLEEP_WIDTH = 14;

/** Plain ASCII fallbacks for NO_COLOR and dumb terminals: 15 columns by 4 lines. */
export const ASCII_WIDTH = 15;
const ASCII_TOP = ['          /\\   ', ' \\_______/ o\\__', '  \\_________,_/'];
export const ASCII_RUN: string[][] = [
  [...ASCII_TOP, ' //         \\\\ '],
  [...ASCII_TOP, '   \\\\     |\\   '],
  [...ASCII_TOP, '     \\\\  //    '],
  [...ASCII_TOP, '   ||     //   '],
];
export const ASCII_SLEEP: string[][] = [
  ['            z  ', '          /\\  Z', ' .-------/ -\\__', '(__________/__)'.padEnd(15)],
  ['             Z ', '          /\\ z ', ' .-------/ -\\__', '(__________/__)'.padEnd(15)],
];
/** One-line ASCII dog for the header and 'mini' at level 0: 6 columns (the braille dog's width), the tail wags. */
export const ASCII_LINE_RUN: string[] = ['~(__)>', '-(__)>', '~(__)>', '_(__)>'];
export const ASCII_LINE_SLEEP: string[] = ['(__)z ', '(__) Z'];
export const ASCII_LINE_WIDTH = 6;
