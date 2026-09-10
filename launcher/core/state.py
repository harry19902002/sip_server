"""服务状态定义与线程安全的可观察状态容器。"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional


class ServiceState(str, Enum):
    IDLE = "idle"
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"
    FAILED = "failed"


STATE_LABELS = {
    ServiceState.IDLE: "未启动",
    ServiceState.STARTING: "启动中",
    ServiceState.RUNNING: "运行中",
    ServiceState.STOPPING: "停止中",
    ServiceState.STOPPED: "已停止",
    ServiceState.FAILED: "启动失败",
}


@dataclass
class StatusSnapshot:
    state: ServiceState = ServiceState.IDLE
    detail: str = ""
    frontend_port: int = 0
    api_port: int = 0
    lan_ip: str = "127.0.0.1"
    started_at: Optional[float] = None
    pid_map: dict = field(default_factory=dict)


class StatusCenter:
    """集中保存状态，变更时通知订阅者（GUI / 托盘）。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._snapshot = StatusSnapshot()
        self._listeners: list[Callable[[StatusSnapshot], None]] = []

    def subscribe(self, listener: Callable[[StatusSnapshot], None]) -> None:
        with self._lock:
            self._listeners.append(listener)

    def snapshot(self) -> StatusSnapshot:
        with self._lock:
            return StatusSnapshot(**{
                "state": self._snapshot.state,
                "detail": self._snapshot.detail,
                "frontend_port": self._snapshot.frontend_port,
                "api_port": self._snapshot.api_port,
                "lan_ip": self._snapshot.lan_ip,
                "started_at": self._snapshot.started_at,
                "pid_map": dict(self._snapshot.pid_map),
            })

    def update(self, **changes) -> None:
        with self._lock:
            for key, value in changes.items():
                if hasattr(self._snapshot, key):
                    setattr(self._snapshot, key, value)
            current = self.snapshot()
            listeners = list(self._listeners)
        for listener in listeners:
            try:
                listener(current)
            except Exception:
                pass
