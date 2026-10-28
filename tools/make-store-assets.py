"""生成应用商店用的宣传图（小图 440×280，大图 1400×560）。

用法：python tools/make-store-assets.py
产物：store/promo-440x280.png、store/promo-1400x560.png
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.path.join(ROOT, "store")
ICON = os.path.join(STORE, "icon-300.png")

BOLD_CANDIDATES = [
    "C:/Windows/Fonts/seguisb.ttf",
    "C:/Windows/Fonts/segoeuib.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
CJK_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
]


def pick_font(candidates, size):
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def gradient(w, h, c1=(79, 124, 255), c2=(168, 85, 247), angle=0.62):
    x = np.linspace(0, 1, w)
    y = np.linspace(0, 1, h)
    xx, yy = np.meshgrid(x, y)
    t = np.clip(xx * (1 - angle) + yy * angle, 0, 1)[..., None]
    arr = np.array(c1, float) + (np.array(c2, float) - np.array(c1, float)) * t
    return Image.fromarray(arr.astype("uint8"), "RGB").convert("RGBA")


def add_glow(base, cx, cy, r, color=(255, 255, 255), alpha=60):
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color + (alpha,))
    base.alpha_composite(layer.filter(ImageFilter.GaussianBlur(r * 0.55)))


def sparkle(draw, cx, cy, r, fill, power=2.7, samples=400):
    pts = []
    for i in range(samples):
        th = 2 * math.pi * i / samples
        pts.append((cx + r * math.copysign(abs(math.sin(th)) ** power, math.sin(th)),
                    cy - r * math.copysign(abs(math.cos(th)) ** power, math.cos(th))))
    draw.polygon(pts, fill=fill)


def build(w, h, icon_size, pad, title_size, sub_size, out_name):
    img = gradient(w, h)
    add_glow(img, pad + icon_size * 0.55, h * 0.5, icon_size * 1.15, (255, 255, 255), 46)

    icon = Image.open(ICON).convert("RGBA").resize((icon_size, icon_size), Image.LANCZOS)
    icon_y = (h - icon_size) // 2

    # 图标投影，避免和背景糊在一起
    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(
        (pad, icon_y + int(icon_size * 0.06),
         pad + icon_size, icon_y + icon_size + int(icon_size * 0.06)),
        radius=int(icon_size * 0.26), fill=(20, 20, 60, 90))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(icon_size * 0.10)))
    img.alpha_composite(icon, (pad, icon_y))

    draw = ImageDraw.Draw(img)
    f_title = pick_font(BOLD_CANDIDATES, title_size)
    f_sub = pick_font(CJK_CANDIDATES, sub_size)

    tx = pad + icon_size + int(icon_size * 0.32)

    # 标题：白色
    title = "ai-answer-helper"
    draw.text((tx, h * 0.5 - title_size * 0.86), title, font=f_title, fill=(255, 255, 255, 255))

    # 副标题：半透明白
    sub = "网页题目 · AI 解答"
    draw.text((tx + 2, h * 0.5 + title_size * 0.30), sub, font=f_sub, fill=(255, 255, 255, 205))

    # 装饰：两颗小星星
    sparkle(draw, w - int(w * 0.06), int(h * 0.18), int(h * 0.055), (255, 255, 255, 60))
    sparkle(draw, w - int(w * 0.11), int(h * 0.86), int(h * 0.032), (255, 255, 255, 45))

    out = os.path.join(STORE, out_name)
    img.convert("RGB").save(out, "PNG")
    print("wrote", out, img.size)


def main():
    os.makedirs(STORE, exist_ok=True)
    if not os.path.exists(ICON):
        raise SystemExit("先运行 tools/make-icons.py 生成 store/icon-300.png")
    build(440, 280, 92, 34, 28, 17, "promo-440x280.png")
    build(1400, 560, 190, 96, 62, 30, "promo-1400x560.png")


if __name__ == "__main__":
    main()