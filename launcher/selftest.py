"""自检脚本：在不启动服务的前提下，校验便携环境是否完整可用。

用法（便携目录内）：
    python launcher\\selftest.py

检查项：
  1. 目录结构是否齐全
  2. Node 运行时与前端产物是否可用
  3. 后端 API 能否被 Node 正确加载
  4. FreeSWITCH 可执行文件与配置文件是否存在
  5. 端口占用情况
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from launcher.core.config import AppConfig, build_paths, port_is_free  # noqa: E402

PASS = "[ OK ]"
WARN = "[WARN]"
FAIL = "[FAIL]"

results: list[tuple[str, str, str]] = []


def record(level: str, name: str, detail: str = "") -> None:
    results.append((level, name, detail))
    line = f"{level} {name}"
    if detail:
        line += f"  ->  {detail}"
    print(line)


def main() -> int:
    print("=" * 68)
    print("SIP 广播系统 · 便携包自检")
    print("=" * 68)

    paths = build_paths()
    print(f"程序根目录: {paths.root}")
    print(f"运行模式  : {'便携模式（数据在程序目录）' if paths.portable else '安装模式（数据在用户目录）'}\n")

    # 自检过程本身会创建必需目录，避免首次运行时误报
    try:
        paths.ensure()
    except OSError:
        pass

    # ---------- 1. 目录结构 ----------
    # data 与 app 必须存在；logs/runtime 是运行时自动生成的，缺失属正常
    for label, path, required in (
        ("data 目录", paths.data, True),
        ("app 目录", paths.frontend, True),
        ("logs 目录", paths.logs, False),
        ("runtime 目录", paths.runtime, False),
    ):
        if path.is_dir():
            record(PASS, label, str(path))
        elif required:
            record(FAIL, label, f"不存在: {path}")
        else:
            record(PASS, label, f"待首次启动生成: {path}")

    # ---------- 2. Node 运行时 ----------
    node = paths.node
    if node.is_file():
        record(PASS, "随包 Node", f"{node} ({node.stat().st_size / 1048576:.1f} MB)")
        try:
            version = subprocess.run([str(node), "--version"], capture_output=True, text=True, timeout=15)
            record(PASS, "Node 可执行", version.stdout.strip() or version.stderr.strip())
        except Exception as exc:
            record(FAIL, "Node 可执行", str(exc))
    else:
        system_node = _which("node")
        if system_node:
            record(WARN, "随包 Node", f"缺失，将回退系统 node: {system_node}")
        else:
            record(FAIL, "Node 运行时", "既无随包 node，系统也未安装 node")

    # ---------- 3. 前端与后端 ----------
    cli = paths.frontend / "node_modules" / "vinext" / "dist" / "cli.js"
    record(PASS if cli.is_file() else FAIL, "前端 CLI", str(cli))

    dist_index = paths.frontend / "dist"
    record(PASS if dist_index.is_dir() else FAIL, "前端产物 dist/", str(dist_index))

    api_entry = paths.frontend / "services" / "freeswitch-api" / "server.mjs"
    record(PASS if api_entry.is_file() else FAIL, "后端 API 入口", str(api_entry))

    # 用 node --check 做语法校验，确认后端代码能被加载
    if api_entry.is_file():
        node_exe = str(node) if node.is_file() else "node"
        check = subprocess.run([node_exe, "--check", str(api_entry)], capture_output=True, text=True, timeout=30)
        if check.returncode == 0:
            record(PASS, "后端 API 语法", "通过")
        else:
            record(FAIL, "后端 API 语法", check.stderr.strip()[:200])

    # ---------- 4. FreeSWITCH ----------
    config = AppConfig.load(paths)
    fs_dir = Path(config.freeweb_runtime_dir)
    console = None
    for candidate in (
        fs_dir / "FreeSwitchConsole.exe",
        fs_dir / "freeswitch.exe",
        fs_dir / "bin" / "FreeSwitchConsole.exe",
        fs_dir / "bin" / "freeswitch.exe",
    ):
        if candidate.is_file():
            console = candidate
            break

    if console:
        record(PASS, "FreeSWITCH 可执行", str(console))
        # 配置目录可能不在程序目录（安装模式下位于用户数据目录）
        conf_dir = Path(paths.freeswitch_runtime or console.parent) / "conf"
        if conf_dir.is_dir():
            record(PASS, "FreeSWITCH 配置目录", str(conf_dir))
            for name in ("vars.xml", "autoload_configs", "sip_profiles"):
                target = conf_dir / name
                record(PASS if target.exists() else WARN, f"  配置项 {name}", str(target))
        else:
            # 首次运行前 conf 尚未生成，属于正常情况
            record(PASS, "FreeSWITCH 配置目录", f"待首次启动生成: {conf_dir}")
    else:
        record(WARN, "FreeSWITCH", f"未找到可执行文件，请放入: {fs_dir}")

    # ---------- 4.5 可写目录 ----------
    record(
        PASS,
        "数据目录",
        f"{paths.data}（{'便携模式' if paths.portable else '安装模式'}）",
    )

    # ---------- 5. 端口 ----------
    for label, port in (
        ("管理前端端口", config.frontend_port),
        ("业务 API 端口", config.api_port),
    ):
        if port_is_free(port):
            record(PASS, f"{label} {port}", "可用")
        else:
            record(WARN, f"{label} {port}", "已被占用，可在 config.json 中修改")

    # ---------- 汇总 ----------
    print("\n" + "=" * 68)
    failed = [item for item in results if item[0] == FAIL]
    warned = [item for item in results if item[0] == WARN]
    print(f"通过 {len(results) - len(failed) - len(warned)} 项 · "
          f"警告 {len(warned)} 项 · 失败 {len(failed)} 项")
    if failed:
        print("\n需要修复：")
        for _, name, detail in failed:
            print(f"  · {name}: {detail}")
    print("=" * 68)
    return 1 if failed else 0


def _which(name: str) -> str | None:
    from shutil import which

    return which(name)


if __name__ == "__main__":
    sys.exit(main())
