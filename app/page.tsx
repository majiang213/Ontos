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
      {page === "build" ? <CanvasPage /> : <ChatPage />}
    </div>
  );
}
