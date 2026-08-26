// Ontos —— 单一画布页。问数与动作不外置 UI：外部 Agent 经 MCP（/api/mcp）驱动。
// 左上角是工作空间切换器：空间 = 共享元库里按 workspace_id 隔开的一整套配置与历史。
"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CaretDown, Check, Plus } from "@phosphor-icons/react";
import CanvasPage from "@/components/CanvasPage";
import { apiGet, apiPost, setWorkspace } from "@/components/workspaceClient";

export default function Home() {
  const [workspace, setWorkspaceState] = useState("default");
  const switchWorkspace = useCallback((w: string) => {
    setWorkspace(w); // 全局单值先换，再按 key 重挂画布
    setWorkspaceState(w);
  }, []);
  const brand: ReactNode = (
    <>
      <span className="nav-brand">Ontos</span>
      <span className="nav-sha" title="当前代码版本（git 短 hash）">{process.env.NEXT_PUBLIC_GIT_SHA}</span>
      <WorkspaceSwitcher workspace={workspace} onChange={switchWorkspace} />
    </>
  );
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* 切空间按 key 重挂（换一整套配置与历史）；品牌和入口在左上同一条工具条 */}
      <CanvasPage key={workspace} brand={brand} />
    </div>
  );
}

/** 空间切换器：触发器 + 下拉面板。面板里列空间（当前打勾）、底部「新建工作空间」行内展开输入。 */
function WorkspaceSwitcher({ workspace, onChange }: { workspace: string; onChange: (w: string) => void }) {
  const [list, setList] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const data = await apiGet<{ workspaces?: string[] }>("/api/workspaces");
        setList(data.workspaces ?? []);
      } catch {
        setError("空间列表读不出来——检查后端后重新打开"); // 失败也要说：不再 unhandled rejection + 静默空列表
      }
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
    try {
      const data = await apiPost<{ workspaces?: string[] }>("/api/workspaces", { name: name.trim() });
      const created = name.trim();
      setList(data.workspaces ?? []);
      close();
      onChange(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "建不了");
    }
  };
  return (
    <span style={{ position: "relative" }}>
      <button className="workspace-trigger" title="工作空间" onClick={() => (open ? close() : setOpen(true))}>
        {workspace}
        <CaretDown size={12} style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform var(--t-fast)" }} />
      </button>
      {open && (
        <>
          {/* 透明幕布：点面板外任意处收口 */}
          <div style={{ position: "fixed", inset: 0, zIndex: 39 }} onClick={close} />
          <div className="workspace-menu">
            {list.map((w) => (
              <button
                key={w}
                className="workspace-row"
                onClick={() => {
                  onChange(w);
                  close();
                }}
              >
                <span style={{ flex: 1 }}>{w}</span>
                {w === workspace && <Check size={12} style={{ color: "var(--accent)" }} />}
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
              <button className="workspace-row" onClick={() => setCreating(true)}>
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
