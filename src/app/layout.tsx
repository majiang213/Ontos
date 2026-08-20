import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ontos 安托斯 — 对话式本体工作台",
  description: "逆向建模 → 多源整合 → 发布映射 → 问数",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // 字体只用 globals.css 的令牌栈：不引 next/font（构建期要联网下载，且注入的同名变量会顶掉设计令牌）
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
