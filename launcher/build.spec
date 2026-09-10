# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置：产出单文件 SIPBroadcast.exe（启动器）。

只打包「启动器」本体（GUI + 托盘 + 进程编排）。
Node 运行时、前端产物与 FreeSWITCH 由 build-portable.ps1 另行组装进
便携目录，避免把数百 MB 的运行时塞进单文件 exe。
"""

from PyInstaller.utils.hooks import collect_submodules
import os

block_cipher = None

# 应用图标（由 make_icon.py 生成）。
# 注意：spec 文件里 __file__ 不可用，PyInstaller 提供 SPECPATH 变量指向 spec 所在目录。
_here = SPECPATH  # noqa: F821  (由 PyInstaller 注入)
_icon = os.path.join(_here, "assets", "app.ico")
if not os.path.isfile(_icon):
    _icon = None

hiddenimports = [
    "launcher",
    "launcher.core",
    "launcher.core.config",
    "launcher.core.logger",
    "launcher.core.process",
    "launcher.core.single_instance",
    "launcher.core.state",
    "launcher.core.freeswitch_config",
    "pystray",
    "pystray._win32",
    "PIL",
    "PIL.Image",
    "PIL.ImageDraw",
    "PIL.ImageFont",
    "tkinter",
    "tkinter.ttk",
    "tkinter.font",
    "tkinter.constants",
]
hiddenimports += collect_submodules("pystray")

a = Analysis(
    ["main.py"],
    pathex=["."],
    binaries=[],
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "numpy", "pandas", "matplotlib", "scipy",
        "PyQt5", "PyQt6", "PySide2", "PySide6",
        "test",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="SIPBroadcast",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,          # GUI 程序，不弹控制台
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=_icon,
)
