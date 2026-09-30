#!/usr/bin/env python3
"""Rasterise ANSI terminal output (truecolor SGR) to a PNG, drawing block elements and braille
geometrically like Ghostty/iTerm do, and other glyphs with a monospace font.

usage: bun run src/tui/dog/sheet.ts | python3 scripts/ansi2png.py out.png [--cell 10x22] [--scale 2] [--font-braille]
Needs Pillow (python3 -m pip install pillow). --font-braille draws braille with the font instead of dots.
"""
import re, sys
from PIL import Image, ImageDraw, ImageFont

args = sys.argv[1:]
out = args[0]
cw, ch = 10, 22
scale = 1
font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
i = 1
while i < len(args):
    if args[i] == '--cell':
        cw, ch = map(int, args[i + 1].split('x')); i += 2
    elif args[i] == '--scale':
        scale = int(args[i + 1]); i += 2
    elif args[i] == '--font':
        font_path = args[i + 1]; i += 2
    else:
        i += 1
cw *= scale; ch *= scale

FONTBRAILLE = '--font-braille' in sys.argv
BG = (35, 38, 46)
FG = (143, 255, 170)
XTERM16 = {30: (0, 0, 0), 31: (205, 49, 49), 32: (13, 188, 121), 33: (229, 229, 16), 34: (36, 114, 200), 35: (188, 63, 188), 36: (17, 168, 205), 37: (229, 229, 229),
           90: (102, 102, 102), 91: (241, 76, 76), 92: (35, 209, 139), 93: (245, 245, 67), 94: (59, 142, 234), 95: (214, 112, 214), 96: (41, 184, 219), 97: (255, 255, 255)}

def c256(n):
    if n < 16:
        return XTERM16.get(30 + n if n < 8 else 90 + n - 8, FG)
    if n < 232:
        n -= 16
        v = [0, 95, 135, 175, 215, 255]
        return (v[n // 36], v[(n // 6) % 6], v[n % 6])
    g = 8 + (n - 232) * 10
    return (g, g, g)

text = sys.stdin.read()
lines = text.split('\n')
if lines and lines[-1] == '':
    lines.pop()

# parse into grid of (char, fg, bg, dim, rev)
grid = []
state = {'fg': None, 'bg': None, 'dim': False, 'rev': False}
tok = re.compile(r'\x1b\[([0-9;]*)m|(.)', re.S)
for line in lines:
    row = []
    for m in tok.finditer(line):
        if m.group(1) is not None or m.group(2) is None:
            ps = [int(p) if p else 0 for p in (m.group(1) or '0').split(';')]
            k = 0
            while k < len(ps):
                p = ps[k]
                if p == 0: state = {'fg': None, 'bg': None, 'dim': False, 'rev': False}
                elif p == 2: state['dim'] = True
                elif p == 22: state['dim'] = False
                elif p == 7: state['rev'] = True
                elif p == 27: state['rev'] = False
                elif p == 39: state['fg'] = None
                elif p == 49: state['bg'] = None
                elif p in (38, 48):
                    key = 'fg' if p == 38 else 'bg'
                    if ps[k + 1] == 2:
                        state[key] = tuple(ps[k + 2:k + 5]); k += 4
                    elif ps[k + 1] == 5:
                        state[key] = c256(ps[k + 2]); k += 2
                elif 30 <= p <= 37 or 90 <= p <= 97: state['fg'] = XTERM16[p]
                elif 40 <= p <= 47 or 100 <= p <= 107: state['bg'] = XTERM16[p - 10]
                k += 1
        else:
            row.append((m.group(2), dict(state)))
    grid.append(row)

W = max((len(r) for r in grid), default=1)
img = Image.new('RGB', (W * cw + 2 * cw, len(grid) * ch + ch), BG)
d = ImageDraw.Draw(img)
font = ImageFont.truetype(font_path, int(ch * 0.62))

def rect(x, y, fx0, fy0, fx1, fy1, col):
    d.rectangle([x + round(fx0 * cw), y + round(fy0 * ch), x + round(fx1 * cw) - 1, y + round(fy1 * ch) - 1], fill=col)

QUAD = {'▖': 'bl', '▗': 'br', '▘': 'tl', '▝': 'tr', '▙': 'tl bl br', '▛': 'tl tr bl', '▜': 'tl tr br', '▟': 'tr bl br', '▚': 'tl br', '▞': 'tr bl'}
QPOS = {'tl': (0, 0, .5, .5), 'tr': (.5, 0, 1, .5), 'bl': (0, .5, .5, 1), 'br': (.5, .5, 1, 1)}

for r, row in enumerate(grid):
    for c, (chr_, s) in enumerate(row):
        x, y = cw + c * cw, ch // 2 + r * ch
        fg = s['fg'] or FG
        bg = s['bg']
        if s['dim']:
            fg = tuple(int(v * 0.6 + b * 0.4) for v, b in zip(fg, BG))
        if s['rev']:
            fg, bg = (bg or BG), fg
        if bg:
            rect(x, y, 0, 0, 1, 1, bg)
        o = ord(chr_)
        if chr_ == ' ':
            continue
        if chr_ == '█': rect(x, y, 0, 0, 1, 1, fg)
        elif chr_ == '▀': rect(x, y, 0, 0, 1, .5, fg)
        elif chr_ == '▄': rect(x, y, 0, .5, 1, 1, fg)
        elif chr_ == '▌': rect(x, y, 0, 0, .5, 1, fg)
        elif chr_ == '▐': rect(x, y, .5, 0, 1, 1, fg)
        elif chr_ == '▔': rect(x, y, 0, 0, 1, 1 / 8, fg)
        elif chr_ == '▕': rect(x, y, 7 / 8, 0, 1, 1, fg)
        elif 0x2581 <= o <= 0x2587: rect(x, y, 0, 1 - (o - 0x2580) / 8, 1, 1, fg)
        elif 0x2589 <= o <= 0x258F: rect(x, y, 0, 0, (0x2590 - o) / 8, 1, fg)
        elif chr_ in QUAD:
            for q in QUAD[chr_].split(): rect(x, y, *QPOS[q], fg)
        elif 0x2800 <= o <= 0x28FF and not FONTBRAILLE:
            bits = o - 0x2800
            dots = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (0, 3), (1, 3)]
            rad = max(1, round(min(cw / 4, ch / 8) * 0.8))
            for b, (dx, dy) in enumerate(dots):
                if bits & (1 << b):
                    cx = x + (dx * 2 + 1) * cw / 4
                    cy = y + (dy * 2 + 1) * ch / 8
                    d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=fg)
        else:
            d.text((x + cw / 2, y + ch / 2), chr_, font=font, fill=fg, anchor='mm')

img.save(out)
print(out, img.size)
