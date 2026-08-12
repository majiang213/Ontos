"use client";

// 工作台 v4 —— 画布优先：一块永远可编辑的本体画布；
// 步骤动作是画布上的浮动卡，表结构/出码产物在底部抽屉，画布可最大化。
import { useEffect, useState } from "react";
import {
  Database, PencilRuler, ShareNetwork, Code, Scales, GitMerge,
  X, ArrowCounterClockwise, Key,
  CaretLeft, CaretRight, Lightbulb, Plus, CheckCircle, LockSimple, Circle,
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
  reopenDecisions: () => void;
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
  publishChanges: () => void; // 发布后画布改动 → 显式发布升版本
  rollback: (v: number) => void;
  // 选表上画布
  stage: (conn: string, table: string) => void;
  unstage: (conn: string, table: string) => void;
  stageAll: () => void;
  // 手动新建对象（无源）
  createObject: () => string;
  // 画布连线与删除
  createLink: (from: { conn: string | null; name: string }, to: { conn: string | null; name: string }, name: string) => string | null;
  renameLink: (conn: string | null, orig: string, next: string) => string | null;
  deleteLink: (conn: string | null, orig: string) => void;
  deleteObject: (kind: "draft" | "merged", conn: string | null, objName: string) => string | null;
}

const STEP_META: Record<string, { icon: React.ComponentType<{ size?: number }>; sub: string }> = {
  connect: { icon: Database, sub: "M1 连接器 · 只读" },
  model: { icon: PencilRuler, sub: "M2 AI 逆向建模" },
  integrate: { icon: Scales, sub: "M3 整合裁决" },
  publish: { icon: GitMerge, sub: "M4 · 单一事实源" },
};
const PHASE_NAME: Record<string, string> = {
  connect: "连接数据源",
  model: "逆向建模",
  integrate: "多源整合",
  publish: "发布本体",
};

/* ---- 通用小块 ---- */
function CodeBlock({ file, tag, children, maxH = 260 }: { file: string; tag?: string; children: string; maxH?: number }) {
  return (
    <div className="codeblock">
      <div className="cb-head">
        <span className="cb-file">{file}</span>
        {tag && <span className="cb-tag">{tag}</span>}
      </div>
      <pre className="cb-body" style={{ maxHeight: maxH }}>{children}</pre>
    </div>
  );
}

/* ---- 连接表单（工作台面板版）---- */
function ConnectPanel({ flow, onTest, onSave }: { flow: any; onTest: () => void; onSave: () => void }) {
  const c = connFor(flow.idx);
  return (
    <div className="panel">
      <h3>配置数据源 · {c.connection} <span className="tag gray">第 {flow.idx + 1} 个</span></h3>
      <div className="hint">只读账号 · 永不写源库 · 采样仅用于语义判断</div>
      <div className="hint" style={{ marginTop: -8 }}>演示配置已预填——先测试，再保存；可以只连一个，也可以任意加。</div>
      {c.reused && <div className="hint" style={{ color: "var(--warn)" }}>演示后端将复用「{c.backend}」的数据（仅演示环境）</div>}
      <div className="conn-grid">
        <label>类型</label><input defaultValue={c.label} readOnly />
        <label>主机</label><input defaultValue={c.host} />
        <label>端口</label><input defaultValue={c.port} />
        <label>数据库</label><input defaultValue={c.database} />
        <label>只读账号</label><input defaultValue={c.user} />
        <label>密码</label><input type="password" defaultValue={c.password} />
      </div>
      <div className="panel-actions" style={{ marginTop: 12, marginBottom: 0 }}>
        <button className="ghost sm" onClick={onTest} disabled={flow.testing || flow.tested}>
          {flow.testing ? "测试中…" : flow.tested ? "✓ 连接成功" : "测试连接"}
        </button>
        <button className="sm" disabled={!flow.tested} onClick={onSave}>保存 →</button>
      </div>
    </div>
  );
}

/* ---- 裁决面板：LLM 建议一次给全，人逐对审阅定案（裁决权在人，留痕可回滚）---- */
const REL_OPTIONS = [
  { t: "①", name: "完全等价", desc: "同一业务概念，合并为单对象挂多源" },
  { t: "②", name: "部分重叠", desc: "上位对象承载公共属性，各自保留特有属性" },
  { t: "③", name: "生命周期阶段", desc: "统一对象 + 状态属性 + 阶段转化关系" },
  { t: "⑤", name: "仅名字像", desc: "语义不同，不合并，各自独立" },
];
const PAIR_LABEL: Record<string, string> = { person: "人员", department: "部门", position: "职位" };

function DecisionPanel({ data, merged, actions, onClose }: { data: any; merged: boolean; actions: WsActions; onClose?: () => void }) {
  const ev = data.evidence ?? [];
  const decisions = data.decisions ?? {};
  const allDone = ev.length > 0 && ev.every((e: any) => decisions[pairKey(e)]);
  // 业务警示：裁决的业务判断即时提示，不发消息
  const warn =
    decisions.person === "①"
      ? "人员按①等价合并会丢掉“转正”的时间维度——“查转正员工”将答不上来。"
      : decisions.person === "⤼"
        ? "人员这对暂不合并——两源各自独立进本体，随时可重裁。"
        : null;
  return (
    <div className="panel">
      <h3>
        候选对裁决
        {onClose && <button className="ghost sm" style={{ float: "right" }} onClick={onClose} title="收起面板"><X size={12} /></button>}
      </h3>
      <div className="hint">每对都带 LLM 建议（「建议」标）和交集率硬证据——逐对过目点选，裁决权在你</div>
      {ev.map((e: any) => {
        const key = pairKey(e);
        const sel = decisions[key];
        return (
          <div key={e.pair} className="dc-pair">
            <div className="dc-head">
              <b>{PAIR_LABEL[key] ?? key}</b>
              <span className="dc-pairname">{e.pair}</span>
            </div>
            <div className="q-ev">
              {e.rate === null
                ? "无可比对标识字段——数据层无法证明是同一批实体"
                : <>交集率 <b>{(e.rate * 100).toFixed(0)}%</b>（{e.rule}）· A={e.countA} 行 / B={e.countB} 行 / ∩={e.intersection} · 内存计算不落地</>}
            </div>
            <div className="q-ev hint2"><Lightbulb size={12} className="i-inline" />{e.reason}</div>
            <div className="dc-opts">
              {REL_OPTIONS.map((o) => (
                <button key={o.t} className={`dc-opt ${sel === o.t ? "sel" : ""}`} title={`${o.name}：${o.desc}`} onClick={() => actions.setDecision(key, o.t)}>
                  {o.t} {o.name}{o.t === e.suggestion && <span className="dsug">建议</span>}
                </button>
              ))}
              <button className={`dc-opt ${sel === "⤼" ? "sel" : ""}`} title="暂不合并，各自独立，随时可重裁" onClick={() => actions.setDecision(key, "⤼")}>跳过</button>
            </div>
          </div>
        );
      })}
      {warn && <div className="hint" style={{ color: "var(--warn)" }}>{warn}</div>}
      <div className="panel-actions" style={{ marginTop: 10, marginBottom: 0 }}>
        {!allDone && <button className="ghost sm" onClick={actions.decideAll}>都按建议</button>}
        <button className="sm" disabled={!allDone} onClick={actions.publish}>{merged ? "按新裁决重新发布" : "发布合并本体 →"}</button>
      </div>
    </div>
  );
}

/* ---- M1 Schema（只读原料列表：每列标出映射到哪个本体字段；「加入画布」把表变成画布节点）---- */
function SchemaView({ data, mapIndex = {}, staged, locked, stageActions }: {
  data: any[];
  mapIndex?: Record<string, string[]>;
  staged?: Set<string>; // 已加入画布的表（草稿 ∪ 已发布本体的来源）
  locked?: boolean; // 已确认/已发布后不可移出，只能加
  stageActions?: { stage: (c: string, t: string) => void; unstage: (c: string, t: string) => void; stageAll: () => void };
}) {
  return (
    <div className="grid" style={{ gap: 12 }}>
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
              const on = staged?.has(`${db.connection}.${t.name}`);
              return (
                <details key={t.name} className="tbl-acc">
                  <summary>
                    <span className="mono">{t.name}</span>
                    <span className="tag gray">{t.comment}</span>
                    <span className="rows-n">{t.rowCount} 行 · {mapped}/{t.columns.length} 列已映射</span>
                    {stageActions && (
                      on ? (
                        locked ? (
                          <span className="tag ok" onClick={(e) => e.preventDefault()}>已加入</span>
                        ) : (
                          <button className="ghost sm" onClick={(e) => { e.preventDefault(); stageActions.unstage(db.connection, t.name); }}>移出</button>
                        )
                      ) : (
                        <button className="sm" onClick={(e) => { e.preventDefault(); stageActions.stage(db.connection, t.name); }}>加入画布</button>
                      )
                    )}
                  </summary>
                  <div className="tbl-acc-body">
                    <table className="data">
                      <tbody>
                        {t.columns.map((c: any) => {
                          const to = mapIndex[`${db.connection}.${t.name}.${c.name}`];
                          return (
                            <tr key={c.name}>
                              <td>{c.pk ? <Key size={10} className="i-inline" /> : null}{c.name}</td>
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
                    <CodeBlock file={`采样 · 前 ${t.sample.length} 行`} maxH={120}>
                      {t.sample.map((r: any) => Object.values(r).join(" | ")).join("\n")}
                    </CodeBlock>
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
function ObjectEditor({ obj, schemas, onSave, onSaveYaml, onClose, ignored, onToggleIgnore, onReplan, onDelete }: {
  obj: any; schemas: any[]; onSave: (o: any) => string | null; onSaveYaml: (text: string) => string | null; onClose: () => void;
  ignored?: boolean; onToggleIgnore?: () => void; onReplan?: () => void; onDelete?: () => void;
}) {
  const [label, setLabel] = useState(obj.label ?? "");
  const [identity, setIdentity] = useState(obj.identity ?? "");
  const [props, setProps] = useState<any[]>(obj.properties.map((p: any) => ({ ...p })));
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
      properties: props.map(({ _new, ...p }) => p),
      sources,
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
        {!yamlMode && (
          <button
            className="ghost sm"
            style={{ marginLeft: "auto" }}
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
        <button className="ghost sm" style={yamlMode ? { marginLeft: "auto" } : undefined} onClick={onClose}><X size={12} /></button>
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
            <label>识别字段</label><input value={identity} placeholder="跨源认人的属性，如 id_card" onChange={(e) => setIdentity(e.target.value)} />
          </div>
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

/* ---- 关系卡：连线后命名；点已有边可改名/删除 ---- */
function LinkCard({ fromLabel, toLabel, link, onClose, onCreate, onRename, onDelete }: {
  fromLabel: string; toLabel: string; link: any | null;
  onClose: () => void; onCreate: (name: string) => string | null;
  onRename: (next: string) => string | null; onDelete: () => void;
}) {
  const [name, setName] = useState(link?.name ?? "");
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const e = link ? onRename(name) : onCreate(name);
    if (e) setErr(e);
    else onClose();
  };
  return (
    <div className="panel">
      <h3>{link ? "编辑关系" : "新建关系"}<span className="tag gray" style={{ marginLeft: 6 }}>{fromLabel} → {toLabel}</span></h3>
      <div className="oe-grid" style={{ marginTop: 6 }}>
        <label>关系名</label>
        <input
          autoFocus
          value={name}
          placeholder="如 works_in"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
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

/* ---- 新系统（本体即应用）：对象数据实时查源库，无出码、无新库、数据永不迁移 ---- */
function AppView({ data }: { data: any }) {
  const objs = Object.values<any>(data.ontology.object_types).filter((o) => !o._ignored);
  const [tab, setTab] = useState(objs[0]?.name ?? "");
  const [rows, setRows] = useState<any[] | null>(null);
  const [srcNote, setSrcNote] = useState("");
  const obj = objs.find((o) => o.name === tab);
  useEffect(() => {
    if (!obj) return;
    let dead = false;
    setRows(null);
    fetch("/api/objects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ontology: data.ontology, object: obj.name }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (dead) return;
        setRows(res.rows ?? []);
        setSrcNote((res.sources ?? []).join(" + "));
      })
      .catch(() => { if (!dead) setRows([]); });
    return () => { dead = true; };
  }, [obj?.name, data.ontology]);

  // 血缘直接从本体算：对象字段 ← 源列；代理主键（无源 uuid pk）不进血缘
  const lineage = objs.flatMap((o) =>
    o.properties
      .filter((p: any) => !p.pk || o.sources.some((s: any) => s.fields[p.name]))
      .map((p: any) => ({
        label: `${o.label} · ${p.label ?? p.name}`,
        derived: p.derived as string | undefined,
        from: o.sources.filter((s: any) => s.fields[p.name]).map((s: any) => `${s.connection}.${s.table}.${s.fields[p.name]}`),
      })),
  );
  const hasDept = (rows ?? []).some((r) => r.dept !== undefined);
  const cols = obj ? [...obj.properties.map((p: any) => ({ name: p.name, label: p.label ?? p.name })), ...(hasDept ? [{ name: "dept", label: "部门" }] : [])] : [];

  return (
    <div className="panel">
      <div className="hint" style={{ marginBottom: 8 }}>
        本体 v{data.version} 驱动 · {objs.length} 个对象 · 数据实时查源库、永不迁移
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
          <div className="hint" style={{ margin: "2px 0 8px" }}>来源：{srcNote || "—"}（只读）</div>
          <div className="scrollbox" style={{ maxHeight: 320 }}>
            <table className="data">
              <thead><tr>{cols.map((c) => <th key={c.name}>{c.label}</th>)}<th>来源</th></tr></thead>
              <tbody>
                {(rows ?? []).map((r, i) => (
                  <tr key={i}>
                    {cols.map((c) => <td key={c.name}>{r[c.name] ?? "—"}</td>)}
                    <td><span className="tag gray">{r._src ?? (obj.sources.length > 1 ? obj.sources.map((s: any) => s.connection).join("+") : obj.sources[0]?.connection)}</span></td>
                  </tr>
                ))}
                {rows === null && <tr><td colSpan={cols.length + 1} style={{ color: "var(--ink-3)" }}>查询中…</td></tr>}
                {rows?.length === 0 && <tr><td colSpan={cols.length + 1} style={{ color: "var(--ink-3)" }}>无数据</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
      {tab === "问数 API" && (
        <>
          <div className="hint" style={{ marginBottom: 8 }}>应用的对外只读接口——每问一个新问题，编译出的结构化查询命名保存在这里，实时查源库</div>
          <ApiAssetList apis={data.apiAssets ?? []} />
        </>
      )}
      {tab === "血缘" && (
        <>
          <div className="hint" style={{ marginBottom: 8 }}>每个字段的数据从哪来：对象字段 ← 源表列；「派生」字段按规则计算，不直接来自任何一列</div>
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
  return { ont: { object_types, link_types }, meta, linkMeta };
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
  actions, collapsed, onToggleCollapse,
  drawer, onDrawer,
}: {
  mode: "wizard" | "editor";
  badges: Badges;
  data: any;
  collapsed: boolean;
  onToggleCollapse: () => void;
  drawer: null | "schema" | "code";
  onDrawer: (d: null | "schema" | "code") => void;
  connectFlow: any;
  connectActions: { test: () => void; save: () => void };
  decisionOpen: boolean;
  onDecisionOpen: (open: boolean) => void;
  actions: WsActions;
}) {
  const [selObj, setSelObj] = useState<string | null>(null);
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
      ? { icon: ShareNetwork, color: "var(--accent)", title: `模型编辑器 · v${badges.version}${data.pending ? " · 有未发布改动" : ""}`, sub: data.pending ? "画布是工作副本——发布后才生效到新系统" : "本体已发布 · 可持续演进" }
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

  // 收起态：右侧一条细栏，点击展开
  if (collapsed) {
    return (
      <div className="ws-col always collapsed">
        <button className="ws-rail" onClick={onToggleCollapse} title="展开工作台">
          <CaretLeft size={14} />
          <span className="ws-rail-label">工作台</span>
        </button>
      </div>
    );
  }

  return (
    <div className="ws-col always">
      <div className="ws-head">
        <span className="ws-icon" style={{ background: head.color }}><HeadIcon size={13} /></span>
        <div className="ws-tt">
          <div className="wt">{head.title}</div>
          <div className="ws">{head.sub}</div>
        </div>
        <button className="ghost sm ws-collapse" onClick={onToggleCollapse} title="收起工作台"><CaretRight size={13} /></button>
      </div>

      <>
        {/* 工具条：加数据源导入 / 选表 / 手动新建——画布两种输入法并列 */}
          <div className="ws-toolbar">
            <button className="ghost sm" onClick={actions.connect}>
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
            <span className="grow" />
            {data.pending && (
              <button className="sm" onClick={actions.publishChanges} title="画布是工作副本——发布后新系统才同步到最新版本">
                发布 v{(badges.version ?? 0) + 1}
              </button>
            )}
            {data.merged && (
              <button className="ghost sm" onClick={() => actions.reopenDecisions()} title="清空全部裁决，重新逐对裁决">
                <ArrowCounterClockwise size={11} className="i-inline" />全部重裁
              </button>
            )}
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
            {data.schemas && (
              <button className={`ghost sm ${drawer === "schema" ? "tool-active" : ""}`} onClick={() => onDrawer(drawer === "schema" ? null : "schema")}>
                <Database size={11} className="i-inline" />表结构
              </button>
            )}
            {data.merged && (
              <button className={`ghost sm ${drawer === "code" ? "tool-active" : ""}`} onClick={() => onDrawer(drawer === "code" ? null : "code")}>
                <Code size={11} className="i-inline" />新系统
              </button>
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
                  <ShareNetwork size={22} weight="light" />
                  <div className="ch-t">画布还是空的</div>
                  <div className="ch-d">从上方工具条「连接数据源」导入，或「新建对象」手动搭建</div>
                </div>
              )}
            </div>

            {/* 浮动卡：连接表单（左上） */}
            {formActive && (
              <div className="cv-float cv-tl"><ConnectPanel flow={connectFlow} onTest={connectActions.test} onSave={connectActions.save} /></div>
            )}
            {/* 浮动卡：裁决面板（底中；确认草稿后自动浮出直到发布，发布后由「全部重裁/重新规划」再开） */}
            {mode === "wizard" && ev.length > 0 && ((!data.merged && badges.confirmed) || (decisionOpen && data.merged)) && (
              <div className="cv-float cv-bc">
                <DecisionPanel
                  data={data}
                  merged={!!data.merged}
                  actions={actions}
                  onClose={data.merged ? () => onDecisionOpen(false) : undefined}
                />
              </div>
            )}

            {/* 浮动卡：阶段动作（左下，全部由状态驱动） */}
            {!formActive && mode === "wizard" && data.drafts?.length > 0 && !badges.confirmed && (
              <div className="cv-float cv-bl">
                <div className="panel">
                  <b style={{ fontSize: 13.5 }}>草稿已生成，等你确认</b>
                  <div className="hint" style={{ margin: "4px 0 10px" }}>点画布上的对象核对语义、改字段；噪音对象在编辑卡里忽略（不进本体）。</div>
                  <button className="sm" onClick={actions.confirmDrafts}>确认草稿</button>
                </div>
              </div>
            )}
            {!formActive && mode === "wizard" && badges.confirmed && ev.length === 0 && !data.merged && (
              <div className="cv-float cv-bl"><PublishPanel data={data} actions={actions} /></div>
            )}

            {/* 浮动卡：对象编辑（右侧） */}
            {sel && selMeta && (
              <div className="cv-float cv-right">
                <ObjectEditor
                  key={`${selMeta.orig}|${sel.label}|${sel.identity ?? ""}|${sel.properties.map((p: any) => `${p.name}:${p.label ?? ""}:${p.type}`).join(",")}`}
                  obj={{ ...sel, name: selMeta.orig }}
                  schemas={data.schemas ?? []}
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
                  onCreate={(name) => {
                    const f = nodeMeta[linkEdit!.from!];
                    const t = nodeMeta[linkEdit!.to!];
                    return actions.createLink({ conn: f.conn, name: f.orig }, { conn: t.conn, name: t.orig }, name);
                  }}
                  onRename={(next) => {
                    const m = linkMeta[linkEdit!.name!];
                    return actions.renameLink(m?.conn ?? null, m?.orig ?? linkEdit!.name!, next);
                  }}
                  onDelete={() => {
                    const m = linkMeta[linkEdit!.name!];
                    actions.deleteLink(m?.conn ?? null, m?.orig ?? linkEdit!.name!);
                  }}
                />
              </div>
            )}
          </div>

          {/* 底部抽屉：表结构 / 出码产物 */}
          {drawer && (
            <div className="ws-drawer">
              <div className="wd-head">
                <b>{drawer === "schema" ? "源库表结构" : "新系统"}</b>
                <button className="ghost sm" onClick={() => onDrawer(null)}><X size={12} /></button>
              </div>
              <div className="wd-body">
                {drawer === "schema" && (
                  <SchemaView
                    data={data.schemas ?? []}
                    mapIndex={mapIndex}
                    staged={stagedSet}
                    locked={!!badges.confirmed || !!data.merged}
                    stageActions={{ stage: actions.stage, unstage: actions.unstage, stageAll: actions.stageAll }}
                  />
                )}
                {drawer === "code" && data.merged && (
                  <AppView data={{ ontology: (data.history?.at(-1)?.ontology ?? data.merged.ontology), version: data.history?.at(-1)?.version ?? badges.version, apiAssets: data.apis }} />
                )}
              </div>
            </div>
          )}
        </>
    </div>
  );
}
