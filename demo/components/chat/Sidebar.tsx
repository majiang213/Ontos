"use client";

// 左侧导航：工作空间切换 + 页面切换 + 空间资源（数据源/本体/新系统）+ 问数会话列表。
// 没有流程步骤列表——引导由交互承担（连接表单/加入画布/确认草稿/裁决面板/发布条）。
import { useState } from "react";
import {
  Plus, SquaresFour, CaretDown, Database, ShareNetwork, Code,
  ChatCircleText, GitBranch, Check,
} from "@phosphor-icons/react";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function Sidebar({
  wsList, activeWs, onSwitchWs, onNewWs, badges, onOpenView, convs, activeConv, onSwitchConv,
  chats, activeChatId, onNewChat, onSwitchChat,
}: {
  wsList: { id: string; name: string }[];
  activeWs: string;
  onSwitchWs: (id: string) => void;
  onNewWs: () => void;
  badges: { sources: number; objects: number; version: number | null; generated: boolean };
  onOpenView: (kind: "schema" | "ontology" | "code") => void;
  convs: { id: string; title: string }[];
  activeConv: string;
  onSwitchConv: (id: string) => void;
  chats: { id: string; title: string }[];
  activeChatId: string;
  onNewChat: () => void;
  onSwitchChat: (id: string) => void;
}) {
  const [wsMenu, setWsMenu] = useState(false);
  const current = wsList.find((w) => w.id === activeWs);

  const resources = [
    { kind: "schema" as const, icon: <Database size={14} />, label: "数据源", value: badges.sources ? `${badges.sources} 个` : "未连接", ok: !!badges.sources },
    { kind: "ontology" as const, icon: <ShareNetwork size={14} />, label: "本体对象", value: badges.objects ? `${badges.objects} 个${badges.version ? ` · v${badges.version}` : " · 草稿"}` : "—", ok: !!badges.objects },
    { kind: "code" as const, icon: <Code size={14} />, label: "新系统", value: badges.generated ? "运行中" : "—", ok: badges.generated },
  ];

  return (
    <aside className="sidenav">
      <div className="brand">
        <div className="mark">O</div>
        <b>Ontos</b>
        <span>安托斯</span>
      </div>

      {/* 工作空间切换（放最上面：空间是最大的容器，页面是空间内的视图） */}
      <div className="cap-wrap" style={{ display: "block" }}>
        <button className="new-chat" onClick={() => setWsMenu(!wsMenu)}>
          <SquaresFour size={14} />
          {current?.name ?? "工作空间"}
          <CaretDown size={12} style={{ marginLeft: "auto", opacity: 0.5 }} />
        </button>
        {wsMenu && (
          <>
            <div className="cap-overlay" onClick={() => setWsMenu(false)} />
            <div className="cap-menu" style={{ top: 42, bottom: "auto", width: "100%" }}>
              {wsList.map((w) => (
                <button key={w.id} className="cap-item" onClick={() => { setWsMenu(false); onSwitchWs(w.id); }}>
                  <i>{w.id === activeWs ? <Check size={12} weight="bold" /> : null}</i>
                  {w.name}
                </button>
              ))}
              <div className="cap-group" />
              <button className="cap-item" style={{ color: "var(--accent)" }} onClick={() => { setWsMenu(false); onNewWs(); }}>
                <i><Plus size={12} weight="bold" /></i>新建工作空间
              </button>
            </div>
          </>
        )}
      </div>

      {/* 页面切换：本体构建（纯画布）/ 问数（纯对话）——两个页面，不是两个会话 */}
      <div className="page-switch">
        {convs.map((c) => (
          <button key={c.id} className={c.id === activeConv ? "active" : ""} onClick={() => onSwitchConv(c.id)}>
            <i>{c.id === "flow" ? <GitBranch size={13} /> : <ChatCircleText size={13} />}</i>
            {c.title}
          </button>
        ))}
      </div>

      {/* 问数会话列表：可新建、可切换（只在本体构建外的问数页显示） */}
      {activeConv === "chat" && (
        <>
          <div className="nav-label">会话</div>
          <button className="nav-item" onClick={onNewChat}>
            <i><Plus size={14} /></i>新建会话
          </button>
          {chats.map((c) => (
            <button key={c.id} className={`nav-item chat-item ${c.id === activeChatId ? "active" : ""}`} onClick={() => onSwitchChat(c.id)} title={c.title}>
              <i><ChatCircleText size={14} /></i>
              <span className="chat-title">{c.title}</span>
            </button>
          ))}
        </>
      )}

      {/* 空间资源：构建上下文，只在「本体构建」页显示 */}
      {activeConv === "flow" && (
        <>
          <div className="nav-label">空间内容</div>
          {resources.map((r) => (
            <button key={r.kind} className="nav-item" onClick={() => onOpenView(r.kind)}>
              <i>{r.icon}</i>
              {r.label}
              <em className={r.ok ? "res-ok" : ""}>{r.value}</em>
            </button>
          ))}
        </>
      )}

      <div className="nav-spacer" />
      <div className="nav-user" style={{ marginTop: 8 }}>
        <div className="u-av">D</div>
        demo_user
        <span className="tag warn" style={{ marginLeft: "auto" }}>规则模拟</span>
      </div>
    </aside>
  );
}
