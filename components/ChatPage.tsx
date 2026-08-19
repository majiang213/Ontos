// 对话页 —— 纯对话页。问数走 /api/ask（罐头槽位，LLM 就位后替换）；
// 动作走 /api/action；取数路径融合在答案卡里。动作成功后自动再问一次，看状态变化。
// 侧栏有会话列表（可新建），会话存 localStorage，切页不丢。
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiUrl, getWs } from "./wsClient";
import { ArrowUpRight } from "@phosphor-icons/react";

interface Msg {
  role: "user" | "agent";
  text?: string;
  answer?: { query: Record<string, unknown>; rows: Record<string, unknown>[]; path: string[]; question?: string; total?: number }; // total：裁剪持久化前的真实总数
  actionResult?: { ok: boolean; error?: string; projections: { source: string; table: string; op: string; ok: boolean; error?: string; note?: string }[] };
}

interface Session {
  id: string;
  title: string;
  msgs: Msg[];
}

interface SavedApi {
  id: number;
  name: string;
  question: string;
  query_json: string;
}

const SUGGESTED = ["在役设备及其所属部门", "还有多少在途设备", "哪些设备过保了", "每个部门多少台在役设备"];
// 对话历史按工作空间分键：切空间互不可见（切空间时本页整体重挂，挂载时取的是新空间的键）
const storeKey = () => `ontos-chat-sessions:${getWs()}`;

export default function ChatPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [curId, setCurId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sn, setSn] = useState("SN-40217");
  const [actOpen, setActOpen] = useState(false); // 动作区默认收起：演示剧本不抢主视觉
  const [apis, setApis] = useState<SavedApi[]>([]);
  const lastQuestion = useRef<string | null>(null); // 动作成功后的复查用，不从消息列表反推
  const listRef = useRef<HTMLDivElement>(null);
  const curIdRef = useRef<string | null>(null); // 闭包外读当前会话：删光再开时动作与复查不落两个会话

  // 会话从 localStorage 读回（刷新不丢）
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storeKey());
      if (raw) {
        const s = (JSON.parse(raw) as unknown[]).filter(
          (x): x is Session => Boolean(x) && typeof (x as Session).id === "string" && Array.isArray((x as Session).msgs)
        );
        setSessions(s);
        if (s.length) setCurId(s[0].id);
      }
    } catch {
      // 坏数据当没有
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    curIdRef.current = curId;
  }, [curId]);
  useEffect(() => {
    if (!loaded) return;
    try {
      // 结果集不长久留存（数据边界）：答案卡只留前 20 行做回看，完整数据永远在源库现查
      const trimmed = sessions.map((s) => ({
        ...s,
        msgs: s.msgs.map((m) => (m.answer ? { ...m, answer: { ...m.answer, total: m.answer.total ?? m.answer.rows.length, rows: m.answer.rows.slice(0, 20) } } : m)),
      }));
      localStorage.setItem(storeKey(), JSON.stringify(trimmed));
    } catch {
      // 配额满了不挡对话
    }
  }, [sessions, loaded]);

  const msgs = sessions.find((s) => s.id === curId)?.msgs ?? [];

  // 新消息滚到底：答案卡很高，不滚用户以为没响应；切会话也滚
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs.length, busy, curId]);

  const loadApis = useCallback(async () => {
    try {
      const r = await fetch(apiUrl("/api/saved-queries"));
      const data = await r.json();
      setApis(data.apis ?? []);
    } catch {
      // 台账读不到不挡对话
    }
  }, []);
  useEffect(() => {
    void loadApis();
  }, [loadApis]);

  /** 没有会话就先开一个（标题取第一句问的话）。读 ref 不读闭包——append 是函数式更新，不依赖渲染时序。 */
  const ensureSession = (titleSeed: string): string => {
    if (curIdRef.current) return curIdRef.current;
    const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setSessions((ss) => [{ id, title: titleSeed.slice(0, 24), msgs: [] }, ...ss]);
    setCurId(id);
    curIdRef.current = id;
    return id;
  };
  const append = (sid: string, m: Msg) => {
    setSessions((ss) => ss.map((s) => (s.id === sid ? { ...s, msgs: [...s.msgs, m] } : s)));
  };
  const newSession = () => {
    const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    setSessions((ss) => [{ id, title: "新会话", msgs: [] }, ...ss]);
    setCurId(id);
  };
  const removeSession = (sid: string) => {
    setSessions((ss) => {
      const rest = ss.filter((s) => s.id !== sid);
      if (curId === sid) setCurId(rest[0]?.id ?? null);
      return rest;
    });
  };

  async function ask(question: string) {
    lastQuestion.current = question;
    const sid = ensureSession(question);
    setBusy(true);
    append(sid, { role: "user", text: question });
    try {
      const r = await fetch(apiUrl("/api/ask"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "失败");
      append(sid, { role: "agent", answer: { query: data.query, rows: data.rows, path: data.path, question } });
    } catch (e) {
      append(sid, { role: "agent", text: `出错了：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  /** 跑台账里的已存 API：直接执行保存的结构化查询，不重新编译。 */
  async function runApi(api: SavedApi) {
    lastQuestion.current = api.question; // 台账问题也算「上一条问题」，动作后的复查看它
    const sid = ensureSession(api.name);
    setBusy(true);
    append(sid, { role: "user", text: `运行问数 API：${api.name}` });
    try {
      const r = await fetch(apiUrl("/api/query"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: api.query_json,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "失败");
      append(sid, { role: "agent", answer: { query: JSON.parse(api.query_json), rows: data.rows, path: data.path, question: api.question } });
    } catch (e) {
      append(sid, { role: "agent", text: `出错了：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  async function act(action: string, object: string, identity: string, request?: Record<string, unknown>) {
    const sid = ensureSession(`${action} ${identity}`);
    setBusy(true);
    append(sid, { role: "user", text: `${action} ${object} ${identity}` });
    try {
      const r = await fetch(apiUrl("/api/action"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, object, identity, request }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? data.detail ?? "失败");
      append(sid, {
        role: "agent",
        actionResult: { ok: Boolean(data.ok), error: data.error, projections: data.projections ?? [] }, // 兜底空数组，渲染不崩
      });
      // 动作成功后自动再问一次（用记下的上一条问题，不从消息列表反推）
      if (data.ok && lastQuestion.current) await ask(lastQuestion.current);
    } catch (e) {
      append(sid, { role: "agent", text: `出错了：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-wrap" style={{ display: "flex", flexDirection: "row" }}>
      {/* 左侧会话栏（常驻）：新建按钮在上，历史列表在下 */}
      <aside style={{ width: 216, flexShrink: 0, borderRight: "1px solid var(--hairline)", display: "flex", flexDirection: "column", padding: "78px 10px 12px 20px" }}>
        <button className="btn" style={{ justifyContent: "center", marginBottom: 12 }} onClick={newSession}>＋ 新建会话</button>
        <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
          {sessions.map((s) => (
            <div
              key={s.id}
              onClick={() => setCurId(s.id)}
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
                  removeSession(s.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </aside>

      {/* 主区：消息流 + 底部输入卡（内容居中成阅读列，不通栏） */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, padding: "78px 24px 12px" }}>
        <div style={{ width: "100%", maxWidth: 820, margin: "0 auto", flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div ref={listRef} style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 14 }}>
          {msgs.length === 0 && (
            /* 空态 = 引导：一句话说明 + 四个示例问题卡（点了直接问） */
            <div style={{ margin: "10vh auto 0", maxWidth: 520, textAlign: "center" }}>
              <div style={{ fontFamily: "var(--font-serif)", fontSize: 24, color: "var(--ink)", marginBottom: 8 }}>问数据，或对设备发起动作</div>
              <div style={{ fontSize: 13, color: "var(--ink-3)", marginBottom: 24 }}>回答永远是源库里的真数据，附取数路径。</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {SUGGESTED.map((s) => (
                  <button
                    key={s}
                    style={{
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                      padding: "12px 14px",
                      borderRadius: 12,
                      background: "var(--panel)",
                      boxShadow: "0 0 0 1px var(--hairline-strong)",
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
              <div key={`${curId}-${i}`} className="msg-agent" style={m.answer || m.actionResult ? { width: "100%" } : undefined}>
                {m.text && <div style={{ fontSize: 14, lineHeight: 1.8, color: "var(--ink-2)", padding: "2px 4px" }}>{m.text}</div>}
                {m.answer && <AnswerCard a={m.answer} onSaved={loadApis} />}
                {m.actionResult && <ActionCard r={m.actionResult} />}
              </div>
            )
          )}
          {busy && <div style={{ color: "var(--ink-3)", fontSize: 13 }}>查着呢…</div>}
        </div>

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
          style={{ flexShrink: 0, boxShadow: "0 0 0 1px var(--hairline-strong), var(--shadow-soft)" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim() && !busy) {
              ask(input.trim());
              setInput("");
            }
          }}
        >
          <div className="bezel-core" style={{ padding: "12px 14px 8px" }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="问数：在役设备及其所属部门…"
              style={{ width: "100%", border: "none", outline: "none", background: "transparent", fontSize: 14, color: "var(--ink)", padding: "2px 0 10px" }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid var(--hairline)", paddingTop: 8 }}>
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
        </div>
      </div>
    </div>
  );
}

function AnswerCard({ a, onSaved }: { a: NonNullable<Msg["answer"]>; onSaved: () => void }) {
  const [saveName, setSaveName] = useState("");
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 列取所有行的并集：稀疏行不丢列；展开列按「任一行的值是数组」认
  const allKeys = [...new Set(a.rows.flatMap((r) => Object.keys(r)))];
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
          <div style={{ maxHeight: 320, overflow: "auto", borderRadius: 8, boxShadow: "0 0 0 1px var(--hairline-strong)" }}>
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
              const r = await fetch(apiUrl("/api/saved-queries"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: saveName.trim(), question: a.question ?? "", query: a.query }),
              });
              const data = await r.json();
              if (r.ok) {
                setSaved(true);
                onSaved();
              } else {
                setSaveError(data.error ?? "保存失败");
              }
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
