"use client";

// 工作台 v4 —— 画布优先：一块永远可编辑的本体画布；
// 步骤动作是画布上的浮动卡，表结构/出码产物在底部抽屉，画布可最大化。
import { useEffect, useState } from "react";
import {
  Database, PencilRuler, ShareNetwork, TreeStructure, Code, Scales, GitMerge,
  X, ArrowCounterClockwise, Key,
  Lightbulb, Plus, CheckCircle, LockSimple, Circle,
  CornersOut, CornersIn,
} from "@phosphor-icons/react";
import OntologyGraph from "@/components/OntologyGraph";
import { connFor, pairKey } from "./mockAgent";
import { toYaml } from "@/lib/ontology";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Badges {
  sources: number;
  objects: number;
  version: number | null;
  generated: boolean;
  confirmed?: boolean;
}
export interface WsActions {
  applyObjectYaml: (kind: "draft" | "merged", conn: string | null, objName: string, text: string) => string | null;
  updateObject: (kind: "draft" | "merged", conn: string | null, objName: string, updated: any) => string | null;
  replay: () => void;
  confirmDrafts: () => void;
  setDecision: (key: string, t: string) => void;
  toggleIgnore: (conn: string, objName: string) => void;
  replanObject: (name: string) => void;
  // 步骤动作：直接执行，不经过对话
  connect: () => void;
  draft: () => void;
  integrate: () => void;
  decideAll: () => void;
  publish: () => void;
  publishChanges: () => void; // 发布工作副本 → 新版本
  discardChanges: () => void; // 放弃未发布改动
  rollback: (v: number) => void;
  // 选表 → 生成对象直接上画布（字段级多选）；表本身不上画布
  unstage: (conn: string, table: string) => void;
  toggleStage: (conn: string, table: string, allCols: string[]) => void;
  toggleStageColumn: (conn: string, table: string, col: string, allCols: string[]) => void;
  selectAllTables: () => void;
  clearStaging: () => void;
  generate: () => void;
  confirmIdentity: (keep: boolean) => void;
  // 手动新建对象（无源）
  createObject: () => string;
  // 画布连线与删除
  createLink: (from: { conn: string | null; name: string }, to: { conn: string | null; name: string }, name: string, extra?: { label?: string; inverse?: string; card?: string }) => string | null;
  updateLink: (conn: string | null, orig: string, patch: { name?: string; label?: string; inverse?: string; card?: string }) => string | null;
  setQuestions: (qs: string[]) => void;
  deleteLink: (conn: string | null, orig: string) => void;
  deleteObject: (kind: "draft" | "merged", conn: string | null, objName: string) => string | null;
}

const STEP_META: Record<string, { icon: React.ComponentType<{ size?: number }>; sub: string }> = {
  connect: { icon: Database, sub: "只读接入 · 永不写源库" },
  model: { icon: PencilRuler, sub: "选表生成对象 · 有抉择再拍板" },
  integrate: { icon: Scales, sub: "候选对裁决 · 权在你" },
  publish: { icon: GitMerge, sub: "合并为单一事实源" },
};
const PHASE_NAME: Record<string, string> = {
  connect: "连接数据源",
  model: "逆向建模",
  integrate: "多源整合",
  publish: "发布本体",
};

/* ---- 通用小块 ---- */
/* ---- 连接表单（工作台面板版）---- */
function ConnectPanel({ flow, onTest, onSave }: { flow: any; onTest: () => void; onSave: () => void }) {
  const c = connFor(flow.idx);
  return (
    <div className="panel">
      <h3>配置数据源 · {c.connection} <span className="tag gray">第 {flow.idx + 1} 个</span></h3>
      <div className="hint">只读账号 · 永不写源库 · 演示配置已预填，先测通再保存</div>
      {c.reused && <div className="hint" style={{ color: "var(--warn)", marginTop: -6 }}>演示环境将复用「{c.backend}」的数据</div>}
      <div className="conn-grid">
        <label>类型</label><input defaultValue={c.label} readOnly />
        <label>主机</label><input defaultValue={c.host} />
        <label>端口</label><input defaultValue={c.port} />
        <label>数据库</label><input defaultValue={c.database} />
        <label>只读账号</label><input defaultValue={c.user} />
        <label>密码</label><input type="password" defaultValue={c.password} />
      </div>
      <div className="panel-actions" style={{ marginTop: 14, marginBottom: 0 }}>
        <button className="ghost sm" onClick={onTest} disabled={flow.testing || flow.tested}>
          {flow.testing ? "测试中…" : flow.tested ? "已连通" : "测试连接"}
        </button>
        <button className="sm" disabled={!flow.tested} onClick={onSave}>保存并读取表结构</button>
      </div>
    </div>
  );
}

/* ---- 裁决：一次一问。点完自动下一题；全答完再给发布 ---- */
const REL_OPTIONS = [
  { t: "①", name: "完全等价", desc: "同一概念，合并成一个对象，两边都挂上" },
  { t: "②", name: "部分重叠", desc: "有公共部分，也各有自己的字段" },
  { t: "③", name: "生命周期", desc: "同一个人，只是前后两个阶段" },
  { t: "⑤", name: "只是名字像", desc: "不是一回事，各自独立" },
];
const PAIR_LABEL: Record<string, string> = { person: "人员", department: "部门", position: "职位" };
const END_LABEL: Record<string, string> = {
  candidate: "候选人", employee: "员工", department: "部门",
  job_posting: "招聘职位", headcount_position: "岗位编制",
};
const REL_NAME: Record<string, string> = Object.fromEntries(REL_OPTIONS.map((o) => [o.t, o.name]));
const SKIP = "\u293c";

function pairEnds(pair: string) {
  return pair.split(/\s*↔\s*/).map((side) => {
    const [conn, table] = side.split(".");
    return { conn, table, label: END_LABEL[table] ?? table };
  });
}

function DecisionPanel({ data, merged, actions, onClose }: { data: any; merged: boolean; actions: WsActions; onClose?: () => void }) {
  const ev = data.evidence ?? [];
  const decisions = data.decisions ?? {};
  const idx = ev.findIndex((e: any) => !decisions[pairKey(e)]);
  const allDone = ev.length > 0 && idx < 0;
  const step = allDone ? ev.length : Math.max(idx, 0);
  const cur = allDone ? null : ev[step];
  const key = cur ? pairKey(cur) : "";
  const ends = cur ? pairEnds(cur.pair) : [];

  const pick = (t: string) => {
    if (!key) return;
    actions.setDecision(key, t);
  };
  const prev = () => {
    if (step <= 0) return;
    actions.setDecision(pairKey(ev[step - 1]), "");
  };

  return (
    <div className="ask">
      <div className="ask-top">
        <div className="ask-dots" aria-label={`第 ${allDone ? ev.length : step + 1} 题，共 ${ev.length} 题`}>
          {ev.map((e: any, i: number) => (
            <i key={e.pair} className={allDone || i < step ? "done" : i === step ? "on" : ""} />
          ))}
        </div>
        {step > 0 && !allDone && <button type="button" className="ask-nav" onClick={prev}>上一对</button>}
        {onClose && <button type="button" className="ask-nav" onClick={onClose} title="收起"><X size={13} /></button>}
      </div>

      {!allDone && cur && (
        <>
          <h3 className="ask-q">这两边是什么关系？</h3>
          <div className="ask-sides">
            {ends[0] && (
              <div className="ask-end">
                <b>{ends[0].label}</b>
                <em>{ends[0].conn}</em>
              </div>
            )}
            <span className="ask-x" aria-hidden>{"\u2194"}</span>
            {ends[1] && (
              <div className="ask-end">
                <b>{ends[1].label}</b>
                <em>{ends[1].conn}</em>
              </div>
            )}
          </div>
          <div className="ask-rate">
            {cur.rate === null ? (
              <div className="ask-na">两边对不上号，数据没法证明是同一批</div>
            ) : (
              <>
                <span className="ask-pct">{(cur.rate * 100).toFixed(0)}%</span>
                <div className="ask-rate-meta">
                  <div>两库同一批人的比例</div>
                  <div className="ask-rate-s">{cur.countA} 对 {cur.countB}，交 {cur.intersection}</div>
                </div>
              </>
            )}
          </div>
          {cur.reason && <p className="ask-why"><Lightbulb size={13} />{cur.reason}</p>}
          <div className="ask-opts">
            {REL_OPTIONS.map((o) => (
              <button
                key={o.t}
                type="button"
                className={`ask-opt ${o.t === cur.suggestion ? "sug" : ""}`}
                onClick={() => pick(o.t)}
              >
                <span className="ask-opt-n">{o.name}</span>
                <span className="ask-opt-d">{o.desc}</span>
                {o.t === cur.suggestion && <span className="ask-sug">建议</span>}
              </button>
            ))}
            <button type="button" className="ask-opt skip" onClick={() => pick(SKIP)}>
              <span className="ask-opt-n">先跳过</span>
              <span className="ask-opt-d">暂不合并，以后还能改</span>
            </button>
          </div>
        </>
      )}

      {allDone && (
        <>
          <h3 className="ask-q">这几对都定了</h3>
          <p className="ask-lead">不对的点「改」，回到那一题。</p>
          {decisions.person === "①" && (
            <p className="ask-warn">人员若按「完全等价」合并，会丢掉「转正」的时间，查转正员工会答不上来。</p>
          )}
          <ul className="ask-sum">
            {ev.map((e: any) => {
              const k = pairKey(e);
              const t = decisions[k];
              return (
                <li key={e.pair}>
                  <b>{PAIR_LABEL[k] ?? k}</b>
                  <span>{t === SKIP ? "先跳过" : (REL_NAME[t] ?? t)}</span>
                  <button type="button" className="ask-nav" onClick={() => actions.setDecision(k, "")}>改</button>
                </li>
              );
            })}
          </ul>
          <button type="button" className="ask-go" onClick={actions.publish}>
            {merged ? "按新裁决重新发布" : "发布合并本体"}
          </button>
        </>
      )}
    </div>
  );
}

/* ---- M1 Schema（只读原料：勾选表 → 生成对象直接上画布；表本身永不当节点）---- */
function SchemaView({ data, mapIndex = {}, staged, locked, staging, generating, stageActions }: {
  data: any[];
  mapIndex?: Record<string, string[]>;
  staged?: Set<string>; // 已映射到画布对象的表（草稿 ∪ 已发布本体的来源）
  locked?: boolean; // 已确认/已发布后不可移出，只能加
  staging?: Record<string, string[]>; // "conn.table" → 选中的列名
  generating?: boolean;
  stageActions?: {
    toggle: (c: string, t: string, allCols: string[]) => void;
    toggleCol: (c: string, t: string, col: string, allCols: string[]) => void;
    selectAll: () => void; clear: () => void; generate: () => void;
    unstage: (c: string, t: string) => void;
  };
}) {
  const selCount = Object.keys(staging ?? {}).length;
  return (
    <div className="grid" style={{ gap: 12 }}>
      {stageActions && (
        <div className="stage-bar">
          <span className="hint" style={{ margin: 0 }}>{selCount ? `已选 ${selCount} 张表 · 展开可逐列调整` : "勾选表（可字段级），生成对象到画布——表只是原料"}</span>
          <span style={{ flex: 1 }} />
          <button className="ghost sm" onClick={stageActions.selectAll}>全选</button>
          <button className="ghost sm" onClick={stageActions.clear} disabled={!selCount}>清空</button>
          <button className="sm" disabled={!selCount || generating} onClick={stageActions.generate}>
            {generating ? "AI 正在读表…" : "生成对象 →"}
          </button>
        </div>
      )}
      {data.map((db: any) => (
        <div className="src-block" key={db.connection}>
          <div className="src-head">
            <span className="src-ic"><Database size={15} /></span>
            <b>{db.connection}</b>
            <span className="tag gray">{db.kind === "mysql" ? "MySQL" : "PostgreSQL"}</span>
            <span className="tag ok" style={{ marginLeft: "auto" }}>已连接 · 只读</span>
          </div>
          <div className="src-body">
            {db.tables.map((t: any) => {
              const mapped = t.columns.filter((c: any) => mapIndex[`${db.connection}.${t.name}.${c.name}`]).length;
              const key = `${db.connection}.${t.name}`;
              const on = staged?.has(key);
              const selCols = staging?.[key];
              const allCols = t.columns.map((c: any) => c.name);
              const pkCol = t.columns.find((c: any) => c.pk)?.name;
              const tableOn = !!selCols;
              return (
                <details key={key} className="tbl-acc">
                  <summary>
                    {stageActions && !on && (
                      <span
                        role="checkbox"
                        aria-checked={tableOn}
                        tabIndex={0}
                        className={`sel-box ${tableOn ? "on" : ""}`}
                        title={tableOn ? "取消选择" : "选择全表字段"}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          stageActions.toggle(db.connection, t.name, allCols);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === " " || e.key === "Enter") {
                            e.preventDefault();
                            e.stopPropagation();
                            stageActions.toggle(db.connection, t.name, allCols);
                          }
                        }}
                      />
                    )}
                    <span className="mono">{t.name}</span>
                    <span className="tag gray">{t.comment}</span>
                    <span className="rows-n">
                      {selCols ? `已选 ${selCols.length}/${t.columns.length} 列` : `${mapped}/${t.columns.length} 列已映射`}
                    </span>
                    {on && (
                      locked ? (
                        <span className="tag ok" onClick={(e) => e.preventDefault()}>已映射</span>
                      ) : (
                        <button className="ghost sm" onClick={(e) => { e.preventDefault(); e.stopPropagation(); stageActions?.unstage(db.connection, t.name); }} title="移除由这张表生成的对象">移出对象</button>
                      )
                    )}
                  </summary>
                  <div className="tbl-acc-body">
                    <table className="data">
                      <tbody>
                        {t.columns.map((c: any) => {
                          const to = mapIndex[`${db.connection}.${t.name}.${c.name}`];
                          const colSel = !!selCols?.includes(c.name);
                          const isPkAnchor = c.name === pkCol;
                          return (
                            <tr key={c.name}>
                              <td>
                                {stageActions && !on && (
                                  <span
                                    role="checkbox"
                                    aria-checked={colSel}
                                    tabIndex={0}
                                    className={`sel-box sm ${colSel ? "on" : ""} ${isPkAnchor && tableOn ? "lock" : ""}`}
                                    title={isPkAnchor && tableOn ? "主键是来源锚，必选" : colSel ? "不选这列" : "选这列"}
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      if (!(isPkAnchor && colSel)) stageActions.toggleCol(db.connection, t.name, c.name, allCols);
                                    }}
                                    onKeyDown={(e) => {
                                      if (e.key === " " || e.key === "Enter") {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (!(isPkAnchor && colSel)) stageActions.toggleCol(db.connection, t.name, c.name, allCols);
                                      }
                                    }}
                                  />
                                )}
                                {c.pk ? <Key size={10} className="i-inline" /> : null}{c.name}
                              </td>
                              <td style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-2)" }}>{c.type}</td>
                              <td style={{ color: "var(--ink-3)" }}>{c.comment ?? ""}</td>
                              <td>
                                {to
                                  ? to.map((x) => <span key={x} className="tag ok" style={{ marginRight: 4 }}>→ {x}</span>)
                                  : <span style={{ color: "var(--ink-3)", fontSize: 11 }}>未映射</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- 画布内对象编辑（点节点弹出；YAML 进阶编辑收在这里）---- */
function rowsOf<T>(v: T[] | undefined, empty: T): T[] {
  return (v && v.length ? v : []).map((x) => ({ ...x })) as T[];
}

function ObjectEditor({ obj, schemas, peers, onSave, onSaveYaml, onClose, ignored, onToggleIgnore, onReplan, onDelete }: {
  obj: any; schemas: any[]; peers: { name: string; label: string }[];
  onSave: (o: any) => string | null; onSaveYaml: (text: string) => string | null; onClose: () => void;
  ignored?: boolean; onToggleIgnore?: () => void; onReplan?: () => void; onDelete?: () => void;
}) {
  const [label, setLabel] = useState(obj.label ?? "");
  const [identity, setIdentity] = useState(obj.identity ?? "");
  const [kind, setKind] = useState<"thing" | "event">(obj.kind === "event" ? "event" : "thing");
  const [parent, setParent] = useState(obj.parent ?? "");
  const [equivalent, setEquivalent] = useState(obj.equivalent ?? "");
  const [props, setProps] = useState<any[]>(obj.properties.map((p: any) => ({ ...p })));
  const [fns, setFns] = useState<any[]>(rowsOf(obj.functions, { name: "", label: "", rule: "" }));
  const [axioms, setAxioms] = useState<any[]>(rowsOf(obj.axioms, { name: "", rule: "" }));
  const [acts, setActs] = useState<any[]>(rowsOf(obj.actions, { name: "", label: "", does: "" }));
  const [perms, setPerms] = useState<any[]>(rowsOf(obj.permissions, { field: "", who: "" }));
  const [srcs, setSrcs] = useState<any[]>(obj.sources.map((s: any) => ({ ...s, fields: { ...s.fields } })));
  const [err, setErr] = useState<string | null>(null);
  const [yamlMode, setYamlMode] = useState(false);
  const [yamlText, setYamlText] = useState("");
  const [pull, setPull] = useState({ conn: "", table: "", col: "" });
  const setP = (i: number, patch: any) => setProps((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const save = () => {
    // 清理悬空映射：字段被删后它在 sources 里的映射一并去掉；空来源整条去掉
    const keep = new Set(props.map((p) => p.name));
    const sources = srcs
      .map((s) => ({ ...s, fields: Object.fromEntries(Object.entries(s.fields).filter(([p]) => keep.has(p))) }))
      .filter((s) => Object.keys(s.fields).length > 0);
    const e = onSave({
      label: label.trim(),
      identity: identity.trim() || undefined,
      kind,
      parent: parent.trim() || undefined,
      equivalent: equivalent.trim() || undefined,
      properties: props.map(({ _new, ...p }) => p),
      sources,
      functions: fns.filter((x) => x.label || x.rule),
      axioms: axioms.filter((x) => x.rule),
      actions: acts.filter((x) => x.label || x.does),
      permissions: perms.filter((x) => x.who),
    });
    if (e) setErr(e);
    else onClose();
  };
  // 从源表拉一列进来当字段（对象 ↔ 源列是多对多：一列可喂多个对象，一个对象可挂多张表）
  const pullDb = schemas.find((x) => x.connection === pull.conn);
  const pullTable = pullDb?.tables.find((x: any) => x.name === pull.table);
  const addPulled = () => {
    const c = pullTable?.columns.find((x: any) => x.name === pull.col);
    if (!c) return;
    if (srcs.some((s) => s.connection === pull.conn && s.table === pull.table && Object.values(s.fields).includes(pull.col))) {
      setErr("这一列已经在这个对象里了");
      return;
    }
    let name = pull.col;
    for (let i = 2; props.some((p) => p.name === name); i++) name = `${pull.col}_${i}`;
    setErr(null);
    setProps((ps) => [...ps, { name, label: c.comment ?? "", type: c.type }]);
    setSrcs((ss) => {
      const hit = ss.find((s) => s.connection === pull.conn && s.table === pull.table);
      if (hit) return ss.map((s) => (s === hit ? { ...s, fields: { ...s.fields, [name]: pull.col } } : s));
      const pk = pullTable.columns.find((x: any) => x.pk)?.name ?? pull.col;
      return [...ss, { connection: pull.conn, table: pull.table, pk, fields: { [name]: pull.col } }];
    });
    setPull({ conn: pull.conn, table: pull.table, col: "" });
  };
  const saveYaml = () => {
    const e = onSaveYaml(yamlText);
    if (e) setErr(e);
    else setYamlMode(false);
  };
  return (
    <div className="obj-editor">
      <div className="oe-head">
        <b>{obj.label}</b>
        <span className="oc-name">{obj.name}</span>
        {ignored && <span className="tag warn">已忽略 · 不进本体</span>}
        <span className="oe-srcs">
          {obj.sources.length === 0 && <span className="tag gray">手动 · 无源</span>}
          {obj.sources.map((s: any) => <span key={`${s.connection}.${s.table}`} className="tag gray">{s.connection}.{s.table}</span>)}
        </span>
        <span className="oe-actions">
          {!yamlMode && (
            <button
              className="ghost sm"
              title="以 YAML 编辑这个对象"
              onClick={() => {
                setYamlText(toYaml({ object_types: { [obj.name]: obj }, link_types: [] }));
                setErr(null);
                setYamlMode(true);
              }}
            >
              <Code size={12} className="i-inline" />YAML
            </button>
          )}
          <button className="ghost sm" onClick={onClose} title="关闭"><X size={12} /></button>
        </span>
      </div>
      {yamlMode ? (
        <div style={{ marginTop: 10 }}>
          <textarea className="yaml-editor" style={{ minHeight: 220 }} value={yamlText} onChange={(e) => setYamlText(e.target.value)} spellCheck={false} />
          {err && <div className="editor-err">{err}</div>}
          <div className="panel-actions" style={{ marginTop: 8, marginBottom: 0, alignItems: "center" }}>
            <button className="sm" onClick={saveYaml}>保存</button>
            <button className="ghost sm" onClick={() => { setYamlMode(false); setErr(null); }}>返回表单</button>
            <span className="hint" style={{ margin: 0 }}>仅当前对象的 YAML——对象名锁定，内容可改，保存即生效</span>
          </div>
        </div>
      ) : (
        <>
          <div className="oe-grid">
            <label>显示名</label><input value={label} onChange={(e) => setLabel(e.target.value)} />
            <label>种类</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as "thing" | "event")}>
              <option value="thing">事物（一直存在）</option>
              <option value="event">事件（发生过一桩）</option>
            </select>
            <label>识别字段</label><input value={identity} placeholder="实例怎么认，如 id_card" onChange={(e) => setIdentity(e.target.value)} />
            <label>上位对象</label>
            <select value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">无（不是谁的子类）</option>
              {peers.filter((p) => p.name !== obj.name).map((p) => (
                <option key={p.name} value={p.name}>{p.label}</option>
              ))}
            </select>
            <label>同义于</label>
            <select value={equivalent} onChange={(e) => setEquivalent(e.target.value)}>
              <option value="">无</option>
              {peers.filter((p) => p.name !== obj.name).map((p) => (
                <option key={p.name} value={p.name}>{p.label}</option>
              ))}
            </select>
          </div>
          <div className="oe-note">实例不落库：按识别字段现查源库，这里只设「怎么认」。</div>
          <div className="oe-props">
            {props.map((p, i) => (
              <div className="oe-prop" key={i}>
                <input value={p.label ?? ""} placeholder="显示名" onChange={(e) => setP(i, { label: e.target.value })} />
                <input value={p.name} placeholder="字段名" readOnly={!p._new} title={p._new ? "字段名" : "已有字段名锁定（改了源映射会对不上）"} onChange={(e) => setP(i, { name: e.target.value })} />
                <input value={p.type} placeholder="类型" style={{ width: 84, flex: "none" }} onChange={(e) => setP(i, { type: e.target.value })} />
                <button className="ghost sm" onClick={() => setProps((ps) => ps.filter((_, j) => j !== i))}>删</button>
              </div>
            ))}
            <button className="ghost sm" onClick={() => setProps((ps) => [...ps, { name: "", label: "", type: "string", _new: true }])}>
              <Plus size={11} className="i-inline" />添加属性
            </button>
            {schemas.length > 0 && (
              <div className="oe-pull">
                <select value={pull.conn} onChange={(e) => setPull({ conn: e.target.value, table: "", col: "" })}>
                  <option value="" disabled>数据源…</option>
                  {schemas.map((x) => <option key={x.connection} value={x.connection}>{x.connection}</option>)}
                </select>
                <select value={pull.table} onChange={(e) => setPull({ ...pull, table: e.target.value, col: "" })} disabled={!pull.conn}>
                  <option value="" disabled>表…</option>
                  {(pullDb?.tables ?? []).map((t: any) => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
                <select value={pull.col} onChange={(e) => setPull({ ...pull, col: e.target.value })} disabled={!pull.table}>
                  <option value="" disabled>列…</option>
                  {(pullTable?.columns ?? []).map((c: any) => <option key={c.name} value={c.name}>{c.name}{c.comment ? ` · ${c.comment}` : ""}</option>)}
                </select>
                <button className="ghost sm" disabled={!pull.col} onClick={addPulled}>拉入</button>
              </div>
            )}
          </div>
          <div className="oe-sec">
            <div className="oe-sec-t">怎么算（函数）</div>
            {fns.map((f, i) => (
              <div className="oe-prop" key={i}>
                <input value={f.label} placeholder="名称" onChange={(e) => setFns((xs) => xs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <input value={f.rule} placeholder="怎么算，如 状态从候选人变成在职" onChange={(e) => setFns((xs) => xs.map((x, j) => (j === i ? { ...x, rule: e.target.value, name: x.name || `fn_${i + 1}` } : x)))} />
                <button className="ghost sm" onClick={() => setFns((xs) => xs.filter((_, j) => j !== i))}>删</button>
              </div>
            ))}
            <button className="ghost sm" onClick={() => setFns((xs) => [...xs, { name: `fn_${xs.length + 1}`, label: "", rule: "" }])}>添加算法</button>
          </div>
          <div className="oe-sec">
            <div className="oe-sec-t">必须遵守（公理）</div>
            {axioms.map((a, i) => (
              <div className="oe-prop" key={i}>
                <input value={a.rule} placeholder="如 同一个人同一时刻只能有一个状态" onChange={(e) => setAxioms((xs) => xs.map((x, j) => (j === i ? { ...x, rule: e.target.value, name: x.name || `ax_${i + 1}` } : x)))} />
                <button className="ghost sm" onClick={() => setAxioms((xs) => xs.filter((_, j) => j !== i))}>删</button>
              </div>
            ))}
            <button className="ghost sm" onClick={() => setAxioms((xs) => [...xs, { name: `ax_${xs.length + 1}`, rule: "" }])}>添加约束</button>
          </div>
          <div className="oe-sec">
            <div className="oe-sec-t">能做什么（动作）</div>
            {acts.map((a, i) => (
              <div className="oe-prop" key={i} style={{ flexWrap: "wrap" }}>
                <input value={a.label} placeholder="名称，如 录用" onChange={(e) => setActs((xs) => xs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <input value={a.does} placeholder="做什么" onChange={(e) => setActs((xs) => xs.map((x, j) => (j === i ? { ...x, does: e.target.value, name: x.name || `act_${i + 1}` } : x)))} />
                <input value={a.record ?? ""} placeholder="写回哪，如 hr.employee" onChange={(e) => setActs((xs) => xs.map((x, j) => (j === i ? { ...x, record: e.target.value } : x)))} />
                <input value={a.from_fields ?? ""} placeholder="带过去的字段，如 name,id_card" onChange={(e) => setActs((xs) => xs.map((x, j) => (j === i ? { ...x, from_fields: e.target.value } : x)))} />
                <button className="ghost sm" onClick={() => setActs((xs) => xs.filter((_, j) => j !== i))}>删</button>
              </div>
            ))}
            <button className="ghost sm" onClick={() => setActs((xs) => [...xs, { name: `act_${xs.length + 1}`, label: "", does: "" }])}>添加动作</button>
          </div>
          <div className="oe-sec">
            <div className="oe-sec-t">谁能看（权限）</div>
            {perms.map((p, i) => (
              <div className="oe-prop" key={i}>
                <input value={p.field} placeholder="字段，空=整个对象" onChange={(e) => setPerms((xs) => xs.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))} />
                <input value={p.who} placeholder="谁能看，如 人事可看" onChange={(e) => setPerms((xs) => xs.map((x, j) => (j === i ? { ...x, who: e.target.value } : x)))} />
                <button className="ghost sm" onClick={() => setPerms((xs) => xs.filter((_, j) => j !== i))}>删</button>
              </div>
            ))}
            <button className="ghost sm" onClick={() => setPerms((xs) => [...xs, { field: "", who: "" }])}>添加权限</button>
          </div>
          {err && <div className="editor-err">{err}</div>}
          <div className="panel-actions" style={{ marginTop: 10, marginBottom: 0, alignItems: "center" }}>
            <button className="sm" onClick={save}>保存</button>
            <button className="ghost sm" onClick={onClose}>取消</button>
            {onDelete && (
              <button
                className="ghost sm"
                style={{ color: "var(--danger)" }}
                onClick={() => {
                  if (window.confirm(`删除对象「${obj.label}」？挂在它身上的关系会一并删掉。`)) {
                    onDelete();
                    onClose();
                  }
                }}
              >
                删除对象
              </button>
            )}
            {onToggleIgnore && (
              <button className="ghost sm" style={{ marginLeft: "auto" }} onClick={onToggleIgnore}>
                {ignored ? "恢复进本体" : "忽略（不进本体）"}
              </button>
            )}
            {onReplan && (
              <button className="ghost sm" style={onToggleIgnore ? undefined : { marginLeft: "auto" }} onClick={onReplan}>
                <ArrowCounterClockwise size={11} className="i-inline" />重新规划
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ---- 关系卡：名、显示名、基数、逆关系 ---- */
function LinkCard({ fromLabel, toLabel, link, onClose, onCreate, onUpdate, onDelete }: {
  fromLabel: string; toLabel: string; link: any | null;
  onClose: () => void;
  onCreate: (name: string, extra: { label?: string; inverse?: string; card?: string }) => string | null;
  onUpdate: (next: { name: string; label?: string; inverse?: string; card?: string }) => string | null;
  onDelete: () => void;
}) {
  const [name, setName] = useState(link?.name ?? "");
  const [lab, setLab] = useState(link?.label ?? "");
  const [inverse, setInverse] = useState(link?.inverse ?? "");
  const [card, setCard] = useState(link?.card ?? "n:1");
  const [err, setErr] = useState<string | null>(null);
  const extra = () => ({ label: lab, inverse, card });
  const submit = () => {
    const e = link ? onUpdate({ name, ...extra() }) : onCreate(name, extra());
    if (e) setErr(e);
    else onClose();
  };
  return (
    <div className="panel">
      <h3>{link ? "编辑关系" : "新建关系"}<span className="tag gray" style={{ marginLeft: 6 }}>{fromLabel} → {toLabel}</span></h3>
      <div className="oe-grid" style={{ marginTop: 6 }}>
        <label>关系名</label>
        <input autoFocus value={name} placeholder="如 works_in" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} />
        <label>显示名</label>
        <input value={lab} placeholder="如 任职于" onChange={(e) => setLab(e.target.value)} />
        <label>几个对几个</label>
        <select value={card} onChange={(e) => setCard(e.target.value)}>
          <option value="1:1">一对一</option>
          <option value="1:n">一对多</option>
          <option value="n:1">多对一</option>
          <option value="n:n">多对多</option>
        </select>
        <label>反过来叫</label>
        <input value={inverse} placeholder="如 下辖（可空）" onChange={(e) => setInverse(e.target.value)} />
      </div>
      {err && <div className="editor-err">{err}</div>}
      <div className="panel-actions" style={{ marginTop: 10, marginBottom: 0, alignItems: "center" }}>
        <button className="sm" onClick={submit}>{link ? "保存" : "连线"}</button>
        <button className="ghost sm" onClick={onClose}>取消</button>
        {link && (
          <button className="ghost sm" style={{ marginLeft: "auto", color: "var(--danger)" }} onClick={() => { onDelete(); onClose(); }}>
            删除关系
          </button>
        )}
      </div>
    </div>
  );
}

function QuestionsCard({ questions, onSave, onClose }: { questions: string[]; onSave: (qs: string[]) => void; onClose: () => void }) {
  const [qs, setQs] = useState<string[]>(questions.length ? [...questions] : [""]);
  return (
    <div className="panel">
      <h3>能力测试题</h3>
      <div className="hint">模型答得对不对，用这几句业务问题验收。发布后可在对话里直接问。</div>
      <div className="oe-props">
        {qs.map((q, i) => (
          <div className="oe-prop" key={i}>
            <input value={q} placeholder="如 查从候选人转正的员工及部门" onChange={(e) => setQs((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))} />
            <button className="ghost sm" onClick={() => setQs((xs) => xs.filter((_, j) => j !== i))}>删</button>
          </div>
        ))}
        <button className="ghost sm" onClick={() => setQs((xs) => [...xs, ""])}>添加问题</button>
      </div>
      <div className="panel-actions" style={{ marginTop: 10, marginBottom: 0 }}>
        <button className="sm" onClick={() => { onSave(qs); onClose(); }}>保存</button>
        <button className="ghost sm" onClick={onClose}>取消</button>
      </div>
    </div>
  );
}

/* ---- 发布（publish 步；有候选对时发布入口在裁决面板里）---- */
function PublishPanel({ data, actions }: { data: any; actions: WsActions }) {
  const parts = Object.entries(data.decisions ?? {});
  return (
    <div className="panel">
      <h3>发布合并本体</h3>
      <div className="hint">裁决结果合并为单一事实源 ontology.yaml，Git 版本化，版本号 +1</div>
      {parts.length === 0 ? (
        <div className="empty" style={{ padding: 20 }}>无裁决项——单源对象直接进入本体</div>
      ) : (
        parts.map(([k, v]) => (
          <div key={k} className="api-row">
            <span className="api-path">{PAIR_LABEL[k] ?? k}</span>
            <span className="api-desc" />
            <span className="tag">{String(v)}</span>
          </div>
        ))
      )}
      <div className="panel-actions" style={{ marginTop: 12, marginBottom: 0 }}>
        <button className="sm" onClick={actions.publish}>发布合并本体</button>
      </div>
    </div>
  );
}

/* ---- 问数 API 清单 ---- */
function ApiAssetList({ apis }: { apis: any[] }) {
  if (!apis?.length) return <div className="empty" style={{ padding: 24 }}>还没有问数 API——每问一个新问题，编译出的结构化查询会命名保存在这里</div>;
  return (
    <div>
      {apis.map((a: any) => (
        <div key={a.name} className="api-row" style={{ alignItems: "center" }}>
          <span className="ln-field">{a.name}</span>
          <span className="api-desc" style={{ marginLeft: 0, flex: 1 }}>{a.question}</span>
          <span className="tag gray">复用 {a.used} 次</span>
        </div>
      ))}
    </div>
  );
}

/* ---- 映射：已发布本体的字段去向。不取业务行，只展示「字段 ← 源列」。---- */
function AppView({ data }: { data: any }) {
  const objs = Object.values<any>(data.ontology.object_types).filter((o) => !o._ignored);
  const [tab, setTab] = useState(objs[0]?.name ?? "血缘");
  const obj = objs.find((o) => o.name === tab);

  const lineage = objs.flatMap((o) =>
    o.properties
      .filter((p: any) => !p.pk || o.sources.some((s: any) => s.fields[p.name]))
      .map((p: any) => ({
        label: `${o.label} · ${p.label ?? p.name}`,
        derived: p.derived as string | undefined,
        from: o.sources.filter((s: any) => s.fields[p.name]).map((s: any) => `${s.connection}.${s.table}.${s.fields[p.name]}`),
      })),
  );

  return (
    <div className="panel">
      <div className="hint" style={{ marginBottom: 8 }}>
        本体 v{data.version} · {objs.length} 个对象 · 这里只看字段从哪来，不取业务数据
      </div>
      <div className="gen-tabs">
        {objs.map((o) => (
          <button key={o.name} className={tab === o.name ? "active" : ""} onClick={() => setTab(o.name)}>{o.label}</button>
        ))}
        <button className={tab === "问数 API" ? "active" : ""} onClick={() => setTab("问数 API")}>问数 API</button>
        <button className={tab === "血缘" ? "active" : ""} onClick={() => setTab("血缘")}>血缘</button>
      </div>
      {obj && (
        <>
          <div className="hint" style={{ margin: "2px 0 8px" }}>
            来源：{obj.sources.length ? obj.sources.map((s: any) => `${s.connection}.${s.table}`).join(" + ") : "手动 · 无源"}（只读，未取行）
          </div>
          <div className="scrollbox" style={{ maxHeight: 320 }}>
            <table className="data">
              <thead><tr><th>字段</th><th>类型</th><th>来自源列</th></tr></thead>
              <tbody>
                {obj.properties.map((p: any) => {
                  const from = obj.sources
                    .filter((s: any) => s.fields[p.name])
                    .map((s: any) => `${s.connection}.${s.table}.${s.fields[p.name]}`);
                  return (
                    <tr key={p.name}>
                      <td>{p.label ?? p.name}</td>
                      <td style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--ink-2)" }}>{p.type}</td>
                      <td>
                        {p.derived
                          ? <span style={{ color: "var(--ink-3)" }}>派生：{p.derived}</span>
                          : from.length
                            ? from.map((x: string) => <span key={x} className="tag gray" style={{ marginRight: 4 }}>{x}</span>)
                            : <span style={{ color: "var(--ink-3)" }}>—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {tab === "问数 API" && (
        <>
          <div className="hint" style={{ marginBottom: 8 }}>问过的问题会在这里留下接口名。真正取数只发生在「对话」里，这里不拉行。</div>
          <ApiAssetList apis={data.apiAssets ?? []} />
        </>
      )}
      {tab === "血缘" && (
        <>
          <div className="hint" style={{ marginBottom: 8 }}>每个字段从哪来：对象字段 ← 源表列。不展示任何一行业务数据。</div>
          {lineage.map((r, i) => (
            <div key={i} className="api-row" style={{ alignItems: "baseline" }}>
              <span className="ln-field">{r.label}</span>
              <span className="ln-arrow">←</span>
              <span className="api-desc" style={{ fontFamily: r.derived ? undefined : "var(--mono)", fontSize: 11 }}>
                {r.derived ? `派生：${r.derived}` : r.from.join("  +  ")}
              </span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ---- 取数详情 ---- */
/* ================= 主组件：画布优先 =================
   工作台 = 一块永远可编辑的本体画布：
   - 画布内容 = 当前最好的模型（已发布合并本体 > 草稿并集 > 空态）
   - 步骤动作（连接表单/确认草稿/裁决/发布/生成）= 画布上的浮动卡
   - 表结构、出码产物 = 底部抽屉；画布可最大化
*/
// 草稿并集：对象名冲突时加源后缀；返回节点 id → 草稿归属的映射
function unionDrafts(drafts: any[]) {
  const object_types: Record<string, any> = {};
  const link_types: any[] = [];
  const meta: Record<string, { conn: string; orig: string }> = {};
  const linkMeta: Record<string, { conn: string; orig: string }> = {};
  for (const d of drafts) {
    const rename: Record<string, string> = {};
    for (const [name, o] of Object.entries<any>(d.ontology.object_types)) {
      const key = object_types[name] ? `${name}__${d.connection}` : name;
      rename[name] = key;
      object_types[key] = { ...o, name: key };
      meta[key] = { conn: d.connection, orig: name };
    }
    for (const l of d.ontology.link_types ?? []) {
      // 边 id 必须全局唯一：跨桶同名关系加源后缀（与对象同名处理一致）
      const key = link_types.some((x) => x.name === l.name) ? `${l.name}__${d.connection}` : l.name;
      link_types.push({ ...l, name: key, from: rename[l.from] ?? l.from, to: rename[l.to] ?? l.to });
      linkMeta[key] = { conn: d.connection, orig: l.name };
    }
  }
  const questions = drafts.flatMap((d) => d.ontology.questions ?? []).filter((q: string, i: number, a: string[]) => a.indexOf(q) === i);
  return { ont: { object_types, link_types, questions }, meta, linkMeta };
}

// 合并对象名 → 所属候选对（用于「重新规划」入口的显隐）
const PAIR_OF: Record<string, string> = {
  person: "person", candidate: "person", employee: "person",
  department: "department", department_recruiting: "department", department_hr: "department",
  position: "position", job_posting: "position", headcount_position: "position",
};

export default function Workspace({
  mode, badges, data,
  connectFlow, connectActions, decisionOpen, onDecisionOpen,
  actions, drawer, onDrawer, generating, identityAsk,
}: {
  mode: "wizard" | "editor";
  badges: Badges;
  data: any;
  drawer: null | "schema" | "code";
  onDrawer: (d: null | "schema" | "code") => void;
  connectFlow: any;
  connectActions: { test: () => void; save: () => void };
  decisionOpen: boolean;
  onDecisionOpen: (open: boolean) => void;
  generating: boolean;
  identityAsk: boolean;
  actions: WsActions;
}) {
  const [selObj, setSelObj] = useState<string | null>(null);
  const [qOpen, setQOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // 关系卡：{ from, to } = 连线后命名；{ name } = 点已有边编辑
  const [linkEdit, setLinkEdit] = useState<{ from?: string; to?: string; name?: string } | null>(null);

  // 最大化时 Esc 先关裁决面板，再退出最大化
  useEffect(() => {
    if (!maximized) return;
    const h = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (decisionOpen) onDecisionOpen(false);
      else setMaximized(false);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [maximized, decisionOpen, onDecisionOpen]);

  // 连接表单仅在「填写中」浮出；保存后自动打开表结构抽屉加表
  const formActive = !!connectFlow;

  // 阶段完全由状态推导——没有"步骤条"这种东西；发布即自动出码，向导到 publish 为止（之后是模型编辑器）
  const ev = data.evidence ?? [];
  const decisions = data.decisions ?? {};
  const allDecided = ev.length > 0 && ev.every((e: any) => decisions[pairKey(e)]);
  const phase = !data.schemas
    ? "connect"
    : !data.drafts?.length
      ? "connect"
      : !badges.confirmed
        ? "model"
        : ev.length > 0 && !allDecided
          ? "integrate"
          : "publish";
  const stepMeta = STEP_META[phase] ?? STEP_META.connect;
  const head =
    mode === "editor"
      ? { icon: ShareNetwork, color: "var(--accent)", title: `模型编辑器 · v${badges.version}${data.pending ? " · 有未发布改动" : ""}`, sub: data.pending ? "画布是工作副本——发布后才进映射" : "本体已发布 · 可持续演进" }
      : { icon: stepMeta.icon, color: "var(--accent)", title: `初始化建模 · ${PHASE_NAME[phase] ?? ""}`, sub: stepMeta.sub };
  const HeadIcon = head.icon;

  // 画布模型：已发布 > 草稿并集 > 空
  const union = !data.merged && data.drafts?.length ? unionDrafts(data.drafts) : null;
  const canvasOnt = data.merged ? data.merged.ontology : union?.ont ?? null;
  const nodeMeta: Record<string, { conn: string | null; orig: string }> = data.merged
    ? Object.fromEntries(Object.keys(data.merged.ontology.object_types).map((n) => [n, { conn: null, orig: n }]))
    : (union?.meta ?? {});
  const sel = selObj && canvasOnt ? canvasOnt.object_types[selObj] : null;
  const selMeta = selObj ? nodeMeta[selObj] : null;
  const selKind: "draft" | "merged" = data.merged ? "merged" : "draft";
  // 关系（边）的桶归属：已发布 → 全在 merged；草稿并集 → union 时记录的 linkMeta
  const linkMeta: Record<string, { conn: string | null; orig: string }> = data.merged
    ? Object.fromEntries((data.merged.ontology.link_types ?? []).map((l: any) => [l.name, { conn: null, orig: l.name }]))
    : (union?.linkMeta ?? {});
  const editingLink = linkEdit?.name && canvasOnt ? (canvasOnt.link_types.find((l: any) => l.name === linkEdit.name) ?? null) : null;
  const objLabel = (k?: string) => (k && canvasOnt?.object_types[k]?.label) || k || "";
  // 已加入画布的表 = 草稿来源 ∪ 已发布本体来源（表结构抽屉里的「已加入」态）
  const stagedSet = new Set<string>([
    ...(data.drafts ?? []).flatMap((d: any) =>
      Object.values<any>(d.ontology.object_types).filter((o) => !o._ignored).flatMap((o) => o.sources.map((s: any) => `${s.connection}.${s.table}`)),
    ),
    ...Object.values<any>(data.merged?.ontology.object_types ?? {}).flatMap((o) => o.sources.map((s: any) => `${s.connection}.${s.table}`)),
  ]);
  // 源列 → 本体字段 的映射索引：schema 抽屉标出每列的去向（多对多：一列可喂多个对象）
  const mapIndex: Record<string, string[]> = {};
  const ontObjs = data.merged
    ? Object.values<any>(data.merged.ontology.object_types)
    : (data.drafts ?? []).flatMap((d: any) => Object.values<any>(d.ontology.object_types));
  for (const o of ontObjs) {
    if (o._ignored) continue;
    for (const s of o.sources ?? []) {
      for (const [prop, col] of Object.entries(s.fields ?? {})) {
        const k = `${s.connection}.${s.table}.${col}`;
        (mapIndex[k] = mapIndex[k] ?? []).push(`${o.name}.${prop}`);
      }
    }
  }
  const canReplan = !!(
    sel && selMeta && data.merged &&
    (data.evidence ?? []).some((e: any) => pairKey(e) === PAIR_OF[selMeta.orig])
  );

  return (
    <div className="ws-col always">
      <div className="ws-head">
        <span className="ws-icon" style={{ background: head.color }}><HeadIcon size={13} /></span>
        <div className="ws-tt">
          <div className="wt">{head.title}</div>
          <div className="ws">{head.sub}</div>
        </div>
      </div>

      <>
        {/* 工具条：加数据源导入 / 选表 / 手动新建——画布两种输入法并列 */}
          <div className="ws-toolbar">
            <button className={`${data.schemas ? "ghost" : "primary"} sm`} onClick={actions.connect}>
              <Plus size={11} className="i-inline" />{data.schemas ? "添加数据源" : "连接数据源"}
            </button>
            <button
              className="ghost sm"
              onClick={() => {
                const name = actions.createObject();
                if (name) setSelObj(name);
              }}
              title="手动新建一个对象（无源），在编辑卡里命名、加字段"
            >
              <Plus size={11} className="i-inline" />新建对象
            </button>
            <button className="ghost sm" onClick={() => setQOpen(true)} title="用业务问题验收这个本体">
              测试题
            </button>
            <span className="grow" />
            {(data.history?.length ?? 0) > 1 && (
              <select
                className="ver-rollback"
                value=""
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (v) actions.rollback(v);
                }}
              >
                <option value="" disabled>回滚…</option>
                {[...data.history].reverse().map((h: any) => (
                  <option key={h.version} value={h.version} disabled={h.version === badges.version}>
                    v{h.version}{h.note ? `（${h.note}）` : ""} · {new Date(h.at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}
                  </option>
                ))}
              </select>
            )}
            <button
              className={`ghost sm ${maximized ? "tool-active" : ""}`}
              onClick={() => setMaximized(!maximized)}
              title={maximized ? "退出最大化（Esc）" : "最大化画布，专注看图"}
            >
              {maximized ? <CornersIn size={13} /> : <CornersOut size={13} />}
            </button>
          </div>

          {/* 画布（最大化入口在工具条；这里只在最大化时给退出按钮——工具条被遮住了） */}
          <div className={`canvas-wrap ${maximized ? "max" : ""}`}>
            {maximized && (
              <button className="ghost sm canvas-max" onClick={() => setMaximized(false)} title="退出最大化（Esc）">
                <CornersIn size={13} />
              </button>
            )}
            <div className="canvas-main">
              {canvasOnt ? (
                <OntologyGraph
                  ontology={canvasOnt}
                  selected={selObj}
                  onSelect={setSelObj}
                  onConnect={(a, b) => setLinkEdit({ from: a, to: b })}
                  onEdgeSelect={(id) => setLinkEdit({ name: id })}
                />
              ) : (
                <div className="canvas-hint">
                  <div className="ch-ic"><ShareNetwork size={22} weight="duotone" /></div>
                  <div className="ch-t">画布还是空的</div>
                  <div className="ch-d">先连上源库让 AI 读表建模，或直接新建对象手动搭</div>
                  <div className="ch-steps">
                    <span className="ch-step"><b>1</b>连接数据源</span>
                    <span className="ch-step"><b>2</b>勾选表</span>
                    <span className="ch-step"><b>3</b>生成对象上画布</span>
                  </div>
                </div>
              )}
            </div>

            {/* 浮动卡：连接表单（左上） */}
            {formActive && (
              <div className="cv-float cv-tl"><ConnectPanel flow={connectFlow} onTest={connectActions.test} onSave={connectActions.save} /></div>
            )}
            {/* 裁决：与识别字段卡互斥，同一时间底中只一张 */}
            {!identityAsk && mode === "wizard" && ev.length > 0 && ((!data.merged && badges.confirmed) || (decisionOpen && data.merged)) && (
              <div className="cv-float cv-bc">
                <DecisionPanel
                  data={data}
                  merged={!!data.merged}
                  actions={actions}
                  onClose={data.merged ? () => onDecisionOpen(false) : undefined}
                />
              </div>
            )}

            {/* 生成后至多一张抉择卡；答完自动进裁决/发布 */}
            {identityAsk && (
              <div className="cv-float cv-bc">
                <div className="panel">
                  <h3>有个判断需要你定</h3>
                  <div className="hint" style={{ lineHeight: 1.7 }}>
                    对象已在画布上。candidate.idcard_no 和 employee.id_card 都是身份证格式——要把<b>身份证</b>设为「识别字段」吗？跨源认人、算交集率都靠它。
                  </div>
                  <div className="panel-actions" style={{ marginTop: 10, marginBottom: 0 }}>
                    <button className="sm" onClick={() => actions.confirmIdentity(true)}>可以，设为识别字段</button>
                    <button className="ghost sm" onClick={() => actions.confirmIdentity(false)} title="不设则跨源无法比对，候选对交集率会显示「无可比对标识」">先不设</button>
                  </div>
                </div>
              </div>
            )}

            {/* 浮动条：未发布改动——编辑→发布交互（画布=工作副本，应用=已发布版本） */}
            {data.pending && !(decisionOpen && data.merged) && !identityAsk && (
              <div className="cv-float cv-bc">
                <div className="panel pub-bar">
                  <span className="pb-dot" aria-hidden />
                  <span className="pb-t">画布有未发布改动 · 已发布还是 v{badges.version}</span>
                  <button className="sm" onClick={actions.publishChanges}>发布 v{(badges.version ?? 0) + 1}</button>
                  <button className="ghost sm" onClick={actions.discardChanges}>放弃</button>
                </div>
              </div>
            )}

            {/* 无候选对才出发布入口；evidence 必须已经算完（数组），避免请求中误闪 */}
            {!formActive && !identityAsk && mode === "wizard" && badges.confirmed && Array.isArray(data.evidence) && data.evidence.length === 0 && !data.merged && (
              <div className="cv-float cv-bl"><PublishPanel data={data} actions={actions} /></div>
            )}

            {/* 浮动卡：对象编辑（右侧） */}
            {sel && selMeta && (
              <div className="cv-float cv-right">
                <ObjectEditor
                  key={`${selMeta.orig}|${sel.label}|${sel.identity ?? ""}|${sel.properties.map((p: any) => `${p.name}:${p.label ?? ""}:${p.type}`).join(",")}`}
                  obj={{ ...sel, name: selMeta.orig }}
                  schemas={data.schemas ?? []}
                  peers={Object.values<any>(canvasOnt?.object_types ?? {}).map((o) => ({ name: o.name, label: o.label }))}
                  onClose={() => setSelObj(null)}
                  onSave={(o) => actions.updateObject(selKind, selMeta.conn, selMeta.orig, o)}
                  onSaveYaml={(t) => actions.applyObjectYaml(selKind, selMeta.conn, selMeta.orig, t)}
                  ignored={!!sel._ignored}
                  onToggleIgnore={selKind === "draft" && selMeta.conn ? () => actions.toggleIgnore(selMeta.conn!, selMeta.orig) : undefined}
                  onReplan={canReplan ? () => { actions.replanObject(selMeta.orig); setSelObj(null); } : undefined}
                  onDelete={
                    selKind === "merged" || selMeta.conn === "manual"
                      ? () => actions.deleteObject(selKind, selMeta.conn, selMeta.orig)
                      : undefined
                  }
                />
              </div>
            )}

            {/* 浮动卡：关系（连线后命名 / 点边改名、删除） */}
            {canvasOnt && (editingLink || (linkEdit?.from && linkEdit?.to)) && (
              <div className="cv-float cv-tc">
                <LinkCard
                  key={editingLink ? editingLink.name : `${linkEdit!.from}→${linkEdit!.to}`}
                  fromLabel={objLabel(editingLink ? editingLink.from : linkEdit!.from)}
                  toLabel={objLabel(editingLink ? editingLink.to : linkEdit!.to)}
                  link={editingLink}
                  onClose={() => setLinkEdit(null)}
                  onCreate={(name, extra) => {
                    const f = nodeMeta[linkEdit!.from!];
                    const t = nodeMeta[linkEdit!.to!];
                    return actions.createLink({ conn: f.conn, name: f.orig }, { conn: t.conn, name: t.orig }, name, extra);
                  }}
                  onUpdate={(patch) => {
                    const m = linkMeta[linkEdit!.name!];
                    return actions.updateLink(m?.conn ?? null, m?.orig ?? linkEdit!.name!, patch);
                  }}
                  onDelete={() => {
                    const m = linkMeta[linkEdit!.name!];
                    actions.deleteLink(m?.conn ?? null, m?.orig ?? linkEdit!.name!);
                  }}
                />
              </div>
            )}
            {qOpen && (
              <div className="cv-float cv-tl">
                <QuestionsCard
                  questions={canvasOnt?.questions ?? data.merged?.ontology.questions ?? []}
                  onSave={actions.setQuestions}
                  onClose={() => setQOpen(false)}
                />
              </div>
            )}
          </div>

          {/* 底部抽屉：表结构 / 映射 */}
          {drawer && (
            <div className="ws-drawer">
              <div className="wd-head">
                <b>{drawer === "schema" ? "源库表结构" : "映射"}</b>
                <button className="ghost sm" onClick={() => onDrawer(null)}><X size={12} /></button>
              </div>
              <div className="wd-body">
                {drawer === "schema" && (
                  <SchemaView
                    data={data.schemas ?? []}
                    mapIndex={mapIndex}
                    staged={stagedSet}
                    locked={!!badges.confirmed || !!data.merged}
                    staging={data.staging ?? {}}
                    generating={generating}
                    stageActions={{
                      toggle: actions.toggleStage,
                      toggleCol: actions.toggleStageColumn,
                      selectAll: actions.selectAllTables,
                      clear: actions.clearStaging,
                      generate: actions.generate,
                      unstage: actions.unstage,
                    }}
                  />
                )}
                {drawer === "code" && data.merged && (
                  <AppView data={{ ontology: (data.history?.at(-1)?.ontology ?? data.merged.ontology), version: data.history?.at(-1)?.version ?? badges.version, apiAssets: data.apis }} />
                )}
              </div>
            </div>
          )}

          {/* 底部标签条：抽屉入口常驻这里，不占顶部工具条 */}
          {(data.schemas || data.merged) && (
            <div className="ws-tabs">
              {data.schemas && (
                <button className={`ws-tab ${drawer === "schema" ? "active" : ""}`} onClick={() => onDrawer(drawer === "schema" ? null : "schema")}>
                  <Database size={12} className="i-inline" />表结构
                </button>
              )}
              {data.merged && (
                <button className={`ws-tab ${drawer === "code" ? "active" : ""}`} onClick={() => onDrawer(drawer === "code" ? null : "code")}>
                  <TreeStructure size={12} className="i-inline" />映射
                </button>
              )}
            </div>
          )}
        </>
    </div>
  );
}
