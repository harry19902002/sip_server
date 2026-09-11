"""SIP 广播系统 · Windows 启动器

双击运行：自动拉起 FreeSWITCH / 业务 API / 管理前端，
在系统托盘展示状态，关闭窗口即停止全部服务。
"""

from __future__ import annotations

import os
import sys
import threading
import time
import tkinter as tk
import webbrowser
from tkinter import ttk
from typing import Optional


def _bootstrap_import_path() -> None:
    """让 core 包在「源码运行」与「PyInstaller 打包」两种模式下都能导入。

    - 源码运行：把 launcher/ 的父目录加入 sys.path，用 launcher.core.*
    - 打包运行：PyInstaller 已把 launcher.core 打进包，直接用相对导入
    """
    if getattr(sys, "frozen", False):
        # 冻结环境下模块已随 exe 打包，无需改路径
        return
    current_dir = os.path.dirname(os.path.abspath(__file__))
    parent_dir = os.path.dirname(current_dir)
    if parent_dir not in sys.path:
        sys.path.insert(0, parent_dir)


_bootstrap_import_path()

from launcher.core.config import (  # noqa: E402
    AppConfig,
    RuntimePaths,
    build_paths,
    port_is_free,
)
from launcher.core.logger import Logger  # noqa: E402
from launcher.core.network import describe_ip, list_adapters  # noqa: E402
from launcher.core.process import ProcessManager  # noqa: E402
from launcher.core.single_instance import SingleInstance, focus_existing_window  # noqa: E402
from launcher.core.state import STATE_LABELS, ServiceState, StatusCenter, StatusSnapshot  # noqa: E402

APP_TITLE = "SIP 广播系统"

# 状态 → 托盘图标颜色（深色主题下的高对比配色）
STATE_COLORS = {
    ServiceState.IDLE: "#8b95a5",
    ServiceState.STARTING: "#e8a33d",
    ServiceState.RUNNING: "#3fb950",
    ServiceState.STOPPING: "#e8a33d",
    ServiceState.STOPPED: "#8b95a5",
    ServiceState.FAILED: "#f85149",
}


class LauncherApp:
    def __init__(self) -> None:
        self.paths: RuntimePaths = build_paths()
        self.paths.ensure()
        self.logger = Logger(self.paths.logs)
        self.config = AppConfig.load(self.paths)
        self.status = StatusCenter()
        self.tray_icon = None
        self._shutting_down = False

        self.status.update(
            state=ServiceState.IDLE,
            detail="准备就绪",
            frontend_port=self.config.frontend_port,
            api_port=self.config.api_port,
            lan_ip=self.config.sip_server_host or "127.0.0.1",
        )

        self.manager = ProcessManager(self.paths, self.config, self.logger, on_state=self._on_service_state)

        self.root = tk.Tk()
        self._build_window()
        self._build_tray()

        self.status.subscribe(lambda snap: self.root.after(0, self._render, snap))
        self.logger.subscribe(lambda line: self.root.after(0, self._append_log, line))

        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.bind("<Unmap>", self._on_unmap)

        # 自动启动
        self.root.after(300, self.start_services)

    # ------------------------------------------------------------ 界面

    def _build_window(self) -> None:
        root = self.root
        root.title(APP_TITLE)
        root.geometry("780x820")
        root.minsize(700, 720)

        style = ttk.Style(root)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("Headline.TLabel", font=("Microsoft YaHei UI", 15, "bold"))
        style.configure("Muted.TLabel", font=("Microsoft YaHei UI", 9), foreground="#6b7280")
        style.configure("Status.TLabel", font=("Microsoft YaHei UI", 12, "bold"))
        style.configure("Value.TLabel", font=("Consolas", 10))
        style.configure("TButton", font=("Microsoft YaHei UI", 10), padding=(14, 6))

        container = ttk.Frame(root, padding=18)
        container.pack(fill="both", expand=True)

        # ---- 顶部：状态 ----
        header = ttk.Frame(container)
        header.pack(fill="x")

        self.state_label = ttk.Label(header, text="未启动", style="Status.TLabel")
        self.state_label.pack(anchor="w")

        self.detail_label = ttk.Label(header, text="准备就绪", style="Muted.TLabel")
        self.detail_label.pack(anchor="w", pady=(2, 0))

        # 降级提示条：例如未安装 FreeSWITCH 时说明原因与补救方式
        self.warning_label = ttk.Label(
            header,
            text="",
            style="Muted.TLabel",
            foreground="#e8a33d",
            wraplength=640,
            justify="left",
        )
        self.warning_label.pack(anchor="w", pady=(6, 0))

        ttk.Separator(container, orient="horizontal").pack(fill="x", pady=14)

        # ---- 中部：信息网格 ----
        info = ttk.Frame(container)
        info.pack(fill="x")
        info.columnconfigure(1, weight=1)

        self.value_labels: dict[str, ttk.Label] = {}
        rows = [
            ("管理页面", "manage_url"),
            ("业务 API", "api_url"),
            ("局域网地址", "lan_url"),
            ("服务进度", "progress"),
        ]
        for index, (label, key) in enumerate(rows):
            ttk.Label(info, text=label, style="Muted.TLabel").grid(
                row=index, column=0, sticky="w", padx=(0, 12), pady=3
            )
            value = ttk.Label(info, text="—", style="Value.TLabel")
            value.grid(row=index, column=1, sticky="w", pady=3)
            self.value_labels[key] = value

        ttk.Separator(container, orient="horizontal").pack(fill="x", pady=14)

        # ---- 网卡绑定 ----
        self._build_adapter_picker(container)

        ttk.Separator(container, orient="horizontal").pack(fill="x", pady=14)

        # ---- 端口配置 ----
        self._build_port_settings(container)

        ttk.Separator(container, orient="horizontal").pack(fill="x", pady=14)

        # ---- 按钮 ----
        actions = ttk.Frame(container)
        actions.pack(fill="x")

        self.open_button = ttk.Button(actions, text="打开管理页面", command=self.open_browser)
        self.open_button.pack(side="left")

        self.restart_button = ttk.Button(actions, text="重启服务", command=self.restart_services)
        self.restart_button.pack(side="left", padx=8)

        self.logs_button = ttk.Button(actions, text="打开日志目录", command=self.open_logs)
        self.logs_button.pack(side="left")

        self.stop_button = ttk.Button(actions, text="停止服务", command=self.stop_services)
        self.stop_button.pack(side="right")

        # ---- 日志 ----
        ttk.Label(container, text="运行日志", style="Muted.TLabel").pack(anchor="w", pady=(16, 4))

        log_frame = ttk.Frame(container)
        log_frame.pack(fill="both", expand=True)

        self.log_widget = tk.Text(
            log_frame,
            height=10,
            wrap="none",
            font=("Consolas", 9),
            background="#11151c",
            foreground="#c9d1d9",
            insertbackground="#c9d1d9",
            relief="flat",
            padx=10,
            pady=8,
        )
        scrollbar = ttk.Scrollbar(log_frame, orient="vertical", command=self.log_widget.yview)
        self.log_widget.configure(yscrollcommand=scrollbar.set)
        self.log_widget.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        self.log_widget.configure(state="disabled")

    # ------------------------------------------------------------ 网卡选择

    def _build_adapter_picker(self, parent: ttk.Frame) -> None:
        """FreeSWITCH 绑定网卡选择。

        机器上装有代理软件时会出现 TUN 虚拟网卡（如 198.18.0.1），
        FreeSWITCH 自动探测可能选中它，导致 SIP 终端注册不上。
        这里让用户显式指定绑定到哪块网卡。
        """
        frame = ttk.Frame(parent)
        frame.pack(fill="x")

        header = ttk.Frame(frame)
        header.pack(fill="x")

        ttk.Label(header, text="FreeSWITCH 绑定网卡", style="Muted.TLabel").pack(side="left")
        self.show_virtual = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            header,
            text="显示虚拟网卡",
            variable=self.show_virtual,
            command=self._refresh_adapters,
        ).pack(side="right")

        row = ttk.Frame(frame)
        row.pack(fill="x", pady=(6, 0))
        row.columnconfigure(0, weight=1)

        self.adapter_combo = ttk.Combobox(row, state="readonly", values=[])
        self.adapter_combo.grid(row=0, column=0, sticky="ew")
        self.adapter_combo.bind("<<ComboboxSelected>>", lambda _e: self._on_adapter_selected())

        self.apply_adapter_button = ttk.Button(row, text="应用并重启", command=self._apply_adapter)
        self.apply_adapter_button.grid(row=0, column=1, padx=(8, 0))

        self.adapter_hint = ttk.Label(
            frame,
            text="",
            style="Muted.TLabel",
            wraplength=690,
            justify="left",
        )
        self.adapter_hint.pack(anchor="w", pady=(6, 0))

        self._adapter_map: dict[str, str] = {}
        self._refresh_adapters()

    def _refresh_adapters(self) -> None:
        """按当前选择重新填充网卡下拉框，并尽量保持已选项。"""
        current_ip = getattr(self.config, "bind_ip", "") or ""

        try:
            adapters = list_adapters(include_virtual=self.show_virtual.get())
        except Exception as exc:  # noqa: BLE001
            self.adapter_hint.configure(text=f"无法枚举网卡: {exc}")
            return

        self._adapter_map = {}
        values: list[str] = []

        auto_label = "自动探测（推荐）"
        self._adapter_map[auto_label] = ""
        values.append(auto_label)

        for adapter in adapters:
            label = adapter.label
            self._adapter_map[label] = adapter.ip
            values.append(label)

        # 已配置的 IP 若不在当前列表中（例如被「隐藏虚拟网卡」过滤），
        # 仍补一条，避免用户看到的选择与实际配置不一致。
        known_ips = set(self._adapter_map.values())
        if current_ip and current_ip not in known_ips:
            extra = f"{current_ip} · 当前配置（不在列表）"
            self._adapter_map[extra] = current_ip
            values.append(extra)

        self.adapter_combo.configure(values=values)

        selected = None
        for label, ip in self._adapter_map.items():
            if ip == current_ip:
                selected = label
                break
        self.adapter_combo.set(selected or auto_label)

        self._update_adapter_hint(current_ip, adapters)

    def _update_adapter_hint(self, current_ip: str, adapters: list) -> None:
        virtual_hidden = 0
        try:
            all_adapters = list_adapters(include_virtual=True)
            virtual_hidden = len(all_adapters) - len(adapters)
        except Exception:  # noqa: BLE001
            pass

        if not current_ip:
            text = "未指定网卡：由 FreeSWITCH 自动探测。"
        else:
            text = f"当前绑定：{describe_ip(current_ip)}。"

        if virtual_hidden > 0:
            text += f"已隐藏 {virtual_hidden} 块虚拟网卡（代理 TUN 等，选择后会导致 SIP 终端注册不上）。"
        self.adapter_hint.configure(text=text)

    def _on_adapter_selected(self) -> None:
        label = self.adapter_combo.get()
        ip = self._adapter_map.get(label, "")
        if not ip:
            self.adapter_hint.configure(text="已选择「自动探测」，保存后由 FreeSWITCH 自行决定绑定网卡。")
            return
        self.adapter_hint.configure(text=f"待应用：{describe_ip(ip)}。点击「应用并重启」生效。")

    def _apply_adapter(self) -> None:
        """保存所选网卡到 config.json，并重启服务使其生效。"""
        label = self.adapter_combo.get()
        ip = self._adapter_map.get(label, "")

        self.config.bind_ip = ip
        # 终端注册地址跟随所选网卡，避免「绑 A 卡却告诉终端连 B 地址」
        if ip:
            self.config.sip_server_host = ip

        try:
            self.config.save(self.paths)
            self.logger.write(
                f"已保存绑定网卡配置: {describe_ip(ip) if ip else '自动探测'}"
            )
        except Exception as exc:  # noqa: BLE001
            self.logger.write(f"保存配置失败: {exc}")

        self.status.update(lan_ip=self.config.sip_server_host or "127.0.0.1")
        self._update_adapter_hint(ip, list_adapters(include_virtual=self.show_virtual.get()))

        if self.manager.is_running():
            self.logger.write("正在按新网卡配置重启服务…")
            self.restart_services()
        else:
            self.logger.write("服务未运行，配置已保存，下次启动时生效。")

    # ------------------------------------------------------------ 端口配置

    def _build_port_settings(self, parent: ttk.Frame) -> None:
        """端口配置：管理页面、业务 API、SIP 均可在界面上修改。"""
        frame = ttk.Frame(parent)
        frame.pack(fill="x")

        ttk.Label(frame, text="端口配置", style="Muted.TLabel").pack(anchor="w")

        grid = ttk.Frame(frame)
        grid.pack(fill="x", pady=(6, 0))

        # (显示名, config 字段, 说明)
        self._port_fields = [
            ("管理页面", "frontend_port", "浏览器访问地址的端口"),
            ("业务 API", "api_port", "后端服务端口"),
            ("SIP 信令", "sip_port", "SIP 终端注册端口"),
        ]
        self.port_vars: dict[str, tk.StringVar] = {}
        self._port_entries: dict[str, ttk.Entry] = {}

        for index, (label, attr, hint) in enumerate(self._port_fields):
            ttk.Label(grid, text=label, style="Muted.TLabel").grid(
                row=index, column=0, sticky="w", padx=(0, 10), pady=3
            )
            var = tk.StringVar(value=str(getattr(self.config, attr)))
            entry = ttk.Entry(grid, textvariable=var, width=8, font=("Consolas", 10))
            entry.grid(row=index, column=1, sticky="w", pady=3)
            self.port_vars[attr] = var
            self._port_entries[attr] = entry
            ttk.Label(grid, text=hint, style="Muted.TLabel").grid(
                row=index, column=2, sticky="w", padx=(12, 0), pady=3
            )

        actions = ttk.Frame(frame)
        actions.pack(fill="x", pady=(8, 0))
        self.apply_ports_button = ttk.Button(
            actions, text="应用并重启", command=self._apply_ports
        )
        self.apply_ports_button.pack(side="left")
        ttk.Button(actions, text="恢复默认", command=self._reset_ports).pack(
            side="left", padx=8
        )

        self.port_hint = ttk.Label(
            frame, text="", style="Muted.TLabel", wraplength=690, justify="left"
        )
        self.port_hint.pack(anchor="w", pady=(6, 0))

    def _collect_ports(self) -> tuple[dict[str, int] | None, str]:
        """读取界面上的端口输入，校验后返回 (端口表, 错误信息)。"""
        values: dict[str, int] = {}
        for label, attr, _hint in self._port_fields:
            raw = self.port_vars[attr].get().strip()
            if not raw.isdigit():
                return None, f"「{label}」端口必须是数字。"
            port = int(raw)
            if not (1 <= port <= 65535):
                return None, f"「{label}」端口需在 1-65535 之间。"
            values[attr] = port

        if len(set(values.values())) != len(values):
            return None, "各端口不能重复，请修改后再试。"

        # 端口占用检查：已在运行的服务占着自己当前的端口，属正常，跳过。
        current = {
            "frontend_port": self.config.frontend_port,
            "api_port": self.config.api_port,
            "sip_port": self.config.sip_port,
        }
        for label, attr, _hint in self._port_fields:
            port = values[attr]
            if port == current.get(attr) and self.manager.is_running():
                continue
            if not port_is_free(port, "127.0.0.1"):
                return None, f"「{label}」端口 {port} 已被占用，请换一个。"
        return values, ""

    def _reset_ports(self) -> None:
        for attr, value in (
            ("frontend_port", 3000),
            ("api_port", 3001),
            ("sip_port", 5060),
        ):
            self.port_vars[attr].set(str(value))
        self.port_hint.configure(text="已填入默认端口，点击「应用并重启」生效。")

    def _sync_port_fields(self) -> None:
        """把配置里的端口同步到输入框。

        若某个输入框正持有焦点（用户正在输入），则跳过它，避免打断输入。
        """
        focused = self.root.focus_get()
        for _label, attr, _hint in self._port_fields:
            var = self.port_vars.get(attr)
            entry = self._port_entries.get(attr)
            if var is None:
                continue
            if entry is not None and focused == entry:
                continue
            expected = str(getattr(self.config, attr))
            if var.get() != expected:
                var.set(expected)

    def _apply_ports(self) -> None:
        values, error = self._collect_ports()
        if values is None:
            self.port_hint.configure(text=f"⚠ {error}")
            return

        changed = []
        for attr, port in values.items():
            if getattr(self.config, attr) != port:
                changed.append(attr)
            setattr(self.config, attr, port)

        # 前端也要知道新的 API 端口（通过环境变量在启动时注入）
        try:
            self.config.save(self.paths)
            detail = "、".join(
                f"{label} {values[attr]}" for label, attr, _ in self._port_fields
            )
            self.logger.write(f"已保存端口配置: {detail}")
        except Exception as exc:  # noqa: BLE001
            self.logger.write(f"保存端口配置失败: {exc}")

        # 同步状态中心展示的端口
        self.status.update(
            frontend_port=self.config.frontend_port, api_port=self.config.api_port
        )

        if not changed:
            self.port_hint.configure(text="端口无变化。")
            return

        if self.manager.is_running():
            self.port_hint.configure(text="端口已更新，正在重启服务…")
            self.logger.write("正在按新端口配置重启服务…")
            self.restart_services()
        else:
            self.port_hint.configure(text="端口已保存，下次启动时生效。")

    # ------------------------------------------------------------ 托盘

    def _build_tray(self) -> None:
        try:
            import pystray
            from PIL import Image, ImageDraw
        except ImportError:
            self.logger.write("未安装 pystray/Pillow，托盘功能不可用（不影响服务运行）")
            return

        self._tray_image = Image
        self._tray_draw = ImageDraw
        self._pystray = pystray

        image = self._make_tray_icon(STATE_COLORS[ServiceState.IDLE])

        menu = pystray.Menu(
            pystray.MenuItem("显示主窗口", self._tray_show, default=True),
            pystray.MenuItem("打开管理页面", self._tray_open_browser),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("重启服务", self._tray_restart),
            pystray.MenuItem("停止服务", self._tray_stop),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("退出并关闭服务", self._tray_quit),
        )

        self.tray_icon = pystray.Icon("sip-broadcast", image, APP_TITLE, menu)
        threading.Thread(target=self.tray_icon.run, name="tray", daemon=True).start()

    def _make_tray_icon(self, color: str):
        """用几何图形画一个 SIP 广播示意图标，无需外部图片资源。"""
        size = 64
        image = self._tray_image.new("RGBA", (size, size), (0, 0, 0, 0))
        draw = self._tray_draw.Draw(image)

        # 圆角底板
        draw.rounded_rectangle([2, 2, size - 3, size - 3], radius=14, fill="#1f2430")

        # 中心广播塔
        draw.ellipse([size // 2 - 6, size // 2 - 6, size // 2 + 6, size // 2 + 6], fill=color)
        draw.line([size // 2, size // 2 + 6, size // 2, size - 12], fill=color, width=4)

        # 左右声波弧线
        for offset, width in ((14, 3), (22, 3)):
            draw.arc(
                [size // 2 - offset - 6, size // 2 - offset, size // 2 + offset + 6, size // 2 + offset],
                start=200, end=340, fill=color, width=width,
            )
        return image

    def _refresh_tray_icon(self, state: ServiceState) -> None:
        if not self.tray_icon:
            return
        try:
            self.tray_icon.icon = self._make_tray_icon(STATE_COLORS.get(state, "#8b95a5"))
            self.tray_icon.title = f"{APP_TITLE} · {STATE_LABELS.get(state, '')}"
        except Exception:
            pass

    def _tray_show(self, *_args) -> None:
        self.root.after(0, self.show_window)

    def _tray_open_browser(self, *_args) -> None:
        self.root.after(0, self.open_browser)

    def _tray_restart(self, *_args) -> None:
        self.root.after(0, self.restart_services)

    def _tray_stop(self, *_args) -> None:
        self.root.after(0, self.stop_services)

    def _tray_quit(self, *_args) -> None:
        self.root.after(0, self.on_close)

    # ------------------------------------------------------------ 服务控制

    def start_services(self) -> None:
        if self.manager.is_running():
            return
        threading.Thread(target=self._run_start, name="start", daemon=True).start()

    def _run_start(self) -> None:
        self._set_buttons_busy(True)
        started = self.manager.start_all()
        self.root.after(0, lambda: self._set_buttons_busy(False))
        self.status.update(started_at=time.time() if started else None)

    def stop_services(self) -> None:
        threading.Thread(target=self.manager.stop_all, name="stop", daemon=True).start()

    def restart_services(self) -> None:
        def worker():
            self._set_buttons_busy(True)
            self.manager.stop_all()
            time.sleep(1.0)
            self.manager.start_all()
            self.root.after(0, lambda: self._set_buttons_busy(False))

        threading.Thread(target=worker, name="restart", daemon=True).start()

    def _on_service_state(self, state: ServiceState, detail: str) -> None:
        self.status.update(state=state, detail=detail)

    def _set_buttons_busy(self, busy: bool) -> None:
        state = "disabled" if busy else "normal"
        for button in (self.restart_button, self.stop_button):
            try:
                button.configure(state=state)
            except tk.TclError:
                pass

    # ------------------------------------------------------------ 界面刷新

    def _render(self, snap: StatusSnapshot) -> None:
        self.state_label.configure(text=STATE_LABELS.get(snap.state, "未知"))
        self.detail_label.configure(text=snap.detail or "")

        manage = f"http://127.0.0.1:{snap.frontend_port}/"
        api = f"http://127.0.0.1:{snap.api_port}/health"
        lan = f"http://{snap.lan_ip}:{snap.frontend_port}/"

        self.value_labels["manage_url"].configure(text=manage)
        self.value_labels["api_url"].configure(text=api)
        self.value_labels["lan_url"].configure(text=lan)

        # 端口输入框跟随实际配置（用户手动编辑时不覆盖，避免打断输入）
        self._sync_port_fields()

        progress = " · ".join(
            f"{key}:{value}" for key, value in self.manager.progress.items()
        )
        self.value_labels["progress"].configure(text=progress or "—")

        # 降级提示：优先展示可选组件的失败原因
        failures = getattr(self.manager, "optional_failures", {})
        if failures and snap.state in (ServiceState.RUNNING, ServiceState.STARTING):
            self.warning_label.configure(
                text="⚠ " + "；".join(failures.values()) +
                     "（可将 FreeSWITCH 放入 data\\freeswitch 后点「重启服务」）"
            )
        else:
            self.warning_label.configure(text="")

        if snap.state == ServiceState.FAILED:
            self.state_label.configure(foreground="#f85149")
        elif snap.state == ServiceState.RUNNING:
            self.state_label.configure(foreground="#3fb950")
        elif snap.state in (ServiceState.STARTING, ServiceState.STOPPING):
            self.state_label.configure(foreground="#e8a33d")
        else:
            self.state_label.configure(foreground="#6b7280")

        self._refresh_tray_icon(snap.state)

    def _append_log(self, line: str) -> None:
        try:
            self.log_widget.configure(state="normal")
            self.log_widget.insert("end", line + "\n")
            # 控制内存占用
            if int(self.log_widget.index("end-1c").split(".")[0]) > 800:
                self.log_widget.delete("1.0", "100.0")
            self.log_widget.see("end")
            self.log_widget.configure(state="disabled")
        except tk.TclError:
            pass

    # ------------------------------------------------------------ 动作

    def open_browser(self) -> None:
        webbrowser.open(self.config.open_browser_url)

    def open_logs(self) -> None:
        try:
            os.startfile(str(self.paths.logs))  # type: ignore[attr-defined]
        except Exception:
            pass

    def show_window(self) -> None:
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    def _on_unmap(self, _event) -> None:
        """最小化时隐藏到托盘（若托盘可用）。"""
        if self.tray_icon and self.root.state() == "iconic":
            self.root.withdraw()

    def on_close(self) -> None:
        """关闭窗口 = 关闭全部服务并退出程序。"""
        if self._shutting_down:
            return
        self._shutting_down = True

        self.logger.write("正在退出，停止全部服务…")
        try:
            self.status.update(state=ServiceState.STOPPING, detail="正在关闭服务…")
        except Exception:
            pass

        if self.tray_icon:
            try:
                self.tray_icon.stop()
            except Exception:
                pass

        def shutdown():
            self.manager.stop_all()
            self.logger.write("全部服务已停止，程序退出。")
            try:
                self.root.after(0, self.root.destroy)
            except Exception:
                pass

        threading.Thread(target=shutdown, name="shutdown", daemon=True).start()

    def run(self) -> None:
        self.root.mainloop()


def main() -> int:
    # 顶层异常兜底：GUI 模式（无控制台）下异常不可见，
    # 必须写入日志文件，否则用户只能看到「双击没反应」。
    try:
        return _run()
    except Exception as exc:  # noqa: BLE001
        _write_crash_log(exc)
        raise


def _write_crash_log(exc: BaseException) -> None:
    import traceback

    try:
        root = build_paths().root
        log_dir = root / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        with open(log_dir / "launcher-crash.log", "a", encoding="utf-8") as handle:
            handle.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} 启动器异常 =====\n")
            handle.write(detail)
    except Exception:
        pass


def _run() -> int:
    guard = SingleInstance()
    if not guard.acquire():
        # 已有实例在运行：尝试把它的窗口拉到前台
        focus_existing_window(APP_TITLE)
        return 0

    try:
        app = LauncherApp()
        app.run()
    finally:
        guard.release()
    return 0


if __name__ == "__main__":
    sys.exit(main())
