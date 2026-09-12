"""版本号：语义化基础版本 + 构建时间戳。

版本号形如 ``0.1.0+20260912.1004``，其中：

- ``0.1.0``  —— 人工维护的基础版本（与 ``installer.iss`` 的 ``AppVersion`` 对应）
- ``20260912.1004`` —— 构建日期 + 时间（``YYYYMMDD.HHMM``），本地时间

构建时 ``build-portable.ps1`` 会生成 ``launcher/_build_info.py``，内容为
``BUILD_STAMP = "20260912.1004"``。源码模式（未打包）下该文件可能不存在，
此时回退为 ``dev``，保证任何情况下都能导入而不抛异常。
"""

from __future__ import annotations

# 人工维护的基础版本：发版时同步修改这里与 launcher/installer.iss 的 AppVersion。
BASE_VERSION = "0.1.0"


def build_stamp() -> str:
    """构建时间戳（``YYYYMMDD.HHMM``）；未打包时返回 ``dev``。"""
    try:
        from launcher._build_info import BUILD_STAMP  # type: ignore[import-not-found]
    except Exception:
        return "dev"
    stamp = str(BUILD_STAMP).strip()
    return stamp or "dev"


def full_version() -> str:
    """完整版本号：``0.1.0+20260912.1004``（源码模式为 ``0.1.0+dev``）。"""
    return f"{BASE_VERSION}+{build_stamp()}"


def short_version() -> str:
    """紧凑版本号，供窗口标题等窄空间使用。"""
    stamp = build_stamp()
    return BASE_VERSION if stamp == "dev" else f"{BASE_VERSION} ({stamp})"


def build_date_display() -> str:
    """把 ``20260912.1004`` 渲染为 ``2026-09-12 10:04``；dev 时返回 ``开发模式``。"""
    stamp = build_stamp()
    if len(stamp) == 13 and stamp[8] == "." and stamp.replace(".", "").isdigit():
        date, time = stamp.split(".")
        return f"{date[0:4]}-{date[4:6]}-{date[6:8]} {time[0:2]}:{time[2:4]}"
    return "开发模式"
