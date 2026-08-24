// 动作表单（附录 B 动作定义的子集，见《外部Agent编辑画布.md》§6）——新建或编辑一条简单动作（子集之外的动作由 formCompatible 挡住，进不来）。
// 行类型与 prefill/buildActionDef 往返函数收在 ./actionView（纯函数，单测覆盖往返恒等）。
"use client";

import { useRef, useState } from "react";
import { buildActionDef, prefillEff, prefillPre, type EffRow, type PreRow, type PropVal } from "./actionView";


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
