/// <reference types="vite/client" />

// 构建便携版时由构建环境注入的变量。
// 未注入时使用代码内默认值，因此不影响常规开发与部署。
interface ImportMetaEnv {
  readonly VITE_API_PORT?: string;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}
