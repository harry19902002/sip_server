"""生成应用图标（多分辨率 ICO）。

形状定义在 launcher/core/icon.py，与托盘图标共用同一份绘制逻辑。
本脚本只负责把各尺寸组装成 ICO 容器，并额外导出一张 PNG 预览。

用法：
    python make_icon.py [输出路径]

默认输出 launcher/assets/app.ico，同时写出 app.png（256×256 预览）。
"""

from __future__ import annotations

import io
import struct
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from launcher.core.icon import build_icon  # noqa: E402

# ICO 内包含的尺寸，额外补 20/40/96 覆盖 125%、150%、300% 缩放
ICON_SIZES = [
    (16, 16),
    (20, 20),
    (24, 24),
    (32, 32),
    (40, 40),
    (48, 48),
    (64, 64),
    (96, 96),
    (128, 128),
    (256, 256),
]


def _write_ico(path: Path, images: list[Image.Image]) -> None:
    """手工组装 ICO 容器，每个尺寸都用自己的渲染结果。

    不用 PIL 的 ``save(format="ICO", sizes=...)``：那个接口只会把同一张底图
    机械缩放，无法让 16/24px 走「收边距 + 加粗线宽 + 省掉声波」这套小尺寸
    优化。这里直接写 ICONDIR + ICONDIRENTRY + PNG 载荷（Vista 起支持）。
    """
    blobs: list[bytes] = []
    for image in images:
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        blobs.append(buffer.getvalue())

    count = len(images)
    entries = bytearray()
    offset = 6 + 16 * count
    for image, blob in zip(images, blobs):
        width, height = image.size
        entries += struct.pack(
            "<BBBBHHII",
            0 if width >= 256 else width,
            0 if height >= 256 else height,
            0,  # 调色板颜色数（32 位真彩为 0）
            0,  # 保留字节
            1,  # color planes
            32,  # bits per pixel
            len(blob),
            offset,
        )
        offset += len(blob)

    with open(path, "wb") as fh:
        fh.write(struct.pack("<HHH", 0, 1, count))
        fh.write(bytes(entries))
        for blob in blobs:
            fh.write(blob)


def main() -> int:
    output = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "assets" / "app.ico"
    output.parent.mkdir(parents=True, exist_ok=True)

    _write_ico(output, [build_icon(size[0]) for size in ICON_SIZES])

    preview = output.with_suffix(".png")
    build_icon(512).resize((256, 256), Image.LANCZOS).save(preview, format="PNG")

    print(f"已生成图标: {output} ({output.stat().st_size} bytes)")
    print(f"已生成预览: {preview}")
    print("包含尺寸: " + ", ".join(f"{w}×{h}" for w, h in ICON_SIZES))
    return 0


if __name__ == "__main__":
    sys.exit(main())
