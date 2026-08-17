// 对话页 —— 纯对话页。问数走 /api/ask（罐头槽位，LLM 就位后替换）；
// 动作走 /api/action；取数路径融合在答案卡里。动作成功后自动再问一次，看状态变化。
"use client";

import { useState } from "react";

interface Msg {
  role: "user" | "agent";
  text?: string;
  answer?: { query: Record<string, unknown>; rows: Record<string, unknown>[]; path: string[] };
  actionResult?: { ok: boolean; error?: string; projections: { source: string; table: string; op: string; ok: boolean; error?: string; note?: string }[] };
}

const SUGGESTED = ["在役设备及其所属部门", "还有多少在途设备", "哪些设备过保了", "每个部门多少台在役设备"];

const panel: React.CSSProperties = {
  background: "var(--panel)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius)",
  boxShadow: "var(--shadow-sm)",
};

export default function ChatPage() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [sn, setSn] = useState("SN-40217");

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
      setMsgs((m) => [...m, { role: "agent", answer: { query: data.query, rows: data.rows, path: data.path } }]);
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
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", maxWidth: 860, margin: "0 auto", width: "100%", padding: 16 }}>
      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
        {msgs.length === 0 && (
          <div style={{ color: "var(--ink-3)", fontSize: 13, textAlign: "center", marginTop: 80 }}>
            问点什么，或对一台设备发起动作。建议：{SUGGESTED.join("；")}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "92%" }}>
            {m.role === "user" && (
              <div style={{ ...panel, padding: "8px 14px", background: "var(--accent-soft)", fontSize: 14 }}>{m.text}</div>
            )}
            {m.role === "agent" && m.text && <div style={{ ...panel, padding: "10px 14px", fontSize: 14 }}>{m.text}</div>}
            {m.role === "agent" && m.answer && <AnswerCard a={m.answer} />}
            {m.role === "agent" && m.actionResult && <ActionCard r={m.actionResult} />}
          </div>
        ))}
        {busy && <div style={{ color: "var(--ink-3)", fontSize: 13 }}>…</div>}
      </div>

      {/* 动作条 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0", flexWrap: "wrap" }}>
        <input value={sn} onChange={(e) => setSn(e.target.value)} style={{ ...panel, padding: "6px 10px", fontSize: 13, width: 140 }} placeholder="序列号" />
        <ActBtn label="验收" onClick={() => act("convert", "equipment", sn)} disabled={busy} />
        <ActBtn label="调拨到 D07" onClick={() => act("transfer", "equipment", sn, { dept: "D07" })} disabled={busy} />
        <ActBtn label="报废" onClick={() => act("scrap", "equipment", sn)} disabled={busy} />
      </div>

      {/* 输入条 */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim() && !busy) {
            ask(input.trim());
            setInput("");
          }
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="问数：在役设备及其所属部门…"
          style={{ ...panel, flex: 1, padding: "10px 14px", fontSize: 14 }}
        />
        <button type="submit" disabled={busy} style={{ ...panel, padding: "10px 20px", background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer" }}>
          问
        </button>
      </form>
      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        {SUGGESTED.map((s) => (
          <button key={s} onClick={() => !busy && ask(s)} style={{ ...panel, padding: "4px 10px", fontSize: 12, cursor: "pointer", color: "var(--ink-2)" }}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function ActBtn({ label, onClick, disabled }: { label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ ...panel, padding: "6px 14px", fontSize: 13, cursor: "pointer", color: "var(--ink)" }}>
      {label}
    </button>
  );
}

function AnswerCard({ a }: { a: NonNullable<Msg["answer"]> }) {
  const cols = a.rows.length ? Object.keys(a.rows[0]).filter((c) => !Array.isArray(a.rows[0][c])) : [];
  const expandCols = a.rows.length ? Object.keys(a.rows[0]).filter((c) => Array.isArray(a.rows[0][c])) : [];
  return (
    <div style={{ ...panel, padding: 14, fontSize: 13 }}>
      <div style={{ marginBottom: 8, color: "var(--ink-2)" }}>共 {a.rows.length} 条</div>
      {cols.length > 0 && (
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr>
              {cols.concat(expandCols).map((c) => (
                <th key={c} style={{ textAlign: "left", borderBottom: "1px solid var(--border-strong)", padding: "4px 8px", color: "var(--ink-3)", fontWeight: 500 }}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {a.rows.slice(0, 20).map((r, i) => (
              <tr key={i}>
                {cols.map((c) => (
                  <td key={c} style={{ borderBottom: "1px solid var(--border)", padding: "4px 8px" }}>{String(r[c] ?? "—")}</td>
                ))}
                {expandCols.map((c) => (
                  <td key={c} style={{ borderBottom: "1px solid var(--border)", padding: "4px 8px", color: "var(--ink-2)" }}>
                    {(r[c] as Record<string, unknown>[]).map((x) => Object.values(x).join("")).join("、") || "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {a.rows.length > 20 && <div style={{ color: "var(--ink-3)", marginTop: 6 }}>只列前 20 条</div>}
      <details style={{ marginTop: 10 }}>
        <summary style={{ cursor: "pointer", color: "var(--ink-2)" }}>取数路径</summary>
        <ol style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--ink-2)", fontSize: 12, lineHeight: 1.8 }}>
          {a.path.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ol>
      </details>
      <details style={{ marginTop: 6 }}>
        <summary style={{ cursor: "pointer", color: "var(--ink-3)", fontSize: 12 }}>结构化查询</summary>
        <pre style={{ fontSize: 11, background: "var(--bg)", padding: 8, borderRadius: 8, overflow: "auto" }}>{JSON.stringify(a.query, null, 2)}</pre>
      </details>
    </div>
  );
}

function ActionCard({ r }: { r: NonNullable<Msg["actionResult"]> }) {
  return (
    <div style={{ ...panel, padding: 14, fontSize: 13 }}>
      <div style={{ marginBottom: 8, color: r.ok ? "var(--ok)" : "var(--danger)" }}>{r.ok ? "完成" : `未完成：${r.error ?? "部分投影失败"}`}</div>
      {r.projections.map((p, i) => (
        <div key={i} style={{ fontSize: 12, lineHeight: 1.8, color: p.ok ? "var(--ink-2)" : "var(--danger)" }}>
          {p.ok ? "✓" : "✗"} {p.source}.{p.table} {p.op}
          {p.note ? `（${p.note}）` : ""}
          {p.error ? `（${p.error}）` : ""}
        </div>
      ))}
    </div>
  );
}
