"""验证启动器渲染出的 modules.conf.xml 是否包含 G.722 的提供模块。

便携版自带 FreeSWITCH 的 conf 有 105 个模块，但启动器每次启动都会用仓库模板
（22 个）覆盖它，所以实际生效的是模板。这里用真实渲染器跑一遍，确认覆盖结果里
有 mod_spandsp，且不含任何不存在的模块。
"""
import shutil
import sys
from pathlib import Path
from tempfile import mkdtemp

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "launcher"))

from core.freeswitch_config import FreeswitchConfigurator  # noqa: E402

portable_fs = ROOT / "dist-portable" / "SIPBroadcast-Portable" / "data" / "freeswitch"
if not portable_fs.is_dir():
    print(f"[skip] 便携版 FreeSWITCH 不存在: {portable_fs}")
    sys.exit(0)

work = Path(mkdtemp(prefix="fsrender-"))
conf = work / "conf"
shutil.copytree(portable_fs / "conf", conf)

logs = []
cfg = FreeswitchConfigurator(
    fs_root=work,
    template_root=ROOT / "infra" / "freeswitch" / "config",
    logger=logs.append,
)
cfg.render(
    esl_password="test-esl",
    sip_domain="sip.local",
    sip_default_password="test-sip",
    external_ip="192.168.1.10",
    sip_port=5060,
    conf_dir=conf,
    bind_ip="192.168.1.10",
    codec_prefs="OPUS,G722,PCMU,PCMA",
)

modules = (conf / "autoload_configs" / "modules.conf.xml").read_text(encoding="utf-8")
loaded = [line.split('"')[1] for line in modules.splitlines() if "<load module=" in line]

missing = [m for m in loaded if not (portable_fs / "mod" / f"{m}.dll").is_file()]

print(f"渲染后加载模块数: {len(loaded)}")
print(f"是否含 mod_spandsp（G.722 提供者）: {'mod_spandsp' in loaded}")
print(f"是否含不存在的 mod_g722: {'mod_g722' in loaded}")
print(f"磁盘上找不到对应 dll 的模块: {missing or '无'}")

vars_text = (conf / "vars.xml").read_text(encoding="utf-8")
import re  # noqa: E402
prefs = re.search(r'data="global_codec_prefs=([^"]*)"', vars_text)
print(f"global_codec_prefs: {prefs.group(1) if prefs else '(未找到)'}")

shutil.rmtree(work, ignore_errors=True)

ok = "mod_spandsp" in loaded and "mod_g722" not in loaded and not missing
print("\n结论:", "通过" if ok else "失败")
sys.exit(0 if ok else 1)
