// 对象编辑卡：描述 / 唯一键 / 字段 / 动作 / 来源 / 危险区，六个 Section 与它们自己的表单状态机。
// 换卡即重挂（父级按对象名给 key），表单状态自然清；脏表单取消要确认，开着期间外部改动先问再盖。
// 表单状态经 onFormState 回调报给页面（监视器豁免、Esc 守卫、切换守卫），页面不再递 ref 下来。
"use client";

import { useEffect, useRef, useState } from "react";
import Bezel from "./Bezel";
import { ActionForm } from "../forms/ActionForm";
import { FieldForm, Section } from "./FieldForm";
import { effectSummary, formCompatible } from "../forms/actionView";
import type { ObjectType } from "../../server/schema/config";

export type ActionFormState = { mode: "create" } | { mode: "edit"; name: string } | null;

/** 卡内表单状态：页面拿它做监视器豁免（busy）、Esc 守卫（actionForm）、切换对象守卫（actionDirty）。 */
export interface ObjectFormState {
  busy: boolean; // 字段表单或动作表单开着：轮询不冲掉未保存内容
  actionForm: ActionFormState; // 动作表单开没开、开的哪条
  actionDirty: boolean; // 动作表单里有未保存改动
}

const FORM_IDLE: ObjectFormState = { busy: false, actionForm: null, actionDirty: false };

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
}) {
  const [fieldForm, setFieldForm] = useState<{ mode: "create" } | { mode: "edit"; name: string } | null>(null);
  const [actionForm, setActionForm] = useState<ActionFormState>(null);
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

  return (
    <div className="float-card float-tr" style={{ width: 400, maxHeight: "calc(100% - 110px)" }}>
      <Bezel pad={16} coreStyle={{ overflow: "auto", maxHeight: "calc(100vh - 140px)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontFamily: "var(--font-serif)", fontSize: 16 }}>{name}</span>
          <button className="chip" aria-label="关闭" onClick={closeCard}>✕</button>
        </div>
        <div style={{ color: "var(--ink-3)", fontSize: 11, margin: "2px 0 8px" }}>
          {states?.[name] === "new" ? "草稿，发布后生效" : states?.[name] === "modified" ? "有未发布改动" : "与已发布一致"}
        </div>
        <Section title="描述">
          <textarea
            key={name} /* 切换对象时强制重挂，否则旧描述会写进新对象 */
            className="ctl"
            defaultValue={sel.description ?? ""}
            rows={1}
            style={{ width: "100%" }}
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
        <Section title="字段">
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
              {Object.entries(sel.properties).map(([p, d]: [string, any]) => (
                <div key={p} style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    <code>{p}</code> <span style={{ color: "var(--ink-3)" }}>{d.type}{d.derived ? " · 派生" : ""}</span>
                    {d.description ? <span style={{ color: "var(--ink-3)" }}> · {d.description}</span> : null}
                    {d.type === "enum" && d.values?.length ? <span style={{ color: "var(--ink-3)" }}> · {d.values.join("/")}</span> : null}
                  </span>
                  <button className="chip" style={{ fontSize: 11 }} title="编辑这个字段" onClick={() => setFieldForm({ mode: "edit", name: p })}>编辑</button>
                  <button
                    className="x-btn"
                    title={sel.identity === p ? "唯一键不能直接删，先在上方换一个" : "删除字段"}
                    onClick={() => void op({ op: "remove_property", object: name, name: p })}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button className="btn" style={{ fontSize: 12, marginTop: 6 }} onClick={() => setFieldForm({ mode: "create" })}>加字段</button>
            </>
          )}
        </Section>
        <Section title="动作">
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
                    <div style={{ color: "var(--ink-3)", marginTop: 2 }}>
                      前置：{def.pre && Object.keys(def.pre).length > 0 ? <code style={{ fontSize: 11, wordBreak: "break-all" }}>{JSON.stringify(def.pre)}</code> : "无前置"}
                    </div>
                    {effectSummary(def).map((line, i) => (
                      <div key={i} style={{ color: "var(--ink-3)" }}>· {line}</div>
                    ))}
                  </div>
                );
              })}
              {Object.keys(sel.actions ?? {}).length === 0 && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>还没有动作——点下面新建，或让 Agent 写</div>}
              <button className="btn" style={{ fontSize: 12, marginTop: 6 }} onClick={() => setActionForm({ mode: "create" })}>新建动作</button>
            </>
          )}
        </Section>
        <Section title="来源">
          {Object.keys(sel.sources ?? {}).length === 0 && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>还没有来源——这个对象是手工建的，没挂任何表</div>}
          {Object.entries(sel.sources ?? {}).map(([srcName, s]: [string, any]) => (
            <div key={srcName} style={{ fontSize: 12, lineHeight: 1.9 }}>
              <strong>{srcName}</strong>　<code>{s.connection}.{s.table}</code>
            </div>
          ))}
        </Section>
        <Section title="危险区">
          <button
            className="btn"
            style={{ color: "var(--danger)" }}
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
        </Section>
      </Bezel>
    </div>
  );
}
