// Cloudflare Workers 运行时类型的最小声明。
//
// 背景：本项目是 React + DOM 环境，`lib` 含 "dom"。若引入完整的
// @cloudflare/workers-types，它会以全局方式重复声明 Request / Response /
// fetch 等符号，与 DOM 内置类型冲突，导致 tsc 大面积报错。
//
// 这里只声明模板入口（worker/index.ts、db/index.ts）实际用到的少数符号，
// 既让类型检查通过，又不污染全局 DOM 类型。若将来真的接入 D1/R2，
// 应改为按 Cloudflare 官方方式引入完整类型包并在 tsconfig 中单独隔离。

declare module "cloudflare:workers" {
  // Cloudflare 运行时注入的环境绑定。当前项目未启用 D1/R2
  // （.openai/hosting.json 中 d1/r2 均为 null），因此除已知的 DB 外
  // 允许承载其它任意绑定。
  interface CloudflareEnv {
    DB?: D1Database;
    [binding: string]: unknown;
  }

  export const env: CloudflareEnv;
}

/** Cloudflare 静态资源绑定：按路径取回构建产物。 */
interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

/**
 * Cloudflare D1 数据库绑定的最小声明。
 *
 * 只保留 drizzle D1 驱动在类型层面需要的内容；本模板未真正启用 D1，
 * 因此方法返回类型用宽松签名，避免引入完整类型包。
 */
interface D1Database {
  prepare(query: string): unknown;
  batch<T = unknown>(statements: unknown[]): Promise<T[]>;
  exec(query: string): Promise<unknown>;
  dump(): Promise<ArrayBuffer>;
}
