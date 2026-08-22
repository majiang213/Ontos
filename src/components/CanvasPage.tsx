// 本体构建页 —— 纯画布页（无对话列）。
// 画布内容 = 工作副本（已发布 + 未发布改动）；发布走「发布 vN+1 / 放弃」；表结构收进底部抽屉。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import OntologyCanvas, { type CanvasLink, type CanvasObject } from "./OntologyCanvas";
import PairCard from "./PairCard";
import Bezel from "./Bezel";
import { ApiError, apiGet, apiPost, apiDel } from "./wsClient";
import QuestionsCard from "./QuestionsCard";
import { ConnectForm, CreateForm, FieldForm, LinkForm, PROP_TYPES, Section } from "./forms";
import type { PairAdvice } from "../server/engine/llmSlot";

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
    tables: { name: string; columns: { name: string; type: string; pk: boolean; comment?: string }[]; sample?: Record<string, unknown>[] }[];
  }[];
}

/** 浮卡（「同一时间只浮一张卡」的类型表达）：开一张 = 收其余，互斥由联合类型保证，不再手工维护。
 *  左上组（版本/新建/连接/问题集）与右侧组（连线表单/关系详情/对象编辑）同一联合——开任何一张都收上一张。
 *  例外：底中裁决面板与底部表结构抽屉是独立区域，不进联合。 */
type Card =
  | { kind: "versions" }
  | { kind: "create" }
  | { kind: "connect" }
  | { kind: "questions" }
  | { kind: "link"; from: string; to: string } // 拖线落地后等待取名的半成品
  | { kind: "linkDetail"; name: string } // 点中的边
  | { kind: "object"; name: string } // 对象编辑卡
  | null;

export default function CanvasPage() {
  const [ont, setOnt] = useState<OntologyResp | null>(null);
  const [schema, setSchema] = useState<IntrospectResp | null>(null);
  const [card, setCard] = useState<Card>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [pairs, setPairs] = useState<PairAdvice[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [versionsData, setVersionsData] = useState<{ version: number; createdAt: string }[] | null>(null); // null = 读着呢
  const [publishing, setPublishing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [rollbacking, setRollbacking] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [fieldForm, setFieldForm] = useState<{ mode: "create" } | { mode: "edit"; name: string } | null>(null); // 字段区：列表 ↔ 表单
  const cardName = card?.kind === "object" ? card.name : null;
  useEffect(() => setFieldForm(null), [cardName]); // 换卡收表单
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []); // 卸载清定时器

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);
  /** 网络层失败（fetch reject）的统一提示。服务端拒绝（ApiError）带上游文案，不走这里。 */
  const netErr = useCallback((e: unknown) => showToast(`网络错误：${e instanceof Error ? e.message : String(e)}`), [showToast]);
  /** 失败的统一分流：服务端拒绝直接显示上游文案，网络层失败加前缀。 */
  const failToast = useCallback((e: unknown) => (e instanceof ApiError ? showToast(e.message) : netErr(e)), [showToast, netErr]);

  const refresh = useCallback(() => apiGet<OntologyResp>("/api/ontology").then(setOnt), []);
  // 疑似重复列表：每次从服务端按当前草稿重算（已裁的、被合并撤掉的都不再来）
  const loadPairs = useCallback(async () => {
    const data = await apiGet<{ candidates?: PairAdvice[] }>("/api/candidates");
    setPairs(data.candidates ?? []);
  }, []);
  useEffect(() => {
    refresh().catch(netErr); // 首轮加载失败也要说
    apiGet<IntrospectResp>("/api/introspect").then(setSchema).catch(netErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时跑一次
  }, [refresh, netErr]);

  /** 编辑操作统一入口：发给草稿，刷新视图，错误进 toast。网络层失败也要说。 */
  const op = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        await apiPost("/api/draft", body);
        await refresh();
        return true;
      } catch (e) {
        failToast(e);
        return false;
      }
    },
    [refresh, failToast]
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
      const data = await apiPost<{ version: number }>("/api/publish");
      showToast(`已发布 v${data.version}，问数与动作即刻生效`);
      await refresh();
    } catch (e) {
      failToast(e);
    } finally {
      setPublishing(false);
    }
  };
  const discard = async () => {
    if (publishing) return; // 与发布同一把闸，防连点
    setPublishing(true);
    try {
      await apiDel("/api/publish");
      showToast("已放弃改动，回到已发布快照");
      setCard(null);
      await refresh();
    } catch (e) {
      failToast(e);
    } finally {
      setPublishing(false);
    }
  };

  // Esc 关一切浮卡。输入控件里的 Esc 不拦——那边的 onBlur 自动保存语义不能被关卡吃掉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea,select")) return;
      setCard(null);
      setPanelOpen(false);
      setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 多选表 → 生成对象 → 直接上画布并收起抽屉。 */
  const generateFromTables = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const tables = [...selectedTables].map((key) => {
        const dot = key.indexOf("."); // 只切第一个点：连接名/表名里再有点不炸
        return { connection: key.slice(0, dot), table: key.slice(dot + 1) };
      });
      const data = await apiPost<{ created: string[] }>("/api/generate", { tables });
      showToast(`已生成对象：${data.created.join("、")}（草稿，发布后生效）`);
      setSelectedTables(new Set());
      setDrawerOpen(false);
      await refresh();
    } catch (e) {
      failToast(e);
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
          description: d.description,
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

  const sel = card?.kind === "object" ? (ont?.object_types?.[card.name] as any) : null;

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
      <OntologyCanvas
        objects={objects}
        links={links}
        layout={ont?.layout}
        selectedLink={card?.kind === "linkDetail" ? card.name : null}
        onSelect={(name) => setCard({ kind: "object", name })}
        onSelectLink={(name) => setCard({ kind: "linkDetail", name })}
        onConnectRequest={(from, to) => setCard({ kind: "link", from, to })}
        onLayoutChange={saveLayout}
      />

      {/* 左上：发布状态 + 入口 */}
      <div className="float-card float-tl" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", maxWidth: "calc(100vw - 32px)" }}>
          <button
            className="eyebrow"
            style={{ cursor: "pointer", border: "none" }}
            title="版本历史"
            onClick={async () => {
              if (card?.kind === "versions") {
                setCard(null); // toggle：再点收起
                return;
              }
              setCard({ kind: "versions" });
              setVersionsData(null); // 先给「读着呢」态再填数据
              try {
                const data = await apiGet<{ versions?: { version: number; createdAt: string }[] }>("/api/versions");
                setVersionsData(data.versions ?? []);
              } catch (e) {
                netErr(e);
              }
            }}
          >
            {/* 空白种子版本（v1 且没有任何对象）不算「发布过」——空白空间注册时自动有一个空本体的 v1 */}
            {ont && ont.version === 1 && Object.keys(ont.object_types).length === 0 ? "未发布" : `已发布 v${ont?.version ?? "…"}`} ▾
          </button>
          {/* 发布常驻工具条、永可点：有改动时是「发布 vN+1 / 放弃」，没改动点一下给提示（不置灰） */}
          {ont?.dirty ? (
            <>
              <button
                className="btn-cta"
                style={{ fontSize: 12, padding: "6px 10px 6px 14px" }}
                title={ont.deleted?.length ? `将删除：${ont.deleted.join("、")}` : undefined}
                onClick={publish}
                disabled={publishing}
              >
                发布 v{(ont?.version ?? 1) + 1}
              </button>
              <button className="btn" onClick={discard} disabled={publishing}>放弃</button>
            </>
          ) : (
            <button className="btn" onClick={() => showToast("没有未发布的改动——画布和已发布一致")}>发布</button>
          )}
          <button className="btn" onClick={() => setCard({ kind: "create" })}>新建对象</button>
          <button className="btn" onClick={() => setCard({ kind: "connect" })}>连接数据源</button>
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
          <button className="btn" onClick={() => (card?.kind === "questions" ? setCard(null) : setCard({ kind: "questions" }))}>验收问题集</button>
      </div>

      {/* 空画布引导：没有任何对象时告诉人两条起步路径 */}
      {ont && objects.length === 0 && (
        <div className="float-card" style={{ top: "40%", left: "50%", translate: "-50% -50%", width: 380 }}>
          <Bezel pad={18} coreStyle={{ fontSize: 13, lineHeight: 2, color: "var(--ink-2)" }}>
            画布还是空的。两条起步路径：
            <br />· 点「连接数据源」接入库，再到「表结构」勾选表生成对象
            <br />· 或点「新建对象」手动建模
          </Bezel>
        </div>
      )}

      {/* 版本历史卡（点版本号展开；回滚 = 旧内容作为新版本发布） */}
      {card?.kind === "versions" && (
        <div className="float-card float-tl" style={{ top: 120, width: 300 }}>
          <Bezel>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>版本历史</span>
                <button className="chip" aria-label="关闭" onClick={() => setCard(null)}>✕</button>
              </div>
              {versionsData === null && <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>读着呢…</div>}
              {versionsData !== null && ont && ont.version === 1 && Object.keys(ont.object_types).length === 0 ? (
                // 空白种子版本（注册时自动落的空本体 v1）不算发布史
                <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 6 }}>还没有发布过——发布一次之后这里会列出历史版本</div>
              ) : (versionsData ?? []).map((v) => (
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
                          const data = await apiPost<{ version: number }>("/api/versions", { version: v.version });
                          showToast(`已回滚到 v${v.version} 的内容（发布为 v${data.version}）`);
                          setCard(null);
                          await refresh();
                        } catch (e) {
                          failToast(e);
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
          </Bezel>
        </div>
      )}

      {/* 验收问题集卡 */}
      {card?.kind === "questions" && <QuestionsCard onClose={() => setCard(null)} showToast={showToast} />}

      {/* 底中：裁决面板（疑似重复）。打开时优先于发布条——同一时间底中只有这一张卡 */}
      {panelOpen && (
        <div className="float-card float-bc" style={{ width: 760, maxHeight: "78%" }}>
          <Bezel coreStyle={{ overflow: "auto", maxHeight: "72vh" }}>
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
                  if (msg) showToast(msg); // 空串 = 不动草稿的结论（仅名称相似/跳过），不弹提示
                  // 重新拉一遍：被合并撤掉的类，挂着它的条目随之消失（三个以上重复时会连环）
                  void loadPairs().then(() => refresh());
                }}
              />
            ))}
          </Bezel>
        </div>
      )}

      {/* 左下：表结构抽屉开关（常驻） */}
      <div className="float-card" style={{ bottom: 18, left: 16 }}>
        <button className="btn" onClick={() => setDrawerOpen((v) => !v)}>{drawerOpen ? "收起表结构" : "表结构"}</button>
      </div>

      {/* toast：瞬时反馈 */}
      {toast && (
        <div className="float-card" style={{ top: 76, left: "50%", translate: "-50% 0", zIndex: 40 }}>
          <Bezel pad="8px 16px" coreStyle={{ fontSize: 13 }}>{toast}</Bezel>
        </div>
      )}

      {/* 连接数据源卡（左上） */}
      {card?.kind === "connect" && (
        <div className="float-card float-tl" style={{ top: 120, width: 320 }}>
          <Bezel>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>连接数据源</div>
            <ConnectForm
              onCancel={() => setCard(null)}
              onDone={async (msg) => {
                setCard(null);
                showToast(msg);
                try {
                  setSchema(await apiGet<IntrospectResp>("/api/introspect"));
                  setDrawerOpen(true); // 保存后自动打开表结构抽屉
                } catch (e) {
                  netErr(e); // 连上了但刷表结构失败：连接已存，刷新失败要告诉人
                }
              }}
            />
          </Bezel>
        </div>
      )}

      {/* 新建对象卡（左上） */}
      {card?.kind === "create" && (
        <div className="float-card float-tl" style={{ top: 120, width: 300 }}>
          <Bezel>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>新建对象</div>
            <CreateForm
              onCancel={() => setCard(null)}
              onSubmit={async (name, description, kind) => {
                const ok = await op({ op: "create_object", name, description, kind });
                if (ok) {
                  setCard({ kind: "object", name }); // 建成即打开新对象的编辑卡
                  showToast(`已加入草稿：${name}（发布后生效）`);
                }
              }}
            />
          </Bezel>
        </div>
      )}

      {/* 右侧：连线表单卡（从节点拖线落地后弹出） */}
      {card?.kind === "link" && (
        <div className="float-card float-tr" style={{ width: 340 }}>
          <Bezel pad={16}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontFamily: "var(--font-serif)", fontSize: 16 }}>新建关系</span>
              <button className="chip" aria-label="关闭" onClick={() => setCard(null)}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-3)", margin: "2px 0 10px" }}>
              {card.from} → {card.to}。关系得说清靠哪两个字段对上，默认用两边的唯一键。
            </div>
            <LinkForm
              key={`${card.from}|${card.to}`}
              from={card.from}
              to={card.to}
              objects={ont?.object_types ?? {}}
              onCancel={() => setCard(null)}
              onSubmit={async (body) => {
                const ok = await op(body);
                if (ok) {
                  setCard(null);
                  showToast("关系已进草稿（发布后生效）");
                }
              }}
            />
          </Bezel>
        </div>
      )}

      {/* 右侧：关系详情卡（点边弹出）：名称/反向名/描述可改，失焦保存 */}
      {card?.kind === "linkDetail" && ont?.link_types?.[card.name] && (
        <div className="float-card float-tr" style={{ width: 320 }}>
          <Bezel pad={16}>
            {(() => {
              const l = ont.link_types[card.name] as any;
              return (
                <>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <span style={{ fontFamily: "var(--font-serif)", fontSize: 16 }}>{card.name}</span>
                    <button className="chip" aria-label="关闭" onClick={() => setCard(null)}>✕</button>
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 2, color: "var(--ink-3)", margin: "2px 0 10px" }}>
                    <div>{l.from} → {l.to}{l.card ? `，基数 ${l.card}` : ""}</div>
                    {l.transition && <div>状态转化：{l.transition.property} 从「{l.transition.from}」到「{l.transition.to}」</div>}
                    {l.match && <div>配对字段：{l.match.map((m: any) => `${m.from} → ${m.to}`).join("，")}</div>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 11, color: "var(--ink-3)" }}>
                    <label>
                      名称
                      <input
                        key={`name:${card.name}`} /* 换关系强制重挂，旧名不写进新关系 */
                        className="text-in"
                        style={{ width: "100%", fontSize: 12, padding: "6px 10px" }}
                        defaultValue={card.name} /* 关系名是 link_types 的键，不在条目里 */
                        onBlur={async (e) => {
                          const v = e.target.value.trim();
                          if (!v || v === e.target.defaultValue) return;
                          const ok = await op({ op: "update_link", name: card.name, new_name: v });
                          if (ok) {
                            setCard({ kind: "linkDetail", name: v }); // 边以关系名为键：卡跟新名走
                            showToast(`关系已改名为 ${v}（进草稿，发布后生效）`);
                          }
                        }}
                      />
                    </label>
                    <label>
                      反向名（可选）
                      <input
                        key={`inv:${card.name}`}
                        className="text-in"
                        style={{ width: "100%", fontSize: 12, padding: "6px 10px" }}
                        defaultValue={l.inverse ?? ""}
                        onBlur={async (e) => {
                          const v = e.target.value.trim();
                          if (v === e.target.defaultValue) return;
                          const ok = await op({ op: "update_link", name: card.name, inverse: v });
                          if (ok) showToast(`反向名已更新（进草稿，发布后生效）`);
                        }}
                      />
                    </label>
                    <label>
                      描述（可选）
                      <textarea
                        key={`desc:${card.name}`}
                        className="ctl"
                        rows={2}
                        style={{ width: "100%" }}
                        defaultValue={l.description ?? ""}
                        onBlur={async (e) => {
                          if (e.target.value === e.target.defaultValue) return;
                          const ok = await op({ op: "update_link", name: card.name, description: e.target.value });
                          if (ok) showToast(`描述已更新（进草稿，发布后生效）`);
                        }}
                      />
                    </label>
                  </div>
                  <button
                    className="chip"
                    style={{ color: "var(--danger)", marginTop: 10 }}
                    onClick={async () => {
                      const ok = await op({ op: "delete_link", name: card.name });
                      if (ok) {
                        setCard(null);
                        showToast(`已删除关系 ${card.name}（进草稿，发布后生效）`);
                      }
                    }}
                  >
                    删除关系
                  </button>
                </>
              );
            })()}
          </Bezel>
        </div>
      )}

      {/* 右侧：对象编辑卡 */}
      {sel && card?.kind === "object" && (
        <div className="float-card float-tr" style={{ width: 400, maxHeight: "calc(100% - 110px)" }}>
          <Bezel pad={16} coreStyle={{ overflow: "auto", maxHeight: "calc(100vh - 140px)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontFamily: "var(--font-serif)", fontSize: 16 }}>{card.name}</span>
              <button className="chip" aria-label="关闭" onClick={() => setCard(null)}>✕</button>
            </div>
            <div style={{ color: "var(--ink-3)", fontSize: 11, margin: "2px 0 8px" }}>
              {ont?.states?.[card.name] === "new" ? "草稿，发布后生效" : ont?.states?.[card.name] === "modified" ? "有未发布改动" : "与已发布一致"}
            </div>
              <Section title="描述">
                <textarea
                  key={card.name} /* 切换对象时强制重挂，否则旧描述会写进新对象 */
                  className="ctl"
                  defaultValue={sel.description ?? ""}
                  rows={1}
                  style={{ width: "100%" }}
                  onBlur={(e) => {
                    // 跟挂载时的值比（defaultValue），不跟实时 sel 比——编辑期间的别处 refresh 不换基准
                    if (e.target.value !== e.target.defaultValue) void op({ op: "update_object", name: card.name, description: e.target.value });
                  }}
                />
              </Section>
              <Section title="唯一键">
                <select
                  className="ctl"
                  value={sel.identity ?? ""}
                  onChange={async (e) => {
                    const ok = await op({ op: "set_identity", object: card.name, name: e.target.value });
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
                          object: card.name,
                          name: v.name,
                          type: v.type,
                          description: v.description || undefined,
                          values: v.type === "enum" && v.values.length ? v.values : undefined,
                        });
                      }
                      return op({
                        op: "update_property",
                        object: card.name,
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
                          onClick={() => void op({ op: "remove_property", object: card.name, name: p })}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <button className="btn" style={{ fontSize: 12, marginTop: 6 }} onClick={() => setFieldForm({ mode: "create" })}>加字段</button>
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
                    const ok = await op({ op: "delete_object", name: card.name });
                    if (ok) {
                      setCard(null);
                      showToast(`已删除 ${card.name}（发布后生效）`);
                    }
                  }}
                >
                  删除这个对象
                </button>
              </Section>
          </Bezel>
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
                    <Bezel key={t.name} pad={12} style={{ minWidth: 260, outline: checked ? "2px solid var(--accent)" : "none" }}>
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
                            <span style={{ color: "var(--ink-3)" }}> {c.type}{c.pk ? " · 主键" : ""}{c.comment ? ` · ${c.comment}` : ""}</span>
                          </span>
                          <span style={{ color: "var(--ink-3)" }}>{columnTarget(s.connection, t.name, c.name)}</span>
                        </div>
                      ))}
                    </Bezel>
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
