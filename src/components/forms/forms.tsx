// 画布页的小表单组件：新建对象、连线、连接数据源、加字段，外加小节标题与字段类型词表。
// 全是自包含展示组件，只靠窄回调 props 通信。
"use client";

import { useRef, useState } from "react";
import { apiPost } from "../wsClient";
import { buildActionDef, prefillEff, prefillPre, type EffRow, type PreRow, type PropVal } from "./actionView";

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

/* ---------- 动作表单（附录 B 动作定义的子集，见《外部Agent编辑画布.md》§6） ----------
   前置：本类非派生字段 等于/不等于 字面量；或 从本类出发的关系 必须已经发生/必须还没发生。
   效应四种：把字段写成某值（update 宿主类）/ 转化（link 本类转化关系）/ 新生一个对象（create）/ 撤走这个对象（delete 宿主类）。
   update/delete 保存时自动写 object + identity: { from: identity }（附录 B：请求点名的那个体必须这样认人），控件上不出现编号。
   表单认不出的动作不进这里（formCompatible 白名单把门），所以回读预填只处理这套形状。
   行类型与 prefill/buildActionDef 往返函数收在 ./actionView（纯函数，单测覆盖往返恒等）。 */

const selStyle: React.CSSProperties = { fontSize: 12, padding: "4px 6px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--panel)", maxWidth: 150 };
const valInputStyle: React.CSSProperties = { fontSize: 12, padding: "4px 8px", flex: 1, minWidth: 60 };

/** 动作表单：新建或编辑一条简单动作（子集之外的动作由 formCompatible 挡住，进不来）。 */
export function ActionForm({
  clsName,
  ont,
  initial, // 编辑模式给现有动作（名字只读：改名本期不做，要删了再建）
  onSave,
  onCancel,
  onDirtyChange,
}: {
  clsName: string;
  ont: { object_types: Record<string, any>; link_types: Record<string, any> };
  initial?: { name: string; def: any };
  onSave: (name: string, def: Record<string, unknown>) => Promise<boolean>;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const cls = ont.object_types[clsName];
  const nonDerived = Object.keys(cls.properties).filter((p) => !cls.properties[p].derived);
  const hostLinks = Object.keys(ont.link_types).filter((n) => ont.link_types[n].from === clsName); // 前置可用的关系（从本类出发）
  const transitions = Object.keys(ont.link_types).filter((n) => ont.link_types[n].transition && ont.link_types[n].from === clsName && ont.link_types[n].to === clsName);
  const classNames = Object.keys(ont.object_types);
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.def?.description ?? "");
  const [preRows, setPreRows] = useState<PreRow[]>(() => prefillPre(initial?.def));
  const [effRows, setEffRows] = useState<EffRow[]>(() => prefillEff(initial?.def) ?? [{ kind: "update", rows: [{ prop: "", source: "request", value: "" }] }]);
  const [newEffKind, setNewEffKind] = useState("update");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touched = useRef(false);
  const touch = () => {
    if (!touched.current) {
      touched.current = true;
      onDirtyChange?.(true);
    }
  };
  const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--ink-3)" };

  const setPre = (i: number, r: PreRow) => {
    touch();
    setPreRows((rows) => rows.map((x, j) => (j === i ? r : x)));
  };
  const setEff = (i: number, r: EffRow) => {
    touch();
    setEffRows((rows) => rows.map((x, j) => (j === i ? r : x)));
  };

  /** 拼 def 走 actionView.buildActionDef（白名单子集的往返恒等有单测守着）。 */

  const propValRow = (p: PropVal, i: number, effIdx: number, allowIdentity: boolean, propChoices: string[]) => (
    <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
      <select
        value={p.prop}
        style={selStyle}
        onChange={(e) => {
          touch();
          setEffRows((rows) => rows.map((x, j) => {
            if (j !== effIdx || (x.kind !== "update" && x.kind !== "create")) return x;
            return { ...x, rows: x.rows.map((y, k) => (k === i ? { ...y, prop: e.target.value } : y)) };
          }));
        }}
      >
        <option value="">选一个字段</option>
        {propChoices.map((pp) => (
          <option key={pp} value={pp}>{pp}</option>
        ))}
      </select>
      <select
        value={p.source}
        style={selStyle}
        onChange={(e) => {
          touch();
          const source = e.target.value as PropVal["source"];
          setEffRows((rows) => rows.map((x, j) => {
            if (j !== effIdx || (x.kind !== "update" && x.kind !== "create")) return x;
            return { ...x, rows: x.rows.map((y, k) => (k === i ? { ...y, source } : y)) };
          }));
        }}
      >
        <option value="request">请求里来的</option>
        {allowIdentity && <option value="identity">请求顶上的识别值</option>}
        <option value="literal">固定值</option>
      </select>
      {p.source === "literal" && (
        <input
          className="ctl"
          style={valInputStyle}
          placeholder="值"
          value={p.value}
          onChange={(e) => {
            touch();
            const value = e.target.value;
            setEffRows((rows) => rows.map((x, j) => {
              if (j !== effIdx || (x.kind !== "update" && x.kind !== "create")) return x;
              return { ...x, rows: x.rows.map((y, k) => (k === i ? { ...y, value } : y)) };
            }));
          }}
        />
      )}
      <button
        type="button"
        className="x-btn"
        title="去掉这行"
        onClick={() => {
          touch();
          setEffRows((rows) => rows.map((x, j) => {
            if (j !== effIdx || (x.kind !== "update" && x.kind !== "create")) return x;
            return { ...x, rows: x.rows.filter((_, k) => k !== i) };
          }));
        }}
      >
        ✕
      </button>
    </div>
  );

  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy) return;
        setError(null);
        const built = buildActionDef({ clsName, name, description, preRows, effRows });
        if (!built.ok) {
          setError(built.error);
          return;
        }
        setBusy(true);
        try {
          if (await onSave(name.trim(), built.def)) onCancel();
        } finally {
          setBusy(false);
        }
      }}
      style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 6 }}
    >
      <label style={labelStyle}>
        名字{initial ? "（改名要删了再建）" : "（小写字母/数字/下划线）"}
        <input className="ctl" value={name} disabled={Boolean(initial)} onChange={(e) => { touch(); setName(e.target.value); }} placeholder="如 mark_checked" />
      </label>
      <label style={labelStyle}>
        说明（可选）
        <input className="ctl" value={description} onChange={(e) => { touch(); setDescription(e.target.value); }} placeholder="一句话说清这条动作做什么" />
      </label>
      <div style={labelStyle}>
        这条动作要先满足（可选）
        {preRows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
            {r.kind === "prop" ? (
              <>
                <select value={r.prop} style={selStyle} onChange={(e) => setPre(i, { ...r, prop: e.target.value })}>
                  <option value="">选一个字段</option>
                  {nonDerived.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <select value={r.op} style={selStyle} onChange={(e) => setPre(i, { ...r, op: e.target.value as "eq" | "ne" })}>
                  <option value="eq">等于</option>
                  <option value="ne">不等于</option>
                </select>
                <input className="ctl" style={valInputStyle} placeholder="值" value={r.value} onChange={(e) => setPre(i, { ...r, value: e.target.value })} />
              </>
            ) : (
              <>
                <select value={r.link} style={selStyle} onChange={(e) => setPre(i, { ...r, link: e.target.value })}>
                  <option value="">选一条关系</option>
                  {hostLinks.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
                <select value={String(r.happened)} style={selStyle} onChange={(e) => setPre(i, { ...r, happened: e.target.value === "true" })}>
                  <option value="true">必须已经发生</option>
                  <option value="false">必须还没发生</option>
                </select>
              </>
            )}
            <button type="button" className="x-btn" title="去掉这行" onClick={() => { touch(); setPreRows((rows) => rows.filter((_, j) => j !== i)); }}>
              ✕
            </button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button type="button" className="chip" onClick={() => { touch(); setPreRows((rows) => [...rows, { kind: "prop", prop: "", op: "eq", value: "" }]); }}>
            加一条字段条件
          </button>
          {hostLinks.length > 0 && (
            <button type="button" className="chip" onClick={() => { touch(); setPreRows((rows) => [...rows, { kind: "link", link: "", happened: true }]); }}>
              加一条关系条件
            </button>
          )}
        </div>
      </div>
      <div style={labelStyle}>
        做完会
        {effRows.map((r, i) => (
          <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "6px 8px", marginTop: 4 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <span style={{ flex: 1 }}>
                {r.kind === "update" ? "把字段写成某值" : r.kind === "link" ? "转化" : r.kind === "create" ? "新生一个对象" : "撤走这个对象（请求点名的那一个）"}
              </span>
              <button type="button" className="x-btn" title="去掉这条" onClick={() => { touch(); setEffRows((rows) => rows.filter((_, j) => j !== i)); }}>
                ✕
              </button>
            </div>
            {r.kind === "update" && (
              <>
                {r.rows.map((p, k) => propValRow(p, k, i, false, nonDerived))}
                <button type="button" className="chip" style={{ marginTop: 4 }} onClick={() => setEff(i, { ...r, rows: [...r.rows, { prop: "", source: "request", value: "" }] })}>
                  再加一个字段
                </button>
              </>
            )}
            {r.kind === "link" && (
              <select value={r.link} style={{ ...selStyle, marginTop: 4 }} onChange={(e) => setEff(i, { ...r, link: e.target.value })}>
                <option value="">选一条转化关系</option>
                {transitions.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
            )}
            {r.kind === "create" && (
              <>
                <select value={r.object} style={{ ...selStyle, marginTop: 4 }} onChange={(e) => setEff(i, { ...r, object: e.target.value, rows: [] })}>
                  <option value="">选一个新生的对象</option>
                  {classNames.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                {r.object &&
                  r.rows.map((p, k) =>
                    propValRow(p, k, i, true, Object.keys(ont.object_types[r.object]?.properties ?? {}).filter((pp) => !ont.object_types[r.object].properties[pp].derived))
                  )}
                {r.object && (
                  <button type="button" className="chip" style={{ marginTop: 4 }} onClick={() => setEff(i, { ...r, rows: [...r.rows, { prop: "", source: "request", value: "" }] })}>
                    再加一个字段
                  </button>
                )}
              </>
            )}
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
          <select value={newEffKind} style={selStyle} onChange={(e) => setNewEffKind(e.target.value)}>
            <option value="update">把字段写成某值</option>
            {transitions.length > 0 && <option value="link">转化</option>}
            <option value="create">新生一个对象</option>
            <option value="delete">撤走这个对象</option>
          </select>
          <button
            type="button"
            className="chip"
            onClick={() => {
              touch();
              setEffRows((rows) => [
                ...rows,
                newEffKind === "update"
                  ? { kind: "update", rows: [{ prop: "", source: "request", value: "" }] }
                  : newEffKind === "link"
                    ? { kind: "link", link: "" }
                    : newEffKind === "create"
                      ? { kind: "create", object: "", rows: [] }
                      : { kind: "delete" },
              ]);
            }}
          >
            加一条
          </button>
        </div>
      </div>
      {error && <div style={{ fontSize: 12, color: "var(--danger)" }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        <button type="submit" className="btn-cta" style={{ fontSize: 12, padding: "6px 16px" }} disabled={busy}>
          {initial ? "保存" : "建好进草稿"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
