import type { Metadata } from "next";
import { Dashboard } from "../dashboard";

export const metadata: Metadata = {
  title: "Codex 设备账号切换器",
  description: "管理已连接 Mac 和 Windows 设备上的 Codex App 账号。",
};

export default function SwitcherPage() {
  return <Dashboard />;
}
