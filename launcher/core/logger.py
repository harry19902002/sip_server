"""日志：写入滚动日志文件，同时把最近若干行留在内存供 GUI 展示。"""

from __future__ import annotations

import threading
import time
from collections import deque
from pathlib import Path


class Logger:
    def __init__(self, log_dir: Path, filename: str = "launcher.log", keep: int = 500) -> None:
        self.log_dir = log_dir
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.path = log_dir / filename
        self._recent: deque[str] = deque(maxlen=keep)
        self._lock = threading.Lock()
        self._listeners = []

    def subscribe(self, listener) -> None:
        with self._lock:
            self._listeners.append(listener)

    def __call__(self, message: str) -> None:
        self.write(message)

    def write(self, message: str) -> None:
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')}  {message}"
        with self._lock:
            self._recent.append(line)
            try:
                with open(self.path, "a", encoding="utf-8") as handle:
                    handle.write(line + "\n")
            except OSError:
                pass
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(line)
            except Exception:
                pass

    def recent(self) -> list[str]:
        with self._lock:
            return list(self._recent)
