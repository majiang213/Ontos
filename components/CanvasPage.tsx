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
  const [generating, setGenerating] = useState(false);
  const [linkDraft, setLinkDraft] = useState<{ from: string; to: string } | null>(null); // 拖线落地后等待取名的半成品
  const [selectedLink, setSelectedLink] = useState<string | null>(null); // 点中的边
  const [maximized, setMaximized] = useState(false); // 画布最大化：藏起全部浮卡，Esc 退出
  const [rollbacking, setRollbacking] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []); // 卸载清定时器

  const refresh = useCallback(() => fetch("/api/ontology").then((r) => r.json()).then(setOnt), []);
  // 疑似重复列表：每次从服务端按当前草稿重算（已裁的、被合并撤掉的都不再来）
  const loadPairs = useCallback(async () => {
    const r = await fetch("/api/candidates");
    const data = await r.json();
    setPairs(data.candidates ?? []);
  }, []);
  useEffect(() => {
    refresh();
    fetch("/api/introspect").then((r) => r.json()).then(setSchema);
  }, [refresh]);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);

  /** 编辑操作统一入口：发给草稿，刷新视图，错误进 toast。网络层失败也要说。 */
  const op = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const r = await fetch("/api/draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await r.json();
        if (!r.ok) {
          showToast(data.error ?? "操作被拒");
          return false;
        }
        await refresh();
        return true;
      } catch (e) {
        showToast(`网络错误：${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
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
    } catch (e) {
      showToast(`网络错误：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPublishing(false);
    }
  };
  const discard = async () => {
    if (publishing) return; // 与发布同一把闸，防连点
    setPublishing(true);
    try {
      const r = await fetch("/api/publish", { method: "DELETE" });
      if (!r.ok) {
        const data = await r.json();
        showToast(data.error ?? "放弃失败");
        return;
      }
      showToast("已放弃改动，回到已发布快照");
      setSelected(null);
      await refresh();
    } catch (e) {
      showToast(`网络错误：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPublishing(false);
    }
  };

  // Esc 关一切浮卡；最大化时先退出最大化。输入控件里的 Esc 不拦——那边的 onBlur 自动保存语义不能被关卡吃掉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea,select")) return;
      if (maximized) setMaximized(false);
      setLinkDraft(null);
      setSelectedLink(null);
      setSelected(null);
      setVersions(null);
      setCreating(false);
      setConnecting(false);
      setQuestionsOpen(false);
      setPanelOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  /** 左上四张卡互斥：开一个关其余。 */
  const openTl = (which: "versions" | "create" | "connect" | "questions") => {
    setCreating(false);
    setConnecting(false);
    setQuestionsOpen(false);
    setVersions(null);
    if (which === "create") setCreating(true);
    if (which === "connect") setConnecting(true);
    if (which === "questions") setQuestionsOpen(true);
    // versions 的数据在调用方拉
  };

  /** 多选表 → 生成对象 → 直接上画布并收起抽屉。 */
  const generateFromTables = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const tables = [...selectedTables].map((key) => {
        const dot = key.indexOf("."); // 只切第一个点：连接名/表名里再有点不炸
        return { connection: key.slice(0, dot), table: key.slice(dot + 1) };
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
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
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
      <OntologyCanvas
        objects={objects}
        links={links}
        layout={ont?.layout}
        selectedLink={selectedLink}
        onSelect={(name) => {
          setSelected(name);
          setSelectedLink(null);
        }}
        onSelectLink={(name) => {
          setSelectedLink(name);
          setSelected(null);
        }}
        onConnectRequest={(from, to) => setLinkDraft({ from, to })}
        onLayoutChange={saveLayout}
        onToggleMaximize={() => setMaximized((v) => !v)}
      />

      {/* 左上：发布状态 + 入口（最大化时藏起） */}
      {!maximized && (
        <div className="float-card float-tl" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", maxWidth: "calc(100vw - 32px)" }}>
          <button
            className="eyebrow"
            style={{ cursor: "pointer", border: "none" }}
            title="版本历史"
            onClick={async () => {
              if (versions) {
                setVersions(null); // toggle：再点收起
                return;
              }
              openTl("versions");
              setVersions([]); // 先开卡给 loading 态再填数据——慢网络下不顶掉别人正在填的卡
              try {
                const r = await fetch("/api/versions");
                const data = await r.json();
                setVersions(data.versions ?? []);
              } catch (e) {
                showToast(`网络错误：${e instanceof Error ? e.message : String(e)}`);
              }
            }}
          >
            已发布 v{ont?.version ?? "…"} ▾
          </button>
          <button className="btn" onClick={() => openTl("create")}>新建对象</button>
          <button className="btn" onClick={() => openTl("connect")}>连接数据源</button>
          <button
            className="btn"
            onClick={async () => {
              try {
                await loadPairs();
                setPanelOpen(true);
              } catch (e) {
                showToast(`网络错误：${e instanceof Error ? e.message : String(e)}`);
              }
            }}
          >
            疑似重复
          </button>
          <button className="btn" onClick={() => (questionsOpen ? setQuestionsOpen(false) : openTl("questions"))}>验收问题集</button>
        </div>
      )}

      {/* 空画布引导：没有任何对象时告诉人两条起步路径 */}
      {ont && objects.length === 0 && (
        <div className="float-card" style={{ top: "40%", left: "50%", translate: "-50% -50%", width: 380 }}>
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 18, fontSize: 13, lineHeight: 2, color: "var(--ink-2)" }}>
              画布还是空的。两条起步路径：
              <br />· 点「连接数据源」接入库，再到「表结构」勾选表生成对象
              <br />· 或点「新建对象」手动建模
            </div>
          </div>
        </div>
      )}

      {/* 版本历史卡（点版本号展开；回滚 = 旧内容作为新版本发布） */}
      {!maximized && versions && (
        <div className="float-card float-tl" style={{ top: 120, width: 300 }}>
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>版本历史</span>
                <button className="chip" aria-label="关闭" onClick={() => setVersions(null)}>✕</button>
              </div>
              {versions.length === 0 && <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>读着呢…</div>}
              {versions.map((v) => (
                <div key={v.version} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, lineHeight: 2.2 }}>
                  <span>
                    <strong>v{v.version}</strong>　<span style={{ color: "var(--ink-3)" }}>{v.createdAt.slice(0, 16).replace("T", " ")}</span>
                  </span>
                  {v.version !== ont?.version && (
                    <button
                      className="chip"
                      disabled={rollbacking}
                      onClick={async () => {
                        if (rollbacking) return; // 防连点：连发会产生两个新版本
                        setRollbacking(true);
                        try {
                          const r = await fetch("/api/versions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: v.version }) });
                          const data = await r.json();
                          if (r.ok) {
                            showToast(`已回滚到 v${v.version} 的内容（发布为 v${data.version}）`);
                            setVersions(null);
                            await refresh();
                          } else showToast(data.error ?? "回滚失败");
                        } catch (e) {
                          showToast(`网络错误：${e instanceof Error ? e.message : String(e)}`);
                        } finally {
                          setRollbacking(false);
                        }
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
      {!maximized && questionsOpen && <QuestionsCard onClose={() => setQuestionsOpen(false)} showToast={showToast} />}

      {/* 底中：裁决面板（疑似重复）。打开时优先于发布条——同一时间底中只有这一张卡 */}
      {!maximized && panelOpen && (
        <div className="float-card float-bc" style={{ width: 520, maxHeight: "60%" }}>
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 14, overflow: "auto", maxHeight: "56vh" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>疑似重复的对象（{pairs.length} 处）</span>
                <button className="chip" aria-label="关闭" onClick={() => setPanelOpen(false)}>✕</button>
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>这些跨源对象可能是同一批现实对象，两两列出，请你逐条定夺；三个以上重复时会出多条，裁完一条会自动重算。</div>
              {pairs.length === 0 && <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 8 }}>没有发现跨源疑似重复的对象。单源对象不用判，可以直接发布。</div>}
              {pairs.map((p) => (
                <PairCard
                  key={`${p.class_a}|${p.class_b}`}
                  pair={p}
                  onDone={(msg) => {
                    showToast(msg);
                    // 重新拉一遍：被合并撤掉的类，挂着它的条目随之消失（三个以上重复时会连环）
                    void loadPairs().then(() => refresh());
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 底中：发布条（有未发布改动时；裁决面板打开时让位；最大化时藏起） */}
      {ont?.dirty && !panelOpen && !maximized && (
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

      {/* 左下：表结构抽屉开关（常驻，不被发布条挤掉；最大化时藏起） */}
      {!maximized && (
        <div className="float-card" style={{ bottom: 18, left: 16 }}>
          <button className="btn" onClick={() => setDrawerOpen((v) => !v)}>{drawerOpen ? "收起表结构" : "表结构"}</button>
        </div>
      )}

      {/* 最大化时的出口（Esc 同效） */}
      {maximized && (
        <div className="float-card" style={{ top: 16, right: 16 }}>
          <button className="btn" onClick={() => setMaximized(false)}>退出最大化（Esc）</button>
        </div>
      )}

      {/* toast：瞬时反馈 */}
      {toast && (
        <div className="float-card" style={{ top: 76, left: "50%", translate: "-50% 0", zIndex: 40 }}>
          <div className="bezel"><div className="bezel-core" style={{ padding: "8px 16px", fontSize: 13 }}>{toast}</div></div>
        </div>
      )}

      {/* 连接数据源卡（左上） */}
      {!maximized && connecting && (
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
      {!maximized && creating && (
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

      {/* 右侧：连线表单卡（从节点拖线落地后弹出） */}
      {!maximized && linkDraft && (
        <div className="float-card float-tr" style={{ width: 340 }}>
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontFamily: "var(--font-serif)", fontSize: 16 }}>新建关系</span>
                <button className="chip" aria-label="关闭" onClick={() => setLinkDraft(null)}>✕</button>
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", margin: "2px 0 10px" }}>
                {linkDraft.from} → {linkDraft.to}。关系得说清靠哪两个字段对上，默认用两边的识别字段。
              </div>
              <LinkForm
                key={`${linkDraft.from}|${linkDraft.to}`}
                from={linkDraft.from}
                to={linkDraft.to}
                objects={ont?.object_types ?? {}}
                onCancel={() => setLinkDraft(null)}
                onSubmit={async (body) => {
                  const ok = await op(body);
                  if (ok) {
                    setLinkDraft(null);
                    showToast("关系已进草稿（发布后生效）");
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* 右侧：关系详情卡（点边弹出） */}
      {!maximized && selectedLink && ont?.link_types?.[selectedLink] && !linkDraft && (
        <div className="float-card float-tr" style={{ width: 320 }}>
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontFamily: "var(--font-serif)", fontSize: 16 }}>{selectedLink}</span>
                <button className="chip" aria-label="关闭" onClick={() => setSelectedLink(null)}>✕</button>
              </div>
              {(() => {
                const l = ont.link_types[selectedLink] as any;
                return (
                  <div style={{ fontSize: 12, lineHeight: 2.2, color: "var(--ink-2)", margin: "6px 0 10px" }}>
                    <div>{l.from} → {l.to}{l.inverse ? `（反向名 ${l.inverse}）` : ""}</div>
                    {l.card && <div>基数 {l.card}</div>}
                    {l.match && <div>配对字段：{l.match.map((m: any) => `${m.from} → ${m.to}`).join("，")}</div>}
                    {l.transition && <div>状态转化：{l.transition.property} 从「{l.transition.from}」到「{l.transition.to}」</div>}
                    {l.description && <div style={{ color: "var(--ink-3)" }}>{l.description}</div>}
                  </div>
                );
              })()}
              <button
                className="chip"
                style={{ color: "var(--danger)" }}
                onClick={async () => {
                  const ok = await op({ op: "delete_link", name: selectedLink });
                  if (ok) {
                    setSelectedLink(null);
                    showToast(`已删除关系 ${selectedLink}（进草稿，发布后生效）`);
                  }
                }}
              >
                删除关系
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 右侧：对象编辑卡 */}
      {!maximized && sel && !creating && !linkDraft && !selectedLink && (
        <div className="float-card float-tr" style={{ width: 340, maxHeight: "calc(100% - 110px)" }}>
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 16, overflow: "auto", maxHeight: "calc(100vh - 140px)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontFamily: "var(--font-serif)", fontSize: 16 }}>{selected}</span>
                <button className="chip" aria-label="关闭" onClick={() => setSelected(null)}>✕</button>
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
                    // 跟挂载时的值比（defaultValue），不跟实时 sel 比——编辑期间的别处 refresh 不换基准
                    if (e.target.value !== e.target.defaultValue) void op({ op: "update_object", name: selected, description: e.target.value });
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

/** 裁决面板里的一对：建议 + 依据 + 交集率（按需计算）+ 五种结论。失败留在面板里可重试。 */
function PairCard({ pair, onDone }: { pair: PairAdvice; onDone: (msg: string) => void }) {
  const [rate, setRate] = useState<{ rate: number; count_a: number; count_b: number; count_hit: number; norm_rule?: string } | null>(null);
  const [stage, setStage] = useState({ from: "", to: "" });
  const [busy, setBusy] = useState(false);
  const [rateBusy, setRateBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (verdict: string) => {
    setBusy(true);
    setError(null);
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
          evidence: rate ?? undefined, // 证据快照：归一化规则、样本量、交集数、比率
        }),
      });
      const data = await r.json();
      if (!r.ok) setError(data.error ?? "裁决被拒"); // 留在面板里，能重试
      else onDone(`已裁决 ${pair.class_a} × ${pair.class_b}：${verdict}（进草稿，发布后生效）`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 五种结论的白话说明：名字是定案术语，解释是给用户扫一眼的
  const options: { v: string; hint: string }[] = [
    { v: "同一", hint: "就是同一批东西——合并成一个对象，挂多个来源" },
    { v: "部分重叠", hint: "有一部分重合——公共字段立一个公共对象，各自特有的字段留下" },
    { v: "阶段", hint: "同一批东西的不同阶段——合并成一个对象，加状态和转化动作" },
    { v: "仅名称相似", hint: "只是名字像，其实不相干——各自独立" },
    { v: "跳过", hint: "这次不判，先放着" },
  ];

  return (
    <div style={{ borderTop: "1px solid var(--hairline)", padding: "12px 0" }}>
      <div style={{ fontSize: 13 }}>
        <code>{pair.class_a}</code> × <code>{pair.class_b}</code>
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-2)", margin: "6px 0 2px" }}>
        AI 建议「{pair.tendency}」，依据：{pair.reason}。
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6 }}>建议只是参考——起名像不像会骗人，定夺要看真实数据和你。</div>
      <div style={{ fontSize: 12, color: "var(--ink-2)", margin: "4px 0" }}>
        {rate ? (
          <>
            两边识别字段实际重合 <strong>{(rate.rate * 100).toFixed(0)}%</strong>（{pair.class_a} {rate.count_a} 条、{pair.class_b} {rate.count_b} 条，其中 {rate.count_hit} 条对得上号）
            {rate.count_hit === 0 ? "——完全对不上，多半不相干" : rate.rate >= 0.5 ? "——多半是同一批" : ""}
          </>
        ) : (
          <button
            className="chip"
            disabled={rateBusy}
            onClick={async () => {
              if (rateBusy) return; // 交集是内存集合运算，连点没意义
              setRateBusy(true);
              setError(null);
              try {
                const r = await fetch("/api/overlap", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ class_a: pair.class_a, class_b: pair.class_b }),
                });
                const data = await r.json();
                if (r.ok) setRate(data);
                else setError(data.error ?? "算不了");
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setRateBusy(false);
              }
            }}
          >
            {rateBusy ? "算着…" : "算一算实际重合度"}
          </button>
        )}
      </div>
      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>实际重合度 = 两边识别字段的取值有多少对得上号（内存里算，不搬数据出库）。</div>
      <div style={{ fontSize: 12, color: "var(--ink-2)", margin: "10px 0 4px" }}>是同一批现实对象吗？选一个结论：</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {options.map((o) => (
          <div key={o.v} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
            <button
              className="chip"
              style={{ minWidth: 76, textAlign: "center" }}
              disabled={busy || (o.v === "阶段" && (!stage.from || !stage.to))}
              onClick={() => decide(o.v)}
            >
              {o.v}
            </button>
            <span style={{ color: "var(--ink-3)" }}>{o.hint}</span>
            {o.v === "阶段" && (
              <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                <input placeholder="前阶段，如：在途" value={stage.from} onChange={(e) => setStage({ ...stage, from: e.target.value })} style={{ width: 110, fontSize: 12, padding: "3px 8px", borderRadius: 8, border: "none", boxShadow: "inset 0 0 0 1px var(--hairline-strong)", background: "var(--panel-2)" }} />
                <span style={{ color: "var(--ink-3)" }}>→</span>
                <input placeholder="后阶段，如：在役" value={stage.to} onChange={(e) => setStage({ ...stage, to: e.target.value })} style={{ width: 110, fontSize: 12, padding: "3px 8px", borderRadius: 8, border: "none", boxShadow: "inset 0 0 0 1px var(--hairline-strong)", background: "var(--panel-2)" }} />
              </span>
            )}
          </div>
        ))}
      </div>
      {error && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 6 }}>{error}</div>}
    </div>
  );
}

/** 验收问题集：增删 + 对着引擎跑通过/失败。问数验收基准，不参与裁决。 */
function QuestionsCard({ onClose, showToast }: { onClose: () => void; showToast: (s: string) => void }) {
  const [items, setItems] = useState<{ id: number; question: string; status: string }[]>([]);
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [acting, setActing] = useState(false); // 增删的防连点
  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/questions");
      const data = await r.json();
      setItems(data.questions ?? []);
    } catch {
      showToast("问题集读不出来");
    }
  }, [showToast]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="float-card float-tl" style={{ top: 120, width: 360 }}>
      <div className="bezel">
        <div className="bezel-core" style={{ padding: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>验收问题集</span>
            <button className="chip" aria-label="关闭" onClick={onClose}>✕</button>
          </div>
          {items.map((q) => (
            <div key={q.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, lineHeight: 2.2 }}>
              <span>{q.question}</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className={`tag ${q.status === "通过" ? "tag-ok" : q.status === "失败" ? "tag-warn" : ""}`}>{q.status}</span>
                <button
                  className="chip"
                  aria-label="删除"
                  disabled={acting}
                  onClick={async () => {
                    setActing(true);
                    try {
                      await fetch("/api/questions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: q.id }) });
                      await load();
                    } finally {
                      setActing(false);
                    }
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
              if (!text.trim() || acting) return;
              setActing(true);
              try {
                const r = await fetch("/api/questions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: text.trim() }) });
                if (r.ok) setText("");
                else showToast("没加上");
                await load();
              } finally {
                setActing(false);
              }
            }}
            style={{ display: "flex", gap: 6, marginTop: 8 }}
          >
            <input className="text-in" style={{ flex: 1, fontSize: 12, padding: "6px 10px" }} placeholder="加一条业务问题" value={text} onChange={(e) => setText(e.target.value)} />
            <button type="submit" className="btn" style={{ fontSize: 12 }} disabled={acting}>加</button>
          </form>
          <button
            className="btn-cta"
            style={{ fontSize: 12, padding: "6px 16px", marginTop: 10 }}
            disabled={running}
            onClick={async () => {
              if (running) return; // 防连点：连跑多遍没意义
              setRunning(true);
              try {
                const r = await fetch("/api/questions?run=1", { method: "POST" });
                const data = await r.json();
                const failed = (data.results ?? []).filter((x: { status: string }) => x.status === "失败");
                showToast(failed.length ? `${failed.length} 条失败，回 M2/M3 修本体或映射` : `全部通过（v${data.version}）`);
                await load();
              } catch (e) {
                showToast(`网络错误：${e instanceof Error ? e.message : String(e)}`);
              } finally {
                setRunning(false);
              }
            }}
          >
            {running ? "跑着…" : "全量跑一遍"}
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

/** 连线表单：关系名/反向名/基数 + 配对字段（默认两边识别字段）。 */
function LinkForm({ from, to, objects, onSubmit, onCancel }: { from: string; to: string; objects: Record<string, any>; onSubmit: (body: Record<string, unknown>) => void; onCancel: () => void }) {
  const fromProps = Object.keys(objects[from]?.properties ?? {});
  const toProps = Object.keys(objects[to]?.properties ?? {});
  const idOf = (c: string) => objects[c]?.identity;
  const [name, setName] = useState(`${from}_${to}`);
  const [inverse, setInverse] = useState("");
  const [card, setCard] = useState("");
  const [description, setDescription] = useState("");
  const [matchFrom, setMatchFrom] = useState(idOf(from) ?? fromProps[0] ?? "");
  const [matchTo, setMatchTo] = useState(idOf(to) ?? toProps[0] ?? "");
  const selStyle: React.CSSProperties = { fontSize: 12, padding: "4px 8px", borderRadius: 8, border: "none", boxShadow: "0 0 0 1px var(--hairline)", background: "var(--panel)" };
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
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err)); // 网络层失败也留卡内
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
