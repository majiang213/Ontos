// Ontos —— 两个页面，不是两个会话：构建 = 纯画布页；对话 = 纯对话页。
// 顶栏左侧是工作空间切换器：空间 = 一套独立配置与历史（lib/config/workspaces/<name>/）。
"use client";

import { useCallback, useEffect, useState } from "react";
import CanvasPage from "@/components/CanvasPage";
import ChatPage from "@/components/ChatPage";
import { setWs } from "@/components/wsClient";

export default function Home() {
  const [page, setPage] = useState<"build" | "chat">("build");
  const [ws, setWsState] = useState("default");
  const switchWs = useCallback((w: string) => {
    setWs(w); // 全局单值先换，再按 key 重挂两页
    setWsState(w);
  }, []);
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <nav className="nav-float">
        <span className="nav-brand">Ontos</span>
        <WsSwitcher ws={ws} onChange={switchWs} />
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
      {/* 两页常驻挂载、用显隐切换：切页不丢画布状态与对话消息；切空间按 key 重挂（换一整套配置与历史） */}
      <div style={{ display: page === "build" ? "contents" : "none" }}>
        <CanvasPage key={ws} />
      </div>
      <div style={{ display: page === "chat" ? "contents" : "none" }}>
        <ChatPage key={ws} />
      </div>
    </div>
  );
}

/** 空间切换器：下拉选空间；＋ 展开小表单新建（从种子模板起步）。 */
function WsSwitcher({ ws, onChange }: { ws: string; onChange: (w: string) => void }) {
  const [list, setList] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await fetch("/api/workspaces");
    const data = await r.json();
    setList(data.workspaces ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 12 }}>
      <select
        value={ws}
        onChange={(e) => onChange(e.target.value)}
        title="工作空间"
        style={{ fontSize: 12, padding: "3px 8px", borderRadius: 10, border: "none", boxShadow: "0 0 0 1px var(--hairline-strong)", background: "var(--panel)", color: "var(--ink-2)" }}
      >
        {list.map((w) => (
          <option key={w} value={w}>{w}</option>
        ))}
      </select>
      {creating ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!name.trim()) return;
            const r = await fetch("/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
            const data = await r.json();
            if (!r.ok) {
              setError(data.error ?? "建不了");
              return;
            }
            setList(data.workspaces ?? []);
            setCreating(false);
            setError(null);
            onChange(name.trim());
            setName("");
          }}
          style={{ display: "inline-flex", gap: 4, alignItems: "center" }}
        >
          <input
            autoFocus
            placeholder="空间名"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => !name.trim() && setCreating(false)}
            style={{ width: 90, fontSize: 12, padding: "3px 8px", borderRadius: 10, border: "none", boxShadow: "0 0 0 1px var(--hairline-strong)", background: "var(--panel)" }}
          />
          {error && <span style={{ fontSize: 11, color: "var(--danger)" }}>{error}</span>}
        </form>
      ) : (
        <button className="chip" style={{ padding: "2px 8px" }} title="新建工作空间" onClick={() => setCreating(true)}>＋</button>
      )}
    </span>
  );
}
