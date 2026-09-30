/**
 * Pixel-art frames for the salu dog. One character per pixel, two pixels per terminal cell
 * (rendered with ▀ ▄ half blocks in render.ts). Palette letters map to salu greens only:
 *   A accent (bright)   T text (light)   M ok (mid)   D chrome (dim)   . transparent
 * The dog faces right. Every frame in a set has the same size.
 */
export type Pixel = 'A' | 'T' | 'M' | 'D' | '.';

/** Upper body shared by the run cycle: tail, back, head, ear, eye, snout. 22 wide, 8 tall. */
const BODY = [
  '......................',
  '...........MM....DD...',
  '..T.......MMMM..DAAD..',
  '..TT.MMMMMMMMMMMAAAAD.',
  '...TMMAAAAAAAAAMAAT.AA',
  '....MMAAAAAAAAAAAAAAAD',
  '....MMAAAAAAAAAAAAADD.',
  '.....MMAAAAAAAAAAMM...',
];

/** Legs, 4 rows each; front pair at cols 14-17, back pair at cols 4-7. */
const LEGS: string[][] = [
  // 0: gather (all feet under the belly)
  ['.....MM.....MMM.......', '.....MM.....MMM.......', '......MM...MM.........', '......DD...DD.........'],
  // 1: reach (front forward, back stretched behind)
  ['...MM.........MMM.....', '..MM..........MM.MM....', '.DD..........MM...MM..', '.............DD....DD.'],
  // 2: flight (legs tucked)
  ['......MM.....MM......', '.....MM.......MM......', '.....DD.......DD......', '......................'],
  // 3: push (back forward, front stretched ahead)
  ['.....MM.......MM.....', '......MM.....MM..MM...', '.......DD...MM....DD..', '............DD........'],
];

function pad(rows: string[], width: number): string[] {
  return rows.map((r) => r.padEnd(width, '.').slice(0, width));
}

export const WIDTH = 22;

/** Run cycle, 12 pixel rows (6 terminal rows) by 22 columns. */
export const RUN: string[][] = LEGS.map((legs) => [...pad(BODY, WIDTH), ...pad(legs, WIDTH)]);

/** Sleeping dog for when nothing runs: curled up, tail over the nose. 22 wide, 12 tall. */
export const SLEEP: string[][] = [
  [
    '......................',
    '......................',
    '......................',
    '......................',
    '......................',
    '.........MMMMMM.......',
    '.....MMMMAAAAAAMMM....',
    '...MMAAAAAAAAAAAAAMM..',
    '..MMAAAAAAAAAAATTAAAM.',
    '..DMMAAAAAAAAAAAAAAMD.',
    '...DDMMMMMMMMMMMMMMD..',
    '.....DDDDDDDDDDDD.....',
  ],
  [
    '......................',
    '......................',
    '......................',
    '......................',
    '.........MMMMMM.......',
    '.....MMMMAAAAAAMMM....',
    '...MMAAAAAAAAAAAAAMM..',
    '..MMAAAAAAAAAAATTAAAM.',
    '..DMMAAAAAAAAAAAAAAMD.',
    '...DDMMMMMMMMMMMMMMD..',
    '.....DDDDDDDDDDDD.....',
    '......................',
  ],
];

/** Compact 4 pixel row (2 terminal rows) run cycle for narrow spaces. 10 wide. */
export const MINI_RUN: string[][] = [
  ['..MMMMAAD.', 'TMAAAAAAAA', '.M.M..M.M.', '.D.D..D.D.'],
  ['..MMMMAAD.', 'TMAAAAAAAA', 'M..M...MM.', 'D..D...DD.'],
  ['..MMMMAAD.', 'TMAAAAAAAA', '.MM....MM.', '.DD....DD.'],
  ['..MMMMAAD.', 'TMAAAAAAAA', '..MM..MM..', '..DD..DD..'],
];
export const MINI_SLEEP: string[][] = [
  ['..........', '.MMMMMMD..', 'DMAAAAATAD', '.DDDDDDD..'],
  ['..........', '..MMMMMD..', 'DMAAAAATAD', '.DDDDDDD..'],
];

/** Plain ASCII fallbacks for NO_COLOR, dumb terminals and non-unicode output. */
export const ASCII_RUN: string[][] = [
  ['      __      ', '  ___/ o\\_    ', ' <_____  __)  ', '   //  \\\\     '],
  ['      __      ', '  ___/ o\\_    ', ' <_____  __)  ', '  //    //    '],
  ['      __      ', '  ___/ o\\_    ', ' <_____  __)  ', '   ||  ||     '],
  ['      __      ', '  ___/ o\\_    ', ' <_____  __)  ', '  \\\\    \\\\    '],
];
export const ASCII_SLEEP: string[][] = [
  ['              ', '   ___        ', ' (_____)z     ', '  ~~~~~       '],
  ['              ', '   ___     z  ', ' (_____)z     ', '  ~~~~~       '],
];
export const ASCII_MINI_RUN: string[] = ['=^.^=', '=^-^=', '=^.^=', '=^-^='];
export const ASCII_MINI_SLEEP: string[] = ['=-.-= z', '=-.-= Z'];

/** One terminal line (2 pixel rows) run cycle, 10 wide, for the header row. */
export const LINE_RUN: string[][] = [
  ['TMAAAAAAAD', '.M.M..M.M.'],
  ['TMAAAAAAAD', 'M..M...MM.'],
  ['TMAAAAAAAD', '.MM....MM.'],
  ['TMAAAAAAAD', '..MM..MM..'],
];
export const ASCII_LINE_RUN: string[] = ['=^.^=>', '=^-^=>', '=^.^=>', '=^-^=>'];
