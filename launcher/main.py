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

from launcher.core.config import AppConfig, RuntimePaths, build_paths  # noqa: E402
from launcher.core.logger import Logger  # noqa: E402
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
        root.geometry("720x540")
        root.minsize(640, 480)

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
