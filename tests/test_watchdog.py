"""看门狗单元测试：不启动真实服务，用假进程验证「发现退出 → 退避重启 → 放弃」。

运行：
    .venv\\Scripts\\python.exe tests\\test_watchdog.py
"""

from __future__ import annotations

import sys
import time
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from launcher.core.process import (  # noqa: E402
    WATCHDOG_UNSTABLE_LIMIT,
    ManagedProcess,
    ProcessManager,
)

FAILURES: list[str] = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"[ OK ] {name}")
    else:
        print(f"[FAIL] {name} {detail}")
        FAILURES.append(name)


class FakeProcess:
    """最小 Popen 替身：poll() 返回 None 表示存活，否则返回退出码。"""

    def __init__(self, *, alive: bool = True, exit_code: int = 1) -> None:
        self.pid = 4242
        self.returncode = None if alive else exit_code

    def poll(self):
        return self.returncode

    def terminate(self):
        self.returncode = 0

    def wait(self, timeout=None):
        return self.returncode or 0

    def kill(self):
        self.returncode = -9


class FakeConfig:
    freeweb_runtime_dir = "C:/nonexistent"
    api_port = 3999
    frontend_port = 3998
    esl_port = 8021
    sip_domain = "sip.local"
    sip_port = 5060
    sip_server_host = "127.0.0.1"
    bind_ip = "127.0.0.1"
    esl_password = "x"
    api_key = "x"
    sip_default_password = "x"
    system_admin_username = "admin"
    system_admin_password = "x"


class FakePaths:
    def __init__(self, tmp: Path) -> None:
        self.root = tmp
        self.data = tmp
        self.logs = tmp
        self.runtime = tmp
        self.frontend = tmp
        self.node = tmp / "node.exe"
        self.freeswitch = tmp
        self.freeswitch_runtime = tmp


def make_manager(tmp: Path, log_lines: list[str]) -> ProcessManager:
    manager = ProcessManager(FakePaths(tmp), FakeConfig(), log_lines.append)
    # 屏蔽真实重启：用计数器记录「被要求重启了几次」
    manager.spawn_calls = []  # type: ignore[attr-defined]

    def fake_spawn(key: str) -> bool:
        manager.spawn_calls.append(key)  # type: ignore[attr-defined]
        # 默认模拟「重启成功」但立刻又崩，以便触发 unstable 上限
        manager._processes[key] = ManagedProcess(  # noqa: SLF001
            key, FakeProcess(alive=False, exit_code=7), tmp / f"{key}.log"  # type: ignore[arg-type]
        )
        return True

    manager._spawn_service = fake_spawn  # type: ignore[method-assign]
    return manager


def test_detects_dead_process_and_restarts(tmp: Path) -> None:
    logs: list[str] = []
    manager = make_manager(tmp, logs)
    manager._processes["freeswitch"] = ManagedProcess(  # noqa: SLF001
        "freeswitch", FakeProcess(alive=False, exit_code=3), tmp / "fs.log"  # type: ignore[arg-type]
    )
    manager._watchdog_tick()  # noqa: SLF001
    # 退避首轮为 WATCHDOG_INTERVAL*1，简短等待足以覆盖
    time.sleep(6)
    check("发现进程退出后请求重启", manager.spawn_calls == ["freeswitch"], f"calls={manager.spawn_calls}")  # type: ignore[attr-defined]
    check(
        "日志包含自动重启记录",
        any("自动重启" in line for line in logs),
        f"logs={logs}",
    )


def test_alive_process_is_left_alone(tmp: Path) -> None:
    logs: list[str] = []
    manager = make_manager(tmp, logs)
    manager._processes["api"] = ManagedProcess(  # noqa: SLF001
        "api", FakeProcess(alive=True), tmp / "api.log"  # type: ignore[arg-type]
    )
    manager._watchdog_tick()  # noqa: SLF001
    time.sleep(1)
    check("存活进程不被重启", manager.spawn_calls == [], f"calls={manager.spawn_calls}")  # type: ignore[attr-defined]


def test_gives_up_after_repeated_crashes(tmp: Path) -> None:
    logs: list[str] = []
    manager = make_manager(tmp, logs)
    manager._processes["api"] = ManagedProcess(  # noqa: SLF001
        "api", FakeProcess(alive=False, exit_code=1), tmp / "api.log"  # type: ignore[arg-type]
    )
    # 连续 tick 触发退避重启，直到超过上限
    for _ in range(WATCHDOG_UNSTABLE_LIMIT + 2):
        manager._watchdog_tick()  # noqa: SLF001
        time.sleep(6)

    check(
        "放弃后记录降级原因",
        any("反复启动失败" in value for value in manager.optional_failures.values()),
        f"failures={manager.optional_failures}",
    )
    calls_after_give_up = len(manager.spawn_calls)  # type: ignore[attr-defined]
    manager._watchdog_tick()  # noqa: SLF001
    time.sleep(6)
    check(
        "放弃后不再继续重启",
        len(manager.spawn_calls) == calls_after_give_up,  # type: ignore[attr-defined]
        f"before={calls_after_give_up} after={len(manager.spawn_calls)}",  # type: ignore[attr-defined]
    )


def test_busy_flag_suppresses_checks(tmp: Path) -> None:
    logs: list[str] = []
    manager = make_manager(tmp, logs)
    manager._busy = True  # type: ignore[attr-defined]
    manager._processes["api"] = ManagedProcess(  # noqa: SLF001
        "api", FakeProcess(alive=False, exit_code=1), tmp / "api.log"  # type: ignore[arg-type]
    )
    manager._watchdog_tick()  # noqa: SLF001
    check("启动编排进行中不干扰", not manager.spawn_calls, f"calls={manager.spawn_calls}")  # type: ignore[attr-defined]


def test_stopping_flag_suppresses_checks(tmp: Path) -> None:
    logs: list[str] = []
    manager = make_manager(tmp, logs)
    manager._stopping = True
    manager._processes["api"] = ManagedProcess(  # noqa: SLF001
        "api", FakeProcess(alive=False, exit_code=1), tmp / "api.log"  # type: ignore[arg-type]
    )
    manager._watchdog_tick()  # noqa: SLF001
    check("停止过程中不重启", not manager.spawn_calls, f"calls={manager.spawn_calls}")  # type: ignore[attr-defined]


def test_watchdog_generation_invalidates_old_thread(tmp: Path) -> None:
    logs: list[str] = []
    manager = make_manager(tmp, logs)
    manager.start_watchdog()
    first_gen = manager._watchdog_gen  # noqa: SLF001
    manager.stop_all(grace=0.1)
    check("停止后代次自增（作废旧线程）", manager._watchdog_gen > first_gen, f"{first_gen} -> {manager._watchdog_gen}")  # noqa: SLF001


def main() -> int:
    import tempfile

    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        test_detects_dead_process_and_restarts(tmp)
        test_alive_process_is_left_alone(tmp)
        test_gives_up_after_repeated_crashes(tmp)
        test_busy_flag_suppresses_checks(tmp)
        test_stopping_flag_suppresses_checks(tmp)
        test_watchdog_generation_invalidates_old_thread(tmp)

    print()
    if FAILURES:
        print(f"失败 {len(FAILURES)} 项: {', '.join(FAILURES)}")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
