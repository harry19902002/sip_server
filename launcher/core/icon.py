"""应用图标的绘制核心。

图标语义：圆角底板 + 白色喇叭 + 右侧声波弧线，直接表达「SIP 广播」。
同一份绘制逻辑同时供三处使用，保证形状完全一致：

    * launcher/make_icon.py   → 生成 assets/app.ico（exe 与安装包图标）
    * launcher/main.py        → 托盘图标（底板换成服务状态色）
    * scripts（可选）          → 导出 PNG 给网页 favicon 参考

小尺寸处理（这是重点，之前旧图标就栽在这）：
    16/20/24px 下声波弧线与箱体的间隙不足 2px，画上去只会糊成一个孤立的点，
    所以这些尺寸只保留喇叭主体；32px 起画一道弧，48px 起画两道。线宽另有
    下限约束，避免缩到子像素后变成半透明噪点。
"""

from __future__ import annotations

from PIL import Image, ImageDraw

# 与 app/globals.css 的 .brand-mark 渐变对应（#2787ff → #125bc6）
GRADIENT_START = (0x2E, 0x8B, 0xFF)
GRADIENT_END = (0x0B, 0x4F, 0xB3)
GLYPH = (255, 255, 255, 255)

# 超采样画布边长：所有几何参数以此坐标系为基准
RENDER = 1024

# 底板圆角半径占画布比例（与 .brand-mark 的 10/35 接近）
CORNER_RATIO = 0.225

# ---------------------------------------------------------------- 几何参数
# 比例参考常见「扬声器」图标：箱体接近正方形，喇叭口高度约为箱体的 1.9 倍。
# 箱体压得太扁会让小尺寸图形变成一根尖刺。
DRIVER_BOX = (150, 404, 302, 620)  # 左、上、右、下
DRIVER_RADIUS = 40

CONE_X = 512  # 喇叭口所在竖边
CONE_TIP_TOP = 300
CONE_TIP_BOTTOM = 724

WAVE_CENTER = (512, 512)
WAVES = [(104, 58), (188, 56)]  # (半径, 线宽)，由内到外
WAVE_ANGLES = (-48, 48)

# 图形在底板里占据的最大边长（占画布比例）
GLYPH_FILL = 0.66
GLYPH_FILL_SMALL = 0.78  # ≤32px 时收紧边距，否则图形太小

# 声波弧线的最小可见线宽（像素）
MIN_STROKE_PX = 1.9


def wave_count(size: int) -> int:
    """按目标尺寸决定画几道声波。"""
    if size < 32:
        return 0
    if size < 48:
        return 1
    return 2


def _diagonal_gradient(size: int) -> Image.Image:
    """左上→右下的对角线性渐变。先在 128px 上算再放大，保证平滑无色带。"""
    small = 128
    gradient = Image.new("RGB", (small, small))
    pixels = gradient.load()
    span = 2 * (small - 1)
    for y in range(small):
        for x in range(small):
            t = (x + y) / span
            pixels[x, y] = (
                round(GRADIENT_START[0] + (GRADIENT_END[0] - GRADIENT_START[0]) * t),
                round(GRADIENT_START[1] + (GRADIENT_END[1] - GRADIENT_START[1]) * t),
                round(GRADIENT_START[2] + (GRADIENT_END[2] - GRADIENT_START[2]) * t),
            )
    return gradient.resize((size, size), Image.BICUBIC)


def _rounded_mask() -> Image.Image:
    mask = Image.new("L", (RENDER, RENDER), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, RENDER - 1, RENDER - 1],
        radius=int(RENDER * CORNER_RATIO),
        fill=255,
    )
    return mask


def draw_plate(size: int = RENDER, color: str | None = None) -> Image.Image:
    """圆角底板，带一层很淡的顶部高光。

    color 为空时用品牌蓝渐变；非空时用纯色铺底（托盘按服务状态换色）。
    """
    mask = _rounded_mask()

    fill = (
        Image.new("RGBA", (RENDER, RENDER), color)
        if color
        else _diagonal_gradient(RENDER).convert("RGBA")
    )
    plate = Image.new("RGBA", (RENDER, RENDER), (0, 0, 0, 0))
    plate.paste(fill, (0, 0), mask)

    # 顶部高光：白色，透明度自上而下衰减，限制在底板内部
    gloss_alpha = Image.new("L", (RENDER, RENDER), 0)
    gloss_draw = ImageDraw.Draw(gloss_alpha)
    height = int(RENDER * 0.55)
    for y in range(height):
        value = int(22 * (1 - y / height) ** 1.4)
        if value:
            gloss_draw.line([(0, y), (RENDER, y)], fill=value)
    gloss_alpha = Image.composite(gloss_alpha, Image.new("L", (RENDER, RENDER), 0), mask)

    gloss_layer = Image.new("RGBA", (RENDER, RENDER), (255, 255, 255, 0))
    gloss_layer.putalpha(gloss_alpha)
    plate = Image.alpha_composite(plate, gloss_layer)
    return plate if size == RENDER else plate.resize((size, size), Image.LANCZOS)


def _raw_glyph(stroke_scale: float = 1.0, waves: int = 2) -> Image.Image:
    """按原始坐标绘制白色喇叭 + 声波，返回未裁切的图层。

    stroke_scale 用于在缩小渲染时按比例加粗线宽，保证落到底图像素后弧线
    仍有 2px 左右宽度，而不是变成半透明的散点。
    """
    glyph = Image.new("RGBA", (RENDER, RENDER), (0, 0, 0, 0))
    g = ImageDraw.Draw(glyph)

    # 喇叭箱体
    g.rounded_rectangle(
        [DRIVER_BOX[0], DRIVER_BOX[1], DRIVER_BOX[2], DRIVER_BOX[3]],
        radius=DRIVER_RADIUS,
        fill=GLYPH,
    )
    # 喇叭口：向右张开的梯形
    g.polygon(
        [
            (DRIVER_BOX[2], DRIVER_BOX[1]),
            (CONE_X, CONE_TIP_TOP),
            (CONE_X, CONE_TIP_BOTTOM),
            (DRIVER_BOX[2], DRIVER_BOX[3]),
        ],
        fill=GLYPH,
    )

    # 声波弧线
    cx, cy = WAVE_CENTER
    for radius, width in WAVES[:waves]:
        g.arc(
            [cx - radius, cy - radius, cx + radius, cy + radius],
            start=WAVE_ANGLES[0],
            end=WAVE_ANGLES[1],
            fill=GLYPH,
            width=max(1, round(width * stroke_scale)),
        )
    return glyph


def _cropped_glyph(stroke_scale: float = 1.0, waves: int = 2) -> Image.Image:
    """绘制并裁到内容边界（去掉四周空白），返回紧凑图层。"""
    raw = _raw_glyph(stroke_scale, waves)
    bbox = raw.getchannel("A").getbbox()
    if bbox is None:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0))
    return raw.crop(bbox)


def draw_glyph(canvas: int = RENDER, fill_ratio: float = GLYPH_FILL) -> Image.Image:
    """返回居中、按内容包围盒等比缩放后的白色图形（透明底）。

    先量出原始内容尺寸算出缩放比，再按该比例反推线宽下限重绘，最后裁切缩放。
    因此任何尺寸下图形都居中、边距均匀、线条不断裂。
    """
    waves = wave_count(canvas)

    probe = _cropped_glyph(1.0, waves)
    target = max(1, int(canvas * fill_ratio))
    scale = target / max(probe.size)
    stroke_scale = (
        max(1.0, (MIN_STROKE_PX / scale) / min(w for _, w in WAVES[:waves]))
        if waves
        else 1.0
    )

    glyph = _cropped_glyph(stroke_scale, waves)
    w, h = glyph.size
    factor = target / max(w, h)
    resized = glyph.resize(
        (max(1, round(w * factor)), max(1, round(h * factor))), Image.LANCZOS
    )

    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.alpha_composite(
        resized,
        ((canvas - resized.width) // 2, (canvas - resized.height) // 2),
    )
    return out


def build_icon(size: int = RENDER, color: str | None = None) -> Image.Image:
    """合成完整图标。color 非空时用纯色底板（托盘状态色用）。"""
    fill_ratio = GLYPH_FILL_SMALL if size <= 32 else GLYPH_FILL
    return Image.alpha_composite(draw_plate(size, color), draw_glyph(size, fill_ratio))
