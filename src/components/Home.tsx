// Ontos —— 单一画布页（客户端组件）。问数与动作不外置 UI：外部 Agent 经 MCP（/api/mcp）驱动。
// 左上角是工作空间切换器：空间 = 共享元库里按 workspace_id 隔开的一整套配置与历史。
// 初始空间由服务端从 cookie 读出传入（首屏即上次用的空间）；这里只校验它还在（空间已删则回 default）。
"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CaretDown, Check, Plus } from "@phosphor-icons/react";
import CanvasPage from "@/components/CanvasPage";
import { apiGet, apiPost, rememberWorkspace, setWorkspace } from "@/components/workspaceClient";

export default function Home({ initialWorkspace }: { initialWorkspace: string }) {
  const [workspace, setWorkspaceState] = useState<string>(() => {
    setWorkspace(initialWorkspace); // 模块单值跟上：画布首轮请求直接打这个空间（子组件 effect 先于本组件 effect 跑）
    return initialWorkspace;
  });
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const switchWorkspace = useCallback((w: string) => {
    setWorkspace(w); // 全局单值先换，再按 key 重挂画布
    setWorkspaceState(w);
    rememberWorkspace(w); // 记到 cookie：下次打开（含刷新）首屏就是这个空间
  }, []);
  // 首轮加载：拉空间列表 → 校验初始空间还在（空间已删/列表读不出都回 default）
  useEffect(() => {
    void (async () => {
      try {
        const data = await apiGet<{ workspaces?: string[] }>("/api/workspaces");
        const list = data.workspaces ?? [];
        setWorkspaces(list);
        if (!list.includes(initialWorkspace)) switchWorkspace("default");
      } catch {
        setListError("空间列表读不出来——检查后端后重新打开"); // 失败也要说：不再 unhandled rejection + 静默空列表
      }
    })();
  }, [initialWorkspace, switchWorkspace]);
  const brand: ReactNode = (
    <>
      <span className="nav-brand">Ontos</span>
      <WorkspaceSwitcher workspace={workspace} onChange={switchWorkspace} workspaces={workspaces} onWorkspaces={setWorkspaces} listError={listError} />
    </>
  );
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* 切空间按 key 重挂（换一整套配置与历史）；品牌和入口在左上同一条工具条 */}
      <CanvasPage key={workspace} brand={brand} />
    </div>
  );
}

/** 空间切换器：触发器 + 下拉面板。面板里列空间（当前打勾）、底部「新建工作空间」行内展开输入。
 *  列表由 Home 拉取（初始校验与下拉共用一份），新建成功后经 onWorkspaces 回写。 */
function WorkspaceSwitcher({
  workspace,
  onChange,
  workspaces,
  onWorkspaces,
  listError,
}: {
  workspace: string;
  onChange: (w: string) => void;
  workspaces: string[];
  onWorkspaces: (list: string[]) => void;
  listError: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
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
      onWorkspaces(data.workspaces ?? []);
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
            {listError && <div style={{ fontSize: 11, color: "var(--danger)", padding: "6px 10px" }}>{listError}</div>}
            {workspaces.map((w) => (
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
