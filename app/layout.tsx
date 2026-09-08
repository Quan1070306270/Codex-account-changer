import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GPT 账号管理",
  description: "管理 ChatGPT 账号、查看真实 Codex 用量并切换 Mac 上的 Codex App。",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
