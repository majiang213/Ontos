"use client";

// 对话列：Kimi 式——Agent 平铺无气泡、用户浅灰胶囊、输入为白底卡片；
// 流程四步（连接→建模→整合→发布），发布即自动出码；裁决在工作台面板里进行。
import { useEffect, useRef, useState } from "react";
import {
  Plus, CaretDown, CaretRight, Circle, ArrowUp, ArrowClockwise,
  PlugsConnected, PencilRuler, Scales, Code, ChatCircleText, ListChecks,
  Percent, GitBranch, ShieldCheck, Cube, LockSimple, CheckCircle, Database, ShareNetwork,
} from "@phosphor-icons/react";
import type { Msg } from "./mockAgent";

/* eslint-disable @typescript-eslint/no-explicit-any */

const HERO = [
  { n: "1", t: "连接数据源", d: "配置只读连接，选表加入画布", say: "连接数据源", key: "connect" },
  { n: "2", t: "逆向建模", d: "AI 读 schema 生成本体草稿，人修订确认", say: "生成本体草稿", key: "model" },
  { n: "3", t: "多源整合", d: "五关系类型裁决 + 数据交集硬证据", say: "开始裁决", key: "integrate" },
  { n: "4", t: "发布本体", d: "合并为单一事实源，自动产出新系统", say: "发布合并本体", key: "publish" },
];

// 输入区 + 菜单：能力与概念的归属地。stepKey 关联流程门控。
const CAP_MENU = [
  {
    group: "能力",
    items: [
      { icon: <PlugsConnected size={14} />, label: "连接源库", say: "先连上两个库看看", stepKey: null },
      { icon: <PencilRuler size={14} />, label: "逆向建模", say: "生成本体草稿", stepKey: null },
      { icon: <Scales size={14} />, label: "整合裁决", say: "开始裁决", stepKey: "integrate" },
      { icon: <Code size={14} />, label: "正向生成", say: "生成新系统", stepKey: "generate" },
      { icon: <ChatCircleText size={14} />, label: "问数示例", say: "查所有从候选人转正的员工及其部门", stepKey: "ask" },
      { icon: <ListChecks size={14} />, label: "当前状态", say: "现在进行到哪一步了？", stepKey: null },
    ],
  },
  {
    group: "概念",
    items: [
      { icon: <Percent size={14} />, label: "交集率", say: "交集率是什么意思？", stepKey: null },
      { icon: <GitBranch size={14} />, label: "五关系类型", say: "五类型是哪五种？", stepKey: null },
      { icon: <ShieldCheck size={14} />, label: "数据边界", say: "数据边界是什么？", stepKey: null },
      { icon: <Cube size={14} />, label: "本体", say: "本体是什么？", stepKey: null },
    ],
  },
];

function Message({ m, onSubmit, onHero, steps, onLocked, onOpenArtifact, onReplay }: { m: Msg; onSubmit: (t: string) => void; onHero: (key: string) => void; steps: { key: string; name: string; state: string }[]; onLocked: (name: string) => void; onOpenArtifact: (kind: string) => void; onReplay: () => void }) {
  if (m.role === "user") return <div className="row u"><div className="bubble u">{m.text}</div></div>;
  return (
    <div className="row a">
      <div className="avatar">O</div>
      <div className="bubble a">
        {m.text && <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>}

        {m.payload?.hero && (
          <div className="hero-grid">
            {HERO.map((c, i) => {
              const st = steps.find((s) => s.key === c.key);
              // 首张卡是流程入口：永不锁定（连接配置就是它内部的交互）；
              // 步骤不在流程里（如单源跳过整合）也按锁定处理，不可点
              const locked = i > 0 && st?.state !== "open" && st?.state !== "done";
              const done = st?.state === "done";
              const current = !done && !locked; // 与侧栏同一套状态语言：✓ 完成 / ● 当前 / 🔒 锁定
              return (
                <div
                  className={`hero-card clickable ${locked ? "locked" : ""} ${current ? "current" : ""}`}
                  key={c.n}
                  onClick={() => (locked ? onLocked(st?.name ?? c.t) : onHero(c.key))}
                  title={locked ? `先完成前置步骤` : c.say}
                >
                  <div className="hc-t">
                    <span className="num">
                      {done ? <CheckCircle size={11} weight="fill" /> : locked ? <LockSimple size={10} /> : <Circle size={7} weight="fill" />}
                    </span>
                    {c.t}
                  </div>
                  <div className="hc-d">{c.d}</div>
                </div>
              );
            })}
          </div>
        )}

        {m.kind === "schema" && (
          <div className="artifact" onClick={() => onOpenArtifact("schema")}>
            <Database size={14} />
            <span className="af-t">源库 schema · {m.payload.sources.length} 库 {m.payload.sources.reduce((n: number, s: any) => n + s.tables.length, 0)} 表</span>
            <span className="af-go">查看 →</span>
          </div>
        )}
        {(m.kind === "drafts" || m.kind === "published" || m.kind === "generated") && (
          <div className="artifact" onClick={() => onOpenArtifact(m.kind === "generated" ? "code" : "ontology")}>
            {m.kind === "generated" ? <Code size={14} /> : <ShareNetwork size={14} />}
            <span className="af-t">
              {m.kind === "drafts" && `本体草稿 · ${m.payload.drafts.reduce((n: number, d: any) => n + Object.keys(d.ontology.object_types).length, 0)} 个对象类型`}
              {m.kind === "published" && "合并本体 · 已发布"}
              {m.kind === "generated" && "新系统 · DDL / CRUD API / 界面 / 血缘"}
            </span>
            <span className="af-go">查看 →</span>
          </div>
        )}

        {m.kind === "answer" && (
          <div className="chat-card answer">
            <div style={{ fontWeight: 600, margin: "2px 0 8px", display: "flex", alignItems: "center", gap: 6 }}>
              共 {m.payload.rows.length} 条
              <span className="tag ok">实时查源库 · 未落库</span>
              <span className="tag gray">取数 {m.payload.path.length} 步</span>
              <span className="tag gray">写 SQL 否</span>
              {m.payload.api && (
                <span className="tag">{m.payload.api.reused ? "复用 API" : "新存 API"} · {m.payload.api.name}</span>
              )}
              <button className="ghost sm" style={{ marginLeft: "auto" }} onClick={onReplay} title="用同一个问题重新查一次">
                <ArrowClockwise size={12} className="i-inline" />重放
              </button>
            </div>
            <div className="scrollbox">
              <table className="data">
                <thead><tr><th>姓名</th><th>身份证（脱敏）</th><th>状态</th><th>部门</th><th>入职日期</th></tr></thead>
                <tbody>
                  {m.payload.rows.map((r: any, i: number) => (
                    <tr key={i}><td>{r.name}</td><td>{r.id_card}</td><td>{r.status}</td><td>{r.dept ?? "—"}</td><td>{r.hired_at ?? "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details className="sq" open>
              <summary>取数路径与结构化查询</summary>
              <ol className="steps">
                {m.payload.path.map((p: string, i: number) => (
                  <li key={i}><span className="step-n">{i + 1}</span>{p}</li>
                ))}
              </ol>
              <pre className="code">{JSON.stringify(m.payload.structured_query, null, 2)}</pre>
              <div className="sq-log">query_log · 只存行数与路径</div>
              <pre className="code">{JSON.stringify(m.payload.query_log, null, 2)}</pre>
            </details>
          </div>
        )}

        {m.payload?.suggestions && (
          <div className="chips">
            {m.payload.suggestions.map((s: string) => (
              <span key={s} className="chip" onClick={() => onSubmit(s)}>{s}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Conversation({
  msgs, busy, onSubmit, onHero, inputHint, steps, onLocked, onOpenArtifact,
  onReplay,
}: {
  msgs: Msg[];
  busy: boolean;
  onSubmit: (t: string) => void;
  onHero: (key: string) => void;
  inputHint: string;
  steps: { key: string; name: string; state: string }[];
  onLocked: (name: string) => void;
  onOpenArtifact: (kind: string) => void;
  onReplay: () => void;
}) {
  const [text, setText] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, busy]);

  const send = () => {
    if (text.trim() && !busy) {
      onSubmit(text);
      setText("");
      taRef.current?.focus();
    }
  };

  return (
    <div className="chat-col">
      <div className="chat-head">
        <div className="title">Ontos 演示 <span>规则模拟 · LLM 驱动占位</span></div>
        <div className="spacer" />
        <button className="ghost sm" onClick={() => location.reload()}>重新开始</button>
      </div>
      <div className="chat-scroll">
        <div className="chat-stream">
          {msgs.map((m) => <Message key={m.id} m={m} onSubmit={onSubmit} onHero={onHero} steps={steps} onLocked={onLocked} onOpenArtifact={onOpenArtifact} onReplay={onReplay} />)}
          {busy && (
            <div className="row a"><div className="avatar">O</div><div className="bubble a typing"><i /><i /><i /></div></div>
          )}
          <div ref={endRef} />
        </div>
      </div>
      <div className="chat-input">
        <div className="input-card">
          <textarea
            ref={taRef}
            rows={2}
            placeholder={inputHint}
            value={text}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "/") {
                setText("");
                setMenuOpen(true);
                return;
              }
              setText(v);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="input-bar">
            <div className="cap-wrap">
              <button
                className="plus-btn"
                title="能力与概念"
                onClick={() => setMenuOpen(!menuOpen)}
              >
                <Plus size={14} weight="bold" />
              </button>
              {menuOpen && (
                <>
                  <div className="cap-overlay" onClick={() => setMenuOpen(false)} />
                  <div className="cap-menu">
                    {CAP_MENU.map((g) => (
                      <div key={g.group}>
                        <div className="cap-group">{g.group}</div>
                        {g.items.map((it) => {
                          const st = it.stepKey ? steps.find((s) => s.key === it.stepKey) : null;
                          const locked = st?.state === "locked";
                          return (
                            <button
                              key={it.label}
                              className={`cap-item ${locked ? "locked" : ""}`}
                              onClick={() => {
                                setMenuOpen(false);
                                if (locked && st) onLocked(st.name);
                                else onSubmit(it.say);
                              }}
                            >
                              <i>{locked ? <LockSimple size={13} /> : it.icon}</i>
                              {it.label}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
            <span className="mode">规则模拟 <CaretDown size={10} style={{ display: "inline", verticalAlign: "-1px" }} /></span>
            <div className="grow" />
            <button className="send-btn" onClick={send} disabled={busy || !text.trim()}><ArrowUp size={15} weight="bold" /></button>
          </div>
        </div>
      </div>
    </div>
  );
}
