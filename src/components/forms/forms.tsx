// 画布页的小表单组件：新建对象、连线、连接数据源（同一消费者 CanvasPage）。
// 字段表单与小节壳已随消费者搬走（cards/FieldForm.tsx，ObjectCard 配套）；全是自包含展示组件，只靠窄回调 props 通信。
"use client";

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../workspaceClient";

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
  // sqlite 文件选择器：可选 .db 文件清单（null = 还没拉到）+ 勾选集合 + 手动路径模式
  const [files, setFiles] = useState<{ file: string; path: string; title?: string; connection: string; connected: boolean }[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [manual, setManual] = useState(false);
  const inputStyle: React.CSSProperties = { fontSize: 13, padding: "8px 12px" };
  useEffect(() => {
    if (type !== "sqlite" || manual) return;
    setFiles(null);
    setFilesError(null);
    apiGet<{ files: { file: string; path: string; title?: string; connection: string; connected: boolean }[] }>("/api/list_sqlite_files")
      .then((d) => setFiles(d.files))
      .catch((e) => setFilesError(e instanceof Error ? e.message : String(e)));
  }, [type, manual]);
  const toggle = (connection: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(connection)) next.delete(connection);
      else next.add(connection);
      return next;
    });
  const canSubmit = type === "sqlite" && !manual ? picked.size > 0 : name.trim() !== "";
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canSubmit || busy) return;
        // sqlite 选择器模式：勾选的文件逐个测试并保存，失败的不挡住成功的
        if (type === "sqlite" && !manual) {
          const chosen = (files ?? []).filter((f) => picked.has(f.connection));
          if (chosen.length === 0) return;
          setBusy(true);
          setError(null);
          const saved: string[] = [];
          const failed: string[] = [];
          for (const f of chosen) {
            try {
              const data = await apiPost<{ saved: boolean; warning?: string }>("/api/connections", {
                name: f.connection,
                type: "sqlite",
                db_name: f.path,
                test: true,
              });
              // 空库（没有表）测通但不落库：不算「已连接」，照 warning 报原因
              if (data.saved) saved.push(f.title ?? f.file);
              else failed.push(`${f.title ?? f.file}（${data.warning ?? "没有可连接的表"}）`);
            } catch (err) {
              failed.push(`${f.title ?? f.file}（${err instanceof Error ? err.message : String(err)}）`);
            }
          }
          setBusy(false);
          if (failed.length === 0) {
            onDone(`已连接 ${saved.length} 个库：${saved.join("、")}`);
            return;
          }
          if (saved.length === 0) {
            setError(`连接失败：${failed.join("；")}`);
            return;
          }
          onDone(`已连接 ${saved.length} 个库，失败 ${failed.length} 个：${failed.join("；")}`);
          return;
        }
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
          onDone(data.warning ?? `已连接 ${name.trim()}，读到 ${data.tables?.length ?? 0} 张表`);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err)); // 拒绝与网络层失败都留卡内
        } finally {
          setBusy(false);
        }
      }}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <select className="ctl" value={type} onChange={(e) => setType(e.target.value as "sqlite" | "mysql" | "pg")} style={{ fontSize: 13 }}>
        <option value="sqlite">SQLite 文件（演示）</option>
        <option value="mysql">MySQL</option>
        <option value="pg">PostgreSQL</option>
      </select>
      {type === "sqlite" ? (
        manual ? (
          <>
            <input className="text-in" style={inputStyle} placeholder="连接名（小写，如 purchase_sys）" value={name} onChange={(e) => setName(e.target.value)} />
            <input className="text-in" style={inputStyle} placeholder="文件路径（如 .ontos-demo/purchase.db）" value={dbName} onChange={(e) => setDbName(e.target.value)} />
            <button type="button" className="chip" style={{ alignSelf: "flex-start" }} onClick={() => setManual(false)}>← 选文件</button>
          </>
        ) : (
          <>
            {files === null && !filesError && <div style={{ fontSize: 12, color: "var(--ink-2)" }}>读取可选文件…</div>}
            {filesError && <div style={{ fontSize: 12, color: "var(--danger)" }}>读不到可选文件：{filesError}</div>}
            {files !== null && files.length === 0 && (
              <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.6 }}>
                演示库目录里还没有可选的 .db 文件——先跑 <code>npm run demo:seed</code> 生成演示数据，再回来连
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 220, overflowY: "auto" }}>
              {(files ?? []).map((f) => (
                <label
                  key={f.connection}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12,
                    padding: "4px 6px",
                    borderRadius: 8,
                    cursor: f.connected ? "default" : "pointer",
                    opacity: f.connected ? 0.55 : 1,
                  }}
                >
                  <input type="checkbox" checked={picked.has(f.connection)} disabled={f.connected} onChange={() => toggle(f.connection)} />
                  <span style={{ fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 }}>{f.title ?? f.file}</span>
                  <span style={{ color: "var(--ink-3)", fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "nowrap", flexShrink: 0 }}>{f.connection}</span>
                  <span style={{ color: "var(--ink-3)", marginLeft: "auto", fontSize: 11, fontFamily: "var(--font-mono)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }}>{f.connected ? "已连接" : f.path}</span>
                </label>
              ))}
            </div>
            <button type="button" className="chip" style={{ alignSelf: "flex-start" }} onClick={() => setManual(true)}>手动指定路径</button>
          </>
        )
      ) : (
        <>
          <input className="text-in" style={inputStyle} placeholder="连接名（小写，如 purchase_sys）" value={name} onChange={(e) => setName(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <input className="text-in" style={{ ...inputStyle, flex: 1, minWidth: 0 }} placeholder="主机" value={host} onChange={(e) => setHost(e.target.value)} />
            <input className="text-in" style={{ ...inputStyle, width: 90 }} placeholder="端口" value={port} onChange={(e) => setPort(e.target.value)} />
          </div>
          <input className="text-in" style={inputStyle} placeholder="库名" value={dbName} onChange={(e) => setDbName(e.target.value)} />
          <div style={{ display: "flex", gap: 8 }}>
            <input className="text-in" style={{ ...inputStyle, flex: 1, minWidth: 0 }} placeholder="账号" value={user} onChange={(e) => setUser(e.target.value)} />
            <input className="text-in" style={{ ...inputStyle, flex: 1, minWidth: 0 }} placeholder="密码" type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
          </div>
        </>
      )}
      {error && <div style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
        <button type="submit" className="btn-cta" style={{ fontSize: 13, padding: "6px 16px" }} disabled={busy || !canSubmit}>
          {busy ? "测试中…" : type === "sqlite" && !manual && picked.size > 1 ? `测试并保存（${picked.size} 个）` : "测试并保存"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
