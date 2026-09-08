// 对象编辑卡：头部（对象名 / 描述 / 唯一键）+ 字段 / 阶段 / 动作 / 来源 四个标签页 + 底部删除。
// 阶段页一块一个阶段：中文名为主、标识(key)为辅——中文名点击轻改，「改标识」级联改写动作前置与转化关系（带确认）；
// 可上下移、条件全文（explainWhen）、出向转化（转为谁 + 执行动作的前置效应）。
// 换卡即重挂（父级按对象名给 key），表单状态自然清；脏表单取消要确认，开着期间外部改动先问再盖；表单开着时其余标签页锁住。
// 表单状态经 onFormState 回调报给页面（监视器豁免、Esc 守卫、切换守卫），页面不再递 ref 下来。

"use client";

import { useEffect, useRef, useState } from "react";
import Bezel from "./Bezel";
import AutoTextarea from "./AutoTextarea";
import { ActionForm } from "../forms/ActionForm";
import { FieldForm, Section } from "./FieldForm";
import { effectSummary, formCompatible, preSummary } from "../forms/actionView";
import { MSG } from "../../server/errors";
import { enumValueKey, enumValueLabel, type ActionDef, type EnumValue, type OntologyConfig, type ObjectType } from "../../server/schema/config";
import { classStages, explainWhen, moveStageItem, type StageItem } from "../../server/features/ontology/stages";
import { sourceLabel } from "../sourceLabel";

export type ActionFormState = { mode: "create" } | { mode: "edit"; name: string } | null;

/** 卡内表单状态：页面拿它做监视器豁免（busy）、Esc 守卫（actionForm）、切换对象守卫（actionDirty）。 */
export interface ObjectFormState {
  busy: boolean; // 字段表单或动作表单开着：轮询不冲掉未保存内容
  actionForm: ActionFormState; // 动作表单开没开、开的哪条
  actionDirty: boolean; // 动作表单里有未保存改动
}

const FORM_IDLE: ObjectFormState = { busy: false, actionForm: null, actionDirty: false };

type TabKey = "fields" | "stages" | "actions" | "sources";

/** 一条动作的前置与效应白话：前置一行（顿号连），效应一条一「·」行。动作区与阶段页的转化块共用。 */
function PreEffect({ def, ont, clsName }: { def: ActionDef; ont: OntologyConfig; clsName: string }) {
  const pre = preSummary(def, ont, clsName);
  return (
    <>
      <div style={{ color: "var(--ink-3)", marginTop: 2 }}>前置：{pre.length ? pre.join("、") : "无前置"}</div>
      {effectSummary(def).map((line, i) => (
        <div key={i} style={{ color: "var(--ink-3)" }}>· {line}</div>
      ))}
    </>
  );
}

export default function ObjectCard({
  name,
  sel,
  states,
  actionChanges,
  ont,
  op,
  refresh,
  closeCard,
  showToast,
  onFormState,
  currentRev,
  initialTab,
}: {
  name: string;
  sel: ObjectType;
  states?: Record<string, "new" | "modified" | "same">;
  actionChanges?: { added: string[]; overwritten: string[]; removed: string[] };
  ont: { object_types: Record<string, any>; link_types: Record<string, any> };
  op: (body: Record<string, unknown>) => Promise<boolean>;
  refresh: () => Promise<unknown>;
  closeCard: () => void;
  showToast: (s: string) => void;
  onFormState: (s: ObjectFormState) => void;
  currentRev: () => number | null;
  /** 测试缝：renderToString 点不了标签，组件测试用它直达阶段/动作页；生产不传（默认字段页）。 */
  initialTab?: TabKey;
}) {
  const [fieldForm, setFieldForm] = useState<{ mode: "create" } | { mode: "edit"; name: string } | null>(null);
  const [actionForm, setActionForm] = useState<ActionFormState>(null);
  const [tab, setTab] = useState<TabKey>(initialTab ?? "fields");
  const [stageEdit, setStageEdit] = useState<{ i: number; kind: "key" | "label" } | null>(null);
  const stageEditCancel = useRef(false);
  const dirtyRef = useRef(false); // 动作表单脏标记（卡内 Esc/取消确认自用；报页面走 onFormState）
  const actionFormRev = useRef<number | null>(null); // 打开动作表单那一刻的 rev：保存时不一样要先问
  useEffect(() => {
    onFormState({ busy: Boolean(fieldForm || actionForm), actionForm, actionDirty: actionForm ? dirtyRef.current : false });
  }, [fieldForm, actionForm, onFormState]);
  useEffect(() => () => onFormState(FORM_IDLE), [onFormState]); // 收卡即归零：不留陈表单状态卡住监视器
  useEffect(() => {
    if (actionForm) actionFormRev.current = currentRev();
    else {
      actionFormRev.current = null;
      dirtyRef.current = false;
    }
  }, [actionForm, currentRev]);

  // 动作表单开着时 Esc = 取消表单回到列表（有未保存改动先问一句），不冒到页面去关整卡
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !actionForm) return;
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea,select")) return;
      if (dirtyRef.current && !window.confirm("动作表单里有没保存的改动，取消就丢了。确定取消？")) return;
      setActionForm(null);
      void refresh(); // 表单收口后再拉一次：开着期间轮询只记 rev 不刷视图
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actionForm, refresh]);

  const stages = classStages(ont, name);
  const srcLabel = (key: string) => sourceLabel(sel.sources, key);
  const saveMoved = (i: number, dir: number) => {
    if (!stages) return;
    return op({ op: "edit_stages", object: name, items: moveStageItem(stages.items, i, dir) }); // 中文名随块走
  };

  /** 阶段两级改名：中文名轻改（只给人看）；key 是配置里的标识，级联改写动作前置与转化关系，入口带确认。 */
  const saveStageEdit = (it: StageItem, i: number, kind: "key" | "label", raw: string) => {
    const cancelled = stageEditCancel.current;
    stageEditCancel.current = false;
    setStageEdit(null);
    if (!stages || cancelled) return;
    const v = raw.trim();
    const items = stages.items.map((row, j) => {
      const base: { value: string; when: Record<string, unknown>; label?: string } = { value: row.value, when: row.when };
      const label = j === i ? (kind === "key" ? row.label : v || undefined) : row.label;
      if (label) base.label = label;
      return base;
    });
    if (kind === "key") {
      if (!v || v === it.value) return;
      items[i].value = v;
    } else {
      if ((it.label ?? "") === v) return;
    }
    void op({ op: "edit_stages", object: name, items });
  };

  const formOpen = Boolean(fieldForm || actionForm);
  const tabDefs: { key: TabKey; label: string }[] = [
    { key: "fields", label: "字段" },
    ...(stages ? [{ key: "stages" as TabKey, label: "阶段" }] : []),
    { key: "actions", label: "动作" },
    { key: "sources", label: "来源" },
  ];
  const active: TabKey = tab === "stages" && !stages ? "fields" : tab; // 转化被删后阶段页消失，别停在空页

  return (
    <div className="float-card float-tr" style={{ width: "min(440px, calc(100vw - 24px))", maxHeight: "calc(100% - 110px)" }}>
      <Bezel pad={16} coreStyle={{ overflow: "auto", maxHeight: "calc(100vh - 140px)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <input
            key={`name:${name}`}
            className="ctl"
            defaultValue={name}
            title="对象名（问数按这个名字）"
            style={{ fontFamily: "var(--font-serif)", fontSize: 16, flex: 1, minWidth: 0, padding: "4px 8px" }}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (!v || v === name) {
                e.target.value = name;
                return;
              }
              void op({ op: "update_object", name, new_name: v }).then((ok) => {
                if (!ok) e.target.value = name;
              });
            }}
          />
          <button className="chip" aria-label="关闭" onClick={closeCard}>✕</button>
        </div>
        <div style={{ color: "var(--ink-3)", fontSize: 11, margin: "2px 0 8px" }}>
          {states?.[name] === "new" ? "草稿，发布后生效" : states?.[name] === "modified" ? "有未发布改动" : "与已发布一致"}
        </div>
        <Section title="描述">
          <AutoTextarea
            key={name} /* 切换对象时强制重挂，否则旧描述会写进新对象 */
            className="ctl"
            defaultValue={sel.description ?? ""}
            minRows={1}
            onBlur={(e) => {
              // 跟挂载时的值比（defaultValue），不跟实时 sel 比——编辑期间的别处 refresh 不换基准
              if (e.target.value !== e.target.defaultValue) void op({ op: "update_object", name, description: e.target.value });
            }}
          />
        </Section>
        <Section title="唯一键">
          <select
            className="ctl"
            value={sel.identity ?? ""}
            onChange={async (e) => {
              const ok = await op({ op: "set_identity", object: name, name: e.target.value });
              if (!ok) e.target.value = sel.identity ?? ""; // 被拒则回显（如选了派生字段）
            }}
          >
            <option value="">未设置</option>
            {Object.entries(sel.properties).filter(([, d]: [string, any]) => !d.derived).map(([p]) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </Section>

        <div className="card-tabs">
          {tabDefs.map((t) => (
            <button
              key={t.key}
              className={`btn${active === t.key ? " is-on" : ""}`}
              style={{ fontSize: 12, padding: "5px 12px" }}
              disabled={formOpen && active !== t.key}
              title={formOpen && active !== t.key ? "先把表单收起来再切换" : undefined}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {active === "fields" && (
          <div style={{ marginTop: 12 }}>
            {fieldForm ? (
              <FieldForm
                initial={fieldForm.mode === "edit" ? { name: fieldForm.name, ...(sel.properties[fieldForm.name] as any) } : undefined}
                onSave={async (v) => {
                  if (fieldForm.mode === "create") {
                    return op({
                      op: "add_property",
                      object: name,
                      name: v.name,
                      type: v.type,
                      description: v.description || undefined,
                      values: v.type === "enum" && v.values.length ? v.values : undefined,
                    });
                  }
                  return op({
                    op: "update_property",
                    object: name,
                    name: fieldForm.name,
                    new_name: v.name !== fieldForm.name ? v.name : undefined,
                    type: v.type,
                    description: v.description,
                    values: v.type === "enum" ? v.values : undefined,
                  });
                }}
                onCancel={() => setFieldForm(null)}
              />
            ) : (
              <>
                {/* 阶段属性不在这里列：它由阶段页管（时期名、条件、转化），重复列两份只会让人对不上 */}
                {Object.entries(sel.properties)
                  .filter(([p]) => p !== stages?.property)
                  .map(([p, d]: [string, any]) => (
                    <div key={p} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        <code>{p}</code> <span style={{ color: "var(--ink-3)" }}>{d.type}{d.derived ? " · 派生" : ""}</span>
                        {d.description ? <span style={{ color: "var(--ink-3)" }}> · {d.description}</span> : null}
                        {d.type === "enum" && d.values?.length ? (
                          <span style={{ color: "var(--ink-3)" }}>
                            {" "}
                            ·{" "}
                            {d.values
                              .map((v: EnumValue) => {
                                const k = String(enumValueKey(v));
                                const l = enumValueLabel(v);
                                return l ? `${l}(${k})` : k;
                              })
                              .join("/")}
                          </span>
                        ) : null}
                      </span>
                      <button className="chip" style={{ fontSize: 11 }} title="编辑这个字段" onClick={() => setFieldForm({ mode: "edit", name: p })}>编辑</button>
                      <button
                        className="x-btn"
                        title={sel.identity === p ? MSG.propIdentityNoDelete : "删除字段"}
                        onClick={() => void op({ op: "remove_property", object: name, name: p })}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                <button className="ghost-add" onClick={() => setFieldForm({ mode: "create" })}>+ 加字段</button>
              </>
            )}
          </div>
        )}

        {active === "stages" && stages && (
          <div className="stage-rows" style={{ marginTop: 12 }}>
            {stages.items.map((it, i) => {
              const convs = stages.conversions.filter((c) => c.from === it.value);
              const editing = stageEdit?.i === i ? stageEdit.kind : null;
              return (
                <div key={`${JSON.stringify(it.when)}:${it.value}`} className="stage-block">
                  <div className="stage-head">
                    {editing ? (
                      <input
                        className="ctl"
                        autoFocus
                        defaultValue={editing === "key" ? it.value : it.label ?? ""}
                        onBlur={(e) => saveStageEdit(it, i, editing, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                          if (e.key === "Escape") {
                            stageEditCancel.current = true;
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                      />
                    ) : (
                      <>
                        <button
                          className="stage-name"
                          title="点一下改中文名"
                          onClick={() => setStageEdit({ i, kind: "label" })}
                        >
                          {it.label ?? it.value}
                        </button>
                        {it.label && <code className="stage-key">{it.value}</code>}
                        <span style={{ flex: 1 }} />
                        <button
                          className="chip stage-rename"
                          title="改时期标识：值域、派生规则、转化关系（含自动名）与动作前置里的同名等值会一起改"
                          onClick={() => {
                            if (window.confirm("改标识会连着改写值域、派生规则、转化关系和动作前置里的同名等值。确定改？")) setStageEdit({ i, kind: "key" });
                          }}
                        >
                          改标识
                        </button>
                      </>
                    )}
                    <span className="stage-move">
                      <button className="chip" disabled={i === 0} title="上移" onClick={() => void saveMoved(i, -1)}>↑</button>
                      <button className="chip" disabled={i === stages.items.length - 1} title="下移" onClick={() => void saveMoved(i, 1)}>↓</button>
                    </span>
                  </div>
                  <div className="stage-cond">{explainWhen(it.when, srcLabel)}</div>
                  {convs.map((c) => (
                    <div key={c.link} className="stage-conv">
                      <div>
                        转为 <code>{c.to}</code>
                        {c.action && <>　动作 <code>{c.action}</code></>}
                      </div>
                      {c.action && sel.actions?.[c.action] && <PreEffect def={sel.actions[c.action]} ont={ont} clsName={name} />}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {active === "actions" && (
          <div style={{ marginTop: 12 }}>
            {actionForm ? (
              <ActionForm
                clsName={name}
                ont={ont}
                initial={actionForm.mode === "edit" ? { name: actionForm.name, def: sel.actions?.[actionForm.name] } : undefined}
                onDirtyChange={(d) => {
                  dirtyRef.current = d;
                  onFormState({ busy: true, actionForm, actionDirty: d }); // 脏变化只发生在表单开着时
                }}
                onSave={async (aName, def) => {
                  // 保存仍不带 base_rev；表单开着期间外面改过了，先问一句再盖
                  if (actionFormRev.current !== null && currentRev() !== null && currentRev() !== actionFormRev.current) {
                    if (!window.confirm("外面已经改过这份草稿，还要按表单覆盖吗？")) return false;
                  }
                  const ok = await op({ op: "set_action", object: name, name: aName, def });
                  if (ok) {
                    setActionForm(null);
                    showToast(`动作 ${aName} 已进草稿（发布后生效）`);
                  }
                  return ok;
                }}
                onCancel={() => {
                  if (dirtyRef.current && !window.confirm("动作表单里有没保存的改动，取消就丢了。确定取消？")) return;
                  setActionForm(null);
                  void refresh(); // 表单收口后再拉一次：开着期间轮询只记 rev 不刷视图
                }}
              />
            ) : (
              <>
                {Object.entries(sel.actions ?? {}).map(([a, def]: [string, any]) => {
                  const key = `${name}.${a}`;
                  const badge = actionChanges?.added.includes(key) ? "新增" : actionChanges?.overwritten.includes(key) ? "已修改" : null;
                  return (
                    <div key={a} style={{ fontSize: 12, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <code>{a}</code>
                        {badge && <span className="tag tag-warn">{badge}</span>}
                        <span style={{ flex: 1 }} />
                        {/* 表单认不出的动作（超出附录 B 子集）只展示、只许删——点「编辑」再保存会把认不出的键丢掉 */}
                        {formCompatible(def, name, ont) && (
                          <button className="chip" style={{ fontSize: 11 }} title="编辑这条动作" onClick={() => setActionForm({ mode: "edit", name: a })}>编辑</button>
                        )}
                        <button
                          className="chip"
                          style={{ fontSize: 11, color: "var(--danger)" }}
                          title="删除这条动作"
                          onClick={async () => {
                            if (!window.confirm("删除这条动作？进草稿，发布后才从已发布里拿掉")) return;
                            const ok = await op({ op: "remove_action", object: name, name: a });
                            if (ok) showToast(`已删除动作 ${a}（进草稿，发布后生效）`);
                          }}
                        >
                          删除
                        </button>
                      </div>
                      {def.description && <div style={{ color: "var(--ink-3)", marginTop: 2 }}>{def.description}</div>}
                      <PreEffect def={def} ont={ont} clsName={name} />
                    </div>
                  );
                })}
                {Object.keys(sel.actions ?? {}).length === 0 && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>还没有动作——点下面新建，或让 Agent 写</div>}
                <button className="ghost-add" onClick={() => setActionForm({ mode: "create" })}>+ 新建动作</button>
              </>
            )}
          </div>
        )}

        {active === "sources" && (
          <div style={{ marginTop: 12 }}>
            {Object.keys(sel.sources ?? {}).length === 0 && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>还没有来源——这个对象是手工建的，没挂任何表</div>}
            {Object.entries(sel.sources ?? {}).map(([srcName, s]: [string, any]) => (
              <div key={srcName} style={{ fontSize: 12, lineHeight: 1.9 }}>
                <strong>{srcName}</strong>　<code>{s.connection}.{s.table}</code>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 10, display: "flex", justifyContent: "flex-end" }}>
          <button
            className="btn"
            style={{ color: "var(--danger)", fontSize: 12 }}
            onClick={async () => {
              const ok = await op({ op: "delete_object", name });
              if (ok) {
                closeCard();
                showToast(`已删除 ${name}（发布后生效）`);
              }
            }}
          >
            删除这个对象
          </button>
        </div>
      </Bezel>
    </div>
  );
}
