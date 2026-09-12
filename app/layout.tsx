import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "SIP广播系统 · 管理平台",
  description: "面向园区、校园与公共空间的 SIP 广播运营管理平台。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // 运行时配置注入：业务 API 端口与版本号由启动器通过环境变量传入，在 HTML 里写入
  // window.__SIP_RUNTIME__，使前端无需重新构建即可跟随 GUI 中修改的端口、
  // 并显示本次打包的版本（含构建日期时间）。
  // 这段脚本位于 <head>，会在应用 JS 之前执行。
  const apiPort = process.env.SIP_API_PORT || "";
  const appVersion = process.env.SIP_APP_VERSION || "";
  const runtimeConfig: string[] = [];
  if (apiPort) runtimeConfig.push(`apiPort:${JSON.stringify(apiPort)}`);
  if (appVersion) runtimeConfig.push(`version:${JSON.stringify(appVersion)}`);
  const runtimeScript =
    `try{var t=localStorage.getItem("sip-theme");if(t==="dark")document.documentElement.dataset.theme="dark"}catch(e){}` +
    (runtimeConfig.length ? `window.__SIP_RUNTIME__={${runtimeConfig.join(",")}};` : "");
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: runtimeScript }} /></head><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
