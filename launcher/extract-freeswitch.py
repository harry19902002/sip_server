"""解包 FreeSWITCH MSI 为便携目录。

优先使用 msiexec 管理安装模式（/a，不会真正安装到系统）。
若系统策略限制 msiexec，则退回到直接从 MSI 的 OLE 容器中提取内嵌 CAB，
再用 Windows 内置 expand.exe 展开。
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

MSI = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("dist-portable/_fsdl/freeswitch.msi")
STAGING = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("dist-portable/_fsdl/staging")


def try_msiexec() -> bool:
    """管理安装模式：msiexec /a <msi> /qn TARGETDIR=<dir>"""
    STAGING.mkdir(parents=True, exist_ok=True)
    log = STAGING.parent / "msiexec.log"

    args = [
        "msiexec.exe",
        "/a", str(MSI.resolve()),
        "/qn",
        f"TARGETDIR={STAGING.resolve()}",
        "/L*v", str(log.resolve()),
    ]
    print(f"[msiexec] {' '.join(args)}")
    try:
        proc = subprocess.run(args, capture_output=True, timeout=900)
    except Exception as exc:
        print(f"[msiexec] 调用失败: {exc}")
        return False

    print(f"[msiexec] exit={proc.returncode}")
    if proc.returncode == 0 and _find_console(STAGING):
        return True

    if log.is_file():
        # 提取日志中的错误行，便于定位
        text = log.read_text(encoding="utf-8", errors="ignore")
        errors = [line for line in text.splitlines() if "error" in line.lower()][-10:]
        for line in errors:
            print(f"[msiexec:log] {line.strip()[:200]}")
    return False


def extract_cab_from_msi() -> bool:
    """从 MSI(OLE 复合文档) 中取出体积最大的流（内嵌 CAB）。"""
    try:
        import olefile
    except ImportError:
        print("[ole] 缺少 olefile")
        return False

    ole = olefile.OleFileIO(str(MSI))
    try:
        largest = None
        for entry in ole.listdir():
            try:
                size = ole.get_size(entry)
            except Exception:
                continue
            if largest is None or size > largest[1]:
                largest = (entry, size)
        if not largest:
            print("[ole] 未找到可提取的流")
            return False

        entry, size = largest
        print(f"[ole] 最大流: {'/'.join(entry)} ({size / 1048576:.1f} MB)")

        cab_path = STAGING.parent / "freeswitch.cab"
        with ole.openstream(entry) as stream:
            data = stream.read()
        cab_path.write_bytes(data)
        print(f"[ole] 已写出 {cab_path} ({len(data) / 1048576:.1f} MB)")

        magic = data[:4]
        print(f"[ole] 文件头: {magic!r}")
        if magic == b"MSCF":
            print("[ole] 确认为 CAB 格式")
            return extract_cab(cab_path)
        print("[ole] 不是标准 CAB，无法用 expand 解包")
        return False
    finally:
        ole.close()


def extract_cab(cab_path: Path) -> bool:
    """用 Windows 内置 expand.exe 展开 CAB。"""
    out_dir = STAGING / "cab"
    out_dir.mkdir(parents=True, exist_ok=True)
    # -F:* 表示展开全部文件，保留目录结构
    args = ["expand.exe", str(cab_path), "-F:*", str(out_dir)]
    print(f"[expand] {' '.join(args)}")
    proc = subprocess.run(args, capture_output=True, timeout=900)
    print(f"[expand] exit={proc.returncode}")
    if proc.returncode != 0:
        tail = proc.stdout.decode("utf-8", errors="ignore")[-500:]
        print(f"[expand] 输出: {tail}")
        return False
    return bool(_find_console(out_dir))


def _find_console(root: Path) -> Path | None:
    if not root.is_dir():
        return None
    for name in ("FreeSwitchConsole.exe", "freeswitch.exe"):
        for found in root.rglob(name):
            return found
    return None


def main() -> int:
    print(f"MSI   : {MSI}")
    print(f"目标  : {STAGING}\n")

    if not MSI.is_file():
        print("MSI 文件不存在")
        return 2

    if try_msiexec():
        console = _find_console(STAGING)
        print(f"\n成功: {console}")
        return 0

    print("\nmsiexec 方式失败，改用 OLE 提取 …\n")
    if extract_cab_from_msi():
        console = _find_console(STAGING)
        print(f"\n成功: {console}")
        return 0

    print("\n两种方式均失败")
    return 1


if __name__ == "__main__":
    sys.exit(main())
