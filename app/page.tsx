// Ontos —— 两个页面，不是两个会话：构建 = 纯画布页；对话 = 纯对话页。
"use client";

import { useState } from "react";
import CanvasPage from "@/components/CanvasPage";
import ChatPage from "@/components/ChatPage";

export default function Home() {
  const [page, setPage] = useState<"build" | "chat">("build");
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 16, padding: "10px 16px", borderBottom: "1px solid var(--border)", background: "var(--panel)" }}>
        <strong style={{ fontSize: 15 }}>Ontos</strong>
        <nav style={{ display: "flex", gap: 4, background: "var(--bg)", borderRadius: 10, padding: 3 }}>
          {(
            [
              ["build", "本体构建"],
              ["chat", "对话"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setPage(key)}
              style={{
                border: "none",
                cursor: "pointer",
                fontSize: 13,
                padding: "5px 16px",
                borderRadius: 8,
                background: page === key ? "var(--panel)" : "transparent",
                color: page === key ? "var(--ink)" : "var(--ink-3)",
                boxShadow: page === key ? "var(--shadow-sm)" : "none",
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>
      {page === "build" ? <CanvasPage /> : <ChatPage />}
    </div>
  );
}
