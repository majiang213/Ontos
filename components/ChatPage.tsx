// 对话页 —— 纯对话页。问数走 /api/ask（罐头槽位，LLM 就位后替换）；
// 动作走 /api/action；取数路径融合在答案卡里。动作成功后自动再问一次，看状态变化。
"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight } from "@phosphor-icons/react";

interface Msg {
  role: "user" | "agent";
  text?: string;
  answer?: { query: Record<string, unknown>; rows: Record<string, unknown>[]; path: string[]; question?: string };
  actionResult?: { ok: boolean; error?: string; projections: { source: string; table: string; op: string; ok: boolean; error?: string; note?: string }[] };
}

interface SavedApi {
  id: number;
  name: string;
  question: string;
  query_json: string;
}

const SUGGESTED = ["在役设备及其所属部门", "还有多少在途设备", "哪些设备过保了", "每个部门多少台在役设备"];

export default function ChatPage() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sn, setSn] = useState("SN-40217");
  const [apis, setApis] = useState<SavedApi[]>([]);

  const loadApis = useCallback(async () => {
    const r = await fetch("/api/saved-queries");
    const data = await r.json();
    setApis(data.apis ?? []);
  }, []);
  useEffect(() => {
    void loadApis();
  }, [loadApis]);

  async function ask(question: string) {
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", text: question }]);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "失败");
      setMsgs((m) => [...m, { role: "agent", answer: { query: data.query, rows: data.rows, path: data.path, question } }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "agent", text: `出错了：${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setBusy(false);
    }
  }

  /** 跑台账里的已存 API：直接执行保存的结构化查询，不重新编译。 */
  async function runApi(api: SavedApi) {
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", text: `运行问数 API：${api.name}` }]);
    try {
      const r = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: api.query_json,
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "失败");
      setMsgs((m) => [...m, { role: "agent", answer: { query: JSON.parse(api.query_json), rows: data.rows, path: data.path, question: api.question } }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "agent", text: `出错了：${e instanceof Error ? e.message : String(e)}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function act(action: string, object: string, identity: string, request?: Record<string, unknown>) {
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", text: `${action} ${object} ${identity}` }]);
    try {
      const r = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, object, identity, request }),
      });
      const data = await r.json();
      setMsgs((m) => [...m, { role: "agent", actionResult: data }]);
      // 动作成功后自动再问一次，确认状态变化（问数始终读最新源库）
      const lastQ = [...msgs].reverse().find((x) => x.role === "user" && x.text && !x.text.includes(" "));
      if (data.ok && lastQ?.text) await ask(lastQ.text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-wrap">
      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        {msgs.length === 0 && (
          <div className="hint">
            问点什么，或对一台设备发起动作。
            <br />
            {SUGGESTED.join("；")}
          </div>
        )}
        {msgs.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="msg-user">{m.text}</div>
          ) : (
            <div key={i} className="msg-agent">
              {m.text && (
                <div className="bezel"><div className="bezel-core" style={{ padding: "10px 14px", fontSize: 14 }}>{m.text}</div></div>
              )}
              {m.answer && <AnswerCard a={m.answer} onSaved={loadApis} />}
              {m.actionResult && <ActionCard r={m.actionResult} />}
            </div>
          )
        )}
        {busy && <div style={{ color: "var(--ink-3)", fontSize: 13 }}>…</div>}
      </div>

      {/* 动作条 */}
      <div className="action-bar">
        <input className="text-in" style={{ flex: "0 0 150px", padding: "8px 14px", fontSize: 13 }} value={sn} onChange={(e) => setSn(e.target.value)} placeholder="序列号" />
        <button className="btn" onClick={() => act("convert", "equipment", sn)} disabled={busy}>验收</button>
        <button className="btn" onClick={() => act("transfer", "equipment", sn, { dept: "D07" })} disabled={busy}>调拨到 D07</button>
        <button className="btn" onClick={() => act("scrap", "equipment", sn)} disabled={busy}>报废</button>
      </div>

      {/* 输入条 */}
      <form
        className="input-line"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim() && !busy) {
            ask(input.trim());
            setInput("");
          }
        }}
      >
        <input className="text-in" value={input} onChange={(e) => setInput(e.target.value)} placeholder="问数：在役设备及其所属部门…" />
        <button type="submit" className="btn-cta" disabled={busy}>
          问
          <span className="ico"><ArrowUpRight size={14} weight="light" /></span>
        </button>
      </form>
      {/* 问数 API 台账：已保存的查询，点了直接重跑 */}
      {apis.length > 0 && (
        <div className="chips">
          {apis.map((a) => (
            <button key={a.id} className="chip" title={a.question} onClick={() => !busy && runApi(a)}>
              {a.name}
            </button>
          ))}
        </div>
      )}
      <div className="chips">
        {SUGGESTED.map((s) => (
          <button key={s} className="chip" onClick={() => !busy && ask(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function AnswerCard({ a, onSaved }: { a: NonNullable<Msg["answer"]>; onSaved: () => void }) {
  const [saveName, setSaveName] = useState("");
  const [saved, setSaved] = useState(false);
  const cols = a.rows.length ? Object.keys(a.rows[0]).filter((c) => !Array.isArray(a.rows[0][c])) : [];
  const expandCols = a.rows.length ? Object.keys(a.rows[0]).filter((c) => Array.isArray(a.rows[0][c])) : [];
  return (
    <div className="bezel">
      <div className="bezel-core" style={{ padding: 14 }}>
        <div className="answer-head">共 {a.rows.length} 条</div>
        {cols.length > 0 && (
          <table className="answer-table">
            <thead>
              <tr>{cols.concat(expandCols).map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {a.rows.slice(0, 20).map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => <td key={c}>{String(r[c] ?? "—")}</td>)}
                  {expandCols.map((c) => (
                    <td key={c} style={{ color: "var(--ink-2)" }}>
                      {(r[c] as Record<string, unknown>[]).map((x) => Object.values(x).join("")).join("、") || "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
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
        {/* 存为问数 API：命名保存这条结构化查询，进台账可复用 */}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!saveName.trim()) return;
            await fetch("/api/saved-queries", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name: saveName.trim(), question: a.question ?? "", query: a.query }),
            });
            setSaved(true);
            onSaved();
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
        </form>
      </div>
    </div>
  );
}

function ActionCard({ r }: { r: NonNullable<Msg["actionResult"]> }) {
  return (
    <div className="bezel">
      <div className="bezel-core" style={{ padding: 14 }}>
        <div className="answer-head" style={{ color: r.ok ? "var(--ok)" : "var(--danger)" }}>
          {r.ok ? "完成" : `未完成：${r.error ?? "部分投影失败"}`}
        </div>
        {r.projections.map((p, i) => (
          <div key={i} style={{ fontSize: 12, lineHeight: 1.9, color: p.ok ? "var(--ink-2)" : "var(--danger)" }}>
            {p.ok ? "✓" : "✗"} {p.source}.{p.table} {p.op}
            {p.note ? `（${p.note}）` : ""}
            {p.error ? `（${p.error}）` : ""}
          </div>
        ))}
      </div>
    </div>
  );
}
