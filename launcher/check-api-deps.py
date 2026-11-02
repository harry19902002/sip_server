"""校验后端 API 目录的模块依赖是否齐全。

递归解析入口文件的所有静态 `import ... from "./xxx.mjs"`，逐个确认文件
存在。用途是在打包阶段拦住「引用了某个文件但没复制进产物」的问题 ——
这类残缺包一旦发出去，表现为 API 启动即崩（ERR_MODULE_NOT_FOUND），
而启动器界面只会提示「健康检查超时」，真正原因埋在 logs/api.log 里，
排查成本很高。

用法：
    python check-api-deps.py <api 目录>

退出码 0 表示依赖完整，1 表示有缺失。
"""

from __future__ import annotations

import os
import re
import sys

# 只匹配相对路径导入；node: 内置模块和第三方包不在检查范围
IMPORT_RE = re.compile(r"""from\s+["'](\.[^"']+)["']""")
# 兼容不带 from 的 side-effect 导入：import "./x.mjs"
SIDE_EFFECT_RE = re.compile(r"""import\s+["'](\.[^"']+)["']""")


def collect_missing(entry: str) -> tuple[int, list[tuple[str, str]]]:
    """从入口文件出发广度遍历，返回 (检查模块数, [(引用方, 缺失路径)])。"""
    checked: set[str] = set()
    missing: list[tuple[str, str]] = []
    queue = [entry]

    while queue:
        current = os.path.normpath(queue.pop())
        if current in checked:
            continue
        checked.add(current)

        try:
            with open(current, encoding="utf-8", errors="ignore") as handle:
                source = handle.read()
        except OSError:
            continue

        specs = IMPORT_RE.findall(source) + SIDE_EFFECT_RE.findall(source)
        for spec in specs:
            target = os.path.normpath(os.path.join(os.path.dirname(current), spec))
            if os.path.isfile(target):
                queue.append(target)
            else:
                missing.append((current, spec))

    return len(checked), missing


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: check-api-deps.py <api 目录>", file=sys.stderr)
        return 2

    api_dir = sys.argv[1]
    entry = os.path.join(api_dir, "server.mjs")

    if not os.path.isfile(entry):
        print(f"找不到入口文件: {entry}")
        return 1

    count, missing = collect_missing(entry)

    if missing:
        print(f"检查了 {count} 个模块，发现 {len(missing)} 处缺失依赖：")
        for source, spec in missing:
            rel_source = os.path.relpath(source, api_dir)
            print(f"  {rel_source}  ->  {spec}")
        return 1

    print(f"检查了 {count} 个模块，所有静态导入均可解析")
    return 0


if __name__ == "__main__":
    sys.exit(main())
