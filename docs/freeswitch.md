# FreeSWITCH 部署与 API

## 架构

FreeSWITCH 负责 SIP 注册、呼叫控制、媒体播放和会议能力。`freeswitch-api`
通过 FreeSWITCH Event Socket Library（ESL）执行调度命令，并对外提供受 API Key
保护的 HTTP 接口。

安全边界：

- SIP `5060/tcp+udp` 和 RTP `16384-16484/udp` 发布给终端；
- ESL `8021/tcp` 只存在于 Compose 内部网络，不发布到宿主机；
- REST API 默认只绑定宿主机 `127.0.0.1:3001`；
- ESL 密码、API Key 和 SIP 密码都由环境变量注入，不提交仓库；
- API 不提供任意 FreeSWITCH 命令透传，仅暴露经过校验的业务操作。

## 前置条件

1. 启动 Docker Desktop，并使用 Linux containers。
2. 确保构建环境可以访问 GitHub。镜像从固定 release tag 编译 FreeSWITCH 和 Sofia-SIP，
   不需要 SignalWire Personal Access Token。
3. 将 `.env.example` 复制为 `.env`，替换其中的全部密码。
4. 对于局域网 SIP 终端，将 `FREESWITCH_EXTERNAL_IP` 设置为运行 Docker 的主机局域网 IP。

建议为三个密码分别生成至少 32 字节随机值，禁止共用。

## 启动

```bash
cp .env.example .env
npm run freeswitch:build
npm run freeswitch:up
docker compose ps
```

首次源码构建会编译 C/C++ 依赖，耗时明显长于安装二进制包。默认从 GitHub 检出
FreeSWITCH `v1.11.2`、Sofia-SIP `v1.13.18` 和 SpanDSP `v3.1.1`；版本通过 `.env` 固定，不建议生产构建使用
浮动分支。构建采用多阶段镜像，最终运行镜像不包含编译器和 Git。

查看日志：

```bash
npm run freeswitch:logs
```

进入 FreeSWITCH CLI：

```bash
docker compose exec freeswitch fs_cli -p "$ESL_PASSWORD"
```

停止服务：

```bash
npm run freeswitch:down
```

## SIP 终端

vanilla 配置提供演示分机，可先用 `1000`、`1001` 等分机注册：

- SIP Server：运行 Docker 的主机 IP
- SIP Port：`5060`
- SIP Domain：`.env` 中的 `FREESWITCH_DOMAIN`
- Password：`.env` 中的 `SIP_DEFAULT_PASSWORD`

演示分机只适合联调。生产环境应由业务数据库生成独立账号和强密码，并通过配置服务同步到 FreeSWITCH Directory。

## REST API

所有 `/api/v1/*` 请求必须携带：

```text
X-API-Key: <FREESWITCH_API_KEY>
```

### 健康检查

```http
GET /health
```

### FreeSWITCH 状态

```http
GET /api/v1/freeswitch/status
```

### 当前通道

```http
GET /api/v1/channels
```

### SIP 注册状态

```http
GET /api/v1/registrations
```

### 发起广播

先将音频复制到 FreeSWITCH 的持久化目录：

```bash
docker compose cp ./notice.wav freeswitch:/var/lib/freeswitch/storage/notice.wav
```

请求示例：

```http
POST /api/v1/broadcasts
Content-Type: application/json
X-API-Key: <FREESWITCH_API_KEY>
Idempotency-Key: <client-generated-unique-key>

{
  "name": "放学安全提醒",
  "targets": ["1000", "1001"],
  "audio": "/var/lib/freeswitch/storage/notice.wav",
  "callerId": "9999",
  "volume": 75
}
```

成功后返回 HTTP `202` 和完整广播任务；重复的幂等键返回原任务。每个目标包含 ESL 后台任务
UUID、通道 UUID、接听时间、结束时间和失败原因。API 订阅 `BACKGROUND_JOB`、
`CHANNEL_ANSWER`、`CHANNEL_HANGUP_COMPLETE`，将状态汇总为 `RUNNING`、`SUCCEEDED`、
`PARTIAL_FAILED`、`FAILED` 或 `CANCELED`。任务保存在 `broadcast-data` 卷中，API 重启后仍可查询。

测试音可使用受限 URI `tone_stream://%(2000,0,440)`；生产广播建议使用持久化目录内的 WAV/MP3。

### 查询与取消广播

```http
GET /api/v1/broadcasts
GET /api/v1/broadcasts/{broadcastId}
POST /api/v1/broadcasts/{broadcastId}/cancel
X-API-Key: <FREESWITCH_API_KEY>
```

取消操作会通过 ESL 对所有未结束通道执行 `uuid_kill`，并将目标和任务状态持久化为
`CANCELED`。列表支持 `?state=RUNNING` 状态筛选。

### 媒体库

媒体库将元数据保存在 `broadcast-data` 卷，将音频二进制保存在独立的 `media-data` 卷。
该卷以只读方式挂载到 FreeSWITCH 的 `/var/lib/freeswitch/storage/media`，上传完成后返回的
`freeswitchPath` 可直接作为广播的 `audio` 参数。

```http
GET  /api/v1/media/files
POST /api/v1/media/files
GET  /api/v1/media/files/{fileId}/content

GET  /api/v1/media/playlists
POST /api/v1/media/playlists
POST /api/v1/media/playlists/{playlistId}/items
DELETE /api/v1/media/playlists/{playlistId}/items/{fileId}
```

上传请求直接使用音频文件作为请求体，并携带编码后的原始文件名：

```http
POST /api/v1/media/files
Content-Type: audio/wav
X-File-Name: %E6%8F%90%E7%A4%BA%E9%9F%B3.wav
X-API-Key: <FREESWITCH_API_KEY>
```

仅接受最大 50 MB 的 WAV、MP3 文件，同时检查扩展名和文件头，避免通过伪造扩展名上传
其他内容。本地试听使用服务端签名的预览令牌并支持 HTTP Range，因此原生 `<audio>` 无需
接触 API Key，也能完成拖动和分段读取。

### 挂断通道

```http
POST /api/v1/channels/{channelUuid}/hangup
X-API-Key: <FREESWITCH_API_KEY>
```

### 重载 XML 配置

```http
POST /api/v1/freeswitch/reload
X-API-Key: <FREESWITCH_API_KEY>
```

## 前端联调

本地前端调用 `http://127.0.0.1:3001/api/v1`：实时广播页会提交所选终端，任务中心每
3 秒刷新任务并提供取消按钮。`ALLOW_INSECURE_BROWSER_API=true` 仅允许 `localhost` 和
`127.0.0.1` Origin 免 API Key，用于当前浏览器原型；生产部署必须设为 `false`，并由同源
网关或服务端会话完成鉴权。

## 测试

```bash
npm run freeswitch:api:test
npm run freeswitch:e2e:test
```

端到端脚本会模拟 SIP 分机 `1000`：完成 Digest 注册、接听 FreeSWITCH INVITE、接收 RTP
测试音、等待任务事件汇总并断言 `SUCCEEDED`。测试要求 Compose 服务已启动，并从本地
`.env` 读取测试凭据。

## 下一阶段

当前版本已完成 FreeSWITCH GitHub 源码构建、SIP 注册、API → ESL 调度、事件状态回写、
广播取消和本地持久化。完整后端规划见 [backend-plan.md](backend-plan.md)，下一阶段建议：

1. 业务数据库到 FreeSWITCH Directory 的动态账号配置；
2. 媒体文件上传、转码与内容审核；
3. 定时计划调度、分区并发控制和失败重试；
4. 将 JSON 持久化升级为 PostgreSQL，并增加审计日志；
5. SIP TLS、SRTP、访问控制和生产监控。
