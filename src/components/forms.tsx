// 画布页的小表单组件：新建对象、连线、连接数据源、加字段，外加小节标题与字段类型词表。
// 全是自包含展示组件，只靠窄回调 props 通信。
"use client";

import { useState } from "react";
import { apiPost } from "./wsClient";

export const PROP_TYPES = ["string", "number", "boolean", "date", "enum"] as const;

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: "0.08em", marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

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

/** 字段表单：新建或改一个字段（名/类型/说明/枚举值各占一行）。枚举值只在类型为 enum 时出现。 */
export function FieldForm({
  initial, // 编辑模式给现有字段；新建为 undefined
  onSave,
  onCancel,
}: {
  initial?: { name: string; type: (typeof PROP_TYPES)[number]; description?: string; values?: (string | number)[] };
  onSave: (v: { name: string; type: (typeof PROP_TYPES)[number]; description: string; values: (string | number)[] }) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [type, setType] = useState<(typeof PROP_TYPES)[number]>(initial?.type ?? "string");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [values, setValues] = useState((initial?.values ?? []).join(","));
  const [busy, setBusy] = useState(false);
  const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--ink-3)" };
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || busy) return;
        setBusy(true);
        try {
          const parsed = type === "enum" ? values.split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : [];
          if (await onSave({ name: name.trim(), type, description: description.trim(), values: parsed })) onCancel();
        } finally {
          setBusy(false);
        }
      }}
      style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 6 }}
    >
      <label style={labelStyle}>
        字段名（小写字母/数字/下划线；被引用的字段改不了名）
        <input className="ctl" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label style={labelStyle}>
        类型
        <select className="ctl" value={type} onChange={(e) => setType(e.target.value as (typeof PROP_TYPES)[number])}>
          {PROP_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </label>
      <label style={labelStyle}>
        说明（可选）
        <input className="ctl" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="如：人员编号" />
      </label>
      {type === "enum" && (
        <label style={labelStyle}>
          枚举值（逗号分隔；取值要跟源数据一致）
          <input className="ctl" value={values} onChange={(e) => setValues(e.target.value)} placeholder="如 in_transit,in_service" />
        </label>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        <button type="submit" className="btn-cta" style={{ fontSize: 12, padding: "6px 16px" }} disabled={busy}>{initial ? "保存" : "建好进草稿"}</button>
        <button type="button" className="btn" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
