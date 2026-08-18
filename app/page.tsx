// Ontos —— 两个页面，不是两个会话：构建 = 纯画布页；对话 = 纯对话页。
"use client";

import { useState } from "react";
import CanvasPage from "@/components/CanvasPage";
import ChatPage from "@/components/ChatPage";

export default function Home() {
  const [page, setPage] = useState<"build" | "chat">("build");
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <nav className="nav-float">
        <span className="nav-brand">Ontos</span>
        {(
          [
            ["build", "本体构建"],
            ["chat", "对话"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} className={`nav-seg ${page === key ? "on" : ""}`} onClick={() => setPage(key)}>
            {label}
          </button>
        ))}
      </nav>
      {/* 两页常驻挂载、用显隐切换：切页不丢画布状态与对话消息 */}
      <div style={{ display: page === "build" ? "contents" : "none" }}>
        <CanvasPage />
      </div>
      <div style={{ display: page === "chat" ? "contents" : "none" }}>
        <ChatPage />
      </div>
    </div>
  );
}
