/**
 * Pixel-art frames for the salu dog. One character per pixel, two pixels per terminal cell
 * (rendered with ▀ ▄ half blocks in render.ts). Palette letters map to salu greens only:
 *   A accent (bright)   T text (light)   M ok (mid)   D chrome (dim)   . transparent
 * The dog faces right. Every frame in a set has the same size. Half blocks make square
 * pixels, so these read at true proportions (a terminal cell is about twice as tall as wide).
 */
export type Pixel = 'A' | 'T' | 'M' | 'D' | '.';

export const WIDTH = 36;

/** Run cycle (gather, reach, tuck, push): a lean dog with a pointed ear, long muzzle and raised tail. 36 x 20 pixels = 10 terminal rows. */
export const RUN: string[][] = [
  [
    'DTD.......................D.........',
    'DTD......................DMDDDDD....',
    'DMD.....................DMMAAAAAD...',
    '.DMD...................DMMAAADAADDD.',
    '.DMMD.................DADDAAAAAAAAAD',
    '..DMMDDDDDDDDDDDDDDDDDDAAAAAAAAAAAAD',
    '...DMMAAAAAAAAAAAAAAAAAAAAAAAAAAMMAA',
    '....DMMAAAAAAAAAAAAAAAAAAAAAADDDMMMD',
    '....DMAAAAAAAAAAAAAAAMAAAAMDD...DDD.',
    '....DMMMMMMMMMMMMMMMMMAAAAMD........',
    '....DMMMMMMMMMMMMMMMMMAAAAMD........',
    '.....DMMMMMMMMMMMMMMMMMMMMMD........',
    '......DMMDDDDDDDDDDDDMMMMMMD........',
    '......DMMD...........DMMDDD.........',
    '.......DMMD..........DMMD...........',
    '.......DMMD..........DMMD...........',
    '.......DMMD..........DMMD...........',
    '.......DMMD..........DMMD...........',
    '.......DMMD..........DMMD...........',
    '.......DMMD..........DMMD...........',
  ],
  [
    'DTD.......................D.........',
    'DTD......................DMDDDDD....',
    'DMD.....................DMMAAAAAD...',
    '.DMD...................DMMAAADAADDD.',
    '.DMMD.................DADDAAAAAAAAAD',
    '..DMMDDDDDDDDDDDDDDDDDDAAAAAAAAAAAAD',
    '...DMMAAAAAAAAAAAAAAAAAAAAAAAAAAMMAA',
    '....DMMAAAAAAAAAAAAAAAAAAAAAADDDMMMD',
    '....DMAAAAAAAAAAAAAAAMAAAAMDD...DDD.',
    '....DMMMMMMMMMMMMMMMMMAAAAMD........',
    '....DMMMMMMMMMMMMMMMMMAAAAMD........',
    '.....DMMMMMMMMMMMMMMMMMMMMMD........',
    '....DMMMDDDDDDDDDDDDDMMMMMMD........',
    '..DDMMDD.............DDDDMMDD.......',
    '.DMMMD...................DMMMD......',
    'DMMDD.....................DDMMDD....',
    'DMMD........................DMMMD...',
    'MMD..........................DDMMD..',
    'MMD............................DD...',
    'DD..................................',
  ],
  [
    'DTD.......................D.........',
    'DTD......................DMDDDDD....',
    'DMD.....................DMMAAAAAD...',
    '.DMD...................DMMAAADAADDD.',
    '.DMMD.................DADDAAAAAAAAAD',
    '..DMMDDDDDDDDDDDDDDDDDDAAAAAAAAAAAAD',
    '...DMMAAAAAAAAAAAAAAAAAAAAAAAAAAMMAA',
    '....DMMAAAAAAAAAAAAAAAAAAAAAADDDMMMD',
    '....DMAAAAAAAAAAAAAAAMAAAAMDD...DDD.',
    '....DMMMMMMMMMMMMMMMMMAAAAMD........',
    '....DMMMMMMMMMMMMMMMMMAAAAMD........',
    '.....DMMMMMMMMMMMMMMMMMMMMMD........',
    '......DDMMDDDDDDDDDDDMMMMMMD........',
    '.......DMMD..........DMMDDD.........',
    '........DMMD........DMMD............',
    '........DMMD........DMMD............',
    '.........DMMD.......DMMD............',
    '..........DMMD.....DMMD.............',
    '...........DMMD...DMMD..............',
    '............DD.....DD...............',
  ],
  [
    'DTD.......................D.........',
    'DTD......................DMDDDDD....',
    'DMD.....................DMMAAAAAD...',
    '.DMD...................DMMAAADAADDD.',
    '.DMMD.................DADDAAAAAAAAAD',
    '..DMMDDDDDDDDDDDDDDDDDDAAAAAAAAAAAAD',
    '...DMMAAAAAAAAAAAAAAAAAAAAAAAAAAMMAA',
    '....DMMAAAAAAAAAAAAAAAAAAAAAADDDMMMD',
    '....DMAAAAAAAAAAAAAAAMAAAAMDD...DDD.',
    '....DMMMMMMMMMMMMMMMMMAAAAMD........',
    '....DMMMMMMMMMMMMMMMMMAAAAMD........',
    '.....DMMMMMMMMMMMMMMMMMMMMMD........',
    '......DDMMDDDDDDDDDDDMMMMMMD........',
    '........DMMMD......DMMDDDDD.........',
    '.........DDMMD....DMMD..............',
    '...........DMMD..DMMD...............',
    '...........DMMD.DMMD................',
    '...........DMMDDMMD.................',
    '..........DMMD.DMMD.................',
    '..........DMMDDMMD..................',
  ],
];

/**
 * Sleeping dog for when nothing runs: lying down, head on its paws, one ear up, tail curled,
 * a small z / big Z floating up beside it and the flank rising and falling. 36 x 16 pixels = 8 rows.
 */
export const SLEEP: string[][] = [
  [
    '....................................',
    '....................................',
    '....................................',
    '....................................',
    '.....................DD.............',
    '....................DMMD............',
    '...................DMAAMD...........',
    '......DDDDDDDDDDDDDDMMAMMDDD.TT.....',
    '..DDDDMAAAAAAAAAAAAAAMMMAAAAD.T.....',
    '.DTTMMMAAAAAAAAAAAAAAMAAAAAAADTT....',
    'DMMDMMMAAAAAAAAAAAAAAMAAAAAAADDDD...',
    'DMDDMMDDDDMMMMMMMMMMMMAAAADDAAAAAD..',
    '.DMMMDMMMMDMMMMMMMMMMMAAAAAAAAAAAD..',
    '..DDMDMMMMDMMMMMMMMMMMAAAAAAAMMMMMDD',
    '....DMDDDDMMMMMMMMMMMMMMMMMMMMMMMMMM',
    '.....D....DDDDDDDDDDDDDDAAAAAMAAMAAD',
  ],
  [
    '....................................',
    '....................................',
    '....................................',
    '....................................',
    '.....................DD..........TT.',
    '....................DMMD......TT..T.',
    '...................DMAAMD......T..TT',
    '...................DMMAMMDDD...TT...',
    '..DD..DDDDDDDDDDDDDDDMMMAAAAD.......',
    '.DTTDDMAAAAAAAAAAAAAAMAAAAAAAD......',
    'DMMDMMMAAAAAAAAAAAAAAMAAAAAAADDDD...',
    'DMDDMMDDDDAAAAAAAAAAAMAAAADDAAAAAD..',
    '.DMMMDMMMMDMMMMMMMMMMMAAAAAAAAAAAD..',
    '..DDMDMMMMDMMMMMMMMMMMAAAAAAAMMMMMDD',
    '....DMDDDDMMMMMMMMMMMMMMMMMMMMMMMMMM',
    '.....D....DDDDDDDDDDDDDDAAAAAMAAMAAD',
  ],
  [
    '....................................',
    '....................................',
    '....................................',
    '..............................TTTT..',
    '.....................DD.........T...',
    '....................DMMD.......T....',
    '...................DMAAMD.....TTTT..',
    '......DDDDDDDDDDDDDDMMAMMDDD........',
    '..DDDDMAAAAAAAAAAAAAAMMMAAAAD.......',
    '.DTTMMMAAAAAAAAAAAAAAMAAAAAAAD......',
    'DMMDMMMAAAAAAAAAAAAAAMAAAAAAADDDD...',
    'DMDDMMDDDDMMMMMMMMMMMMAAAADDAAAAAD..',
    '.DMMMDMMMMDMMMMMMMMMMMAAAAAAAAAAAD..',
    '..DDMDMMMMDMMMMMMMMMMMAAAAAAAMMMMMDD',
    '....DMDDDDMMMMMMMMMMMMMMMMMMMMMMMMMM',
    '.....D....DDDDDDDDDDDDDDAAAAAMAAMAAD',
  ],
  [
    '....................................',
    '...............................TTTT.',
    '.................................T..',
    '................................T...',
    '.....................DD........TTTT.',
    '....................DMMD............',
    '...................DMAAMD....TT.....',
    '...................DMMAMMDDD..T.....',
    '..DD..DDDDDDDDDDDDDDDMMMAAAAD.TT....',
    '.DTTDDMAAAAAAAAAAAAAAMAAAAAAAD......',
    'DMMDMMMAAAAAAAAAAAAAAMAAAAAAADDDD...',
    'DMDDMMDDDDAAAAAAAAAAAMAAAADDAAAAAD..',
    '.DMMMDMMMMDMMMMMMMMMMMAAAAAAAAAAAD..',
    '..DDMDMMMMDMMMMMMMMMMMAAAAAAAMMMMMDD',
    '....DMDDDDMMMMMMMMMMMMMMMMMMMMMMMMMM',
    '.....D....DDDDDDDDDDDDDDAAAAAMAAMAAD',
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
  ['           z  ', '       /\\     ', ' ,----/ \\__   ', ' \\_______,--\' '],
  ['          z z ', '       /\\     ', ' ,----/ \\__   ', ' \\_______,--\' '],
  ['          Z   ', '       /\\     ', ' ,----/ \\__   ', ' \\_______,--\' '],
  ['           z  ', '       /\\     ', ' ,----/ \\__   ', ' \\_______,--\' '],
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
