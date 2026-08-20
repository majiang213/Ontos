// Ontos —— 两个页面，不是两个会话：构建 = 纯画布页；对话 = 纯对话页。
// 左上角是工作空间切换器：空间 = 共享元库里按 workspace_id 隔开的一整套配置与历史。
"use client";

import { useCallback, useEffect, useState } from "react";
import { CaretDown, Check, Plus } from "@phosphor-icons/react";
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
      {/* 左上角：品牌 + 空间切换器（全局）；页面切换留在中栏 */}
      <div style={{ position: "fixed", top: 14, left: 16, zIndex: 30, display: "flex", gap: 8, alignItems: "center" }}>
        <span className="nav-brand">Ontos</span>
        <span className="nav-sha" style={{ fontSize: 10, color: "var(--ink-3)", userSelect: "none" }} title="当前代码版本（git 短 hash）">{process.env.NEXT_PUBLIC_GIT_SHA}</span>
        <WsSwitcher ws={ws} onChange={switchWs} />
      </div>
      <nav className="nav-float">
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

/** 空间切换器：触发器 + 下拉面板。面板里列空间（当前打勾）、底部「新建工作空间」行内展开输入。 */
function WsSwitcher({ ws, onChange }: { ws: string; onChange: (w: string) => void }) {
  const [list, setList] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const r = await fetch("/api/workspaces");
      const data = await r.json();
      setList(data.workspaces ?? []);
    })();
  }, []);
  const close = () => {
    setOpen(false);
    setCreating(false);
    setName("");
    setError(null);
  };
  const create = async () => {
    if (!name.trim()) return;
    const r = await fetch("/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error ?? "建不了");
      return;
    }
    const created = name.trim();
    setList(data.workspaces ?? []);
    close();
    onChange(created);
  };
  return (
    <span style={{ position: "relative" }}>
      <button className="ws-trigger" title="工作空间" onClick={() => (open ? close() : setOpen(true))}>
        {ws}
        <CaretDown size={12} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform var(--t-fast)" }} />
      </button>
      {open && (
        <>
          {/* 透明幕布：点面板外任意处收口 */}
          <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onClick={close} />
          <div className="ws-menu">
            {list.map((w) => (
              <button
                key={w}
                className="ws-row"
                onClick={() => {
                  onChange(w);
                  close();
                }}
              >
                <span style={{ flex: 1 }}>{w}</span>
                {w === ws && <Check size={12} style={{ color: "var(--accent)" }} />}
              </button>
            ))}
            <div style={{ height: 1, background: "var(--hairline)", margin: "3px 4px" }} />
            {creating ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void create();
                }}
                style={{ padding: "2px 4px" }}
              >
                <input
                  autoFocus
                  placeholder="空间名"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && close()}
                  style={{ width: "100%", fontSize: 12, padding: "5px 8px", borderRadius: 8, border: "1px solid var(--line-strong)", background: "var(--panel-2)" }}
                />
                {error && <div style={{ fontSize: 11, color: "var(--danger)", padding: "3px 4px 1px" }}>{error}</div>}
              </form>
            ) : (
              <button className="ws-row" onClick={() => setCreating(true)}>
                <Plus size={12} />
                新建工作空间
              </button>
            )}
          </div>
        </>
      )}
    </span>
  );
}
