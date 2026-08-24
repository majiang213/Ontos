// 画布页的小表单组件：新建对象、连线、连接数据源（同一消费者 CanvasPage）。
// 字段表单与小节壳已随消费者搬走（cards/FieldForm.tsx，ObjectCard 配套）；全是自包含展示组件，只靠窄回调 props 通信。
"use client";

import { useState } from "react";
import { apiPost } from "../wsClient";

export function CreateForm({ onSubmit, onCancel }: { onSubmit: (name: string, description: string, kind: "thing" | "event") => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"thing" | "event">("thing");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit(name.trim(), description.trim(), kind);
      }}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <input className="text-in" style={{ fontSize: 13, padding: "8px 12px" }} placeholder="对象名（小写，如 vendor）" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="text-in" style={{ fontSize: 13, padding: "8px 12px" }} placeholder="一句话说明（可选）" value={description} onChange={(e) => setDescription(e.target.value)} />
      <select className="ctl" value={kind} onChange={(e) => setKind(e.target.value as "thing" | "event")} style={{ fontSize: 13 }}>
        <option value="thing">事物（可持续存在）</option>
        <option value="event">事件（发生过即确定）</option>
      </select>
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button type="submit" className="btn-cta" style={{ fontSize: 13, padding: "6px 16px" }}>加入画布</button>
        <button type="button" className="btn" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}

/** 连线表单：关系名/反向名/基数 + 配对字段（默认两边识别字段）。 */
export function LinkForm({ from, to, objects, onSubmit, onCancel }: { from: string; to: string; objects: Record<string, any>; onSubmit: (body: Record<string, unknown>) => void; onCancel: () => void }) {
  const fromProps = Object.keys(objects[from]?.properties ?? {});
  const toProps = Object.keys(objects[to]?.properties ?? {});
  const idOf = (c: string) => objects[c]?.identity;
  const [name, setName] = useState(`${from}_${to}`);
  const [inverse, setInverse] = useState("");
  const [card, setCard] = useState("");
  const [description, setDescription] = useState("");
  const [matchFrom, setMatchFrom] = useState(idOf(from) ?? fromProps[0] ?? "");
  const [matchTo, setMatchTo] = useState(idOf(to) ?? toProps[0] ?? "");
  const selStyle: React.CSSProperties = { fontSize: 12, padding: "4px 8px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--panel)" };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !matchFrom || !matchTo) return;
        onSubmit({
          op: "create_link",
          name: name.trim(),
          from,
          to,
          inverse: inverse.trim() || undefined,
          card: card || undefined,
          description: description.trim() || undefined,
          match: { from: matchFrom, to: matchTo },
        });
      }}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <input className="text-in" style={{ fontSize: 13, padding: "8px 12px" }} placeholder="关系名（小写，如 belongs_to）" value={name} onChange={(e) => setName(e.target.value)} />
      <input className="text-in" style={{ fontSize: 13, padding: "8px 12px" }} placeholder="反向名（可选，如 has_equipment）" value={inverse} onChange={(e) => setInverse(e.target.value)} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "var(--ink-2)" }}>
        <span>配对字段</span>
        <select value={matchFrom} onChange={(e) => setMatchFrom(e.target.value)} style={selStyle}>
          {fromProps.map((p) => (
            <option key={p} value={p}>{from}.{p}</option>
          ))}
        </select>
        <span style={{ color: "var(--ink-3)" }}>↔</span>
        <select value={matchTo} onChange={(e) => setMatchTo(e.target.value)} style={selStyle}>
          {toProps.map((p) => (
            <option key={p} value={p}>{to}.{p}</option>
          ))}
        </select>
      </div>
      <select value={card} onChange={(e) => setCard(e.target.value)} style={selStyle}>
        <option value="">基数（可选）</option>
        <option value="1:1">1:1</option>
        <option value="1:n">1:n（一对多）</option>
        <option value="n:1">n:1（多对一）</option>
        <option value="n:n">n:n（多对多）</option>
      </select>
      <input className="text-in" style={{ fontSize: 13, padding: "8px 12px" }} placeholder="一句话说明（可选）" value={description} onChange={(e) => setDescription(e.target.value)} />
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button type="submit" className="btn-cta" style={{ fontSize: 13, padding: "6px 16px" }}>建好进草稿</button>
        <button type="button" className="btn" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}

export function ConnectForm({ onDone, onCancel }: { onDone: (msg: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"sqlite" | "mysql" | "pg">("sqlite");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [dbName, setDbName] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputStyle: React.CSSProperties = { fontSize: 13, padding: "8px 12px" };
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || busy) return;
        setBusy(true);
        setError(null);
        try {
          const data = await apiPost<{ warning?: string; tables?: unknown[] }>("/api/connections", {
            name: name.trim(),
            type,
            host: host || undefined,
            port: port ? Number(port) : undefined,
            db_name: dbName || undefined,
            ro_user: user || undefined,
            ro_pass: pass || undefined,
            test: true, // 先测连通再保存
          });
          onDone(data.warning ?? `已连接 ${name}，读到 ${data.tables?.length ?? 0} 张表`);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err)); // 拒绝与网络层失败都留卡内
        } finally {
          setBusy(false);
        }
      }}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <input className="text-in" style={inputStyle} placeholder="连接名（小写，如 purchase_sys）" value={name} onChange={(e) => setName(e.target.value)} />
      <select className="ctl" value={type} onChange={(e) => setType(e.target.value as "sqlite" | "mysql" | "pg")} style={{ fontSize: 13 }}>
        <option value="sqlite">SQLite 文件（演示）</option>
        <option value="mysql">MySQL</option>
        <option value="pg">PostgreSQL</option>
      </select>
      {type === "sqlite" ? (
        <input className="text-in" style={inputStyle} placeholder="文件路径（如 /data/demo.db）" value={dbName} onChange={(e) => setDbName(e.target.value)} />
      ) : (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="text-in" style={{ ...inputStyle, flex: 1 }} placeholder="主机" value={host} onChange={(e) => setHost(e.target.value)} />
            <input className="text-in" style={{ ...inputStyle, width: 90 }} placeholder="端口" value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
          <input className="text-in" style={inputStyle} placeholder="库名" value={dbName} onChange={(e) => setDbName(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <input className="text-in" style={{ ...inputStyle, flex: 1 }} placeholder="只读账号" value={user} onChange={(e) => setUser(e.target.value)} />
            <input className="text-in" style={{ ...inputStyle, flex: 1 }} placeholder="密码" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
          </div>
        </>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button type="submit" className="btn-cta" style={{ fontSize: 13, padding: "6px 16px" }} disabled={busy}>
          {busy ? "测试中…" : "测试并保存"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
