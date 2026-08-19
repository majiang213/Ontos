// 本体构建页 —— 纯画布页（无对话列）。
// 画布内容 = 工作副本（已发布 + 未发布改动）；发布走「发布 vN+1 / 放弃」；表结构收进底部抽屉。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import OntologyCanvas, { type CanvasLink, type CanvasObject } from "./OntologyCanvas";
import PairCard from "./PairCard";
import { apiUrl } from "./wsClient";
import QuestionsCard from "./QuestionsCard";
import { AddProperty, ConnectForm, CreateForm, LinkForm, Section } from "./forms";
import type { PairAdvice } from "../lib/engine/llmSlot";

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

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);
  /** 网络层失败（fetch reject）的统一提示。 */
  const netErr = useCallback((e: unknown) => showToast(`网络错误：${e instanceof Error ? e.message : String(e)}`), [showToast]);

  const refresh = useCallback(() => fetch(apiUrl("/api/ontology")).then((r) => r.json()).then(setOnt), []);
  // 疑似重复列表：每次从服务端按当前草稿重算（已裁的、被合并撤掉的都不再来）
  const loadPairs = useCallback(async () => {
    const r = await fetch(apiUrl("/api/candidates"));
    const data = await r.json();
    setPairs(data.candidates ?? []);
  }, []);
  useEffect(() => {
    refresh().catch(netErr); // 首轮加载失败也要说
    fetch(apiUrl("/api/introspect")).then((r) => r.json()).then(setSchema).catch(netErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时跑一次
  }, [refresh, netErr]);

  /** 编辑操作统一入口：发给草稿，刷新视图，错误进 toast。网络层失败也要说。 */
  const op = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const r = await fetch(apiUrl("/api/draft"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const data = await r.json();
        if (!r.ok) {
          showToast(data.error ?? "操作被拒");
          return false;
        }
        await refresh();
        return true;
      } catch (e) {
        netErr(e);
        return false;
      }
    },
    [refresh, showToast, netErr]
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
      const r = await fetch(apiUrl("/api/publish"), { method: "POST" });
      const data = await r.json();
      if (!r.ok) showToast(data.error ?? "发布被拒");
      else showToast(`已发布 v${data.version}，问数与动作即刻生效`);
      await refresh();
    } catch (e) {
      netErr(e);
    } finally {
      setPublishing(false);
    }
  };
  const discard = async () => {
    if (publishing) return; // 与发布同一把闸，防连点
    setPublishing(true);
    try {
      const r = await fetch(apiUrl("/api/publish"), { method: "DELETE" });
      if (!r.ok) {
        const data = await r.json();
        showToast(data.error ?? "放弃失败");
        return;
      }
      showToast("已放弃改动，回到已发布快照");
      setSelected(null);
      await refresh();
    } catch (e) {
      netErr(e);
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
      setDrawerOpen(false);
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
      const r = await fetch(apiUrl("/api/generate"), {
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
      netErr(e);
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
                const r = await fetch(apiUrl("/api/versions"));
                const data = await r.json();
                // 用户可能已去开别的卡（openTl 会把 versions 置 null）：只在本卡还开着时填数
                setVersions((cur) => (cur === null ? null : (data.versions ?? [])));
              } catch (e) {
                netErr(e);
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
                netErr(e);
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
                          const r = await fetch(apiUrl("/api/versions"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version: v.version }) });
                          const data = await r.json();
                          if (r.ok) {
                            showToast(`已回滚到 v${v.version} 的内容（发布为 v${data.version}）`);
                            setVersions(null);
                            await refresh();
                          } else showToast(data.error ?? "回滚失败");
                        } catch (e) {
                          netErr(e);
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
        <div className="float-card float-bc" style={{ width: 760, maxHeight: "78%" }}>
          <div className="bezel">
            <div className="bezel-core" style={{ padding: 14, overflow: "auto", maxHeight: "72vh" }}>
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
                  try {
                    const s = await fetch(apiUrl("/api/introspect")).then((r) => r.json());
                    setSchema(s);
                    setDrawerOpen(true); // 保存后自动打开表结构抽屉
                  } catch (e) {
                    netErr(e); // 连上了但刷表结构失败：连接已存，刷新失败要告诉人
                  }
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
              <Section title={`识别字段（跨源认人靠它）`}>
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

      {/* 底部抽屉：表结构（只看列定义与采样，多选可生成对象；最大化时藏起） */}
      {!maximized && drawerOpen && (
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
