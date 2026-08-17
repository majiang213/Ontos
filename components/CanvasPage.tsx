// 本体构建页 —— 纯画布页（无对话列）。
// 画布内容 = 已发布配置（只读）；表结构收进底部抽屉，每列标出映射去向。

import { useEffect, useMemo, useState } from "react";
import OntologyCanvas, { type CanvasLink, type CanvasObject } from "./OntologyCanvas";

interface OntologyResp {
  version: number;
  object_types: Record<string, any>;
  link_types: Record<string, any>;
}
interface IntrospectResp {
  sources: { connection: string; tables: { name: string; columns: { name: string; type: string; pk: boolean }[] }[] }[];
}

export default function CanvasPage() {
  const [ont, setOnt] = useState<OntologyResp | null>(null);
  const [schema, setSchema] = useState<IntrospectResp | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    fetch("/api/ontology").then((r) => r.json()).then(setOnt);
    fetch("/api/introspect").then((r) => r.json()).then(setSchema);
  }, []);

  const objects: CanvasObject[] = useMemo(
    () =>
      Object.entries(ont?.object_types ?? {}).map(([name, t]) => ({
        name,
        description: t.description,
        kind: t.kind,
        properties: Object.entries(t.properties).map(([p, d]: [string, any]) => ({
          name: p,
          type: d.type,
          derived: Boolean(d.derived),
          values: d.values,
        })),
        sources: Object.values(t.sources ?? {}).map((s: any) => `${s.connection}.${s.table}`),
        actions: Object.keys(t.actions ?? {}),
      })),
    [ont]
  );
  const links: CanvasLink[] = useMemo(
    () =>
      Object.entries(ont?.link_types ?? {}).map(([name, l]: [string, any]) => ({
        name,
        from: l.from,
        to: l.to,
        inverse: l.inverse,
        kind: l.transition ? "transition" : "match",
      })),
    [ont]
  );

  /** 列 → 去向（哪个类的哪个属性），从配置 sources 反推。 */
  const columnTarget = (connection: string, table: string, column: string): string => {
    for (const [clsName, t] of Object.entries(ont?.object_types ?? {})) {
      for (const [srcName, s] of Object.entries((t as any).sources ?? {})) {
        const src = s as any;
        if (src.connection === connection && src.table === table) {
          for (const [prop, col] of Object.entries(src.fields)) {
            if (col === column) return `${clsName}.${prop}（${srcName}）`;
          }
          if (src.pk === column) return `${clsName} 的主键（${srcName}）`;
        }
      }
    }
    return "未映射";
  };

  const sel = selected ? (ont?.object_types?.[selected] as any) : null;

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
      <OntologyCanvas objects={objects} links={links} onSelect={setSelected} />

      {/* 左上：发布状态 */}
      <div className="float-card float-tl">
        <span className="eyebrow">已发布 v{ont?.version ?? "…"} · 只读快照</span>
      </div>

      {/* 底部中：表结构抽屉开关 */}
      <div className="float-card float-bc">
        <button className="btn" onClick={() => setDrawerOpen((v) => !v)}>
          {drawerOpen ? "收起表结构" : "表结构"}
        </button>
      </div>

      {/* 右侧：对象详情卡 */}
      {sel && (
        <div className="float-card float-tr" style={{ width: 340, maxHeight: "calc(100% - 110px)" }}>
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 16, overflow: "auto", maxHeight: "calc(100vh - 140px)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontFamily: "var(--font-serif)", fontSize: 16 }}>{selected}</span>
                <button className="chip" onClick={() => setSelected(null)}>✕</button>
              </div>
              <div style={{ color: "var(--ink-2)", fontSize: 12, margin: "4px 0 10px" }}>{sel.description}</div>
              <Section title="字段">
                {Object.entries(sel.properties).map(([p, d]: [string, any]) => (
                  <div key={p} style={{ fontSize: 12, lineHeight: 1.9 }}>
                    <code>{p}</code> <span style={{ color: "var(--ink-3)" }}>{d.type}{d.derived ? " · 派生" : ""}</span>
                    {d.description && <span style={{ color: "var(--ink-2)" }}>　{d.description}</span>}
                  </div>
                ))}
              </Section>
              <Section title="来源">
                {Object.entries(sel.sources ?? {}).map(([srcName, s]: [string, any]) => (
                  <div key={srcName} style={{ fontSize: 12, lineHeight: 1.9 }}>
                    <strong>{srcName}</strong>　<code>{s.connection}.{s.table}</code>
                    <div style={{ color: "var(--ink-3)" }}>
                      {Object.entries(s.fields).map(([prop, col]) => `${prop} ← ${String(col)}`).join("；")}
                    </div>
                  </div>
                ))}
              </Section>
              {Object.keys(sel.actions ?? {}).length > 0 && (
                <Section title="动作">
                  {Object.entries(sel.actions).map(([a, d]: [string, any]) => (
                    <div key={a} style={{ fontSize: 12, lineHeight: 1.9 }}>
                      <code>{a}</code>　<span style={{ color: "var(--ink-2)" }}>{d.description}</span>
                    </div>
                  ))}
                </Section>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 底部抽屉：表结构（只看列定义，不取业务行） */}
      {drawerOpen && (
        <div className="drawer">
          {schema?.sources.map((s) => (
            <div key={s.connection} style={{ marginBottom: 20 }}>
              <span className="eyebrow">{s.connection}</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 10 }}>
                {s.tables.map((t) => (
                  <div key={t.name} className="bezel" style={{ minWidth: 260 }}>
                    <div className="bezel-core" style={{ padding: 12 }}>
                      <code style={{ fontSize: 13 }}>{t.name}</code>
                      {t.columns.map((c) => (
                        <div key={c.name} style={{ fontSize: 12, lineHeight: 1.9, display: "flex", justifyContent: "space-between", gap: 14 }}>
                          <span>
                            <code>{c.name}</code>
                            <span style={{ color: "var(--ink-3)" }}> {c.type}{c.pk ? " · 主键" : ""}</span>
                          </span>
                          <span style={{ color: "var(--ink-3)" }}>{columnTarget(s.connection, t.name, c.name)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 11, color: "var(--ink-3)", letterSpacing: "0.08em", marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}
