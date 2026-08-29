# FreeSWITCH 部署与 API

## 架构

FreeSWITCH 负责 SIP 注册、呼叫控制、媒体播放和会议能力。`freeswitch-api`
通过 FreeSWITCH Event Socket Library（ESL）执行调度命令，并对外提供受 API Key
保护的 HTTP 接口。

安全边界：

- SIP `5060/tcp+udp` 和 RTP `16384-16484/udp` 发布给终端；
- ESL `8021/tcp` 只存在于 Compose 内部网络，不发布到宿主机；
- REST API 默认只绑定宿主机 `127.0.0.1:3001`；
- ESL 密码、API Key、SIP 密码和 SignalWire Token 都由环境变量注入，不提交仓库；
- API 不提供任意 FreeSWITCH 命令透传，仅暴露经过校验的业务操作。

## 前置条件

1. 启动 Docker Desktop，并使用 Linux containers。
2. 在 SignalWire 创建 Personal Access Token。官方 FreeSWITCH Debian 软件源构建镜像时需要它。
3. 将 `.env.example` 复制为 `.env`，替换其中的全部密码和 Token。
4. 对于局域网 SIP 终端，将 `FREESWITCH_EXTERNAL_IP` 设置为运行 Docker 的主机局域网 IP。

建议为三个密码分别生成至少 32 字节随机值，禁止共用。

## 启动

```bash
cp .env.example .env
npm run freeswitch:build
npm run freeswitch:up
docker compose ps
```

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

{
  "targets": ["1000", "1001"],
  "audio": "/var/lib/freeswitch/storage/notice.wav",
  "callerId": "9999"
}
```

成功后返回 HTTP `202`，其中包含每个目标的后台任务 UUID 和通道 UUID。

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

## 下一阶段

当前版本完成了 FreeSWITCH 基础部署、SIP 注册基础和 API → ESL 命令链路。后续建议依次增加：

1. 业务数据库到 FreeSWITCH Directory 的动态账号配置；
2. ESL 事件长连接，将 `CHANNEL_ANSWER`、`CHANNEL_HANGUP` 和 `BACKGROUND_JOB` 写入任务状态；
3. 媒体文件上传、转码与内容审核；
4. 分区并发调度、失败重试和任务取消；
5. SIP TLS、RTP 安全策略、访问控制和生产监控。
