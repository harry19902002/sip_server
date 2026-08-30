# SIP 广播系统后端业务规划

## 1. 建设目标

后端不是把 FreeSWITCH 命令直接包装成 HTTP，而是建立“业务控制面 + 通信执行面”两层：

```text
Web / Open API
      │
      ▼
业务 API（鉴权、租户、资源、任务、审计）
      │                  │
      ▼                  ▼
PostgreSQL           Redis / 任务队列
      │                  │
      ├──── 调度器 / Worker ────┐
      │                         ▼
      └──── 配置服务       FreeSWITCH Adapter
                                │ ESL / XML Curl
                                ▼
                         FreeSWITCH 集群
                                │
                         SIP 信令与 RTP 媒体
```

FreeSWITCH 只负责 SIP 注册、呼叫、媒体播放、会议和产生通话事件；账号、终端、分区、计划、
重试、权限、审计等都由业务后端持久化管理。禁止让浏览器、普通业务 API 或用户输入直接透传
任意 ESL 命令。

## 2. 服务边界

首期建议采用“模块化单体 + 独立 Worker”，不要过早拆微服务。一个业务 API 进程和一个 Worker
进程共享领域代码与 PostgreSQL，FreeSWITCH Adapter 保持独立进程并只开放内网接口。

| 模块 | 职责 | 不负责 |
| --- | --- | --- |
| IAM | 用户、角色、数据范围、API Key、登录会话 | SIP 鉴权 |
| 组织与租户 | 租户、站点、区域树、终端归属 | 呼叫执行 |
| SIP 资源 | 分机、凭据、网关、注册快照、设备能力 | 业务任务编排 |
| 媒体 | 上传、哈希去重、转码、时长探测、审核、存储 | 直接拨号 |
| 广播任务 | 草稿、审批、即时/定时任务、目标快照、取消 | 直接解析 ESL 帧 |
| 调度 Worker | 到期扫描、并发分片、重试、超时、补偿 | 用户鉴权 |
| FS Adapter | ESL 长连接、受控命令、XML Directory/Dialplan、事件归一化 | 业务真相存储 |
| 告警审计 | 操作审计、失败聚合、指标、通知 | 修改历史事实 |

推荐部署单元：

- `control-api`：面向 Web/Open API；只提交业务意图。
- `scheduler-worker`：领取任务、冻结目标、分批派发、聚合结果。
- `freeswitch-adapter`：维护 ESL 长连接，负责命令与事件映射；由当前
  `services/freeswitch-api` 演进而来。
- `media-worker`：FFmpeg 转码、响度归一化、病毒扫描、元数据提取。
- `config-provider`：向 FreeSWITCH `mod_xml_curl` 提供 Directory/Dialplan；首期也可并入
  `control-api`，但必须走独立内网路由和缓存。

## 3. 核心业务域

### 3.1 组织、区域与终端

- 租户下可以有多个站点；站点对应独立 SIP 域、FreeSWITCH 节点池和默认策略。
- 区域是树形结构，支持园区/楼栋/楼层/房间等层级；终端可属于一个主区域和多个标签组。
- 终端记录业务在线状态与最后注册状态。在线状态来自心跳或 ESL 注册事件，不允许仅凭
  数据库中存在账号判断在线。
- 终端能力至少包括支持的编解码、是否自动接听、音量控制能力、双向对讲能力和固件版本。
- 删除采用停用/软删除；历史任务目标必须保留当时的号码、区域和显示名快照。

### 3.2 SIP 账号与配置

- 一个终端可绑定一个或多个 SIP 账号，但一个账号同一时刻只能有一个有效归属策略。
- 密码只在创建/轮换时返回一次，数据库保存强哈希或由密钥服务加密保存，日志中必须脱敏。
- Directory 查询以 `domain + username` 为键，返回账号、上下文、呼叫组和允许编解码。
- 配置变更写入 `config_revision`。FreeSWITCH 通过 XML Curl 按需读取并短时缓存；紧急禁用账号
  时同时执行注册清理，避免只改库不生效。
- 外线 SIP Trunk 与内部分机分开建模，网关凭据不得通过普通终端接口读取。

### 3.3 媒体资产

媒体状态：

```text
UPLOADING → PROCESSING → READY
                   ├──→ REJECTED
                   └──→ FAILED
READY → ARCHIVED
```

- 原文件存对象存储，Worker 生成 FreeSWITCH 播放版，例如单声道 PCM WAV（8 kHz/16 kHz，
  具体采样率按终端能力选择）。数据库只保存对象键，不保存宿主机绝对路径。
- 记录 SHA-256、MIME、大小、时长、采样率、声道、审核结果和转码版本。
- FS 节点通过只读共享卷、对象存储预签名拉取或媒体缓存服务获取文件；生产环境不再依赖
  `docker compose cp`。
- 创建任务时只允许引用 `READY` 的媒体，任务执行后媒体采用引用计数/保留期清理。

### 3.4 广播、计划与审批

广播来源至少包括：即时广播、定时计划、周期计划、紧急广播、人工喊话。任务保存目标选择器，
真正开始执行前生成不可变目标快照，避免执行中区域成员变化导致审计不一致。

建议任务状态机：

```text
DRAFT → PENDING_APPROVAL → SCHEDULED → DISPATCHING → RUNNING
  │             │              │             │           │
  └── CANCELED ←┴── REJECTED   └── CANCELED ←┘           ├── SUCCEEDED
                                                          ├── PARTIAL_FAILED
                                                          ├── FAILED
                                                          └── CANCELED
```

目标执行状态：

```text
PENDING → QUEUED → ORIGINATING → RINGING → ANSWERED → PLAYING → SUCCEEDED
                              └──────────────────────────────→ RETRY_WAIT
                              └──────────────────────────────→ FAILED
任一非终态 ────────────────────────────────────────────────→ CANCELED
```

状态变化规则：

- 每次转换采用数据库条件更新或版本号进行并发保护。
- `POST /broadcasts` 必须接受 `Idempotency-Key`，重复请求返回同一个任务。
- 调度器采用数据库时间判断到期，通过 `FOR UPDATE SKIP LOCKED` 或租约避免多个 Worker 重复领取。
- 目标执行记录使用唯一键 `(broadcast_id, endpoint_id, attempt_no)`；同一派发消息重复消费不会
  产生第二路呼叫。
- ESL 的 `Job-UUID`、`Channel-Call-UUID` 与业务 `target_execution_id` 必须双向关联。
- 失败按原因分类：离线、忙线、拒接、无应答、媒体错误、网关错误、系统超时。只有策略允许的
  瞬时错误才重试，默认指数退避并加随机抖动。
- 取消先把业务状态改为 `CANCELED_REQUESTED`（内部状态），再向仍活跃的 Channel 发起挂断；
  收到挂断事件或超时补偿后完成取消。

### 3.5 实时喊话与双向对讲

- 实时喊话不能沿用“上传文件再 originate”的接口，应建立会话资源：创建会话、加入终端、
  获取短期媒体令牌、结束会话。
- 浏览器侧优先 WebRTC，进入 FreeSWITCH conference；硬件麦克风可使用受限 SIP 账号。
- 广播默认单向，听众静音；只有授权的调度员可以开启双向对讲，且要记录参与人和录音策略。
- 紧急广播支持更高优先级和抢占，但抢占策略必须按站点配置，并记录被中断任务。

## 4. 数据模型

生产控制面建议使用 PostgreSQL；Cloudflare D1 可以继续服务前端原型，但不适合作为需要
行锁、租约领取和高频事件写入的唯一业务库。关键表建议如下：

| 表 | 关键字段/约束 | 用途 |
| --- | --- | --- |
| `tenants` | `id, name, status` | 租户边界 |
| `sites` | `tenant_id, sip_domain, timezone, fs_pool_id` | 站点与时区 |
| `zones` | `site_id, parent_id, path, name` | 区域树 |
| `endpoints` | `site_id, zone_id, code, status, capabilities` | 终端主数据 |
| `endpoint_tags` | 唯一 `(endpoint_id, tag_id)` | 动态分组 |
| `sip_accounts` | 唯一 `(domain, username)`, `credential_version` | SIP 鉴权 |
| `sip_registrations` | `account_id, contact, node_id, expires_at` | 当前注册投影 |
| `media_assets` | `object_key, sha256, duration_ms, status` | 媒体资产 |
| `broadcasts` | `type, priority, state, scheduled_at, version` | 广播任务 |
| `broadcast_selectors` | `broadcast_id, selector_type, selector_value` | 原始目标条件 |
| `broadcast_targets` | 唯一 `(broadcast_id, endpoint_id)`, 快照字段 | 不可变目标集 |
| `broadcast_attempts` | `target_id, attempt_no, job_uuid, channel_uuid, state` | 单目标执行 |
| `fs_events_inbox` | 唯一 `(node_id, event_uuid)`, `payload, processed_at` | ESL 事件防重 |
| `schedules` | `rrule, timezone, next_run_at, enabled` | 周期计划 |
| `approvals` | `resource_type, resource_id, decision, actor_id` | 审批轨迹 |
| `audit_logs` | `actor, action, resource, before, after, request_id` | 不可变审计 |
| `outbox_events` | `aggregate_id, type, payload, published_at` | 可靠发布 |
| `fs_nodes` | `name, address, state, capacity, heartbeat_at` | 节点与容量 |

所有业务表包含 `tenant_id`（全局基础表除外）、`created_at`、`updated_at`；对外 ID 使用 UUIDv7
或 ULID，枚举状态在应用层和数据库约束中保持一致。ESL 原始事件可短期保留，长期只保留归一化
字段和审计所需信息。

## 5. API 规划

对外 API 使用 `/api/v1`，统一返回 `requestId`；写接口支持幂等键，列表使用游标分页。

```text
POST   /media/uploads                     创建直传会话
POST   /media/{id}/complete               确认上传并开始转码
GET    /media/{id}                        查询媒体状态

GET    /endpoints                         查询终端/在线状态
POST   /endpoints                         新增终端
POST   /endpoints/{id}/credentials/rotate 轮换 SIP 凭据
GET    /sip/registrations                 查询注册投影

POST   /broadcasts                        创建广播（草稿或直接提交）
POST   /broadcasts/{id}/submit            提交审批/调度
POST   /broadcasts/{id}/approve           审批
POST   /broadcasts/{id}/cancel            取消
GET    /broadcasts/{id}                   查询聚合状态
GET    /broadcasts/{id}/targets           查询逐终端结果
GET    /broadcasts/{id}/events            SSE 推送任务进度

POST   /talk-sessions                     创建实时喊话会话
POST   /talk-sessions/{id}/participants   加入终端
DELETE /talk-sessions/{id}                结束会话
```

FS Adapter 只在内网提供受控接口：

```text
POST /internal/v1/calls/originate
POST /internal/v1/channels/{uuid}/hangup
POST /internal/v1/conferences
GET  /internal/v1/nodes/{id}/status
POST /internal/v1/config/reload
```

当前 `/api/v1/broadcasts` 应在下一阶段迁移到业务 API；Adapter 的调用体改为携带业务
`targetExecutionId`、已校验的拨号目标和媒体对象，不再由公开接口一次接收 500 个号码。

## 6. FreeSWITCH 集成设计

### 6.1 ESL 控制与事件

- Adapter 每个 FS 节点维护一个命令连接池和至少一个事件长连接，订阅 JSON 格式的
  `BACKGROUND_JOB`、`CHANNEL_CREATE`、`CHANNEL_PROGRESS`、`CHANNEL_ANSWER`、
  `CHANNEL_HANGUP_COMPLETE`、`CUSTOM sofia::register`、`CUSTOM sofia::unregister`。
- 命令结果只表示“已受理”，最终状态必须由事件驱动；事件先写 `fs_events_inbox` 再异步归一化。
- originate 时写入自定义 Channel Variables：`sip_broadcast_id`、`sip_target_id`、
  `sip_attempt_id`、`sip_tenant_id`，便于任何事件反查业务实体。
- Adapter 断线后指数退避重连并上报告警。重连窗口内由通道查询和超时补偿修复悬挂状态，不能
  把所有运行中目标直接判失败。

### 6.2 动态配置

首期可继续使用生成 XML + `reloadxml`，但账号达到数百或多节点后应切换 `mod_xml_curl`：

- Directory：按需查询 SIP 账号，5～30 秒缓存；禁用事件主动失效。
- Dialplan：保持少量稳定路由，业务参数从 Channel Variables 传入，不为每个任务生成 XML。
- ACL：按站点维护终端网段、网关地址和 ESL 控制网段。
- 配置服务不可用时使用短期 stale cache，超过安全窗口拒绝新注册，避免无限使用过期凭据。

### 6.3 容量与路由

- 每个节点维护 `max_sessions`、`sessions_per_second`、当前会话数和健康状态。
- 调度按站点和媒体亲和性选节点；一次广播拆成小批次，并用令牌桶限制 CPS。
- 节点失联后只把尚未派发的目标迁移到健康节点；已接通呼叫不跨节点迁移。
- 广播聚合结果不依赖单节点内存，任一 Worker 重启后可由数据库继续执行。

## 7. 安全、审计与可观测性

- 公网仅暴露业务 API（经 TLS/WAF）和确有需要的 SIP/RTP；ESL、XML Curl、数据库、Redis、
  Adapter 仅内网可达。
- SIP 逐步启用 TLS/SRTP；不支持安全媒体的旧终端隔离到受控 VLAN，并限制来源 IP。
- 用户授权采用 RBAC + 数据范围（租户/站点/区域）。紧急广播、实时喊话、凭据轮换、网关修改
  使用更高权限，并可配置双人审批。
- API Key 保存哈希、可轮换、有到期时间和细粒度 scope；服务间使用 mTLS 或短期工作负载身份。
- 审计日志记录操作者、来源、请求 ID、对象、前后值摘要和结果，业务层不可更新或删除。
- 指标至少包含：注册终端数、任务排队时长、呼叫建立时延、接通率、播放成功率、按原因失败数、
  ESL 重连、节点会话数/CPS、媒体转码耗时、队列积压。
- 日志使用结构化 JSON，并贯穿 `request_id → broadcast_id → target_id → attempt_id → channel_uuid`；
  密码、Authorization、SDP 和可能包含敏感信息的 SIP Header 默认不落日志。

## 8. 一致性与故障恢复

- 业务写入与待发布事件使用 Transactional Outbox；Worker 消费至少一次，处理器必须幂等。
- `fs_events_inbox` 以节点和事件 UUID 防重；缺少事件 UUID 时使用稳定字段组合生成摘要键。
- Worker 任务采用短租约并续约。进程崩溃后租约到期可被其他 Worker 领取。
- 每分钟扫描超时状态：`ORIGINATING` 无通道、`PLAYING` 超过媒体时长容差、
  `CANCELED_REQUESTED` 仍有通道，并执行查询/挂断/终结补偿。
- 数据库是业务状态真相，FreeSWITCH 是通话实时状态真相；二者不一致时通过明确的对账任务修复，
  不允许相互无条件覆盖。

## 9. 分阶段实施

### M0：通信基座（当前迭代）

- FreeSWITCH 固定 GitHub release tag 源码多阶段构建，Sofia-SIP 同样固定版本。
- 仅编译广播需要的模块，去除 SignalWire 软件包仓库 Token。
- 保持现有受控 ESL API 和局域网 SIP 联调能力。
- 验收：镜像可构建；两个软终端可注册；WAV/MP3 可播放；挂断、状态、注册查询可用。

### M1：业务最小闭环

- 引入 PostgreSQL、迁移框架、租户/站点/区域/终端/SIP 账号/媒体/广播核心表。
- 建立业务 API、调度 Worker、媒体转码和任务/目标状态机。
- ESL 事件改成长连接并落 Inbox，完成从创建任务到逐终端结果的闭环。
- 验收：100 个目标任务可幂等创建、取消、失败分类、按策略重试，重启 Worker 不丢任务。

### M2：生产可运营

- 动态 Directory、RBAC/数据权限、审批、周期计划、审计、告警、SSE 进度。
- 节点容量治理、媒体缓存、备份恢复、TLS/SRTP 与密钥轮换。
- 验收：500～1000 终端容量压测；故障注入覆盖 FS/Adapter/Worker/DB 短时中断；RPO/RTO 达标。

### M3：高可用与高级业务

- 多节点资源池、跨节点调度、站点级容灾、实时喊话、双向对讲、外线网关和开放 API。
- 验收：节点滚动升级不中断新任务；单节点故障不丢未派发目标；紧急广播抢占策略可审计。

## 10. 当前代码的下一批任务

按依赖顺序建议直接实施：

1. 将 `services/freeswitch-api` 的 ESL 客户端拆为命令连接与事件长连接，先补事件解析、重连、
   订阅和去重测试。
2. 新增本地 PostgreSQL/Redis Compose 服务及 Drizzle PostgreSQL Schema；前端 D1 Schema 与生产
   控制面 Schema 分离，避免混用运行时。
3. 实现 `broadcasts / broadcast_targets / broadcast_attempts / outbox_events / fs_events_inbox`，
   打通单目标状态机，再扩展批量调度。
4. 引入媒体上传与 FFmpeg Worker，API 改为传 `mediaAssetId`，彻底移除用户提交绝对文件路径。
5. 实现动态 Directory 和 SIP 凭据轮换，最后再做审批、周期计划和多节点调度。

在 M1 完成前，当前 REST API 适合作为通信联调接口，不应直接作为公网生产业务 API。
