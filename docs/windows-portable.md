# SIP 广播系统 · Windows 便携版

把整套系统打包成一个可双击运行的 Windows 程序：**无需 Docker、无需安装 Node.js**。

提供两种交付形态：

| 形态 | 适用场景 | 数据位置 |
| --- | --- | --- |
| **安装包** (`SIPBroadcast-Setup-*.exe`) | 正式分发给最终用户 | `%LOCALAPPDATA%\SIPBroadcast` |
| **便携文件夹** | 免安装试用、U 盘携带 | 程序目录下的 `data/` |

## 特性

| 能力 | 说明 |
| --- | --- |
| 双击运行 | 启动器自动拉起 FreeSWITCH、业务 API、管理前端 |
| 系统托盘 | 托盘图标实时反映运行状态（颜色区分），右键可快速操作 |
| 状态 GUI | 展示管理页面地址、API 地址、局域网地址、各服务启动进度与实时日志 |
| 关闭即停服 | 关闭窗口或退出托盘，全部服务被连带回收，不留残进程 |
| 自动适配 | 安装版把可写数据放用户目录，便携版放程序目录，同一套代码自动识别 |
| 降级运行 | 未装 FreeSWITCH 时，管理界面与 API 仍可正常使用 |

> 已在本机完成端到端验证：安装模式与便携模式均正常启动、API 真实连上
> FreeSWITCH、强杀启动器后全部子进程与端口零残留。

## 目录结构

```text
SIPBroadcast-Portable/
├── SIPBroadcast.exe      启动器（GUI + 托盘）
├── config.json           可编辑配置（端口、域等）
├── 说明.txt              面向使用者的说明
├── 调试启动.bat          排障用（保留控制台输出）
├── app/                  前端产物 + 业务 API + 运行时依赖
│   ├── dist/             前端构建产物
│   ├── services/         业务 API（零 npm 依赖的纯 Node 服务）
│   ├── node_modules/     前端运行时依赖（已剔除非必需包）
│   └── package.json
├── node/node.exe         随包 Node 运行时（目标机无需另装）
├── launcher/             启动器源码（排障用，可删除）
├── data/                 数据目录
│   ├── freeswitch/       FreeSWITCH 引擎（程序体，只读使用）
│   ├── media/            上传的音频文件
│   └── *.json            业务数据
├── logs/                 运行日志（首次启动后生成）
└── runtime/              临时文件（首次启动后生成）
```

### 安装版与便携版的路径差异

启动器按以下规则自动判定运行模式：

1. 程序目录存在 `.installed` 标记 → **安装模式**
2. 否则程序目录可写 → **便携模式**
3. 否则（拷到只读位置）→ 也走安装模式

| 内容 | 便携模式 | 安装模式 |
| --- | --- | --- |
| 程序文件 | `<程序目录>` | `C:\Program Files\SIPBroadcast` |
| 业务数据 | `<程序目录>\data` | `%LOCALAPPDATA%\SIPBroadcast\data` |
| 日志 | `<程序目录>\logs` | `%LOCALAPPDATA%\SIPBroadcast\logs` |
| FreeSWITCH 配置/日志/数据库 | `<程序目录>\data\freeswitch` | `%LOCALAPPDATA%\SIPBroadcast\data\freeswitch` |

这样设计的原因：Program Files 默认不可写，而应用需要写配置、日志与数据库。
FreeSWITCH 的**程序体**（DLL、模块）仍从安装目录读取，**可写部分**通过
`-conf/-log/-db/-recordings` 参数指向用户目录。

> 想把安装版改成便携版：删除安装目录下的 `.installed` 文件，并把整个目录
> 拷到可写位置即可。

## 构建

### 环境准备（一次性）

```powershell
# 1) 打包用 Python 环境
python -m venv C:\path\to\sip-launcher
C:\path\to\sip-launcher\Scripts\pip install pystray pillow pyinstaller

# 2) Inno Setup（用于生成安装包；不装则跳过安装包步骤）
#    下载：https://jrsoftware.org/isdl.php
```

### 一条命令完成构建

```powershell
# 生成便携包 + 安装包（推荐）
powershell -ExecutionPolicy Bypass -File launcher\build-portable.ps1

# 首次还需自动获取 FreeSWITCH（约 126MB，受网络影响可能较慢）
powershell -ExecutionPolicy Bypass -File launcher\build-portable.ps1 -DownloadFreeswitch
```

产物：

| 产物 | 路径 | 体积 |
| --- | --- | --- |
| 便携包 | `dist-portable\SIPBroadcast-Portable\` | 约 446 MB |
| 安装包 | `dist-portable\installer\SIPBroadcast-Setup-*.exe` | 约 129 MB |

### 构建参数

| 参数 | 说明 |
| --- | --- |
| `-OutputDirectory <path>` | 自定义便携包输出目录 |
| `-SkipFrontendBuild` | 跳过前端构建（复用已有 `dist/`） |
| `-SkipLauncherBuild` | 跳过 exe 编译 |
| `-SkipInstaller` | 跳过安装包编译 |
| `-NodePath <path>` | 指定随包的 `node.exe` |
| `-FreeswitchDir <path>` | 从已有 FreeSWITCH 目录复制 |
| `-DownloadFreeswitch` | 自动下载并解包 FreeSWITCH |

### 单独编译安装包

```powershell
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" launcher\installer.iss
```

## 安装包说明

安装包由 Inno Setup 生成，提供标准的 Windows 安装体验：

| 环节 | 行为 |
| --- | --- |
| 安装位置 | 默认 `C:\Program Files\SIPBroadcast`，可修改 |
| 快捷方式 | 开始菜单、桌面（可选）、快速启动栏（可选） |
| 权限 | 需要管理员权限（写入 Program Files 与注册卸载信息） |
| 静默安装 | `SIPBroadcast-Setup-*.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART` |
| 自定义目录 | 追加 `/DIR="D:\MyPath"` |
| 安装后 | 可选立即启动（默认勾选） |
| 卸载 | 控制面板或开始菜单；卸载时**询问是否保留业务数据**，默认保留 |

### 静默安装示例

```powershell
# 装到默认位置
SIPBroadcast-Setup-0.1.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART

# 装到指定目录
SIPBroadcast-Setup-0.1.0.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR="D:\SIPBroadcast"
```

> 安装程序会先结束残留的 `SIPBroadcast.exe` 与 `FreeSwitchConsole.exe`，
> 避免升级安装时文件占用。

## 自检

便携包组装完成后，可运行自检确认完整性：

```powershell
python launcher\selftest.py
```

自检会检查目录结构、Node 运行时、前端产物、后端语法、FreeSWITCH 配置与端口占用。

## 配置说明（config.json）

```json
{
  "frontend_port": 3000,
  "api_port": 3001,
  "esl_port": 8021,
  "sip_port": 5060,
  "sip_domain": "sip.local",
  "auto_open_browser": true
}
```

- 端口被占用时修改对应字段并重启程序即可。
- `sip_server_host` 留空时自动探测局域网 IP，SIP 终端应使用该地址注册。

## FreeSWITCH 说明

Windows 版 FreeSWITCH 与 Linux 容器版存在差异，请注意：

| 项目 | Linux 容器版 | Windows 便携版 |
| --- | --- | --- |
| 版本 | 1.11.2（源码编译） | 1.10.12（官方 MSI 解包） |
| 安装方式 | Docker 镜像 | 解包到 `data/freeswitch/` |
| 配置路径 | `/etc/freeswitch` | `data/freeswitch/conf` |
| 需管理员权限 | 否 | 否（便携运行） |

启动器会在每次启动前自动渲染配置，无需手工编辑。渲染内容包括：

- ESL 密码与监听地址（`event_socket.conf.xml`）
- SIP 域、默认密码、编解码偏好（`vars.xml`）
- SIP 端口、移除 WebSocket 绑定（`internal.xml`）
- RTP 端口范围、日志级别（`switch.conf.xml`）
- **注入 `esl-control` ACL**：Windows 版样例配置里没有这个列表，
  而 ESL 配置会引用它，缺少会导致连接被拒（日志报 `Rejected by acl "esl-control"`）

### 实测结论

在本机完成完整验证（Windows 11 + FreeSWITCH 1.10.12）：

- 三个服务全部正常启动，`/health` 返回 `{"status":"ok","freeswitch":"UP ..."}`
- ESL 连接成功（`connected:true`），ACL 拒绝记录为 0
- SIP 5060、ESL 8021、前端 3000、API 3001 均正常监听
- **`mod_shout` 模块存在**，MP3 广播可用（与早期担心不同）

### 获取 FreeSWITCH 的三种方式

```powershell
# 1) 自动下载并解包（推荐，约 126MB，受网络影响可能较慢）
powershell -ExecutionPolicy Bypass -File launcher\build-portable.ps1 -DownloadFreeswitch

# 2) 用下载工具下好后指定 MSI 路径（下载慢时推荐，例如用迅雷）
#    直链：https://files.freeswitch.org/windows/installer/x64/FreeSWITCH-1.10.12-Release-x64.msi
#    文件大小应为 131,940,352 字节
powershell -ExecutionPolicy Bypass -File launcher\extract-freeswitch.py <msi路径> dist-portable\_fsdl\staging

# 3) 指定已安装的 FreeSWITCH 目录
powershell -ExecutionPolicy Bypass -File launcher\build-portable.ps1 -FreeswitchDir "C:\Program Files\FreeSWITCH"
```

构建脚本会自动复用 `dist-portable\_fsdl\staging` 下已解包的内容，无需重复解包。

## 关闭服务的行为

关闭主窗口（或托盘菜单「退出并关闭服务」）时，启动器会：

1. 依次请求终止 管理前端 → 业务 API → FreeSWITCH；
2. 等待优雅退出，超时则强制结束；
3. 由于子进程被绑定到 Windows Job Object，即使启动器被强制结束
   （任务管理器结束进程、意外崩溃），内核也会连带回收全部子进程，
   不会残留占端口的后台服务。

## 常见问题

**双击没有反应？**
查看 `logs/launcher-crash.log` 与 `logs/launcher.log`。

**端口被占用？**
修改 `config.json` 中的 `frontend_port` / `api_port`，或在任务管理器结束占用进程。

**SIP 终端注册不上？**
使用界面上显示的「局域网地址」，并在 Windows 防火墙放行
`5060/TCP`、`5060/UDP`、`16384-16484/UDP`。

**提示 FreeSWITCH 未就绪？**
把 FreeSWITCH 文件放入 `data/freeswitch/`（确保存在 `FreeSwitchConsole.exe`），
然后重启程序。管理界面与 API 不受影响，可先行使用。
