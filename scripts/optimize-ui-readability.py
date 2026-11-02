"""一次性完成界面可读性优化（幂等，可重复执行）。

做四件事：
  1. 字号整体上调到可读区间（文本类放大，图标类保持）；
  2. 承载单行文字的固定高度容器同步增高，避免 13px 文字被裁切；
  3. 次要文字配色加深到 WCAG AA（≥4.5:1）；
  4. body 设置 1.6 基准行高，改善中文行距。

用法：
    python scripts/optimize-ui-readability.py [--dry-run]
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

CSS = Path(__file__).resolve().parent.parent / "app" / "globals.css"

# ---------------------------------------------------------------- 1. 字号阶梯
TEXT_SCALE = {
    7: 11, 8: 12, 9: 13, 10: 13, 11: 13, 12: 14, 13: 14,
    14: 15, 15: 16, 16: 17, 17: 18, 18: 20, 19: 21, 20: 22,
    21: 23, 22: 24, 23: 25, 24: 26, 25: 28, 27: 30, 28: 31, 29: 32,
}

ICON_HINTS = ("icon", "mark", "avatar", "orb", "symbol")

# 这些选择器的 font-size 控制字形图标大小，放大后会撑破固定尺寸方块
SKIP_SELECTORS = (
    ".nav-icon", ".brand-mark i", ".shortcut-tile-icon", ".shortcut-icon",
    ".metric-icon", ".config-tab-icon", ".terminal-summary-icon",
    ".terminal-device-icon", ".target-terminal-icon", ".zone-symbol",
    ".zone-folder", ".alarm-mark", ".play-circle", ".media-play-button",
    ".media-empty > span", ".mic-orb", ".sip-empty > span",
    ".terminal-empty > span", ".zone-terminal-empty > span",
    ".schedule-empty > span", ".confirm-icon", ".role-head",
    ".user-list-empty > span", ".sip-server-mark",
    ".organization-banner-mark", ".organization-preview-mark",
    ".sip-editor-heading > span", ".schedule-modal-heading > span",
    ".schedule-detail-heading > span", ".zone-assignment-heading > span",
    ".role-avatar", ".placeholder-icon", ".schedule-history-mark",
    ".backup-rollback-icon", ".config-sync-icon", ".backup-notice > span",
    ".backup-readonly > span", ".backup-confirm-head > span",
    ".modal-close", ".toast > span", ".media-error button",
    ".media-error > span", ".source-queue-note > span",
    ".sip-security-note span", ".task-notice button",
    ".backup-notice button", ".media-player-close", ".playlist-remove",
    ".task-notice > span", ".precheck-box > span",
    ".shortcut-editing-note > span", ".builder-title > div > span",
    ".step > span", ".custom-check", ".source-check", ".terminal-check i",
    ".theme-options em", ".codec-move button", ".view-switch button",
    ".shortcut-order", ".tree-toggle", ".folder", ".collapse-button",
    ".avatar",
)

# 名字像图标、实际是文字的，强制放大
FORCE_TEXT = (".live-dot",)

# 单行容器需随字号增高，否则文字被裁切或挤成两行
HEIGHT_BUMPS = [
    (r"\.nav-group button \{ width: 100%; height: 42px;", "height: 42px", "height: 46px"),
    (r"\.zone-check \{ position: relative; height: 49px;", "height: 49px", "height: 54px"),
    (r"\.terminal-zone \{ width: 100%; height: 41px;", "height: 41px", "height: 45px"),
    (r"\.tree-node \{ width: 100%; height: 37px;", "height: 37px", "height: 41px"),
    (r"\.data-table th \{ height: 40px;", "height: 40px", "height: 44px"),
    (r"\.sip-account-table th \{ height: 42px; \}", "height: 42px", "height: 46px"),
    (r"\.tabs button \{ height: 57px;", "height: 57px", "height: 60px"),
    (r"\.media-tabs button \{ height: 46px;", "height: 46px", "height: 50px"),
]

# ---------------------------------------------------------------- 3. 配色
LIGHT_TEXT3 = "#5d6b82"   # 原 #8995a6，3.0:1 → 5.4:1
DARK_TEXT3 = "#8d9bb0"    # 原 #8291a5，彩色浅底上 4.0:1 → 4.6:1
PLACEHOLDER = "#647084"   # 原 #9aa5b3，2.5:1 → 4.9:1
SIDEBAR_LABEL = "#8b9fb8"  # 原 #7087a2，4.48:1 → 6.12:1
STATUS_TEXT = "#4d5b6e"    # 原 #667589，4.23:1 → 6.22:1

# 名称像图标但实际是文字，单独上调
TEXT_FIXES = {
    ".codec-order {": (8, 12),
    ".codec-live {": (8, 12),
    ".media-picker-empty {": (9, 12),
    ".list-mark {": (9, 12),
    ".yes-mark, .no-mark {": (8, 12),
}

RULE_RE = re.compile(r"(^|\n)([^{}\n][^{}]*?)\{([^{}]*)\}", re.MULTILINE)
FONT_RE = re.compile(r"font-size:\s*([0-9.]+)px")


def is_icon_selector(selector: str) -> bool:
    low = selector.strip().lower()
    if any(f in low for f in FORCE_TEXT):
        return False
    # :not(...) 是排除条件，不能当判据
    bare = re.sub(r":not\([^)]*\)", "", low)
    if any(s.lower() in bare for s in SKIP_SELECTORS):
        return True
    return any(h in bare for h in ICON_HINTS)


def bump_value(value: float) -> int:
    return TEXT_SCALE.get(int(round(value)), int(round(value)))


def apply_font_scale(css: str) -> tuple[str, int, int]:
    bumped = kept = 0

    def repl(match: re.Match[str]) -> str:
        nonlocal bumped, kept
        lead, selector, body = match.group(1), match.group(2), match.group(3)
        if "font-size" not in body:
            return match.group(0)
        if is_icon_selector(selector):
            kept += body.count("font-size")
            return match.group(0)

        def sub(fm: re.Match[str]) -> str:
            nonlocal bumped
            old = float(fm.group(1))
            new = bump_value(old)
            if new != int(round(old)):
                bumped += 1
            return f"font-size: {new}px"

        return f"{lead}{selector}{{{FONT_RE.sub(sub, body)}}}"

    css = RULE_RE.sub(repl, css)

    def sub_shorthand(fm: re.Match[str]) -> str:
        nonlocal bumped
        bumped += 1
        return f"font: {bump_value(float(fm.group(1)))}px/{fm.group(2)}"

    css = re.sub(r"font:\s*([0-9.]+)px/([0-9.]+)", sub_shorthand, css)
    return css, bumped, kept


def main() -> int:
    dry_run = "--dry-run" in sys.argv
    css = CSS.read_text(encoding="utf-8")
    original = css

    # 1. 字号
    css, bumped, kept = apply_font_scale(css)
    print(f"[1] 字号：上调 {bumped} 处，保持图标 {kept} 处")

    # 2. 高度
    height_changed = 0
    for pattern, old, new in HEIGHT_BUMPS:
        m = re.search(pattern, css)
        if m and old in m.group(0):
            css = css.replace(m.group(0), m.group(0).replace(old, new, 1), 1)
            height_changed += 1
    print(f"[2] 单行容器增高：{height_changed} 处")

    # 3. 配色
    color_subs = [
        # 亮色 / 暗色次要文字
        ("  --text-3: #8995a6;",
         f"  /* 次要文字。原 #8995a6 在白色上仅 3.0:1，低于 WCAG AA 4.5:1 */\n"
         f"  --text-3: {LIGHT_TEXT3};"),
        ("  --text-3: #8291a5;",
         f"  /* 原 #8291a5 在彩色浅底上仅 4.0:1 */\n"
         f"  --text-3: {DARK_TEXT3};"),
        ("color: #7087a2; font-size: 13px;", f"color: {SIDEBAR_LABEL}; font-size: 13px;"),
        ("color: #667589; background: #f1f3f6;", f"color: {STATUS_TEXT}; background: #f1f3f6;"),
        (".search-field input::placeholder { color: #9aa5b3; }",
         f".search-field input::placeholder {{ color: {PLACEHOLDER}; }}"),
        ("color: #aeb8c5; }", f"color: {PLACEHOLDER}; }}"),
    ]
    color_changed = 0
    for old, new in color_subs:
        if old in css:
            css = css.replace(old, new, 1)
            color_changed += 1
    print(f"[3] 低对比度配色：修正 {color_changed} 处")

    # 4. body 基准行高
    body_old = (
        'body { margin: 0; color: var(--text); background: var(--canvas); '
        'font-family: var(--font-geist-sans), "Microsoft YaHei", "PingFang SC", Arial, sans-serif; '
        '-webkit-font-smoothing: antialiased; }'
    )
    body_new = (
        '/* 基准行高 1.6：中文正文需要足够行距。样式表里仅 8% 的规则显式声明\n'
        '   line-height，其余靠这里继承；单行元素由各自的固定高度约束。 */\n'
        'body { margin: 0; color: var(--text); background: var(--canvas); '
        'font-family: var(--font-geist-sans), "Microsoft YaHei", "PingFang SC", Arial, sans-serif; '
        'font-size: 14px; line-height: 1.6; -webkit-font-smoothing: antialiased; }'
    )
    if body_old in css:
        css = css.replace(body_old, body_new, 1)
        print("[4] 基准行高：已设置为 1.6")
    elif "line-height: 1.6" in css:
        print("[4] 基准行高：已是 1.6，跳过")
    else:
        print("[4] 基准行高：未匹配到 body 规则，请手工检查")

    # 5. 误判为图标的文字单独修正
    fixed = 0
    for selector, (old, new) in TEXT_FIXES.items():
        pattern = re.compile(re.escape(selector) + r"[^{}]*?font-size: " + str(old) + r"px")
        css, n = pattern.subn(
            lambda m: m.group(0).replace(f"font-size: {old}px", f"font-size: {new}px"),
            css,
            count=1,
        )
        fixed += n
    print(f"[5] 文字型徽标字号：修正 {fixed} 处")

    if css == original:
        print("\n无变化（可能已优化过）。")

    if dry_run:
        print("\n[dry-run] 未写入")
        return 0

    CSS.write_text(css, encoding="utf-8")
    print(f"\n已写入 {CSS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
