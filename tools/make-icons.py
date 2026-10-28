"""生成 AI 答题助手图标（16/32/48/128）。"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets")
S = 512


def gradient(size, c1, c2, angle=0.55):
    x = np.linspace(0, 1, size)
    y = np.linspace(0, 1, size)
    xx, yy = np.meshgrid(x, y)
    t = np.clip(xx * (1 - angle) + yy * angle, 0, 1)[..., None]
    arr = np.array(c1, dtype=float) + (np.array(c2, dtype=float) - np.array(c1, dtype=float)) * t
    return Image.fromarray(arr.astype("uint8"), "RGB")


def _sgnpow(v, e):
    return math.copysign(abs(v) ** e, v)


def star_mask(size, cx, cy, r, power=2.6, points=4, samples=1440):
    """四角星（sparkle）遮罩：星形线参数方程，尖角细长。"""
    img = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(img)
    poly = []
    for i in range(samples):
        th = 2 * math.pi * i / samples
        poly.append((cx + r * _sgnpow(math.sin(th), power), cy - r * _sgnpow(math.cos(th), power)))
    draw.polygon(poly, fill=255)
    return img


def main():
    os.makedirs(OUT, exist_ok=True)

    bg = gradient(S, (86, 132, 255), (168, 85, 247), 0.62)

    # 圆角矩形遮罩
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.26), fill=255)

    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)

    # 顶部高光
    gloss = Image.new("L", (S, S), 0)
    ImageDraw.Draw(gloss).ellipse((-S * 0.25, -S * 0.85, S * 1.25, S * 0.42), fill=48)
    gloss = gloss.filter(ImageFilter.GaussianBlur(S * 0.05))
    icon = Image.composite(Image.new("RGBA", (S, S), (255, 255, 255, 255)), icon, Image.eval(gloss, lambda v: v))

    # 主星 + 小星
    big = star_mask(S, S * 0.45, S * 0.50, S * 0.37, power=2.7, points=4)
    small = star_mask(S, S * 0.775, S * 0.745, S * 0.14, power=2.5, points=4)

    glow = big.filter(ImageFilter.GaussianBlur(S * 0.045))
    glow = Image.eval(glow, lambda v: int(v * 0.55))
    icon = Image.composite(Image.new("RGBA", (S, S), (255, 255, 255, 255)), icon, glow)

    white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    icon = Image.composite(white, icon, big)
    icon = Image.composite(white, icon, Image.eval(small, lambda v: int(v * 0.92)))

    for size in (128, 48, 32, 16):
        out = icon.resize((size, size), Image.LANCZOS)
        path = os.path.join(OUT, "icon%d.png" % size)
        out.save(path, "PNG")
        print("wrote", path, out.size)


if __name__ == "__main__":
    main()