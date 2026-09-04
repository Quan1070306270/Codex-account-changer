import type { Metadata } from "next";
import { Dashboard } from "./dashboard";

export const metadata: Metadata = {
  title: "GPT 账号管理",
  description: "通过 ChatGPT 官方登录验证并查看真实 Codex 用量。",
};

export default function Home() {
  return <Dashboard />;
}
