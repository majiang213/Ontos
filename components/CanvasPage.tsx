// 本体构建页 —— 纯画布页（无对话列）。
// 画布内容 = 工作副本（已发布 + 未发布改动）；发布走「发布 vN+1 / 放弃」；表结构收进底部抽屉。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import OntologyCanvas, { type CanvasLink, type CanvasObject } from "./OntologyCanvas";

interface OntologyResp {
  version: number;
  dirty: boolean;
  layout: Record<string, { x: number; y: number }>;
  states: Record<string, "new" | "modified" | "same">;
  deleted: string[];
  object_types: Record<string, any>;
  link_types: Record<string, any>;
}
interface IntrospectResp {
  sources: {
    connection: string;
    error?: string;
    tables: { name: string; columns: { name: string; type: string; pk: boolean }[]; sample?: Record<string, unknown>[] }[];
  }[];
}

const PROP_TYPES = ["string", "number", "boolean", "date", "enum"] as const;

export default function CanvasPage() {
  const [ont, setOnt] = useState<OntologyResp | null>(null);
  const [schema, setSchema] = useState<IntrospectResp | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [pairs, setPairs] = useState<PairAdvice[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [versions, setVersions] = useState<{ version: number; createdAt: string }[] | null>(null);
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const refresh = useCallback(() => fetch("/api/ontology").then((r) => r.json()).then(setOnt), []);
  useEffect(() => {
    refresh();
    fetch("/api/introspect").then((r) => r.json()).then(setSchema);
  }, [refresh]);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  /** 编辑操作统一入口：发给草稿，刷新视图，错误进 toast。 */
  const op = useCallback(
    async (body: Record<string, unknown>) => {
      const r = await fetch("/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await r.json();
      if (!r.ok) {
        showToast(data.error ?? "操作被拒");
        return false;
      }
      await refresh();
      return true;
    },
    [refresh, showToast]
  );

  const saveLayout = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      void op({ op: "save_layout", positions });
    },
    [op]
  );

  const publish = async () => {
    if (publishing) return; // 防连点：重复发布会产生空版本
    setPublishing(true);
    try {
      const r = await fetch("/api/publish", { method: "POST" });
      const data = await r.json();
      if (!r.ok) showToast(data.error ?? "发布被拒");
      else showToast(`已发布 v${data.version}，问数与动作即刻生效`);
      await refresh();
    } finally {
      setPublishing(false);
    }
  };
  const discard = async () => {
    await fetch("/api/publish", { method: "DELETE" });
    showToast("已放弃改动，回到已发布快照");
    setSelected(null);
    await refresh();
  };

  /** 多选表 → 生成对象 → 直接上画布并收起抽屉。 */
  const generateFromTables = async () => {
    const tables = [...selectedTables].map((key) => {
      const [connection, table] = key.split(".");
      return { connection, table };
    });
    const r = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tables }),
    });
    const data = await r.json();
    if (!r.ok) {
      showToast(data.error ?? "生成失败");
      return;
    }
    showToast(`已生成对象：${data.created.join("、")}（草稿，发布后生效）`);
    setSelectedTables(new Set());
    setDrawerOpen(false);
    await refresh();
  };

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
        sources: Object.entries(t.sources ?? {}).map(([srcName, s]: [string, any]) => ({
          key: srcName,
          label: `${s.connection}.${s.table}`,
        })),
        actions: Object.keys(t.actions ?? {}),
        state: ont?.states?.[name],
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
      <OntologyCanvas objects={objects} links={links} layout={ont?.layout} onSelect={setSelected} onLayoutChange={saveLayout} />

      {/* 左上：发布状态 + 入口 */}
      <div className="float-card float-tl" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          className="eyebrow"
          style={{ cursor: "pointer", border: "none" }}
          title="版本历史"
          onClick={async () => {
            const r = await fetch("/api/versions");
            const data = await r.json();
            setVersions(data.versions ?? []);
          }}
        >
          已发布 v{ont?.version ?? "…"} ▾
        </button>
        <button className="btn" onClick={() => setCreating(true)}>新建对象</button>
        <button className="btn" onClick={() => setConnecting(true)}>连接数据源</button>
        <button
          className="btn"
          onClick={async () => {
            const r = await fetch("/api/candidates");
            const data = await r.json();
            setPairs(data.candidates ?? []);
            setPanelOpen(true);
          }}
        >
          候选对
        </button>
        <button className="btn" onClick={() => setQuestionsOpen((v) => !v)}>验收问题集</button>
      </div>

      {/* 版本历史卡（点版本号展开；回滚 = 旧内容作为新版本发布） */}
      {versions && (
        <div className="float-card float-tl" style={{ top: 120, width: 300 }}>
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>版本历史</span>
                <button className="chip" onClick={() => setVersions(null)}>✕</button>
              </div>
              {versions.map((v) => (
                <div key={v.version} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, lineHeight: 2.2 }}>
                  <span>
                    <strong>v{v.version}</strong>　<span style={{ color: "var(--ink-3)" }}>{v.createdAt.slice(0, 16).replace("T", " ")}</span>
                  </span>
                  {v.version !== ont?.version && (
                    <button
                      className="chip"
                      onClick={async () => {
                        const r = await fetch("/api/versions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: v.version }) });
                        const data = await r.json();
                        if (r.ok) {
                          showToast(`已回滚到 v${v.version} 的内容（发布为 v${data.version}）`);
                          setVersions(null);
                          await refresh();
                        } else showToast(data.error ?? "回滚失败");
                      }}
                    >
                      回滚到这版
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 验收问题集卡 */}
      {questionsOpen && <QuestionsCard onClose={() => setQuestionsOpen(false)} showToast={showToast} />}

      {/* 底中：裁决面板（候选对） */}
      {panelOpen && !ont?.dirty && (
        <div className="float-card float-bc" style={{ width: 520, maxHeight: "60%" }}>
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 14, overflow: "auto", maxHeight: "56vh" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>候选对裁决（{pairs.length} 对）</span>
                <button className="chip" onClick={() => setPanelOpen(false)}>✕</button>
              </div>
              {pairs.length === 0 && <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 8 }}>没有跨源候选对。单源对象不进裁决，可以直接发布。</div>}
              {pairs.map((p) => (
                <PairCard
                  key={`${p.class_a}|${p.class_b}`}
                  pair={p}
                  onDone={(msg) => {
                    setPairs((prev) => prev.filter((x) => !(x.class_a === p.class_a && x.class_b === p.class_b)));
                    showToast(msg);
                    void refresh();
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 底中：发布条（有未发布改动时） */}
      {ont?.dirty && (
        <div className="float-card float-bc">
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 8, display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "var(--ink-2)", paddingLeft: 6 }}>
                有未发布的改动{ont.deleted?.length ? `；将删除：${ont.deleted.join("、")}` : ""}
              </span>
              <button className="btn-cta" style={{ fontSize: 13, padding: "6px 8px 6px 16px" }} onClick={publish} disabled={publishing}>
                发布 v{(ont?.version ?? 1) + 1}
              </button>
              <button className="btn" onClick={discard} disabled={publishing}>放弃</button>
            </div>
          </div>
        </div>
      )}

      {/* 左下：表结构抽屉开关（常驻，不被发布条挤掉） */}
      <div className="float-card" style={{ bottom: 18, left: 16 }}>
        <button className="btn" onClick={() => setDrawerOpen((v) => !v)}>{drawerOpen ? "收起表结构" : "表结构"}</button>
      </div>

      {/* toast：瞬时反馈 */}
      {toast && (
        <div className="float-card" style={{ top: 76, left: "50%", translate: "-50% 0", zIndex: 40 }}>
          <div className="bezel"><div className="bezel-core" style={{ padding: "8px 16px", fontSize: 13 }}>{toast}</div></div>
        </div>
      )}

      {/* 连接数据源卡（左上） */}
      {connecting && (
        <div className="float-card float-tl" style={{ top: 120, width: 320 }}>
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>连接数据源</div>
              <ConnectForm
                onCancel={() => setConnecting(false)}
                onDone={async (msg) => {
                  setConnecting(false);
                  showToast(msg);
                  const s = await fetch("/api/introspect").then((r) => r.json());
                  setSchema(s);
                  setDrawerOpen(true); // 保存后自动打开表结构抽屉
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* 新建对象卡（左上） */}
      {creating && (
        <div className="float-card float-tl" style={{ top: 120, width: 300 }}>
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>新建对象</div>
              <CreateForm
                onCancel={() => setCreating(false)}
                onSubmit={async (name, description, kind) => {
                  const ok = await op({ op: "create_object", name, description, kind });
                  if (ok) {
                    setCreating(false);
                    setSelected(name);
                    showToast(`已加入草稿：${name}（发布后生效）`);
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* 右侧：对象编辑卡 */}
      {sel && !creating && (
        <div className="float-card float-tr" style={{ width: 340, maxHeight: "calc(100% - 110px)" }}>
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 16, overflow: "auto", maxHeight: "calc(100vh - 140px)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontFamily: "var(--font-serif)", fontSize: 16 }}>{selected}</span>
                <button className="chip" onClick={() => setSelected(null)}>✕</button>
              </div>
              <div style={{ color: "var(--ink-3)", fontSize: 11, margin: "2px 0 8px" }}>
                {ont?.states?.[selected!] === "new" ? "草稿，发布后生效" : ont?.states?.[selected!] === "modified" ? "有未发布改动" : "与已发布一致"}
              </div>
              <Section title="描述">
                <textarea
                  key={selected} /* 切换对象时强制重挂，否则旧描述会写进新对象 */
                  defaultValue={sel.description ?? ""}
                  rows={2}
                  style={{ width: "100%", fontSize: 12, padding: 8, borderRadius: 10, border: "none", boxShadow: "0 0 0 1px var(--hairline)", background: "var(--panel-2)", resize: "vertical" }}
                  onBlur={(e) => {
                    if (e.target.value !== (sel.description ?? "")) void op({ op: "update_object", name: selected, description: e.target.value });
                  }}
                />
              </Section>
              <Section title={`识别字段（同一性标准）`}>
                <select
                  value={sel.identity ?? ""}
                  onChange={(e) => void op({ op: "set_identity", object: selected, name: e.target.value })}
                  style={{ fontSize: 12, padding: "4px 8px", borderRadius: 8, border: "none", boxShadow: "0 0 0 1px var(--hairline)", background: "var(--panel)" }}
                >
                  <option value="">未设置</option>
                  {Object.entries(sel.properties).filter(([, d]: [string, any]) => !d.derived).map(([p]) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </Section>
              <Section title="字段">
                {Object.entries(sel.properties).map(([p, d]: [string, any]) => (
                  <div key={p} style={{ fontSize: 12, lineHeight: 2, display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span>
                      <code>{p}</code> <span style={{ color: "var(--ink-3)" }}>{d.type}{d.derived ? " · 派生" : ""}</span>
                    </span>
                    <button
                      className="chip"
                      title={sel.identity === p ? "识别字段不能直接删" : "删除字段"}
                      onClick={() => void op({ op: "remove_property", object: selected, name: p })}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <AddProperty onAdd={(name, type) => op({ op: "add_property", object: selected, name, type })} />
              </Section>
              <Section title="来源">
                {Object.keys(sel.sources ?? {}).length === 0 && <div style={{ fontSize: 12, color: "var(--ink-3)" }}>无源（manual 桶；挂源映射待 M1/M2）</div>}
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
                    const ok = await op({ op: "delete_object", name: selected });
                    if (ok) {
                      setSelected(null);
                      showToast(`已删除 ${selected}（发布后生效）`);
                    }
                  }}
                >
                  删除这个对象
                </button>
              </Section>
            </div>
          </div>
        </div>
      )}

      {/* 底部抽屉：表结构（只看列定义与采样，多选可生成对象） */}
      {drawerOpen && (
        <div className="drawer">
          {selectedTables.size > 0 && (
            <div style={{ position: "sticky", top: 0, zIndex: 5, paddingBottom: 10, background: "var(--bg-deep)" }}>
              <button className="btn-cta" style={{ fontSize: 13, padding: "6px 8px 6px 16px" }} onClick={generateFromTables}>
                生成对象（{selectedTables.size} 张表）
              </button>
              <button className="btn" style={{ marginLeft: 8 }} onClick={() => setSelectedTables(new Set())}>清空选择</button>
            </div>
          )}
          {schema?.sources.map((s) => (
            <div key={s.connection} style={{ marginBottom: 20 }}>
              <span className="eyebrow">{s.connection}</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 10 }}>
                {s.tables.map((t) => {
                  const key = `${s.connection}.${t.name}`;
                  const checked = selectedTables.has(key);
                  return (
                    <div key={t.name} className="bezel" style={{ minWidth: 260, outline: checked ? "2px solid var(--accent)" : "none" }}>
                      <div className="bezel-core" style={{ padding: 12 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              setSelectedTables((prev) => {
                                const next = new Set(prev);
                                if (next.has(key)) next.delete(key);
                                else next.add(key);
                                return next;
                              })
                            }
                          />
                          <code style={{ fontSize: 13 }}>{t.name}</code>
                        </label>
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
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface PairAdvice {
  class_a: string;
  class_b: string;
  tendency: string;
  reason: string;
}

/** 裁决面板里的一对：建议 + 依据 + 交集率（按需计算）+ 五种结论。 */
function PairCard({ pair, onDone }: { pair: PairAdvice; onDone: (msg: string) => void }) {
  const [rate, setRate] = useState<{ rate: number; count_a: number; count_b: number; count_hit: number } | null>(null);
  const [stage, setStage] = useState({ from: "", to: "" });
  const [busy, setBusy] = useState(false);

  const decide = async (verdict: string) => {
    setBusy(true);
    try {
      const r = await fetch("/api/decisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          class_a: pair.class_a,
          class_b: pair.class_b,
          verdict,
          stage_names: verdict === "阶段" && stage.from && stage.to ? stage : undefined,
          llm_advice: `${pair.tendency}：${pair.reason}`,
          rate: rate?.rate,
        }),
      });
      const data = await r.json();
      if (!r.ok) onDone(data.error ?? "裁决被拒");
      else onDone(`已裁决 ${pair.class_a} × ${pair.class_b}：${verdict}（进草稿，发布后生效）`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ borderTop: "1px solid var(--hairline)", padding: "10px 0" }}>
      <div style={{ fontSize: 13 }}>
        <code>{pair.class_a}</code> × <code>{pair.class_b}</code>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-2)", margin: "4px 0" }}>
        建议：{pair.tendency}（{pair.reason}）
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-2)", margin: "4px 0" }}>
        {rate ? (
          <>交集率 {(rate.rate * 100).toFixed(0)}%（{pair.class_a} {rate.count_a} 条 / {pair.class_b} {rate.count_b} 条 / 重合 {rate.count_hit}）</>
        ) : (
          <button
            className="chip"
            onClick={async () => {
              const r = await fetch("/api/overlap", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ class_a: pair.class_a, class_b: pair.class_b }),
              });
              const data = await r.json();
              if (r.ok) setRate(data);
            }}
          >
            计算交集率
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, alignItems: "center" }}>
        <button className="chip" disabled={busy} onClick={() => decide("同一")}>同一</button>
        <button className="chip" disabled={busy} onClick={() => decide("部分重叠")}>部分重叠</button>
        <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
          <button className="chip" disabled={busy || !stage.from || !stage.to} onClick={() => decide("阶段")}>阶段</button>
          <input placeholder="前阶段" value={stage.from} onChange={(e) => setStage({ ...stage, from: e.target.value })} style={{ width: 64, fontSize: 12, padding: "3px 8px", borderRadius: 8, border: "none", boxShadow: "0 0 0 1px var(--hairline)" }} />
          <input placeholder="后阶段" value={stage.to} onChange={(e) => setStage({ ...stage, to: e.target.value })} style={{ width: 64, fontSize: 12, padding: "3px 8px", borderRadius: 8, border: "none", boxShadow: "0 0 0 1px var(--hairline)" }} />
        </span>
        <button className="chip" disabled={busy} onClick={() => decide("仅名称相似")}>仅名称相似</button>
        <button className="chip" disabled={busy} onClick={() => decide("跳过")}>跳过</button>
      </div>
    </div>
  );
}

/** 验收问题集：增删 + 对着引擎跑通过/失败。问数验收基准，不参与裁决。 */
function QuestionsCard({ onClose, showToast }: { onClose: () => void; showToast: (s: string) => void }) {
  const [items, setItems] = useState<{ id: number; question: string; status: string }[]>([]);
  const [text, setText] = useState("");
  const load = useCallback(async () => {
    const r = await fetch("/api/questions");
    const data = await r.json();
    setItems(data.questions ?? []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="float-card float-tl" style={{ top: 120, width: 360 }}>
      <div className="bezel">
        <div className="bezel-core" style={{ padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>验收问题集</span>
            <button className="chip" onClick={onClose}>✕</button>
          </div>
          {items.map((q) => (
            <div key={q.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, lineHeight: 2.2 }}>
              <span>{q.question}</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className={`tag ${q.status === "通过" ? "tag-ok" : q.status === "失败" ? "tag-warn" : ""}`}>{q.status}</span>
                <button
                  className="chip"
                  onClick={async () => {
                    await fetch("/api/questions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: q.id }) });
                    await load();
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
          ))}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!text.trim()) return;
              await fetch("/api/questions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text.trim() }) });
              setText("");
              await load();
            }}
            style={{ display: "flex", gap: 6, marginTop: 8 }}
          >
            <input className="text-in" style={{ flex: 1, fontSize: 12, padding: "6px 10px" }} placeholder="加一条业务问题" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="btn" style={{ fontSize: 12 }}>加</button>
          </form>
          <button
            className="btn-cta"
            style={{ fontSize: 12, padding: "6px 16px", marginTop: 10 }}
            onClick={async () => {
              const r = await fetch("/api/questions?run=1", { method: "POST" });
              const data = await r.json();
              const failed = (data.results ?? []).filter((x: { status: string }) => x.status === "失败");
              showToast(failed.length ? `${failed.length} 条失败，回 M2/M3 修本体或映射` : `全部通过（v${data.version}）`);
              await load();
            }}
          >
            全量跑一遍
          </button>
        </div>
      </div>
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

function CreateForm({ onSubmit, onCancel }: { onSubmit: (name: string, description: string, kind: "thing" | "event") => void; onCancel: () => void }) {
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
      <select value={kind} onChange={(e) => setKind(e.target.value as "thing" | "event")} style={{ fontSize: 13, padding: "6px 10px", borderRadius: 10, border: "none", boxShadow: "0 0 0 1px var(--hairline)", background: "var(--panel)" }}>
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

function ConnectForm({ onDone, onCancel }: { onDone: (msg: string) => void; onCancel: () => void }) {
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
          const r = await fetch("/api/connections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: name.trim(),
              type,
              host: host || undefined,
              port: port ? Number(port) : undefined,
              db_name: dbName || undefined,
              ro_user: user || undefined,
              ro_pass: pass || undefined,
              test: true, // 先测连通再保存
            }),
          });
          const data = await r.json();
          if (!r.ok) setError(data.error ?? "连不上");
          else onDone(data.warning ?? `已连接 ${name}，读到 ${data.tables?.length ?? 0} 张表`);
        } finally {
          setBusy(false);
        }
      }}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <input className="text-in" style={inputStyle} placeholder="连接名（小写，如 purchase_sys）" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={type} onChange={(e) => setType(e.target.value as "sqlite" | "mysql" | "pg")} style={{ fontSize: 13, padding: "6px 10px", borderRadius: 10, border: "none", boxShadow: "0 0 0 1px var(--hairline)", background: "var(--panel)" }}>
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

function AddProperty({ onAdd }: { onAdd: (name: string, type: (typeof PROP_TYPES)[number]) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof PROP_TYPES)[number]>("string");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (name.trim() && (await onAdd(name.trim(), type))) setName("");
      }}
      style={{ display: "flex", gap: 6, marginTop: 6 }}
    >
      <input className="text-in" style={{ flex: 1, fontSize: 12, padding: "6px 10px" }} placeholder="新字段名" value={name} onChange={(e) => setName(e.target.value)} />
      <select value={type} onChange={(e) => setType(e.target.value as (typeof PROP_TYPES)[number])} style={{ fontSize: 12, borderRadius: 8, border: "none", boxShadow: "0 0 0 1px var(--hairline)", background: "var(--panel)" }}>
        {PROP_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <button type="submit" className="btn" style={{ fontSize: 12, padding: "6px 12px" }}>加字段</button>
    </form>
  );
}
