# SIP 广播系统

基于 FreeSWITCH 的 SIP 广播运营管理平台，提供浏览器管理端、业务 REST API、SIP 终端注册和音频广播能力。FreeSWITCH 由 GitHub 固定版本源码编译，广播任务通过 ESL 下发并回写执行状态。

## 已实现功能

- 用户登录、用户列表、角色权限和系统配置
- 亮色 / 暗色主题及界面偏好持久化
- SIP 账号单个或批量新增、删除及 FreeSWITCH Directory 同步
- 注册终端查询、终端重命名和在线状态展示
- 分区创建、编辑、删除及终端成员管理
- WAV / MP3 上传、浏览器试听、播放列表管理
- 音频文件和播放列表多选实时广播
- 定时计划创建、启停、编辑、删除和到期调度
- 广播任务、通道状态、失败原因和运行总览

## 系统架构

```text
浏览器管理端 (:3000)
        │ HTTP
        ▼
业务 REST API (:3001) ── ESL (:8021，仅容器网络) ── FreeSWITCH
        │                                            ├─ SIP :5060/TCP+UDP
        └─ 持久化业务数据与媒体文件                    └─ RTP :16384-16484/UDP
```

FreeSWITCH、Sofia-SIP 和 SpanDSP 在 Docker 镜像构建阶段从 GitHub release tag 拉取并编译。ESL 不发布到宿主机，管理 API 默认仅监听 `127.0.0.1`。

## 环境要求

- Node.js `>=22.13.0`
- Docker Desktop（Windows / macOS）或 Docker Engine（Linux）
- Docker Compose v2
- GitHub 网络访问能力（首次构建 FreeSWITCH 源码时需要）
- Windows 使用 PowerShell 5.1 或更高版本

首次 FreeSWITCH 源码构建耗时会明显长于普通镜像启动，后续部署会复用 Docker 构建缓存。

## 一键部署

### 0. Windows 安装包 / 便携版（免 Docker）

如果目标电脑不想安装 Docker 与 Node.js，可直接使用 Windows 版本：

- **安装包**：`SIPBroadcast-Setup-0.1.0.exe`，双击按向导安装，提供开始菜单与卸载入口
- **便携版**：双击 `SIPBroadcast.exe` 即自动启动全部服务，托盘常驻显示状态，关闭即停服

```powershell
# 在开发机上一条命令生成便携包与安装包
powershell -ExecutionPolicy Bypass -File launcher\build-portable.ps1 -DownloadFreeswitch
```

两者的可写数据位置会自动区分（安装版放 `%LOCALAPPDATA%\SIPBroadcast`，
便携版放程序目录下的 `data/`）。详见 [docs/windows-portable.md](docs/windows-portable.md)。

### 1. 准备环境变量

Windows：

```powershell
Copy-Item .env.example .env
notepad .env
```

Linux / macOS：

```bash
cp .env.example .env
${EDITOR:-vi} .env
```

必须替换 `.env` 中这三个占位值，且不要使用相同密码：

- `ESL_PASSWORD`：FreeSWITCH ESL 控制密码
- `FREESWITCH_API_KEY`：服务间 API Key
- `SIP_DEFAULT_PASSWORD`：默认 SIP 鉴权密码

局域网 SIP 终端注册时，还应将 `FREESWITCH_EXTERNAL_IP` 和 `SIP_SERVER_HOST` 改为部署主机可被终端访问的局域网 IP。

### 2. 执行部署

Windows：

```powershell
npm run deploy:windows
```

脚本会在需要时自动启动 Docker Desktop，然后依次完成环境校验、`npm ci`、FreeSWITCH/API 镜像构建、容器健康检查、前端生产构建和前端进程启动。

Linux / macOS：

```bash
chmod +x scripts/deploy.sh scripts/stop.sh
npm run deploy:linux
```

部署完成后访问 [http://localhost:3000/](http://localhost:3000/)。初始管理员取自 `.env`：

```text
用户名：admin（SYSTEM_ADMIN_USERNAME）
密码：123456（SYSTEM_ADMIN_PASSWORD）
```

首次登录后请在“用户与权限”中立即修改管理员密码。已经生成过业务数据卷时，修改 `.env` 中的初始密码不会覆盖现有管理员密码。

### 部署参数

Windows 可直接向脚本传参：

```powershell
# 仅检查环境、.env 和 Compose 配置
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -ValidateOnly

# 跳过 npm ci 和容器重新构建
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -SkipInstall -SkipBuild

# 使用其他前端端口
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1 -FrontendPort 8080
```

Linux / macOS 使用环境变量：

```bash
VALIDATE_ONLY=true ./scripts/deploy.sh
SKIP_INSTALL=true SKIP_BUILD=true FRONTEND_PORT=8080 ./scripts/deploy.sh
```

## 停止与重新启动

```powershell
# Windows；保留全部业务和媒体数据卷
npm run deploy:stop:windows
```

```bash
# Linux / macOS；保留全部业务和媒体数据卷
npm run deploy:stop:linux
```

重新执行部署脚本即可启动。停止脚本使用 `docker compose down`，不会删除命名卷；不要添加 `-v`，除非确认需要清空账号、媒体、分区、计划和任务数据。

## 端口与防火墙

| 用途 | 默认端口 | 协议 | 说明 |
| --- | ---: | --- | --- |
| 管理页面 | 3000 | TCP | 部署脚本启动的前端服务 |
| 业务 API | 3001 | TCP | 默认只绑定本机回环地址 |
| SIP 注册与信令 | 5060 | TCP / UDP | 可通过 `SIP_PORT` 修改宿主机端口 |
| RTP 媒体 | 16384-16484 | UDP | 终端必须能够双向访问 |
| ESL | 8021 | TCP | 仅 Compose 内部网络，不对外开放 |

若终端位于其他主机，请在操作系统和网络防火墙中开放 SIP 与 RTP 端口，并确保端口映射、`FREESWITCH_EXTERNAL_IP`、`SIP_SERVER_HOST` 三者一致。

## 常用运维命令

```bash
docker compose ps
docker compose logs -f freeswitch freeswitch-api
docker compose restart freeswitch freeswitch-api
docker compose exec freeswitch fs_cli -p "<ESL_PASSWORD>"
```

前端日志位于：

```text
.runtime/frontend.out.log
.runtime/frontend.err.log
```

运行时 PID 和日志目录不会提交到 Git。

## 测试

静态构建、渲染与代码检查：

```bash
npm test
npm run lint
```

后端单元测试：

```bash
npm run freeswitch:api:test
```

容器启动后可执行完整业务联调：

```bash
npm run freeswitch:e2e:test
npm run media:e2e:test
```

SIP 端到端测试会模拟分机完成 Digest 注册、接听 INVITE、接收 RTP 音频，并检查广播任务最终状态。

## 故障排查

### 登录后显示 `Failed to fetch`

先访问 [http://127.0.0.1:3001/health](http://127.0.0.1:3001/health)，再检查：

```bash
docker compose ps
docker compose logs --tail 200 freeswitch-api
```

若修改了 `FREESWITCH_API_PORT`，当前前端也需要使用相同的 API 端口；默认部署建议保持 `3001`。

### Docker 或 FreeSWITCH 未就绪

Windows 部署脚本会尝试启动 Docker Desktop。若超时，请确认 Docker Desktop 使用 Linux containers，然后运行：

```bash
docker info
docker compose up -d --build
docker compose ps
```

### SIP 账号无法注册

检查客户端填写的服务器 IP、页面显示的 SIP 端口、账号和明文鉴权密码，并确认终端到服务器的 `SIP_PORT` 可达。容器内注册状态可用以下命令核对：

```bash
docker compose exec freeswitch fs_cli -p "<ESL_PASSWORD>" -x "sofia status profile internal reg"
```

### 广播任务显示 0 台接听

确认目标终端处于注册在线状态并能接收服务器发出的 SIP INVITE，同时检查双向 RTP UDP 端口。任务中心中的 FreeSWITCH 原始失败原因会被转换为便于定位的中文提示。

## 数据持久化

Compose 使用以下命名卷保存数据：

- `broadcast-data`：用户、权限、配置、账号元数据、分区、计划和任务
- `media-data`：WAV / MP3 文件及媒体库数据
- `sip-directory`：动态 SIP Directory
- `freeswitch-recordings`、`freeswitch-storage`：FreeSWITCH 录音和存储

升级前建议先备份这些卷。详细的 FreeSWITCH 配置、安全边界和 API 示例见 [docs/freeswitch.md](docs/freeswitch.md)，业务模型见 [docs/backend-plan.md](docs/backend-plan.md)。

## 工程结构

```text
app/                         管理端页面、组件与样式
infra/freeswitch/            FreeSWITCH 源码构建镜像和配置
services/freeswitch-api/     业务 REST API、ESL 控制与持久化
launcher/                    Windows 便携版启动器（GUI + 托盘 + 打包脚本）
scripts/                     Windows / Linux 部署与停止脚本
tests/                       前端渲染和业务集成测试
compose.yaml                 FreeSWITCH 与后端服务编排
```
