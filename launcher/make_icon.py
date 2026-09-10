"""生成应用图标（多分辨率 ICO）。

用几何图形绘制 SIP 广播示意图标，无需外部素材：
深色圆角底板 + 绿色广播塔 + 左右声波弧线。

用法：
    python make_icon.py [输出路径]

默认输出到 launcher/assets/app.ico。
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

# 与启动器托盘图标保持一致的配色
COLOR_ACTIVE = "#3fb950"
COLOR_BACKDROP = "#1f2430"

# ICO 内需要包含的尺寸
ICON_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def draw_icon(size: int, color: str = COLOR_ACTIVE) -> Image.Image:
    """按给定边长绘制图标。所有尺寸按比例缩放，保证小尺寸下仍可辨识。"""
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    s = size

    # 圆角底板
    draw.rounded_rectangle(
        [0, 0, s - 1, s - 1],
        radius=max(1, int(s * 0.22)),
        fill=COLOR_BACKDROP,
    )

    center = s / 2
    radius = max(1, s * 0.095)

    # 广播塔顶端
    draw.ellipse(
        [center - radius, center - radius * 1.2, center + radius, center + radius * 0.8],
        fill=color,
    )
    # 支杆
    draw.line(
        [center, center + radius * 0.8, center, s * 0.80],
        fill=color,
        width=max(1, int(s * 0.055)),
    )
    # 左右声波弧线
    for offset, width_ratio in ((0.22, 0.045), (0.34, 0.040)):
        o = s * offset
        draw.arc(
            [center - o, center - o * 0.95, center + o, center + o * 0.95],
            start=205,
            end=335,
            fill=color,
            width=max(1, int(s * width_ratio)),
        )

    return image


def main() -> int:
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "assets" / "app.ico"
    output.parent.mkdir(parents=True, exist_ok=True)

    # Pillow 会从最大尺寸生成全部子尺寸；必须先渲染 256 再保存
    draw_icon(256).save(output, format="ICO", sizes=ICON_SIZES)

    print(f"已生成图标: {output} ({output.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
