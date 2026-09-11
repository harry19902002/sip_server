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
  // 运行时配置注入：业务 API 端口由启动器通过环境变量传入，在 HTML 里写入
  // window.__SIP_RUNTIME__，使前端无需重新构建即可跟随 GUI 中修改的端口。
  // 这段脚本位于 <head>，会在应用 JS 之前执行。
  const apiPort = process.env.SIP_API_PORT || "";
  const runtimeScript =
    `try{var t=localStorage.getItem("sip-theme");if(t==="dark")document.documentElement.dataset.theme="dark"}catch(e){}` +
    (apiPort ? `window.__SIP_RUNTIME__={apiPort:${JSON.stringify(apiPort)}};` : "");
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: runtimeScript }} /></head><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
