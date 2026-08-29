# SIP 广播系统

面向园区、校园与公共空间的 SIP 广播运营管理平台前端原型。

## 功能概览

- 运行总览与广播任务状态
- 实时广播和定时计划
- 终端列表、分区管理与 SIP 账号管理
- 媒体库、用户权限和系统配置
- 卡片 / 表格视图、搜索筛选及交互式操作

## 技术栈

- React 19
- TypeScript
- vinext / Vite
- Cloudflare Workers（可选 D1 与 Drizzle）

## 本地运行

需要 Node.js `>=22.13.0`。

```bash
npm install
npm run dev
```

常用命令：

```bash
npm run build
npm test
npm run lint
```

## 工程结构

```text
app/          页面与样式
db/           数据库入口与 Schema
drizzle/      数据库迁移元数据
public/       静态资源
tests/        渲染测试
worker/       Cloudflare Worker 入口
```

## 说明

当前仓库主要提供可交互的 Web 管理端原型，页面中的终端、任务、账号和计划数据为演示数据。
