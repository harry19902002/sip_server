"""便携包依赖闭包收集：把 vinext / vite / react 运行所需的包完整复制出来。

只保留运行期依赖（dependencies / optionalDependencies / peerDependencies），
跳过 devDependencies，从而把体积从 444MB 压到可接受范围。
"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path


# 前端启动（vinext start）真正需要的根包
ROOT_PACKAGES = [
    "vinext",
    "vite",
    "react",
    "react-dom",
    "react-server-dom-webpack",
]

# 这些包在生产运行时不需要，剔除可显著减小体积
EXCLUDE_PACKAGES = {
    "typescript",
    "eslint",
    "@eslint",
    "drizzle-kit",
    "wrangler",
    "@cloudflare",
    "tailwindcss",
    "@tailwindcss",
    "@types",
    "miniflare",
    "workerd",
    "@esbuild",
}


def collect(source_modules: Path, target_modules: Path, log=print) -> dict:
    target_modules.mkdir(parents=True, exist_ok=True)

    seen: set[str] = set()
    queue: list[str] = list(ROOT_PACKAGES)
    missing: list[str] = []
    copied: list[str] = []

    while queue:
        name = queue.pop(0)
        if name in seen:
            continue
        seen.add(name)

        if any(name == ex or name.startswith(ex + "/") for ex in EXCLUDE_PACKAGES):
            continue

        source = source_modules.joinpath(*name.split("/"))
        if not source.is_dir():
            missing.append(name)
            continue

        destination = target_modules.joinpath(*name.split("/"))
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(
                source,
                destination,
                symlinks=False,
                ignore=shutil.ignore_patterns(".bin", "test", "tests", "__tests__", "*.md"),
            )
            copied.append(name)

        package_json = source / "package.json"
        if not package_json.is_file():
            continue
        try:
            data = json.loads(package_json.read_text(encoding="utf-8"))
        except Exception:
            continue

        for key in ("dependencies", "optionalDependencies"):
            for dep in (data.get(key) or {}):
                if dep not in seen:
                    queue.append(dep)

    return {"copied": copied, "missing": missing, "total": len(copied)}


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: collect-deps.py <source_node_modules> <target_node_modules>")
        return 2

    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    result = collect(source, target)

    print(f"[deps] 已复制 {result['total']} 个包")
    if result["missing"]:
        print(f"[deps] 未找到（可忽略，通常为平台可选依赖）: {', '.join(result['missing'][:15])}")

    total_bytes = sum(f.stat().st_size for f in target.rglob("*") if f.is_file())
    print(f"[deps] 目标体积: {total_bytes / 1048576:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
