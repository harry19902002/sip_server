"""单实例控制：避免重复双击启动多个服务实例。

Windows 上用命名互斥体（named mutex）实现，进程退出时内核自动释放，
不存在陈旧锁文件的问题。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import sys

MUTEX_NAME = "Global\\SIPBroadcastLauncher.SingleInstance"

ERROR_ALREADY_EXISTS = 183


class SingleInstance:
    def __init__(self, name: str = MUTEX_NAME) -> None:
        self._name = name
        self._handle = None
        self.already_running = False

    def acquire(self) -> bool:
        """尝试获取独占锁。返回 True 表示本进程是首个实例。"""
        if sys.platform != "win32":
            return True

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.restype = wintypes.HANDLE
        kernel32.CreateMutexW.argtypes = [wintypes.LPCVOID, wintypes.BOOL, wintypes.LPCWSTR]

        handle = kernel32.CreateMutexW(None, True, self._name)
        last_error = ctypes.get_last_error()

        self._handle = handle
        if last_error == ERROR_ALREADY_EXISTS:
            self.already_running = True
            return False
        return True

    def release(self) -> None:
        if self._handle and sys.platform == "win32":
            try:
                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel32.ReleaseMutex(wintypes.HANDLE(self._handle))
                kernel32.CloseHandle(wintypes.HANDLE(self._handle))
            except Exception:
                pass
            self._handle = None


def focus_existing_window(title_fragment: str = "SIP 广播系统") -> bool:
    """尝试把已运行实例的窗口拉到前台。"""
    if sys.platform != "win32":
        return False
    try:
        user32 = ctypes.WinDLL("user32", use_last_error=True)
        found = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def enum_proc(hwnd, _lparam):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buffer = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buffer, length + 1)
                if title_fragment in buffer.value:
                    found.append(hwnd)
                    return False
            return True

        user32.EnumWindows(enum_proc, 0)
        if found:
            hwnd = found[0]
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            user32.SetForegroundWindow(hwnd)
            return True
    except Exception:
        pass
    return False
