// 对话页 —— 纯对话页。问数走 /api/ask（罐头槽位，LLM 就位后替换）；
// 动作走 /api/action；取数路径融合在答案卡里。动作成功后自动再问一次，看状态变化。
// 会话模型在 sessionStore.ts（React 之外）：本页只订阅与渲染。切空间时本页整体重挂，store 按新空间的键重建。
"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { apiGet, apiPost, getWs } from "./wsClient";
import { SessionStore, type Msg } from "./sessionStore";
import { ArrowUpRight } from "@phosphor-icons/react";

interface SavedApi {
  id: number;
  name: string;
  question: string;
  query_json: string;
}

const SUGGESTED = ["在役设备及其所属部门", "还有多少在途设备", "哪些设备过保了", "每个部门多少台在役设备"];

export default function ChatPage() {
  const [store] = useState(() => new SessionStore(getWs()));
  const sessions = useSyncExternalStore(store.subscribe, store.getSessions, store.getSessions);
  const curId = useSyncExternalStore(store.subscribe, store.getCurId, store.getCurId);
  useEffect(() => store.init(), [store]); // 挂载后从 localStorage 读回（只在客户端）
  const msgs = useMemo(() => sessions.find((s) => s.id === curId)?.msgs ?? [], [sessions, curId]);

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sn, setSn] = useState("SN-40217");
  const [actOpen, setActOpen] = useState(false); // 动作区默认收起：演示剧本不抢主视觉
  const [apis, setApis] = useState<SavedApi[]>([]);
  const listRef = useRef<HTMLDivElement>(null);

  // 新消息滚到底：答案卡很高，不滚用户以为没响应；切会话也滚
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, busy, curId]);

  const loadApis = useCallback(async () => {
    try {
      const data = await apiGet<{ apis?: SavedApi[] }>("/api/saved-queries");
      setApis(data.apis ?? []);
    } catch {
      // 台账读不到不挡对话
    }
  }, []);
  useEffect(() => {
    void loadApis();
  }, [loadApis]);

  async function ask(question: string) {
    store.lastQuestion = question;
    const sid = store.ensureSession(question);
    setBusy(true);
    store.append(sid, { role: "user", text: question });
    try {
      const data = await apiPost<{ query: Record<string, unknown>; rows: Record<string, unknown>[]; path: string[] }>("/api/ask", { question });
      store.append(sid, { role: "agent", answer: { query: data.query, rows: data.rows, path: data.path, question } });
    } catch (e) {
      store.append(sid, { role: "agent", text: `出错了：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  /** 跑台账里的已存 API：直接执行保存的结构化查询，不重新编译。 */
  async function runApi(api: SavedApi) {
    store.lastQuestion = api.question; // 台账问题也算「上一条问题」，动作后的复查看它
    const sid = store.ensureSession(api.name);
    setBusy(true);
    store.append(sid, { role: "user", text: `运行问数 API：${api.name}` });
    try {
      const data = await apiPost<{ rows: Record<string, unknown>[]; path: string[] }>("/api/query", api.query_json);
      store.append(sid, { role: "agent", answer: { query: JSON.parse(api.query_json), rows: data.rows, path: data.path, question: api.question } });
    } catch (e) {
      store.append(sid, { role: "agent", text: `出错了：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function act(action: string, object: string, identity: string, request?: Record<string, unknown>) {
    const sid = store.ensureSession(`${action} ${identity}`);
    setBusy(true);
    store.append(sid, { role: "user", text: `${action} ${object} ${identity}` });
    try {
      const data = await apiPost<{ ok: boolean; error?: string; projections?: NonNullable<Msg["actionResult"]>["projections"] }>("/api/action", { action, object, identity, request });
      store.append(sid, {
        role: "agent",
        actionResult: { ok: Boolean(data.ok), error: data.error, projections: data.projections ?? [] }, // 兜底空数组，渲染不崩
      });
      // 动作成功后自动再问一次（用记下的上一条问题，不从消息列表反推）
      if (data.ok && store.lastQuestion) await ask(store.lastQuestion);
    } catch (e) {
      store.append(sid, { role: "agent", text: `出错了：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  /** 输入组合区：动作区 + 问数 API 台账 + 输入卡。空态时收进 hero（对话框在上，同 Claude）；有消息后沉到底部。 */
  const renderComposer = () => (
    <>
      {/* 动作区（点开才展开）；绑的是种子本体的演示剧本，通用形态是外部 Agent 经 MCP 发动作 */}
      {actOpen && (
        <div className="bezel" style={{ marginBottom: 10 }}>
          <div className="bezel-core" style={{ padding: 12, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--ink-2)" }}>对序列号</span>
            <input className="text-in" style={{ width: 140, padding: "6px 12px", fontSize: 13 }} value={sn} onChange={(e) => setSn(e.target.value)} placeholder="SN-40217" />
            <span style={{ fontSize: 12, color: "var(--ink-3)" }}>发起动作：</span>
            <button className="btn" onClick={() => act("convert", "equipment", sn)} disabled={busy}>验收</button>
            <button className="btn" onClick={() => act("transfer", "equipment", sn, { dept: "D07" })} disabled={busy}>调拨到 D07</button>
            <button className="btn" onClick={() => act("scrap", "equipment", sn)} disabled={busy}>报废</button>
            <button className="chip" aria-label="收起" style={{ marginLeft: "auto" }} onClick={() => setActOpen(false)}>收起</button>
          </div>
        </div>
      )}
      {/* 问数 API 台账：已保存的查询，点了直接重跑 */}
      {apis.length > 0 && (
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
          <span style={{ fontSize: 11, color: "var(--ink-3)" }}>问数 API：</span>
          {apis.map((a) => (
            <button key={a.id} className="chip" title={a.question} onClick={() => !busy && runApi(a)}>
              {a.name}
            </button>
          ))}
        </div>
      )}
      {/* 输入卡：输入区 + 底部工具条（动作开关在左，发送在右） */}
      <form
        className="bezel"
        style={{ flexShrink: 0, borderColor: "var(--line-strong)" }}
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim() && !busy) {
            ask(input.trim());
            setInput("");
          }
        }}
      >
        <div className="bezel-core" style={{ padding: "12px 14px 8px" }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="问数：在役设备及其所属部门…"
            rows={3}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault(); // 回车发送，Shift+回车换行
                if (input.trim() && !busy) {
                  ask(input.trim());
                  setInput("");
                }
              }
            }}
            style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontSize: 14, color: "var(--ink)", padding: "2px 0 10px", resize: "none", lineHeight: 1.7, fontFamily: "inherit", display: "block" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid var(--hairline-strong)", paddingTop: 8 }}>
            <button type="button" className="chip" onClick={() => setActOpen((v) => !v)}>
              ⚡ 对设备发起动作
            </button>
            <span style={{ flex: 1 }} />
            <button type="submit" className="btn-cta" aria-label="发送" disabled={busy}>
              <span className="ico"><ArrowUpRight size={14} weight="light" /></span>
            </button>
          </div>
        </div>
      </form>
    </>
  );

  const renderSessionList = () => (
    <>
      <button className="btn" style={{ justifyContent: "center", marginBottom: 12 }} onClick={() => store.newSession()}>＋ 新建会话</button>
      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => store.select(s.id)}
            style={{
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 8,
              cursor: "pointer",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 4,
              background: s.id === curId ? "var(--accent-soft)" : "transparent",
              color: s.id === curId ? "var(--accent-ink)" : "var(--ink-2)",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.title}</span>
            <button
              aria-label="删除会话"
              style={{ border: "none", background: "none", color: "var(--ink-3)", cursor: "pointer", padding: 0, fontSize: 12 }}
              onClick={(e) => {
                e.stopPropagation();
                store.removeSession(s.id);
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </>
  );

  return (
    <div className="chat-wrap">
      {/* 左侧会话栏常驻、占文档流：窗口变窄时主区自然收窄，永不折叠成弹层 */}
      <aside className="chat-aside">
        {renderSessionList()}
      </aside>

      {/* 主区：消息流 + 底部输入卡（阅读列在主区内居中，宽度随窗口伸缩） */}
      <div className="chat-main">
        <div style={{ width: "100%", maxWidth: 820, margin: "0 auto", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div ref={listRef} style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
          {msgs.length === 0 && (
            /* 空态 = 引导：标题 + 输入卡 + 示例问题（同 Claude：对话框在上方居中，不沉底） */
            <div style={{ margin: "auto", width: "100%", textAlign: "center" }}>
              <div style={{ fontFamily: "var(--font-serif)", fontSize: 24, color: "var(--ink)", marginBottom: 8 }}>问数据，或对设备发起动作</div>
              <div style={{ fontSize: 13, color: "var(--ink-3)", marginBottom: 24 }}>回答永远是源库里的真数据，附取数路径。</div>
              <div style={{ textAlign: "left" }}>{renderComposer()}</div>
              <div className="chat-suggest">
                {SUGGESTED.map((s) => (
                  <button
                    key={s}
                    style={{
                      cursor: "pointer",
                      textAlign: "left",
                      padding: "12px 14px",
                      borderRadius: 12,
                      background: "var(--panel)",
                      border: "1px solid var(--line-strong)",
                      fontSize: 13,
                      color: "var(--ink-2)",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: 8,
                    }}
                    onClick={() => !busy && ask(s)}
                  >
                    {s}
                    <ArrowUpRight size={14} weight="light" />
                  </button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) =>
            m.role === "user" ? (
              <div key={`${curId}-${i}`} className="msg-user">{m.text}</div>
            ) : (
              <div key={`${curId}-${i}`} className="msg-agent" style={m.answer || m.actionResult ? { width: "100%", minWidth: 0 } : undefined}>
                {m.text && <div style={{ fontSize: 14, lineHeight: 1.8, color: "var(--ink-2)", padding: "2px 4px" }}>{m.text}</div>}
                {m.answer && <AnswerCard a={m.answer} onSaved={loadApis} />}
                {m.actionResult && <ActionCard r={m.actionResult} />}
              </div>
            )
          )}
          {busy && <div style={{ color: "var(--ink-3)", fontSize: 13 }}>查着呢…</div>}
        </div>

        {/* 有消息后输入区沉到底部 */}
        {msgs.length > 0 && renderComposer()}
        </div>
      </div>
    </div>
  );
}

function AnswerCard({ a, onSaved }: { a: NonNullable<Msg["answer"]>; onSaved: () => void }) {
  const [saveName, setSaveName] = useState("");
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 列取所有行的并集：稀疏行不丢列；展开列按「任一行的值是数组」认。
  // 值全为空的列直接跳过——旧版本答案里可能留着这种键：看不见内容却把表格顶宽
  const allKeys = [...new Set(a.rows.flatMap((r) => Object.keys(r)))].filter((c) => a.rows.some((r) => r[c] !== undefined && r[c] !== null && r[c] !== ""));
  const cols = allKeys.filter((c) => !a.rows.some((r) => Array.isArray(r[c])));
  const expandCols = allKeys.filter((c) => a.rows.some((r) => Array.isArray(r[c])));
  return (
    <div className="bezel">
      <div className="bezel-core" style={{ padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
          <div className="answer-head" style={{ marginBottom: 0 }}>共 {a.total ?? a.rows.length} 条</div>
          {a.question && <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{a.question}</div>}
        </div>
        {cols.length > 0 && (
          <div style={{ maxHeight: 320, overflow: "auto", borderRadius: 8, border: "2px solid var(--line-strong)" }}>
            <table className="answer-table" style={{ width: "100%" }}>
              <thead style={{ position: "sticky", top: 0, background: "var(--panel)" }}>
                <tr>{cols.concat(expandCols).map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {a.rows.slice(0, 20).map((r, i) => (
                  <tr key={i}>
                    {cols.map((c) => <td key={c}>{String(r[c] ?? "—")}</td>)}
                    {expandCols.map((c) => (
                      <td key={c} style={{ color: "var(--ink-2)" }}>
                        {((r[c] as Record<string, unknown>[] | undefined) ?? []).map((x) => Object.values(x).join(" · ")).join("、") || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {a.rows.length > 20 && <div style={{ color: "var(--ink-3)", marginTop: 6, fontSize: 12 }}>只列前 20 条</div>}
        <details className="fold">
          <summary>取数路径</summary>
          <div className="fold-body">
            <ol style={{ margin: 0, paddingLeft: 18 }}>
              {a.path.map((p, i) => <li key={i}>{p}</li>)}
            </ol>
          </div>
        </details>
        <details className="fold">
          <summary>结构化查询</summary>
          <div className="fold-body mono-block">{JSON.stringify(a.query, null, 2)}</div>
        </details>
        {/* 存为问数 API：命名保存这条结构化查询，进台账可复用。失败卡内留错，名字不丢 */}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!saveName.trim()) return;
            setSaveError(null);
            try {
              await apiPost("/api/saved-queries", { name: saveName.trim(), question: a.question ?? "", query: a.query });
              setSaved(true);
              onSaved();
            } catch (err) {
              setSaveError(err instanceof Error ? err.message : String(err));
            }
          }}
          style={{ display: "flex", gap: 6, marginTop: 10, alignItems: "center" }}
        >
          <input
            className="text-in"
            style={{ fontSize: 12, padding: "5px 10px", width: 180 }}
            placeholder="命名这条查询（如：在役设备台账）"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
          />
          <button type="submit" className="chip" disabled={saved}>
            {saved ? "已存" : "存为问数 API"}
          </button>
          {saveError && <span style={{ fontSize: 12, color: "var(--danger)" }}>{saveError}</span>}
        </form>
      </div>
    </div>
  );
}

/** 投影操作的白话名（引擎的 op 是 insert/update/delete，不上屏）。 */
function opLabel(op: string): string {
  return op === "insert" ? "插入" : op === "update" ? "更新" : op === "delete" ? "删除" : op;
}

function ActionCard({ r }: { r: NonNullable<Msg["actionResult"]> }) {
  return (
    <div className="bezel">
      <div className="bezel-core" style={{ padding: 14 }}>
        <div className="answer-head" style={{ color: r.ok ? "var(--ok)" : "var(--danger)" }}>
          {r.ok ? "完成" : `未完成：${r.error ?? "部分来源没写成"}`}
        </div>
        {r.projections.map((p, i) => (
          <div key={i} style={{ fontSize: 12, lineHeight: 1.9, color: p.ok ? "var(--ink-2)" : "var(--danger)" }}>
            {p.ok ? "✓" : "✗"} {p.source}.{p.table} {opLabel(p.op)}
            {p.note ? `（${p.note}）` : ""}
            {p.error ? `（${p.error}）` : ""}
          </div>
        ))}
      </div>
    </div>
  );
}
