// 字段表单与小节壳 —— ObjectCard 的配套件（唯一消费者），从 forms.tsx 杂物袋拆到消费者旁边。
// 字段类型词表从 propertySchema 派生（schema 单源），不再手写一份双轨。
"use client";

import { useState } from "react";
import { enumValueKey, propertySchema } from "../../server/schema/config";

/** 字段类型词表：与 schema/config.ts 的 propertySchema 同一出处（派生，不写第二份）。 */
export const PROP_TYPES = propertySchema.shape.type.options;

/** 小节标题壳：编辑卡的分区标题。 */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: "0.08em", marginBottom: 4 }}>{title}</div>
      {children}
    </div>
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
  const [values, setValues] = useState((initial?.values ?? []).map((v) => String(enumValueKey(v))).join(","));
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
        字段名（小写字母/数字/下划线；改名会把来源对照一起换过来；被关系、公理、派生字段或动作引用着的改不了名）
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
