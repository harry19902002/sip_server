"""网卡枚举：列出本机可用的 IPv4 网卡，供 FreeSWITCH 绑定选择。

背景：FreeSWITCH 默认用 `$${local_ip_v4}`（自动探测）作为 sip-ip/rtp-ip。
但当机器上存在代理软件的 TUN 虚拟网卡（如 Clash/Mihomo 的 198.18.0.1）时，
自动探测会选中虚拟网卡，导致 SIP 终端无法注册。此时需要让用户显式指定
绑定到哪块真实网卡。

实现说明：优先调用 Win32 的 GetAdaptersAddresses（能拿到网卡友好名与
状态），失败时回退到 socket 枚举（只有 IP，无名）。两条路径都不依赖
第三方库，便于 PyInstaller 打包。
"""

from __future__ import annotations

import ctypes
import socket
from dataclasses import dataclass
from ctypes import wintypes


# ---------------------------------------------------------------- 数据结构


@dataclass
class NetworkAdapter:
    """一块网卡上的一个 IPv4 地址。"""

    name: str          # 网卡友好名，如「以太网 2」「WLAN」
    ip: str            # IPv4 地址
    description: str = ""
    is_virtual: bool = False   # 疑似虚拟网卡（TUN/TAP/代理/虚拟机）

    @property
    def label(self) -> str:
        """下拉框展示用的文案。"""
        parts = [f"{self.ip}", self.name]
        if self.description and self.description != self.name:
            parts.append(self.description)
        text = "  ·  ".join(parts)
        if self.is_virtual:
            text += "（虚拟网卡）"
        return text


# 疑似虚拟网卡的关键字（大小写不敏感）。命中后仅作标记，仍允许用户选择。
_VIRTUAL_HINTS = (
    "mihomo", "clash", "tun", "tap", "wireguard", "openvpn", "tailscale",
    "zerotier", "virtualbox", "vmware", "hyper-v", "vethernet", "loopback",
    "npcap", "wintun", "softether", "sangfor", "easyconnect", "anyconnect",
    "docker", "wsl",
)


def _looks_virtual(*texts: str) -> bool:
    blob = " ".join(t for t in texts if t).lower()
    return any(hint in blob for hint in _VIRTUAL_HINTS)


def is_probably_unusable(ip: str) -> bool:
    """判断 IP 是否不适合作为 SIP 绑定地址。

    - 回环 127.0.0.0/8
    - 链路本地 169.254.0.0/16
    - 基准测试保留段 198.18.0.0/15（常被代理软件用作 fake-ip）
    """
    if not ip or ip.startswith("127."):
        return True
    parts = ip.split(".")
    if len(parts) != 4:
        return True
    try:
        first, second = int(parts[0]), int(parts[1])
    except ValueError:
        return True
    if first == 169 and second == 254:
        return True
    if first == 198 and second in (18, 19):
        return True
    return False


# ---------------------------------------------------------------- Win32 实现

_AF_UNSPEC = 0
_GAA_FLAG_SKIP_ANYCAST = 0x0002
_GAA_FLAG_SKIP_MULTICAST = 0x0004
_GAA_FLAG_SKIP_DNS_SERVER = 0x0008

_IF_OPER_STATUS_UP = 1
_IF_TYPE_SOFTWARE_LOOPBACK = 24


class _SOCKET_ADDRESS(ctypes.Structure):
    _fields_ = [
        ("lpSockaddr", ctypes.c_void_p),
        ("iSockaddrLength", ctypes.c_int),
    ]


class _IP_ADAPTER_UNICAST_ADDRESS(ctypes.Structure):
    pass


_IP_ADAPTER_UNICAST_ADDRESS._fields_ = [
    ("Length", wintypes.ULONG),
    ("Flags", wintypes.ULONG),
    ("Next", ctypes.POINTER(_IP_ADAPTER_UNICAST_ADDRESS)),
    ("Address", _SOCKET_ADDRESS),
    ("PrefixOrigin", ctypes.c_int),
    ("SuffixOrigin", ctypes.c_int),
    ("DadState", ctypes.c_int),
    ("ValidLifetime", wintypes.ULONG),
    ("PreferredLifetime", wintypes.ULONG),
    ("LeaseLifetime", wintypes.ULONG),
]


class _IP_ADAPTER_ADDRESSES(ctypes.Structure):
    """只声明到 OperStatus 为止，后续字段用不到。

    ctypes 按指针地址读取内存，声明字段少于真实结构不影响读取，
    只要不越界访问未声明字段即可。
    """

    pass


_IP_ADAPTER_ADDRESSES._fields_ = [
    ("Length", wintypes.ULONG),
    ("IfIndex", wintypes.ULONG),
    ("Next", ctypes.POINTER(_IP_ADAPTER_ADDRESSES)),
    ("AdapterName", ctypes.c_char_p),
    ("FirstUnicastAddress", ctypes.POINTER(_IP_ADAPTER_UNICAST_ADDRESS)),
    ("FirstAnycastAddress", ctypes.c_void_p),
    ("FirstMulticastAddress", ctypes.c_void_p),
    ("FirstDnsServerAddress", ctypes.c_void_p),
    ("DnsSuffix", ctypes.c_wchar_p),
    ("Description", ctypes.c_wchar_p),
    ("FriendlyName", ctypes.c_wchar_p),
    ("PhysicalAddress", ctypes.c_ubyte * 8),
    ("PhysicalAddressLength", wintypes.ULONG),
    ("Flags", wintypes.ULONG),
    ("Mtu", wintypes.ULONG),
    ("IfType", wintypes.ULONG),
    ("OperStatus", ctypes.c_int),
]


def _extract_ipv4(sockaddr_ptr) -> str | None:
    """从 sockaddr 指针取出 IPv4 字符串（仅处理 AF_INET）。"""
    if not sockaddr_ptr:
        return None
    raw = ctypes.cast(sockaddr_ptr, ctypes.POINTER(ctypes.c_ubyte))
    family = raw[0] | (raw[1] << 8)
    if family != socket.AF_INET:
        return None
    return socket.inet_ntoa(bytes(raw[4:8]))


def _enum_with_win32() -> list[NetworkAdapter]:
    try:
        iphlpapi = ctypes.windll.iphlpapi  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        return []

    flags = (
        _GAA_FLAG_SKIP_ANYCAST
        | _GAA_FLAG_SKIP_MULTICAST
        | _GAA_FLAG_SKIP_DNS_SERVER
    )

    size = wintypes.ULONG(15000)
    for _ in range(3):
        buffer = ctypes.create_string_buffer(size.value)
        ret = iphlpapi.GetAdaptersAddresses(
            wintypes.ULONG(_AF_UNSPEC),
            wintypes.ULONG(flags),
            None,
            ctypes.byref(buffer),
            ctypes.byref(size),
        )
        if ret == 0:
            break
        # ERROR_BUFFER_OVERFLOW = 111：缓冲区不够，size 已被回填为所需大小
        if ret != 111:
            return []
    else:
        return []

    adapters: list[NetworkAdapter] = []
    node = ctypes.cast(buffer, ctypes.POINTER(_IP_ADAPTER_ADDRESSES))
    while node:
        entry = node.contents  # type: ignore[assignment]
        if entry.IfType != _IF_TYPE_SOFTWARE_LOOPBACK and entry.OperStatus == _IF_OPER_STATUS_UP:
            friendly = entry.FriendlyName or ""
            desc = entry.Description or ""
            virtual = _looks_virtual(friendly, desc)
            unicast = entry.FirstUnicastAddress
            while unicast:
                ip = _extract_ipv4(unicast.contents.Address.lpSockaddr)
                if ip and not is_probably_unusable(ip):
                    adapters.append(
                        NetworkAdapter(
                            name=friendly or desc or "未知网卡",
                            ip=ip,
                            description=desc,
                            is_virtual=virtual,
                        )
                    )
                unicast = unicast.contents.Next
        node = entry.Next

    return adapters


def _enum_with_socket() -> list[NetworkAdapter]:
    """回退方案：只能拿到 IP，网卡名统一占位。"""
    found: list[NetworkAdapter] = []
    seen: set[str] = set()
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
    except OSError:
        infos = []
    for info in infos:
        ip = info[4][0]
        if ip in seen or is_probably_unusable(ip):
            continue
        seen.add(ip)
        found.append(NetworkAdapter(name="本机网卡", ip=ip))
    return found


# ---------------------------------------------------------------- 对外接口


def list_adapters(include_virtual: bool = False) -> list[NetworkAdapter]:
    """列出可用 IPv4 网卡，真实网卡在前、虚拟网卡在后。

    默认过滤掉代理 TUN 等虚拟网卡（它们对 SIP 终端不可达，是注册失败的
    常见原因）；调用方传 include_virtual=True 可看到全部网卡。

    同一 IP 只保留第一条。若 Win32 调用不可用则回退到 socket 枚举。
    """
    adapters = _enum_with_win32()
    if not adapters:
        adapters = _enum_with_socket()

    deduped: list[NetworkAdapter] = []
    seen: set[str] = set()
    for adapter in adapters:
        if adapter.ip in seen:
            continue
        seen.add(adapter.ip)
        if adapter.is_virtual and not include_virtual:
            continue
        deduped.append(adapter)

    # 真实网卡优先，方便用户直接选择
    deduped.sort(key=lambda a: (a.is_virtual, a.ip))
    return deduped


def find_adapter(ip: str) -> NetworkAdapter | None:
    """按 IP 查找网卡（含虚拟网卡，便于对已配置但当前未列出的 IP 作说明）。"""
    for adapter in list_adapters(include_virtual=True):
        if adapter.ip == ip:
            return adapter
    return None


def describe_ip(ip: str) -> str:
    """给 IP 生成简短说明，用于界面展示。"""
    if not ip:
        return "自动探测"
    adapter = find_adapter(ip)
    if adapter is None:
        return f"{ip}（未在当前网卡中找到）"
    text = f"{ip} · {adapter.name}"
    if adapter.is_virtual:
        text += "（虚拟网卡）"
    return text
