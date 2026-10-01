#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""埋方块 / Fillomino 的美术资产工厂：一条命令重画出盘上全部位图。

    python3 assets/gen/gen_art.py            # 重画 assets/ 下所有位图

为什么要有这个文件而不是手放几张 PNG：图标、纹理、精灵、社交卡画的是**同一套母题**，
而这套母题的颜色必须和 js/theme.js 里的那一份一致。母题一旦只存在于某张位图里，改配色
就会出现"盘上的块是新的、启动图标是旧的"。所以颜色在这里是从 theme.js 的字面量**读出来**的
（PALETTE / DIGIT_FILL 直接正则抽取，不复制粘贴），几何则是代码画出来的——重跑一次逐字节相同。

母题：格子纸上的区块。一块写着 4 的 2×2 方块（描边绿＝"格数对上了"）、一块写着 2 的骨牌
（描边蓝＝"还没长满"）、一枚写着 1 的单格。玩家自己写的数字是琥珀色、作者印上去的是白色，
这条区分和 js/render/board.js 的画法同源。

依赖：Python 3 + Pillow（`pip3 install pillow`）。字体只取 macOS 自带的 Arial / Hiragino，
缺字体会直接报错退出而不是悄悄产出一张没有字的图。
"""
import os
import re
import struct
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit('需要 Pillow：pip3 install pillow')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_ICONS = os.path.join(REPO, 'assets', 'icons')
OUT_IMG = os.path.join(REPO, 'assets', 'img')

SS = 2  # 超采样倍数：几何全部按 2x 画完再 LANCZOS 缩回，圆角与描边才不带锯齿


def read_theme():
    """从 js/theme.js 抽出 Palette 与 DigitFill，位图和画布因此共享同一份颜色。"""
    src = open(os.path.join(REPO, 'js', 'theme.js'), encoding='utf-8').read()
    pal = dict(re.findall(r"^\s*([a-zA-Z]+):\s*'(#[0-9A-Fa-f]{6})'", src, re.M))
    fills = re.findall(r"'(#[0-9A-Fa-f]{6})'", src[src.index('export const DigitFill'):src.index('export const Space')])
    for key in ('accentEdge', 'info', 'success', 'ink'):
        if key not in pal:
            sys.exit('js/theme.js 里找不到颜色令牌 %s，母题无法与画布对齐' % key)
    return pal, fills


PAL, DIGIT_FILL = read_theme()


def rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(c, other, t):
    return tuple(int(round(a + (b - a) * t)) for a, b in zip(c, other))


INK = rgb(PAL['ink'])
ACCENT = rgb(PAL['accentEdge'])
BLUE = rgb(PAL['info'])
GREEN = rgb(PAL['success'])
LINE = rgb(PAL['line'])
BG_TOP = rgb(PAL['bgTop'])
BG_BOTTOM = rgb(PAL['bgBottom'])
FILLS = [rgb(c) for c in DIGIT_FILL]


def font_path(candidates):
    for p in candidates:
        if os.path.exists(p):
            return p
    sys.exit('缺字体：试过的路径 %s' % candidates)


SANS_BOLD = font_path([
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/Library/Fonts/Arial Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
])
CJK = font_path([
    '/System/Library/Fonts/Hiragino Sans GB.ttc',
    '/System/Library/Fonts/Supplemental/Songti.ttc',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
])


def font(path, size):
    from PIL import ImageFont
    return ImageFont.truetype(path, size)


def gradient(size, top, bottom):
    """竖直渐变背景，写成逐行一次 putpixel 太慢，按 1px 高的条带拉伸。"""
    w, h = size
    img = Image.new('RGB', (1, h))
    for y in range(h):
        img.putpixel((0, y), mix(top, bottom, y / max(1, h - 1)))
    return img.resize((w, h), Image.NEAREST)


def lcg(seed):
    s = [seed & 0xFFFFFFFF]

    def nxt():
        s[0] = (s[0] * 1664525 + 1013904223) & 0xFFFFFFFF
        return s[0] / 0xFFFFFFFF
    return nxt


def rounded(d, box, r, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


# ---- 母题本体：区块 + 数字 ------------------------------------------------------------------

# 网格坐标 (列, 行)，4×4 的构图。四格块已经长满（绿描边、作者印的白字），两格块是玩家刚补完的
# （绿描边、琥珀字），写着 3 的那块只有两格——蓝描边说的就是"还差一格"，它右边那格留白。
# 一张图标把玩法的两条判据（面积=数字、绿/蓝两色描边）都讲完，且它自己就是一个合法的 Fillomino 局面。
BLOCKS = [
    {'cells': [(1, 0), (2, 0), (1, 1), (2, 1)], 'n': 4, 'fill': FILLS[3], 'rim': GREEN, 'ink': INK},
    {'cells': [(0, 2), (0, 3)], 'n': 2, 'fill': FILLS[1], 'rim': GREEN, 'ink': ACCENT},
    {'cells': [(2, 2), (3, 2)], 'n': 3, 'fill': FILLS[2], 'rim': BLUE, 'ink': ACCENT},
    {'cells': [(3, 3)], 'n': 1, 'fill': FILLS[0], 'rim': GREEN, 'ink': INK},
]


def motif(img, S, detail=True, scale=1.0):
    """把母题画在 img 上：S 为画布边长，scale 用于 maskable 的安全区。"""
    d = ImageDraw.Draw(img)
    grid = 4
    span = S * 0.60 * scale            # 母题占画布的比例
    cell = span / grid
    ox = (S - span) / 2
    oy = (S - span) / 2

    if detail:
        for i in range(grid + 1):
            d.line([(ox, oy + i * cell), (ox + span, oy + i * cell)], fill=LINE, width=max(1, int(S * 0.0035)))
            d.line([(ox + i * cell, oy), (ox + i * cell, oy + span)], fill=LINE, width=max(1, int(S * 0.0035)))

    lw = max(2, int(S * 0.022 * scale))
    for blk in BLOCKS:
        # 只描"没有同块邻居"的那条边，四格块的轮廓因此是一条闭合粗边，而不是一堆内部分隔线。
        # 这和 js/render/board.js 的画法同源。
        for (cx, cy) in blk['cells']:
            x = ox + cx * cell
            y = oy + cy * cell
            d.rectangle([x + lw / 2, y + lw / 2, x + cell - lw / 2, y + cell - lw / 2], fill=blk['fill'])
        pts = set(blk['cells'])
        for (cx, cy) in blk['cells']:
            x = ox + cx * cell
            y = oy + cy * cell
            if (cx, cy - 1) not in pts:
                d.line([(x, y), (x + cell, y)], fill=blk['rim'], width=lw)
            if (cx, cy + 1) not in pts:
                d.line([(x, y + cell), (x + cell, y + cell)], fill=blk['rim'], width=lw)
            if (cx - 1, cy) not in pts:
                d.line([(x, y), (x, y + cell)], fill=blk['rim'], width=lw)
            if (cx + 1, cy) not in pts:
                d.line([(x + cell, y), (x + cell, y + cell)], fill=blk['rim'], width=lw)
        for (cx, cy) in blk['cells']:
            x = ox + cx * cell
            y = oy + cy * cell
            if not detail:
                continue
            f = font(SANS_BOLD, int(cell * 0.62))
            label = str(blk['n'])
            box = d.textbbox((0, 0), label, font=f)
            d.text((x + cell / 2 - (box[0] + box[2]) / 2, y + cell / 2 - (box[1] + box[3]) / 2),
                   label, font=f, fill=blk['ink'])


def icon(S, maskable=False):
    """一张位图图标。maskable 走 Android 的 80% 安全区，圆角版留给 favicon 与 iOS。"""
    big = S * SS
    g = gradient((big, big), mix(BG_TOP, BG_BOTTOM, 0.15), BG_BOTTOM).convert('RGBA')
    if maskable:
        img = g
    else:
        # 圆角外留透明：先按同一颗圆角做遮罩再贴，比在透明底上直接画少一圈毛边。
        rnd = big * 0.225
        mask = Image.new('L', (big, big), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, big, big], radius=rnd, fill=255)
        img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
        img.paste(g, (0, 0), mask)
        d = ImageDraw.Draw(img)
        inset = big * 0.014
        d.rounded_rectangle([inset, inset, big - inset, big - inset], radius=rnd * 0.94,
                            outline=mix(LINE, INK, 0.18), width=int(big * 0.013))
    motif(img, big, detail=S >= 96, scale=0.80 if maskable else 1.0)
    return img.resize((S, S), Image.LANCZOS)


def paper_tile(S=256, pitch=64):
    """可无缝平铺的格子纸：画布 board.js 把它铺在盘面底下，纹理因此和图标同源。"""
    big = S * SS
    img = Image.new('RGBA', (big, big), rgb(PAL['surfaceLift']) + (255,))
    d = ImageDraw.Draw(img)
    rand = lcg(20260930)
    scale = big / S
    for i in range(int((big * big) / 2600)):
        x = rand() * big
        y = rand() * big
        a = int(6 + rand() * 12)
        d.point((x, y), fill=mix(rgb(PAL['surfaceLift']), INK, 0.5) + (a,))
    minor = mix(rgb(PAL['surface']), LINE, 0.45)
    major = LINE
    step = pitch * scale
    for k in range(0, int(big / step) + 1):
        p = k * step
        d.line([(p, 0), (p, big)], fill=minor + (120,), width=max(1, int(scale)))
        d.line([(0, p), (big, p)], fill=minor + (120,), width=max(1, int(scale)))
    d.line([(0, 0), (big, 0)], fill=major + (150,), width=int(2 * scale))
    d.line([(0, 0), (0, big)], fill=major + (150,), width=int(2 * scale))
    return img.resize((S, S), Image.LANCZOS)


def sprite_sheet(chip=64):
    """胜利粒子用的精灵条：8 个色块一行，取号即取色，画布只需一次 drawImage。"""
    big = chip * SS
    n = len(FILLS)
    img = Image.new('RGBA', (big * n, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for i, c in enumerate(FILLS):
        x = i * big
        rim = [GREEN, BLUE][i % 2]
        r = big * 0.26
        d.rounded_rectangle([x + big * 0.06, big * 0.06, x + big * 0.94, big * 0.94], radius=r,
                            fill=c, outline=rim, width=int(big * 0.09))
        d.rounded_rectangle([x + big * 0.22, big * 0.20, x + big * 0.52, big * 0.42], radius=r * 0.5,
                            fill=mix(c, INK, 0.22) + (120,))
    return img.resize((chip * n, chip), Image.LANCZOS)


def og_card(W=1200, H=630):
    """社交卡：左文案右盘面。OG/Twitter 都取这一张，避免两套图各自过期。"""
    big_w, big_h = W * SS, H * SS
    img = gradient((big_w, big_h), mix(BG_TOP, BG_BOTTOM, 0.1), BG_BOTTOM).convert('RGBA')
    d = ImageDraw.Draw(img)
    step = big_h / 9
    for k in range(10):
        d.line([(0, k * step), (big_w, k * step)], fill=LINE + (90,), width=max(1, SS))
        d.line([(k * step, 0), (k * step, big_h)], fill=LINE + (90,), width=max(1, SS))

    pad = big_h * 0.10
    title = '埋方块'
    d.text((pad, big_h * 0.13), title, font=font(CJK, int(big_h * 0.21)), fill=INK)
    d.text((pad, big_h * 0.40), 'Fillomino · 区域格数推理',
           font=font(CJK, int(big_h * 0.072)), fill=BLUE)
    d.text((pad, big_h * 0.545), '每一块相连的同数区域，', font=font(CJK, int(big_h * 0.055)), fill=mix(INK, BG_BOTTOM, 0.28))
    d.text((pad, big_h * 0.625), '格数刚好等于它写着的那个数。', font=font(CJK, int(big_h * 0.055)), fill=mix(INK, BG_BOTTOM, 0.28))

    chips = ['每局唯一解', '铅笔规则推到底', '离线可玩']
    x = pad
    for t in chips:
        f = font(CJK, int(big_h * 0.040))
        box = d.textbbox((0, 0), t, font=f)
        w = box[2] - box[0] + big_h * 0.050
        h = box[3] - box[1] + big_h * 0.038
        y = big_h * 0.775
        rounded(d, [x, y, x + w, y + h], h * 0.42, fill=mix(BG_TOP, LINE, 0.5), outline=BLUE, width=int(big_h * 0.0045))
        d.text((x + w / 2 - (box[0] + box[2]) / 2, y + h / 2 - (box[1] + box[3]) / 2), t, font=f, fill=INK)
        x += w + big_h * 0.033

    # 右侧示范盘：5×5 满盘。这一份是 js/engine/generate.js 的 plantSolution(5,5,5) 在种子 7 下
    # 真实吐出的解（不是手摆的），所以卡上不会出现"一块写着 4 却只有 3 格"这种外行错。
    demo = [
        [1, 3, 3, 1, 2],
        [4, 3, 4, 4, 2],
        [4, 4, 2, 4, 3],
        [5, 4, 2, 4, 3],
        [5, 5, 5, 5, 3],
    ]
    span = big_h * 0.72
    cell = span / 5
    bx = big_w - pad - span
    by = (big_h - span) / 2
    d.rounded_rectangle([bx - cell * 0.18, by - cell * 0.18, bx + span + cell * 0.18, by + span + cell * 0.18],
                        radius=cell * 0.30, fill=rgb(PAL['surface']) + (235,), outline=mix(LINE, INK, 0.15),
                        width=int(big_h * 0.006))
    # 相邻的同数格本来就是一块（这条规则就是玩法本身），所以按同值连通分量分组来描边。
    seen = [[False] * 5 for _ in range(5)]
    lw = int(cell * 0.11)
    df = font(SANS_BOLD, int(cell * 0.60))
    for gy in range(5):
        for gx in range(5):
            if seen[gy][gx]:
                continue
            v = demo[gy][gx]
            stack = [(gx, gy)]
            comp = []
            while stack:
                cx, cy = stack.pop()
                if seen[cy][cx] or demo[cy][cx] != v:
                    continue
                seen[cy][cx] = True
                comp.append((cx, cy))
                stack += [(cx + dx, cy + dy) for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                          if 0 <= cx + dx < 5 and 0 <= cy + dy < 5]
            pts = set(comp)
            # 一块一个填充色：和画布同源，DigitFill[数字-1]。
            fill = FILLS[(v - 1) % len(FILLS)]
            # 大块的数字算"作者印的"（白），小块算"玩家写的"（琥珀）——和盘面上两种字色同一套语义。
            ink = INK if v >= 4 else ACCENT
            for (cx, cy) in comp:
                x = bx + cx * cell
                y = by + cy * cell
                d.rectangle([x + lw / 2, y + lw / 2, x + cell - lw / 2, y + cell - lw / 2], fill=fill)
            for (cx, cy) in comp:
                x = bx + cx * cell
                y = by + cy * cell
                if (cx, cy - 1) not in pts:
                    d.line([(x, y), (x + cell, y)], fill=GREEN, width=lw)
                if (cx, cy + 1) not in pts:
                    d.line([(x, y + cell), (x + cell, y + cell)], fill=GREEN, width=lw)
                if (cx - 1, cy) not in pts:
                    d.line([(x, y), (x, y + cell)], fill=GREEN, width=lw)
                if (cx + 1, cy) not in pts:
                    d.line([(x + cell, y), (x + cell, y + cell)], fill=GREEN, width=lw)
            for (cx, cy) in comp:
                x = bx + cx * cell
                y = by + cy * cell
                box = d.textbbox((0, 0), str(v), font=df)
                d.text((x + cell / 2 - (box[0] + box[2]) / 2, y + cell / 2 - (box[1] + box[3]) / 2),
                       str(v), font=df, fill=ink)
    return img.resize((W, H), Image.LANCZOS)


def write(img, rel):
    path = os.path.join(REPO, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, 'PNG', optimize=True)
    with open(path, 'rb') as fh:
        raw = fh.read(33)
    w, h = struct.unpack('>II', raw[16:24])
    print('  %-42s %4dx%-4d %6d B' % (rel, w, h, os.path.getsize(path)))
    assert raw[:8] == b'\x89PNG\r\n\x1a\n', rel


def main():
    print('theme 抽取：Palette %d 个十六进制令牌，DigitFill %d 色' % (len(PAL), len(FILLS)))
    jobs = [
        ('assets/icons/icon-1024.png', icon(1024)),
        ('assets/icons/icon-512.png', icon(512)),
        ('assets/icons/icon-256.png', icon(256)),
        ('assets/icons/icon-192.png', icon(192)),
        ('assets/icons/icon-180.png', icon(180)),
        ('assets/icons/icon-maskable-512.png', icon(512, maskable=True)),
        ('assets/icons/apple-touch-icon.png', icon(180)),
        ('assets/icons/icon-96.png', icon(96)),
        ('assets/icons/favicon-48.png', icon(48)),
        ('assets/icons/favicon-32.png', icon(32)),
        ('assets/icons/favicon-16.png', icon(16)),
        ('assets/img/og-cover.png', og_card()),
        ('assets/img/paper-grid.png', paper_tile()),
        ('assets/img/particles.png', sprite_sheet()),
    ]
    for rel, img in jobs:
        write(img, rel)
    print('ok: %d 张位图重画完成（颜色取自 js/theme.js）' % len(jobs))


if __name__ == '__main__':
    main()
