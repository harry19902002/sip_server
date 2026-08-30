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
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: `try{var t=localStorage.getItem("sip-theme");if(t==="dark")document.documentElement.dataset.theme="dark"}catch(e){}` }} /></head><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
