"""子进程编排：启动/停止后端 API、前端与 FreeSWITCH。

Windows 上的三个关键点：
1. 用 `CREATE_NO_WINDOW` 隐藏子进程控制台窗口；
2. 用 Job Object 绑定子进程，父进程退出时内核级连带回收，避免残留；
3. 停止时先礼后兵：先 terminate，超时再 kill。

另有运行期看门狗（watchdog）：子进程若在运行中意外退出（实测 FreeSWITCH 会因
系统时钟跳变等原因静默退出），会自动重启，避免出现「管理页面能打开、但首页
数据加载失败」这种半死状态。
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from .state import ServiceState

CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200

# ---------------------------------------------------------------- 看门狗参数

# 巡检间隔：只做 process.poll()，开销极低，5 秒足以兼顾恢复速度与资源占用。
WATCHDOG_INTERVAL = 5.0
# 重启退避：第 n 次尝试等待 INTERVAL * 2^(n-1) 秒，避免崩溃循环打满 CPU。
WATCHDOG_MAX_BACKOFF = 60.0
# 进程存活超过该时长再退出，视为「偶发崩溃」，会重置连续失败计数。
WATCHDOG_UNSTABLE_WINDOW = 60.0
# 连续「起来就崩」的次数上限，超过则放弃自动重启，交还人工介入。
WATCHDOG_UNSTABLE_LIMIT = 5

# ---------------------------------------------------------------- Job Object

_job_handle = None
_job_lock = threading.Lock()


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
        ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.POINTER(ctypes.c_ulong)),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
    ]


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", _IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9


def ensure_job_object():
    """创建带 KILL_ON_JOB_CLOSE 的 Job Object。

    父进程（本启动器）无论正常退出还是被强杀，Windows 内核都会连带
    结束 Job 内的全部子进程——彻底杜绝「关掉 GUI 但服务还在跑」。
    """
    global _job_handle
    with _job_lock:
        if _job_handle is not None:
            return _job_handle

        try:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        except OSError:
            return None

        kernel32.CreateJobObjectW.restype = wintypes.HANDLE

        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            return None

        info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE

        ok = kernel32.SetInformationJobObject(
            wintypes.HANDLE(handle),
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if not ok:
            kernel32.CloseHandle(wintypes.HANDLE(handle))
            return None

        _job_handle = (kernel32, handle)
        return _job_handle


def assign_to_job(process: subprocess.Popen) -> None:
    job = ensure_job_object()
    if not job:
        return
    kernel32, handle = job
    try:
        kernel32.AssignProcessToJobObject(
            wintypes.HANDLE(handle), wintypes.HANDLE(int(process._handle))  # noqa: SLF001
        )
    except Exception:
        pass


# ---------------------------------------------------------------- 进程封装


@dataclass
class ManagedProcess:
    name: str
    process: subprocess.Popen
    log_path: Path
    started_at: float = field(default_factory=time.time)
    # 看门狗用：已自动重启次数、连续「起来就崩」次数
    restarts: int = 0
    unstable_streak: int = 0

    def alive(self) -> bool:
        return self.process.poll() is None

    def exit_code(self) -> Optional[int]:
        return self.process.poll()


class ProcessManager:
    """管理一组子进程，并向 GUI 汇报状态。"""

    def __init__(self, paths, config, logger, on_state: Callable[[ServiceState, str], None] | None = None):
        self.paths = paths
        self.config = config
        self.log = logger
        self._on_state = on_state
        self._processes: dict[str, ManagedProcess] = {}
        self._lock = threading.RLock()
        self._stopping = False
        # 面板可见的启动进度，供 GUI 读取
        self.progress: dict[str, str] = {}
        # 可选组件的降级原因（如未安装 FreeSWITCH）
        self.optional_failures: dict[str, str] = {}
        # ---- 看门狗 ----
        self._watchdog_thread: Optional[threading.Thread] = None
        # 看门狗「代次」：stop/start 时自增，旧线程发现代次不匹配即自行退出。
        # 不能只把 _watchdog_thread 置 None —— 旧线程仍在 sleep，醒来后若
        # _stopping 已被新的 start 重置为 False，就会与新线程同时巡检并重复重启。
        self._watchdog_gen = 0
        # 启动/重启进行中：看门狗此时必须让路，否则会与正在编排的启动流程抢进程
        self._busy = False
        # 每个服务最近一次（自动）重启的时间戳，用于退避计算
        self._last_restart_at: dict[str, float] = {}
        # 恢复中的服务名，供 GUI 显示「正在恢复」而不误判成「运行中」
        self.recovering: set[str] = set()

    # ---------- 状态回调 ----------

    def _emit(self, state: ServiceState, detail: str = "") -> None:
        if self._on_state:
            try:
                self._on_state(state, detail)
            except Exception:
                pass

    def _set_progress(self, key: str, text: str) -> None:
        self.progress[key] = text
        self.log(f"[{key}] {text}")

    # ---------- 启动 ----------

    def start_all(self) -> bool:
        """按依赖顺序启动。

        策略：FreeSWITCH 是可选组件——缺失时降级运行（管理界面与 API 仍可用，
        便于用户先配置、再补装引擎），而不是让整个程序启动失败。
        API 与前端为必需组件，任一失败则整体回滚。
        """
        self._stopping = False
        self._busy = True
        self._emit(ServiceState.STARTING, "正在启动服务…")
        self.optional_failures.clear()
        try:
            return self._start_all_locked()
        finally:
            self._busy = False
            # 启动编排结束后才开启看门狗：否则它可能在 API/前端尚未登记时就
            # 把 FreeSWITCH 的正常启动窗口误判为崩溃并「重启」。
            if not self._stopping:
                self.start_watchdog()

    def _start_all_locked(self) -> bool:
        """启动编排主体（由 start_all 持有 _busy 标记调用）。"""
        # ---- 可选：FreeSWITCH ----
        self._set_progress("freeswitch", "FreeSWITCH 语音引擎 启动中…")
        if self.start_freeswitch():
            self._set_progress("freeswitch", "FreeSWITCH 已就绪")
        else:
            reason = "未找到 FreeSWITCH 可执行文件，语音广播功能将不可用"
            self.optional_failures["freeswitch"] = reason
            self._set_progress("freeswitch", reason)
            self.log(f"降级启动：{reason}")

        # ---- 必需：业务 API ----
        self._set_progress("api", "业务 API 服务 启动中…")
        if not self.start_api():
            # API 依赖 ESL，但 FreeSWITCH 缺失时 API 仍能启动（ESL 会自动重连），
            # 因此这里失败属于真实故障，需要整体回滚。
            self._set_progress("api", "业务 API 服务 启动失败")
            self.log("业务 API 启动失败，请检查 logs/api.log")
            self._emit(ServiceState.FAILED, "业务 API 服务 启动失败")
            self.stop_all()
            return False
        self._set_progress("api", "业务 API 服务 已就绪")

        # ---- 必需：管理前端 ----
        self._set_progress("frontend", "管理前端 启动中…")
        if not self.start_frontend():
            self._set_progress("frontend", "管理前端 启动失败")
            self._emit(ServiceState.FAILED, "管理前端 启动失败")
            self.stop_all()
            return False
        self._set_progress("frontend", "管理前端 已就绪")

        if self.optional_failures:
            self._emit(ServiceState.RUNNING, "服务运行中（语音引擎未就绪，广播功能受限）")
        else:
            self._emit(ServiceState.RUNNING, "所有服务运行中")
        return True

    def start_freeswitch(self, console: Optional[Path] = None) -> bool:
        """以便携方式启动 FreeSWITCH。

        Windows 版通过命令行参数指定各目录（-conf/-log/-db/-mod/...），
        从而把全部可变数据约束在便携目录内，不污染系统安装目录。

        console 可显式传入（看门狗重启时复用首次探测到的路径，避免重复查找）。
        """
        fs_dir: Path = Path(self.config.freeweb_runtime_dir)
        if console is None:
            console = self._find_freeswitch_console(fs_dir)
        if console is None:
            self.log(f"未找到 FreeSWITCH 可执行文件，目录: {fs_dir}")
            return False

        fs_root = console.parent

        # 可写目录：便携模式下与程序同目录；安装模式下指向用户数据目录。
        # FreeSWITCH 需要写 conf（部分模块会回写）、log、db、recordings，
        # 装在 Program Files 时这些位置不可写，必须外移。
        runtime_root: Path = self.paths.freeswitch_runtime or fs_root
        runtime_root.mkdir(parents=True, exist_ok=True)

        conf_dir = runtime_root / "conf"
        if runtime_root != fs_root:
            self._seed_runtime_conf(fs_root / "conf", conf_dir)
        else:
            conf_dir = fs_root / "conf"

        # 启动前渲染配置：ESL 密码、SIP 端口、域、编解码等
        try:
            from .freeswitch_config import FreeswitchConfigurator

            configurator = FreeswitchConfigurator(
                fs_root=runtime_root,
                template_root=self.paths.frontend / "infra" / "freeswitch" / "config",
                logger=self.log,
            )
            configurator.render(
                esl_password=self.config.esl_password,
                sip_domain=self.config.sip_domain,
                sip_default_password=self.config.sip_default_password,
                external_ip=self.config.sip_server_host,
                sip_port=self.config.sip_port,
                conf_dir=conf_dir,
                bind_ip=self.config.bind_ip,
                codec_prefs=self.config.codec_prefs,
            )
        except Exception as exc:
            self.log(f"[config] 渲染 FreeSWITCH 配置失败: {exc}")

        cmd = [
            str(console),
            "-nc",                      # 无控制台窗口，后台运行
            "-nonat",                   # 局域网部署，跳过 NAT 探测
        ]

        # 安装模式下把可写目录显式指向用户数据目录（便携模式下与默认一致，无需传参）
        if runtime_root != fs_root:
            cmd += [
                "-conf", str(conf_dir),
                "-log", str(runtime_root / "log"),
                "-db", str(runtime_root / "db"),
                "-recordings", str(runtime_root / "recordings"),
                "-storage", str(runtime_root / "storage"),
                "-run", str(runtime_root / "run"),
            ]

        return self._spawn(
            key="freeswitch",
            cmd=cmd,
            cwd=fs_root,        # 工作目录保持程序目录，确保 DLL 与模块能被正确加载
            env=self._base_env(),
            log_name="freeswitch.log",
            health=None,
            settle_seconds=3.0,
        )

    def _seed_runtime_conf(self, source_conf: Path, target_conf: Path) -> None:
        """安装模式首次运行时，把随包的 conf 复制到可写目录。

        只在目标不存在时复制，之后用户的配置修改不会被覆盖。
        """
        if target_conf.exists():
            return
        if not source_conf.is_dir():
            self.log(f"[config] 未找到随包配置目录: {source_conf}")
            return
        try:
            import shutil

            shutil.copytree(source_conf, target_conf)
            self.log(f"[config] 已初始化可写配置目录: {target_conf}")
        except Exception as exc:
            self.log(f"[config] 初始化配置目录失败: {exc}")

    @staticmethod
    def _find_freeswitch_console(fs_dir: Path) -> Optional[Path]:
        """FreeSWITCH 不同版本的可执行文件名略有差异，逐个探测。"""
        candidates = [
            fs_dir / "FreeSwitchConsole.exe",
            fs_dir / "freeswitch.exe",
            fs_dir / "bin" / "FreeSwitchConsole.exe",
            fs_dir / "bin" / "freeswitch.exe",
        ]
        for candidate in candidates:
            if candidate.is_file():
                return candidate
        return None

    def start_api(self) -> bool:
        node = self._node_executable()
        entry = self.paths.frontend / "services" / "freeswitch-api" / "server.mjs"
        if not entry.is_file():
            self.log(f"未找到后端 API 入口: {entry}")
            return False

        data = self.paths.data
        # Write SIP accounts into the directory actually read by FreeSWITCH.
        # Preserve accounts created by older portable builds on first startup.
        fs_runtime = self.paths.freeswitch_runtime or Path(self.config.freeweb_runtime_dir)
        sip_directory = fs_runtime / "conf" / "directory" / "default"
        sip_directory.mkdir(parents=True, exist_ok=True)
        legacy_directory = data / "sip-directory"
        if legacy_directory.is_dir():
            import shutil
            for account_file in legacy_directory.glob("*.xml"):
                destination = sip_directory / account_file.name
                if not destination.exists():
                    shutil.copyfile(account_file, destination)
        env = self._base_env()
        env.update(
            {
                "PORT": str(self.config.api_port),
                "API_KEY": self.config.api_key,
                "ESL_HOST": "127.0.0.1",
                "ESL_PORT": str(self.config.esl_port),
                "ESL_PASSWORD": self.config.esl_password,
                "FREESWITCH_DOMAIN": self.config.sip_domain,
                "SIP_PORT": str(self.config.sip_port),
                # 预置 8XXX 号段账号的鉴权密码，与 vars.xml 的 default_password 一致
                "SIP_DEFAULT_PASSWORD": self.config.sip_default_password,
                "SIP_SERVER_HOST": self.config.sip_server_host,
                "BROADCAST_DATA_FILE": str(data / "broadcasts.json"),
                "MEDIA_DATA_FILE": str(data / "media.json"),
                "MEDIA_DIRECTORY": str(data / "media"),
                "SIP_DIRECTORY": str(sip_directory),
                "TERMINAL_METADATA_FILE": str(data / "terminals.json"),
                "ZONE_DATA_FILE": str(data / "zones.json"),
                "SCHEDULE_DATA_FILE": str(data / "schedules.json"),
                "SYSTEM_DATA_FILE": str(data / "system.json"),
                # 分区群呼拨号方案输出目录：FreeSWITCH 的 conf/dialplan，
                # 由业务后端按分区数据生成 90_zone_paging.xml。
                "ZONE_DIALPLAN_DIR": str(
                    Path(self.config.freeweb_runtime_dir) / "conf" / "dialplan" / "default"
                ),
                "SYSTEM_ADMIN_USERNAME": str(self.config.system_admin_username),
                "SYSTEM_ADMIN_PASSWORD": str(self.config.system_admin_password),
                "ALLOW_INSECURE_BROWSER_API": "true",
                # 便携模式下媒体文件放在 data/media，需要让业务层使用正确的路径前缀
                "MEDIA_FREESWITCH_PREFIX": (data / "media").as_posix(),
                "AUDIO_ROOTS": ",".join(
                    [
                        (data / "media").as_posix(),
                        # FreeSWITCH 自带的提示音目录也纳入白名单
                        (Path(self.config.freeweb_runtime_dir) / "sounds").as_posix(),
                        (Path(self.config.freeweb_runtime_dir) / "storage").as_posix(),
                    ]
                ),
            }
        )

        return self._spawn(
            key="api",
            cmd=[node, str(entry)],
            cwd=entry.parent,
            env=env,
            log_name="api.log",
            health=f"http://127.0.0.1:{self.config.api_port}/health",
        )

    def start_frontend(self) -> bool:
        node = self._node_executable()
        cli = self.paths.frontend / "node_modules" / "vinext" / "dist" / "cli.js"
        if not cli.is_file():
            self.log(f"未找到前端 CLI: {cli}")
            return False

        env = self._base_env()
        env["PORT"] = str(self.config.frontend_port)
        # 业务 API 端口随启动器配置变化，通过环境变量传给前端，
        # 由 layout 注入到 window.__SIP_RUNTIME__，避免改端口后前端失配。
        env["SIP_API_PORT"] = str(self.config.api_port)
        env["SIP_FRONTEND_PORT"] = str(self.config.frontend_port)
        # 版本号随构建时间注入，前端在管理页脚展示，便于核对部署版本
        try:
            from launcher.version import full_version

            env["SIP_APP_VERSION"] = full_version()
        except Exception:
            pass

        return self._spawn(
            key="frontend",
            cmd=[
                node, str(cli), "start",
                "--hostname", self.config.frontend_host,
                "--port", str(self.config.frontend_port),
            ],
            cwd=self.paths.frontend,
            env=env,
            log_name="frontend.log",
            health=f"http://127.0.0.1:{self.config.frontend_port}/",
        )

    # ---------- 内部 ----------

    def _node_executable(self) -> str:
        """优先使用随包携带的 node，其次系统 node。"""
        bundled = self.paths.node
        if bundled.is_file():
            return str(bundled)
        return "node"

    def _base_env(self) -> dict:
        env = dict(os.environ)
        env["NODE_ENV"] = "production"
        env.setdefault("NPM_CONFIG_UPDATE_NOTIFIER", "false")
        return env

    def _spawn(self, key, cmd, cwd, env, log_name, health=None, settle_seconds: float = 0.0) -> bool:
        log_file = self.paths.logs / log_name
        try:
            log_file.parent.mkdir(parents=True, exist_ok=True)
            handle = open(log_file, "ab", buffering=0)
            creation = CREATE_NO_WINDOW
            if key != "freeswitch":
                creation |= CREATE_NEW_PROCESS_GROUP

            process = subprocess.Popen(
                cmd,
                cwd=str(cwd),
                env=env,
                stdout=handle,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                creationflags=creation,
            )
            assign_to_job(process)
        except FileNotFoundError:
            self.log(f"[{key}] 可执行文件不存在: {cmd[0]}")
            return False
        except Exception as exc:
            self.log(f"[{key}] 启动失败: {exc}")
            return False

        with self._lock:
            self._processes[key] = ManagedProcess(key, process, log_file)

        self.log(f"[{key}] 已启动 PID={process.pid}")

        # 无健康探测的进程（如 FreeSWITCH）给一个短暂观察窗口，
        # 以便尽早发现「秒退」这类启动失败。
        if settle_seconds > 0:
            time.sleep(settle_seconds)
            if process.poll() is not None:
                self.log(f"[{key}] 进程提前退出 code={process.returncode}")
                return False

        if health and not self._wait_health(health, timeout=90):
            self.log(f"[{key}] 健康检查未通过: {health}")
            return False

        return True

    def _wait_health(self, url: str, timeout: int) -> bool:
        """等待 HTTP 端点就绪。

        判定标准是「服务在监听并能响应 HTTP」，不要求业务层完全健康：
        例如 /health 在 FreeSWITCH 未就绪时会返回 502，但这说明 API 本身
        已经启动成功，属于可接受的降级状态。
        """
        deadline = time.time() + timeout
        last_error = ""
        while time.time() < deadline:
            if self._stopping:
                return False
            if not self.is_alive_any():
                self.log("启动过程中相关进程已退出")
                return False
            try:
                with urllib.request.urlopen(url, timeout=3) as response:
                    if 200 <= response.status < 500:
                        return True
            except urllib.error.HTTPError as exc:
                # 服务已响应（如 502/503），说明端口已就绪
                self.log(f"健康检查收到 HTTP {exc.code}，视为已启动")
                return True
            except urllib.error.URLError as exc:
                last_error = str(exc.reason)
            except OSError as exc:
                last_error = str(exc)
            time.sleep(1.0)
        if last_error:
            self.log(f"健康检查超时，最后错误: {last_error}")
        return False

    def is_alive_any(self) -> bool:
        """启动期间用于判断「相关进程是否已崩」，避免死等健康检查。"""
        with self._lock:
            keys = list(self._processes.keys())
        for key in keys:
            managed = self._processes.get(key)
            if managed and managed.alive():
                return True
        return False

    # ---------- 停止 ----------

    def stop_all(self, grace: float = 10.0) -> None:
        self._stopping = True
        self._busy = False
        # 作废看门狗：自增代次后，旧线程下一次醒来会自行退出（见 _watchdog_gen 注释）
        self._watchdog_gen += 1
        self._watchdog_thread = None
        with self._lock:
            self.recovering.clear()
        self._emit(ServiceState.STOPPING, "正在停止服务…")

        with self._lock:
            items = list(self._processes.items())
            self._processes.clear()

        # 反序停止：前端 → API → FreeSWITCH
        order = {"frontend": 0, "api": 1, "freeswitch": 2}
        items.sort(key=lambda kv: order.get(kv[0], 9))

        # 第一轮：礼貌终止
        for key, managed in items:
            proc = managed.process
            if proc.poll() is None:
                self.log(f"[{key}] 正在停止 PID={proc.pid}")
                try:
                    proc.terminate()
                except Exception:
                    pass

        # 第二轮：等待退出，超时则强杀
        deadline = time.time() + grace
        for key, managed in items:
            proc = managed.process
            remaining = max(0.0, deadline - time.time())
            try:
                proc.wait(timeout=remaining)
                self.log(f"[{key}] 已退出 code={proc.returncode}")
            except subprocess.TimeoutExpired:
                self.log(f"[{key}] 未响应，强制结束")
                try:
                    proc.kill()
                    proc.wait(timeout=5)
                except Exception:
                    pass

        self._emit(ServiceState.STOPPED, "服务已停止")

    def is_running(self) -> bool:
        with self._lock:
            return any(item.alive() for item in self._processes.values())

    def snapshot(self) -> dict[str, Optional[int]]:
        with self._lock:
            return {key: item.exit_code() for key, item in self._processes.items()}

    # ---------- 看门狗 ----------

    def start_watchdog(self) -> None:
        """启动运行期看门狗。

        背景：FreeSWITCH 可能因系统时钟跳变等原因**静默退出**。此时 API 与前端
        仍在监听，管理页面照常打开，但首页数据全部加载失败
        （`connect ECONNREFUSED 127.0.0.1:8021`），且不会自愈。
        看门狗负责发现这种情况并按退避策略自动重启。
        """
        if self._watchdog_thread and self._watchdog_thread.is_alive():
            return
        self._watchdog_gen += 1
        generation = self._watchdog_gen
        self._watchdog_thread = threading.Thread(
            target=self._watchdog_loop, args=(generation,), name="watchdog", daemon=True
        )
        self._watchdog_thread.start()
        self.log("[watchdog] 运行期守护已启动（巡检间隔 %ds）" % int(WATCHDOG_INTERVAL))

    def _watchdog_loop(self, generation: int) -> None:
        while not self._stopping and generation == self._watchdog_gen:
            time.sleep(WATCHDOG_INTERVAL)
            if self._stopping or generation != self._watchdog_gen:
                break
            try:
                self._watchdog_tick()
            except Exception as exc:  # 看门狗自身绝不能崩
                self.log(f"[watchdog] 巡检异常: {exc}")

    def _watchdog_tick(self) -> None:
        with self._lock:
            watched = list(self._processes.keys())
            # 启动/重启编排进行中：此时进程表本就在变，跳过本轮避免误判
            if not watched or self._busy:
                return
            stopping = self._stopping

        if stopping:
            return

        for key in watched:
            with self._lock:
                managed = self._processes.get(key)
                if managed is None:
                    continue
                if managed.alive():
                    # 存活足够久 → 认定已稳定，重置「连续崩溃」计数
                    if managed.unstable_streak and (
                        time.time() - managed.started_at > WATCHDOG_UNSTABLE_WINDOW
                    ):
                        managed.unstable_streak = 0
                    continue
                code = managed.exit_code()

            self._restart_service(key, code)

    def _restart_service(self, key: str, exit_code: Optional[int]) -> None:
        """按退避策略重启单个服务；连续崩溃过多则放弃并上报。"""
        with self._lock:
            managed = self._processes.get(key)
            if managed is None:
                return
            managed.unstable_streak += 1
            streak = managed.unstable_streak
            restarts = managed.restarts
            # 进程存活时长：用来区分「偶发崩溃」与「起来就崩」
            lived = time.time() - managed.started_at

        if streak > WATCHDOG_UNSTABLE_LIMIT:
            self.log(
                f"[watchdog] {key} 连续 {streak} 次启动后很快退出，已停止自动重启；"
                f"请检查 logs/{key}.log"
            )
            self.optional_failures[key] = (
                f"{key} 反复启动失败（连续 {streak} 次），已停止自动重启"
            )
            with self._lock:
                self.recovering.discard(key)
            self._emit(ServiceState.RUNNING, self._detail_text())
            return

        # 指数退避：第 n 次等待 INTERVAL * 2^(n-1)，上限 WATCHDOG_MAX_BACKOFF
        delay = min(WATCHDOG_INTERVAL * (2 ** (streak - 1)), WATCHDOG_MAX_BACKOFF)
        with self._lock:
            self.recovering.add(key)
        self.log(
            f"[watchdog] {key} 已退出（code={exit_code}，运行 {lived:.0f}s），"
            f"{delay:.0f}s 后自动重启（第 {streak} 次）"
        )
        self._emit(ServiceState.RUNNING, self._detail_text())

        # 退避期间分段休眠，保证能及时响应停止请求
        waited = 0.0
        while waited < delay and not self._stopping:
            time.sleep(min(1.0, delay - waited))
            waited += 1.0
        if self._stopping:
            with self._lock:
                self.recovering.discard(key)
            return

        ok = self._spawn_service(key)
        with self._lock:
            self.recovering.discard(key)
            managed = self._processes.get(key)
            if managed is not None and ok:
                # 关键：_spawn_service 会创建全新的 ManagedProcess，
                # 必须把崩溃计数与重启次数「搬」过去，否则连续崩溃判定永远归零、
                # 退避也不会升级（曾漏掉这里，导致 unstable 上限形同虚设）。
                managed.restarts = restarts + 1
                managed.unstable_streak = streak
                self._last_restart_at[key] = time.time()
        if ok:
            self.log(f"[watchdog] {key} 已自动重启（累计 {restarts + 1} 次）")
        else:
            self.log(f"[watchdog] {key} 自动重启失败")
        self._emit(ServiceState.RUNNING, self._detail_text())

    def _spawn_service(self, key: str) -> bool:
        """按服务名重新拉起对应进程（供看门狗复用）。

        直接复用各服务既有的启动方法，确保重启与首启走完全相同的路径
        （环境变量、配置渲染、健康检查都一致）。
        """
        try:
            if key == "freeswitch":
                ok = self.start_freeswitch()
                if not ok:
                    # 可执行文件已不存在：清理登记，避免看门狗反复重试幽灵进程
                    with self._lock:
                        self._processes.pop(key, None)
                return ok
            if key == "api":
                return self.start_api()
            if key == "frontend":
                return self.start_frontend()
        except Exception as exc:
            self.log(f"[watchdog] {key} 重启异常: {exc}")
        return False

    def _detail_text(self) -> str:
        """把「正在恢复」的服务拼进状态详情，避免界面误显示为一切正常。"""
        with self._lock:
            recovering = sorted(self.recovering)
        if recovering:
            return "服务运行中（正在自动恢复：" + "、".join(recovering) + "）"
        if self.optional_failures:
            return "服务运行中（语音引擎未就绪，广播功能受限）"
        return "所有服务运行中"

