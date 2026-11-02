"""FreeSWITCH 便携配置渲染。

Docker 部署时配置由容器 entrypoint 用 sed 改写 Linux 系统目录下的文件；
便携部署没有这一步，因此需要由启动器在每次启动前，把仓库中的
FreeSWITCH 配置模板渲染进便携目录，并修正 Linux/Windows 路径差异。

处理的原则是「幂等」：重复运行不会破坏已经渲染好的配置。
"""

from __future__ import annotations

import re
import shutil
from pathlib import Path


def _escape_xml(value: str) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace('"', "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("'", "&apos;")
    )


# 编解码优先级：G722（G.722）是 16 kHz 采样的宽带语音，64 kbps。
# 注意 RFC 3551 规定 G722 的 RTP 时钟率字段必须写 8000（RFC 1890 的历史
# 遗留错误），FreeSWITCH 内部仍以 16000 Hz 处理，终端侧不要按 SDP 里的
# 8000 去解码，否则会听到降速变调的声音。
DEFAULT_CODEC_PREFS = "OPUS,G722,PCMU,PCMA"

# 随包 FreeSWITCH 演示账号对应的目录分组区块。
#
# directory/default.xml 里 sales/billing/support 三个组只由 `type="pointer"`
# 指针构成，指向随包演示分机 1000~1014。这些分机文件会被清理（换成 8XXX 号段），
# 若不删掉指针，FreeSWITCH 会把它们当作**已定义但无密码**的用户，
# `list_users` 就会出现 `1000||sip.local|sales|...` 这类幽灵记录，
# 在 SIP 账号管理页里显示成一批读不到密码的空账号。
_VANILLA_POINTER_GROUP_PATTERN = re.compile(
    r'[ \t]*<group\s+name="(?:sales|billing|support)">[\s\S]*?</group>\s*\n?'
)

# 需要由本文件（而非随包样例）接管的本机分机号段拨号方案。
# 随包 dialplan 的 `^80(\d{2})$` 是「从通话组删除成员」的演示功能，
# 不接管的话拨打 8001 不会呼通终端。
_LOCAL_EXTENSIONS_FILE = "01_local_extensions.xml"



class FreeswitchConfigurator:
    """把模板渲染到目标 conf 目录。

    conf 目录可能与 FreeSWITCH 程序目录不同（安装模式下 conf 位于用户
    数据目录，以规避 Program Files 的写权限限制）。
    """

    def __init__(self, fs_root: Path, template_root: Path, logger) -> None:
        self.fs_root = fs_root
        self.template_root = template_root
        self.log = logger

    # ---------------- 公开入口 ----------------

    def render(self, *, esl_password: str, sip_domain: str, sip_default_password: str,
               external_ip: str, sip_port: int, conf_dir: Path | None = None,
               bind_ip: str = "", codec_prefs: str = DEFAULT_CODEC_PREFS) -> None:
        conf = Path(conf_dir) if conf_dir else (self.fs_root / "conf")
        conf.mkdir(parents=True, exist_ok=True)

        self._render_event_socket(conf, esl_password)
        self._render_vars(conf, sip_domain, sip_default_password, external_ip, bind_ip, codec_prefs)
        self._patch_internal_profile(conf, sip_port, bind_ip)
        self._patch_switch_conf(conf)
        self._patch_acl_conf(conf)
        self._patch_modules(conf)
        self._install_dialplan_files(conf)
        self._patch_directory_pointers(conf)
        self._ensure_directories()

    def _install_dialplan_files(self, conf: Path) -> None:
        """装入项目自带的拨号方案文件。

        001 序号的预设广播路由（88xxxx）与 00 序号同理：都必须排在样例
        dialplan 之前，否则会被样例规则抢先匹配。
        """
        files = (
            # 预设广播服务号码（88xxxx）：本项目原始文件，序号 00 保证最先命中
            ("preset-broadcast.xml", "00_preset_broadcast.xml"),
            # 本机分机号段（80xx）：必须早于样例的 `^80(\\d{2})$`（删通话组成员）
            ("local-extensions.xml", _LOCAL_EXTENSIONS_FILE),
        )
        default_plan = conf / "dialplan" / "default.xml"

        for source_name, target_name in files:
            template = self.template_root / source_name
            if not template.is_file():
                continue
            target = conf / "dialplan" / "default" / target_name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(template, target)

            # Vanilla FreeSWITCH reserves 88* for eavesdrop and 80xx for callgroup
            # demos. Route our service numbers first, before the sample dialplan
            # can consume them.
            if default_plan.is_file():
                text = default_plan.read_text(encoding="utf-8")
                include = f'<X-PRE-PROCESS cmd="include" data="default/{target_name}"/>'
                if include not in text:
                    text = text.replace('<context name="default">', '<context name="default">\n    ' + include, 1)
                    default_plan.write_text(text, encoding="utf-8")
            self.log(f"[config] 已装入拨号方案 {target_name}")

    def _patch_directory_pointers(self, conf: Path) -> None:
        """移除指向随包演示分机的目录分组指针。

        directory/default.xml 的 sales / billing / support 三组只有指针、
        没有实际用户定义。这些指针指向演示分机 1000~1014，而演示分机会被
        业务后端清理并替换成 8XXX 号段。悬空指针会让 FreeSWITCH 造出
        「无密码、无上下文」的幽灵用户，污染 SIP 账号列表。
        """
        target = conf / "directory" / "default.xml"
        if not target.is_file():
            return
        text = target.read_text(encoding="utf-8")
        stripped, count = _VANILLA_POINTER_GROUP_PATTERN.subn("", text)
        if count == 0:
            return
        target.write_text(stripped, encoding="utf-8")
        self.log(f"[config] 已移除 {count} 个指向演示分机的目录分组指针")


    # ---------------- 各配置文件 ----------------

    def _render_event_socket(self, conf: Path, esl_password: str) -> None:
        """ESL 密码不能沿用模板里的占位符，必须按当前配置渲染。"""
        target = conf / "autoload_configs" / "event_socket.conf.xml"
        target.parent.mkdir(parents=True, exist_ok=True)

        template = self.template_root / "event_socket.conf.xml.template"
        if template.is_file():
            text = template.read_text(encoding="utf-8")
        else:
            text = (
                '<configuration name="event_socket.conf">\n'
                "  <settings>\n"
                '    <param name="nat-map" value="false"/>\n'
                '    <param name="listen-ip" value="127.0.0.1"/>\n'
                '    <param name="listen-port" value="8021"/>\n'
                '    <param name="password" value="__ESL_PASSWORD__"/>\n'
                '    <param name="apply-inbound-acl" value="esl-control"/>\n'
                '    <param name="stop-on-bind-error" value="true"/>\n'
                "  </settings>\n"
                "</configuration>\n"
            )

        # Windows 部署中 ESL 只被本机启动器使用，绑定回环即可，避免暴露
        text = re.sub(
            r'(<param\s+name="listen-ip"\s+value=")[^"]*(")',
            r"\g<1>127.0.0.1\g<2>",
            text,
        )
        text = text.replace("__ESL_PASSWORD__", _escape_xml(esl_password))
        target.write_text(text, encoding="utf-8")
        self.log(f"[config] 已写入 {target.name}")

    def _render_vars(self, conf: Path, sip_domain: str, sip_default_password: str,
                     external_ip: str, bind_ip: str = "",
                     codec_prefs: str = DEFAULT_CODEC_PREFS) -> None:
        target = conf / "vars.xml"
        if not target.is_file():
            self.log(f"[config] 跳过 vars.xml（不存在）: {target}")
            return

        text = target.read_text(encoding="utf-8")

        def set_data(name: str, value: str) -> None:
            nonlocal text
            pattern = rf'(data="{re.escape(name)}=)[^"]*(")'
            replacement = rf"\g<1>{value}\g<2>"
            if re.search(pattern, text):
                text = re.sub(pattern, replacement, text)
                return
            # 属性不存在时插入一条新的 X-PRE-PROCESS。
            # 注意：示例 conf 里的 X-PRE-PROCESS 都是自闭合的（以 "/>" 结尾），
            # 不存在 </X-PRE-PROCESS> 结束标签，因此必须按首个自闭合行插入。
            new_line = f'  <X-PRE-PROCESS cmd="set" data="{name}={value}"/>\n'
            match = re.search(r'^[ \t]*<X-PRE-PROCESS\b[^>]*/>[ \t]*$', text, re.MULTILINE)
            if match:
                insert_at = match.end()
                text = text[:insert_at] + "\n" + new_line.rstrip("\n") + text[insert_at:]
            elif "<include>" in text:
                text = text.replace("<include>", "<include>\n" + new_line, 1)

        set_data("domain", _escape_xml(sip_domain))
        set_data("default_password", _escape_xml(sip_default_password))
        set_data("external_rtp_ip", _escape_xml(external_ip))
        set_data("external_sip_ip", _escape_xml(external_ip))
        set_data("global_codec_prefs", _escape_xml(codec_prefs))
        set_data("outbound_codec_prefs", _escape_xml(codec_prefs))

        # 显式钉住本机绑定 IP。
        # 关键：FreeSWITCH 默认用内部探测得到的 local_ip_v4，机器上存在代理
        # TUN 虚拟网卡（Clash/Mihomo 的 198.18.0.1）时会选错网卡，导致 SIP
        # 终端注册不上。此处显式 set 会覆盖内部探测值。
        if bind_ip:
            set_data("local_ip_v4", _escape_xml(bind_ip))
            self.log(f"[config] 已固定绑定网卡: local_ip_v4={bind_ip}")
        else:
            text = re.sub(r'\s*<X-PRE-PROCESS[^>]*data="local_ip_v4=[^"]*"\s*/>', "", text)

        target.write_text(text, encoding="utf-8")
        self.log("[config] 已更新 vars.xml")

    def _patch_internal_profile(self, conf: Path, sip_port: int, bind_ip: str = "") -> None:
        target = conf / "sip_profiles" / "internal.xml"
        if not target.is_file():
            return
        text = target.read_text(encoding="utf-8")

        # 本项目只发布 UDP/TCP，移除 WebSocket 绑定（避免依赖证书）
        text = re.sub(r'\s*<param\s+name="ws-binding"[^>]*/>', "", text)
        text = re.sub(r'\s*<param\s+name="wss-binding"[^>]*/>', "", text)

        # 按配置设置 SIP 端口
        text = re.sub(
            r'(<param\s+name="sip-port"\s+value=")[^"]*(")',
            rf"\g<1>{sip_port}\g<2>",
            text,
        )

        # 绑定到指定网卡：把 sip-ip / rtp-ip 的自动探测换成显式地址。
        # 这样即使机器上有代理 TUN 虚拟网卡，Sofia 也只会绑在选定网卡上。
        if bind_ip:
            for param in ("sip-ip", "rtp-ip"):
                text = re.sub(
                    rf'(<param\s+name="{param}"\s+value=")[^"]*(")',
                    rf"\g<1>{bind_ip}\g<2>",
                    text,
                )
            self.log(f"[config] 已固定 SIP/RTP 绑定地址: {bind_ip}")

        target.write_text(text, encoding="utf-8")
        self.log("[config] 已更新 internal.xml")

    def _patch_switch_conf(self, conf: Path) -> None:
        target = conf / "autoload_configs" / "switch.conf.xml"
        if not target.is_file():
            return
        text = target.read_text(encoding="utf-8")

        def set_param(name: str, value: str) -> None:
            nonlocal text
            pattern = rf'(<param\s+name="{re.escape(name)}"\s+value=")[^"]*(")'
            if re.search(pattern, text):
                text = re.sub(pattern, rf"\g<1>{value}\g<2>", text)
            else:
                text = text.replace(
                    "<settings>",
                    f'<settings>\n    <param name="{name}" value="{value}"/>',
                    1,
                )

        set_param("colorize-console", "false")
        set_param("max-sessions", "1000")
        set_param("sessions-per-second", "30")
        set_param("rtp-start-port", "16384")
        set_param("rtp-end-port", "16484")
        set_param("loglevel", "info")

        target.write_text(text, encoding="utf-8")
        self.log("[config] 已更新 switch.conf.xml")

    def _patch_acl_conf(self, conf: Path) -> None:
        """确保存在 esl-control 列表。

        Windows 版 FreeSWITCH 的样例 acl.conf.xml 与 Linux 版不同，默认
        并不包含 esl-control 列表；而 event_socket.conf.xml 中
        apply-inbound-acl="esl-control" 会引用它。缺少该列表会导致
        ESL 连接被拒（日志出现 Rejected by acl "esl-control"）。
        """
        target = conf / "autoload_configs" / "acl.conf.xml"
        if not target.is_file():
            return

        text = target.read_text(encoding="utf-8")

        if 'name="esl-control"' in text:
            self.log("[config] esl-control ACL 已存在")
            return

        esl_block = (
            '    <list name="esl-control" default="deny">\n'
            '      <node type="allow" cidr="127.0.0.0/8"/>\n'
            '      <node type="allow" cidr="10.0.0.0/8"/>\n'
            '      <node type="allow" cidr="172.16.0.0/12"/>\n'
            '      <node type="allow" cidr="192.168.0.0/16"/>\n'
            "    </list>\n"
        )

        if "</network-lists>" in text:
            text = text.replace("</network-lists>", esl_block + "  </network-lists>", 1)
        elif "<network-lists>" in text:
            text = text.replace("<network-lists>", "<network-lists>\n" + esl_block, 1)
        else:
            self.log("[config] acl.conf.xml 结构异常，跳过 esl-control 注入")
            return

        target.write_text(text, encoding="utf-8")
        self.log("[config] 已注入 esl-control ACL")

    def _patch_modules(self, conf: Path) -> None:
        """Windows 版 FreeSWITCH 不一定带全部模块，缺模块会导致启动失败。

        这里不删除模块（无法在运行时可靠探测），但把项目自带的精简
        modules.conf.xml 复制过去，使加载清单与业务需求一致。
        """
        source = self.template_root / "modules.conf.xml"
        target = conf / "autoload_configs" / "modules.conf.xml"
        if source.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
            self.log("[config] 已更新 modules.conf.xml")

        # 样例配置里的 mod_pgsql 不在精简构建中，避免加载失败
        pre_load = conf / "autoload_configs" / "pre_load_modules.conf.xml"
        if pre_load.is_file():
            text = pre_load.read_text(encoding="utf-8")
            text = re.sub(r"\s*<load\s+module=\"mod_pgsql\"\s*/>", "", text)
            pre_load.write_text(text, encoding="utf-8")

    def _ensure_directories(self) -> None:
        """确保运行时目录存在。

        目录建在 fs_root（即调用方传入的可写运行时根目录）下。
        安装模式下调用方传的是用户数据目录，避免写 Program Files。
        """
        for name in ("log", "db", "storage", "recordings", "run"):
            try:
                (self.fs_root / name).mkdir(parents=True, exist_ok=True)
            except OSError as exc:
                self.log(f"[config] 无法创建目录 {name}: {exc}")
