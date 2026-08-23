// 本体构建页 —— 纯画布页（无对话列）。
// 画布内容 = 工作副本（已发布 + 未发布改动）；发布走「发布 vN+1 / 放弃」；表结构收进底部抽屉。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import OntologyCanvas from "./OntologyCanvas";
import type { CanvasLink, CanvasObject } from "./layout";
import type { BorderPin } from "./FloatingEdge";
import PairCard from "./PairCard";
import Bezel from "./Bezel";
import { ApiError, apiGet, apiPost, apiDel, getWs } from "./wsClient";
import QuestionsCard from "./QuestionsCard";
import { ActionForm, ConnectForm, CreateForm, FieldForm, LinkForm, PROP_TYPES, Section } from "./forms";
import { effectSummary, externalToast, formCompatible } from "./actionView";
import type { PairAdvice } from "../server/engine/llmSlot";

interface OntologyResp {
  rev: number; // Store.rev：轮询监视器按它判变没变（ETag 同值）
  version: number;
  dirty: boolean;
  layout: Record<string, { x: number; y: number }>;
  edgeBends: Record<string, { dx: number; dy: number }>; // 线的弯折点（界面状态，随摆位存）
  edgePins: Record<string, { source?: { side: "top" | "bottom" | "left" | "right"; t: number }; target?: { side: "top" | "bottom" | "left" | "right"; t: number } }>; // 端点钉点
  states: Record<string, "new" | "modified" | "same">;
  deleted: string[];
  action_changes: { added: string[]; overwritten: string[]; removed: string[] }; // 类名.动作名
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
  | { kind: "link"; from: string; to: string; pins?: { source?: BorderPin; target?: BorderPin } } // 拖线落地后等待取名的半成品（pins = 两端钉点）
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
  const [actionForm, setActionForm] = useState<{ mode: "create" } | { mode: "edit"; name: string } | null>(null); // 动作区：列表 ↔ 表单
  const cardName = card?.kind === "object" ? card.name : null;
  useEffect(() => setFieldForm(null), [cardName]); // 换卡收表单
  useEffect(() => setActionForm(null), [cardName]);
  // 监视器状态：lastRev/etag 跟服务端对齐；localBusy=本页正在写；formBusy=表单开着（不冲掉未保存内容）
  const ontRef = useRef<OntologyResp | null>(null);
  const cardRef = useRef<Card>(null);
  const actionFormRef = useRef<typeof actionForm>(null);
  const lastRev = useRef<number | null>(null);
  const etagRef = useRef<string | null>(null);
  const localBusy = useRef(false);
  const pollFailed = useRef(false);
  const formBusy = useRef(false);
  const actionFormDirty = useRef(false);
  const actionFormRev = useRef<number | null>(null); // 打开动作表单那一刻的 rev：保存时不一样要先问
  useEffect(() => { cardRef.current = card; }, [card]);
  useEffect(() => { actionFormRef.current = actionForm; }, [actionForm]);
  useEffect(() => { formBusy.current = Boolean(fieldForm || actionForm); }, [fieldForm, actionForm]);
  useEffect(() => {
    if (actionForm) actionFormRev.current = lastRev.current;
    else { actionFormRev.current = null; actionFormDirty.current = false; }
  }, [actionForm]);
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

  /** 每次拿到本体 JSON 都过这里：state、rev、ETag 一起记——本页写入的 refresh 与轮询共用这一句。 */
  const applyOnt = useCallback((data: OntologyResp) => {
    ontRef.current = data;
    lastRev.current = data.rev;
    etagRef.current = `"${getWs()}-${data.rev}"`; // 与 GET /api/ontology 的 ETag 同格式
    setOnt(data);
  }, []);
  const refresh = useCallback(() => apiGet<OntologyResp>("/api/ontology").then(applyOnt), [applyOnt]);
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

  /** 本页一切写路径的唯一入口：写期间 localBusy 置位，轮询不动作也不 toast 成「外部改动」。
   *  finally 里一定放下——失败也放（写成功但 refresh 失败同样放，让下一轮轮询把已落地的草稿拉回来）。 */
  const withLocalWrite = useCallback(
    async (fn: () => Promise<void>): Promise<boolean> => {
      localBusy.current = true;
      try {
        await fn();
        return true;
      } catch (e) {
        failToast(e);
        return false;
      } finally {
        localBusy.current = false;
      }
    },
    [failToast]
  );

  // 画布当监视器：每 2 秒轮询工作副本（隐页暂停），外部写入后约 2 秒内刷新并 toast。
  // 自有 fetch（cache: no-store + If-None-Match）：apiGet 对非 2xx 抛错且拿不到 304，不能复用。
  useEffect(() => {
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch(`/api/ontology?ws=${encodeURIComponent(getWs())}`, {
          cache: "no-store",
          headers: etagRef.current ? { "If-None-Match": etagRef.current } : {},
        });
        if (r.status === 304) {
          pollFailed.current = false;
          return; // 无变化
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as OntologyResp;
        pollFailed.current = false;
        if (localBusy.current) return; // 本页正在写：它自己会 refresh，不当外部改动
        if (lastRev.current !== null && data.rev === lastRev.current) return; // rev 没变（兜底；正常走 304）
        if (formBusy.current) {
          // 表单开着：不冲掉未保存的内容、不偷偷重挂；记下新 rev，保存或取消后再拉一次
          lastRev.current = data.rev;
          etagRef.current = r.headers.get("etag") ?? etagRef.current;
          showToast("草稿有更新，保存会盖掉外面刚写的");
          return;
        }
        const prev = ontRef.current;
        applyOnt(data);
        // 开着的对象卡对应类已不在草稿里：收卡
        const open = cardRef.current;
        if (open?.kind === "object" && !(open.name in data.object_types)) {
          setCard(null);
          showToast("这个对象已从草稿里去掉");
          return;
        }
        if (prev) showToast(externalToast(prev, data)); // 首轮由 refresh 负责，不弹
      } catch {
        if (!pollFailed.current) {
          pollFailed.current = true; // 失败一次就提醒，但不每 2 秒弹
          showToast("没法自动刷新画布，请重新打开本页");
        }
      }
    };
    const timer = setInterval(tick, 2000);
    return () => clearInterval(timer);
  }, [applyOnt, showToast]);

  /** 编辑操作统一入口：发给草稿，刷新视图，错误进 toast。网络层失败也要说。 */
  const op = useCallback(
    async (body: Record<string, unknown>) =>
      withLocalWrite(async () => {
        await apiPost("/api/draft", body);
        await refresh();
      }),
    [withLocalWrite, refresh]
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
      await withLocalWrite(async () => {
        const data = await apiPost<{ version: number }>("/api/publish");
        showToast(`已发布 v${data.version}，问数与动作即刻生效`);
        await refresh();
      });
    } finally {
      setPublishing(false);
    }
  };
  const discard = async () => {
    if (publishing) return; // 与发布同一把闸，防连点
    if (!window.confirm("放弃会连别人刚写的动作和你改的字段一起没。确定放弃？")) return;
    setPublishing(true);
    try {
      await withLocalWrite(async () => {
        await apiDel("/api/publish");
        showToast("已放弃改动，回到已发布快照");
        setCard(null);
        await refresh();
      });
    } finally {
      setPublishing(false);
    }
  };

  // Esc 关一切浮卡。输入控件里的 Esc 不拦——那边的 onBlur 自动保存语义不能被关卡吃掉。
  // 动作表单开着时 Esc = 取消表单回到列表（有未保存改动先问一句），不是关掉整张对象卡
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea,select")) return;
      if (actionFormRef.current) {
        if (actionFormDirty.current && !window.confirm("动作表单里有没保存的改动，取消就丢了。确定取消？")) return;
        setActionForm(null);
        void refresh(); // 表单收口后再拉一次：开着期间轮询只记 rev 不刷视图
        return;
      }
      setCard(null);
      setPanelOpen(false);
      setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refresh]);

  /** 多选表 → 生成对象 → 直接上画布并收起抽屉。 */
  const generateFromTables = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      await withLocalWrite(async () => {
        const tables = [...selectedTables].map((key) => {
          const dot = key.indexOf("."); // 只切第一个点：连接名/表名里再有点不炸
          return { connection: key.slice(0, dot), table: key.slice(dot + 1) };
        });
        const data = await apiPost<{ created: string[] }>("/api/generate", { tables });
        showToast(`已生成对象：${data.created.join("、")}（草稿，发布后生效）`);
        setSelectedTables(new Set());
        setDrawerOpen(false);
        await refresh();
      });
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
        description: l.description,
        fromLabel: ont?.object_types?.[l.from]?.description ?? l.from,
        toLabel: ont?.object_types?.[l.to]?.description ?? l.to,
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
        edgeBends={ont?.edgeBends}
        edgePins={ont?.edgePins}
        selectedLink={card?.kind === "linkDetail" ? card.name : null}
        onSelect={(name) => {
          // 动作表单有未保存改动时，切去别的对象先问一句（切换会收掉表单）
          if (actionFormRef.current && actionFormDirty.current && cardRef.current?.kind === "object" && cardRef.current.name !== name) {
            if (!window.confirm("动作表单里有没保存的改动，切换会丢掉。继续？")) return;
          }
          setCard({ kind: "object", name });
        }}
        onSelectLink={(name) => setCard({ kind: "linkDetail", name })}
        onConnectRequest={(from, to, pins) => setCard({ kind: "link", from, to, pins })}
        onReconnectLink={async (name, from, to, moved) => {
          const ok = await op({ op: "update_link", name, from, to });
          if (ok) {
            if (moved?.pin) void op({ op: "save_edge_pin", name, end: moved.end, pin: moved.pin }); // 拖的那头钉新位置（静默）
            showToast(`关系已改接为 ${from} → ${to}（发布后生效）`);
          }
        }}
        onBendChange={(name, bend) => void op({ op: "save_edge_bend", name, bend })} // 拉弯/拉直：静默存，与摆位同理
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
                title={
                  // title 点名将发生的变化：将删除的类 + 动作差集里实际发生的子集（三个动词不永远并排）
                  (() => {
                    const parts: string[] = [];
                    if (ont.deleted?.length) parts.push(`将删除：${ont.deleted.join("、")}`);
                    const ac = ont.action_changes;
                    if (ac?.added.length) parts.push(`将新增的动作：${ac.added.join("、")}`);
                    if (ac?.overwritten.length) parts.push(`将更新的动作：${ac.overwritten.join("、")}`);
                    if (ac?.removed.length) parts.push(`将删除的动作：${ac.removed.join("、")}`);
                    return parts.length ? parts.join("；") : undefined;
                  })()
                }
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

      {/* 版本历史卡：点某版把内容覆盖到当前画布（未发布） */}
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
                  <button
                    className="chip"
                    disabled={rollbacking}
                    onClick={async () => {
                      if (rollbacking) return;
                      setRollbacking(true);
                      try {
                        await withLocalWrite(async () => {
                          await apiPost("/api/versions", { version: v.version });
                          showToast(`已用 v${v.version} 覆盖当前画布（还没发布）`);
                          setCard(null);
                          await refresh();
                        });
                      } finally {
                        setRollbacking(false);
                      }
                    }}
                  >
                    回到这版
                  </button>
                </div>
              ))}
          </Bezel>
        </div>
      )}

      {/* 验收问题集卡 */}
      {card?.kind === "questions" && <QuestionsCard onClose={() => setCard(null)} showToast={showToast} version={ont?.version} />}

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
                  // 裁决也走 withLocalWrite：不然人刚裁的「同一」会被轮询 toast 成外部改动
                  void withLocalWrite(async () => {
                    await loadPairs(); // 重新拉一遍：被合并撤掉的类，挂着它的条目随之消失（三个以上重复时会连环）
                    await refresh();
                  });
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
                  // 钉点随建线落存（静默）：端点就是连的时候手选的位置
                  if (card.pins?.source) void op({ op: "save_edge_pin", name: body.name, end: "source", pin: card.pins.source });
                  if (card.pins?.target) void op({ op: "save_edge_pin", name: body.name, end: "target", pin: card.pins.target });
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
              <Section title="动作">
                {actionForm ? (
                  <ActionForm
                    clsName={card.name}
                    ont={ont!}
                    initial={actionForm.mode === "edit" ? { name: actionForm.name, def: sel.actions?.[actionForm.name] } : undefined}
                    onDirtyChange={(d) => { actionFormDirty.current = d; }}
                    onSave={async (name, def) => {
                      // 保存仍不带 base_rev；表单开着期间外面改过了，先问一句再盖
                      if (actionFormRev.current !== null && lastRev.current !== null && lastRev.current !== actionFormRev.current) {
                        if (!window.confirm("外面已经改过这份草稿，还要按表单覆盖吗？")) return false;
                      }
                      const ok = await op({ op: "set_action", object: card.name, name, def });
                      if (ok) {
                        setActionForm(null);
                        showToast(`动作 ${name} 已进草稿（发布后生效）`);
                      }
                      return ok;
                    }}
                    onCancel={() => {
                      if (actionFormDirty.current && !window.confirm("动作表单里有没保存的改动，取消就丢了。确定取消？")) return;
                      setActionForm(null);
                      void refresh(); // 表单收口后再拉一次：开着期间轮询只记 rev 不刷视图
                    }}
                  />
                ) : (
                  <>
                    {Object.entries(sel.actions ?? {}).map(([a, def]: [string, any]) => {
                      const key = `${card.name}.${a}`;
                      const ac = ont?.action_changes;
                      const badge = ac?.added.includes(key) ? "新增" : ac?.overwritten.includes(key) ? "已修改" : null;
                      return (
                        <div key={a} style={{ fontSize: 12, padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <code>{a}</code>
                            {badge && <span className="tag tag-warn">{badge}</span>}
                            <span style={{ flex: 1 }} />
                            {/* 表单认不出的动作（超出附录 B 子集）只展示、只许删——点「编辑」再保存会把认不出的键丢掉 */}
                            {formCompatible(def, card.name, ont!) && (
                              <button className="chip" style={{ fontSize: 11 }} title="编辑这条动作" onClick={() => setActionForm({ mode: "edit", name: a })}>编辑</button>
                            )}
                            <button
                              className="chip"
                              style={{ fontSize: 11, color: "var(--danger)" }}
                              title="删除这条动作"
                              onClick={async () => {
                                if (!window.confirm("删除这条动作？进草稿，发布后才从已发布里拿掉")) return;
                                const ok = await op({ op: "remove_action", object: card.name, name: a });
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
