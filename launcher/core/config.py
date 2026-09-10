"""运行时配置：路径解析、配置加载、端口与主机发现。

支持两种部署形态，自动识别：

1. **便携模式**（解压即用）
   程序目录可写，数据放在 `<程序目录>/data`，整个文件夹可拷贝搬运。

2. **安装模式**（Inno Setup 安装到 Program Files）
   程序目录只读，数据改写用户目录 `%LOCALAPPDATA%\\SIPBroadcast\\data`，
   避免因权限不足导致启动失败。

判定方式：尝试在程序目录创建探针文件，失败即判定为安装模式。
"""

from __future__ import annotations

import os
import socket
import sys
from dataclasses import dataclass, field
from pathlib import Path


# ---------------------------------------------------------------------- 路径


def is_frozen() -> bool:
    """是否运行在 PyInstaller 打包后的 exe 中。"""
    return getattr(sys, "frozen", False)


def app_root() -> Path:
    """程序所在目录（安装/便携目录）。"""
    if is_frozen():
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent.parent


def resource_root() -> Path:
    """只读资源目录（打包后为 PyInstaller 解包目录）。"""
    if is_frozen() and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS).resolve()  # type: ignore[attr-defined]
    return app_root()


def default_user_data_dir() -> Path:
    """安装模式下的可写数据目录。"""
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
    if base:
        return Path(base) / "SIPBroadcast"
    return Path.home() / ".sipbroadcast"


# 安装包会在程序目录留下此标记，用于显式区分「安装模式」与「便携模式」。
# 之所以不靠「目录是否可写」判断：管理员运行时 Program Files 也可写，
# 会导致同一套程序在不同账号下行为不一致。
INSTALL_MARKER = ".installed"


def _directory_is_writable(path: Path) -> bool:
    """通过实际创建探针文件判断目录可写，比检查属性更可靠。"""
    try:
        path.mkdir(parents=True, exist_ok=True)
        probe = path / ".write-probe"
        with open(probe, "w", encoding="utf-8") as handle:
            handle.write("probe")
        probe.unlink()
        return True
    except OSError:
        return False


@dataclass
class RuntimePaths:
    root: Path
    data: Path
    logs: Path
    runtime: Path
    frontend: Path
    node: Path
    freeswitch: Path
    # FreeSWITCH 的可写运行时根目录（conf / log / db / recordings 落在这里）
    freeswitch_runtime: Path = None  # type: ignore[assignment]
    # 数据是否落在程序目录之外（安装模式）
    portable: bool = True

    def ensure(self) -> None:
        for path in (self.data, self.logs, self.runtime):
            path.mkdir(parents=True, exist_ok=True)
        if self.freeswitch_runtime:
            self.freeswitch_runtime.mkdir(parents=True, exist_ok=True)


def build_paths() -> RuntimePaths:
    """构建路径布局，自动区分便携模式与安装模式。

    便携模式：
        <root>/data, <root>/logs, <root>/runtime, <root>/app, <root>/node

    安装模式：
        程序体仍在 <root>，但可写数据改到 <用户目录>/SIPBroadcast 下，
        FreeSWITCH 的 conf/log/db 也一并落到数据目录，避免写 Program Files。
    """
    root = app_root()

    # 判定模式：
    #   1) 存在安装标记 → 安装模式（由安装包写入，最可靠）；
    #   2) 否则若程序目录可写 → 便携模式；
    #   3) 否则（拷贝到只读位置）也走安装模式，数据落用户目录。
    installed = (root / INSTALL_MARKER).is_file()
    portable = (not installed) and _directory_is_writable(root)

    if portable:
        data = root / "data"
        logs = root / "logs"
        runtime = root / "runtime"
        fs_runtime = root / "data" / "freeswitch"
    else:
        # 安装模式：数据放用户目录
        user_base = default_user_data_dir()
        data = user_base / "data"
        logs = user_base / "logs"
        runtime = user_base / "runtime"
        # FreeSWITCH 的可写部分（配置、日志、数据库）放用户目录
        fs_runtime = data / "freeswitch"

    return RuntimePaths(
        root=root,
        data=data,
        logs=logs,
        runtime=runtime,
        frontend=root / "app",
        node=root / "node" / "node.exe",
        # FreeSWITCH 程序体（DLL 与模块）始终随程序目录走，保持只读使用
        freeswitch=root / "data" / "freeswitch",
        freeswitch_runtime=fs_runtime,
        portable=portable,
    )


@dataclass
class AppConfig:
    """运行参数。字段默认值面向便携运行，可被 config.json / 环境变量覆盖。"""

    frontend_port: int = 3000
    api_port: int = 3001
    esl_port: int = 8021
    sip_port: int = 5060
    sip_domain: str = "sip.local"

    # FreeSWITCH 在 Windows 上无法像 Linux 一样被容器编排，
    # 这里保留可配置的监听地址，默认仅本机。
    api_host: str = "127.0.0.1"
    frontend_host: str = "127.0.0.1"
    # SIP 终端注册时使用的服务器地址；留空则自动探测局域网 IP
    sip_server_host: str = ""

    esl_password: str = "sip-broadcast-esl"
    api_key: str = "sip-broadcast-api-key"
    sip_default_password: str = "123456"

    system_admin_username: str = "admin"
    system_admin_password: str = "123456"

    freeweb_runtime_dir: str = ""
    # 空闲多久后自动关闭服务（分钟）；0 表示不自动关闭
    idle_shutdown_minutes: int = 0
    auto_open_browser: bool = True
    open_browser_url: str = ""

    raw: dict = field(default_factory=dict)

    # ---------- 加载 ----------

    @classmethod
    def load(cls, paths: RuntimePaths) -> "AppConfig":
        config = cls()
        config.raw = {}

        # 1) 用户可编辑配置
        config._merge_file(paths.root / "config.json")
        # 2) 安装模式下也读取用户目录中的配置（优先级更高，便于用户改端口）
        if not paths.portable:
            config._merge_file(paths.data.parent / "config.json")
        # 3) 环境变量覆盖（最高优先级，便于临时调试）
        config._merge_env()

        if not config.freeweb_runtime_dir:
            config.freeweb_runtime_dir = str(paths.freeswitch)

        # SIP 终端需要访问真实网卡地址，而非回环地址
        if not config.sip_server_host:
            config.sip_server_host = detect_lan_ip()

        if not config.open_browser_url:
            config.open_browser_url = f"http://127.0.0.1:{config.frontend_port}/"

        return config

    def _merge_file(self, path: Path) -> None:
        if not path.is_file():
            return
        try:
            import json

            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return
        if isinstance(payload, dict):
            self._apply(payload)
            self.raw.update(payload)

    def _merge_env(self) -> None:
        mapping = {
            "SIP_FRONTEND_PORT": "frontend_port",
            "SIP_API_PORT": "api_port",
            "SIP_ESL_PORT": "esl_port",
            "SIP_PORT": "sip_port",
            "FREESWITCH_DOMAIN": "sip_domain",
            "SIP_ESL_PASSWORD": "esl_password",
            "SIP_API_KEY": "api_key",
            "SIP_DEFAULT_PASSWORD": "sip_default_password",
            "SIP_ADMIN_USERNAME": "system_admin_username",
            "SIP_ADMIN_PASSWORD": "system_admin_password",
            "SIP_FREESWITCH_DIR": "freeweb_runtime_dir",
        }
        for env_key, attr in mapping.items():
            value = os.environ.get(env_key)
            if value is None or value == "":
                continue
            self._apply({attr: value})

    def _apply(self, payload: dict) -> None:
        for key, value in payload.items():
            if not hasattr(self, key):
                continue
            current = getattr(self, key)
            try:
                if isinstance(current, bool):
                    setattr(self, key, _coerce_bool(value))
                elif isinstance(current, int):
                    setattr(self, key, int(value))
                else:
                    setattr(self, key, str(value))
            except (TypeError, ValueError):
                continue


def _coerce_bool(value) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


# ------------------------------------------------------------------ 网络工具


def detect_lan_ip() -> str:
    """探测本机在局域网中的地址，用于生成 SIP 终端可访问的配置。

    注意：部分环境（VPN / 代理 TUN 网卡）会返回 198.18.x.x 这类
    fake-ip 地址，对 SIP 终端不可达，需要跳过并回退到真实网卡。
    """
    candidates: list[str] = []

    # 方式一：UDP connect 探测默认出口地址
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.settimeout(0.5)
            probe.connect(("8.8.8.8", 80))
            candidates.append(probe.getsockname()[0])
    except OSError:
        pass

    # 方式二：枚举本机网卡地址
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            candidates.append(info[4][0])
    except OSError:
        pass

    for address in candidates:
        if _is_usable_lan_ip(address):
            return address
    return "127.0.0.1"


def _is_usable_lan_ip(address: str) -> bool:
    if not address or address.startswith("127."):
        return False
    parts = address.split(".")
    if len(parts) != 4:
        return False
    try:
        first, second = int(parts[0]), int(parts[1])
    except ValueError:
        return False

    # 198.18.0.0/15 是基准测试保留段，常被代理软件拿来做 fake-ip
    if first == 198 and second in (18, 19):
        return False
    # 169.254.0.0/16 为链路本地地址，不可路由
    if first == 169 and second == 254:
        return False
    return True


def port_is_free(port: int, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.3)
        try:
            probe.bind((host, port))
            return True
        except OSError:
            return False


def find_free_port(preferred: int, host: str = "127.0.0.1", limit: int = 60) -> int:
    for offset in range(limit):
        candidate = preferred + offset
        if port_is_free(candidate, host):
            return candidate
    raise RuntimeError(f"无法在 {preferred}..{preferred + limit} 范围内找到可用端口")
