// 本体构建页 —— 纯画布页（无对话列）。
// 画布内容 = 工作副本（已发布 + 未发布改动）；发布走「发布 vN+1 / 放弃」；表结构收进底部抽屉。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import OntologyCanvas from "./canvas/OntologyCanvas";
import type { CanvasLink, CanvasObject } from "./canvas/layout";
import type { BorderPin } from "./canvas/geometry";
import Bezel from "./cards/Bezel";
import DecisionLog from "./cards/DecisionLog";
import PendingPairs from "./cards/PendingPairs";

/** 裁决留痕的一行（/api/decide 的响应行）：画布徽章与留痕视图共用同一形状。 */
interface AdjDecisionRow {
  class_a: string;
  class_b: string;
  verdict: Verdict;
  llm_advice?: string;
  rate?: number;
  evidence?: {
    norm_rule?: string;
    count_a?: number;
    count_b?: number;
    count_hit?: number;
    rate?: number;
    fields?: Record<string, string>;
  };
}
import { ApiError, apiGet, apiPost, apiDel } from "./workspaceClient";
import QuestionsCard from "./cards/QuestionsCard";
import { LinkForm } from "./forms/forms";
import ObjectCard, { type ObjectFormState } from "./cards/ObjectCard";
import LinkDetailCard from "./cards/LinkDetailCard";
import VersionsCard from "./cards/VersionsCard";
import SchemaDrawer from "./cards/SchemaDrawer";
import { effectSummary, formCompatible } from "./forms/actionView";
import { decisionRowsOf } from "./canvas/sharedOrigin";
import { externalToast, publishTitle, shouldCloseObjectCard, versionLabel, type OntologyResp } from "./ontFrame";
import { sourceLabel } from "./sourceLabel";
import { useRevWatcher } from "./revWatcher";
import { columnTarget as columnTargetOf } from "../server/features/ontology/lineage";
import { definedPinEnds } from "../server/features/ontology/canvasState";
import { isUiStateOp } from "../server/schema/ops";
import { Verdict, type PairAdvice } from "../server/schema/verdict";
import { classStages, stageHint, stageSourceKeys } from "../server/features/ontology/stages";
import type { ObjectType } from "../server/schema/config";

interface IntrospectResp {
  sources: {
    connection: string;
    error?: string;
    tables: { name: string; columns: { name: string; type: string; pk: boolean; comment?: string }[]; sample?: Record<string, unknown>[] }[];
  }[];
}

/** 浮卡（「同一时间只浮一张卡」的类型表达）：开一张 = 收其余，互斥由联合类型保证，不再手工维护。
 *  左上组（版本/问题集）与右侧组（连线表单/关系详情/对象编辑）同一联合——开任何一张都收上一张。
 *  例外：底中留痕视图与底部数据源抽屉是独立区域，不进联合。 */
type Card =
  | { kind: "versions" }
  | { kind: "questions" }
  | { kind: "link"; from: string; to: string; pins?: { source?: BorderPin; target?: BorderPin } } // 拖线落地后等待取名的半成品（pins = 两端钉点）
  | { kind: "linkDetail"; name: string } // 点中的边
  | { kind: "object"; name: string } // 对象编辑卡
  | null;

export default function CanvasPage({ brand }: { brand: ReactNode }) {
  const [ont, setOnt] = useState<OntologyResp | null>(null);
  const [schema, setSchema] = useState<IntrospectResp | null>(null);
  const [card, setCard] = useState<Card>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [pairs, setPairs] = useState<PairAdvice[]>([]);
  // 底中浮动卡（互斥）：留痕（已落定的判定与证据）/ 待定（召回提出、还没判定的对）——两件事两张卡
  const [bottom, setBottom] = useState<"log" | "pending" | null>(null);
  const [publishing, setPublishing] = useState(false); // 发布/放弃/回滚同一把闸（mutate 原语）
  const [generating, setGenerating] = useState(false);
  const [toast, setToast] = useState<{ text: string; sticky: boolean } | null>(null);
  // 对象编辑卡与表结构抽屉已各自成 module（cards/ObjectCard、cards/SchemaDrawer）。
  // 页面只留：开哪张卡、卡内表单状态（ObjectCard 经 onFormState 报上来，写进 formStateRef 供守卫读）。
  const [adjRows, setAdjRows] = useState<AdjDecisionRow[]>([]);
  // 裁决留痕随 rev 重取（Agent 落判定会 bump rev）：草稿行与已发布行都进画布（留痕即日志），已放弃的行由元库排除。
  useEffect(() => {
    let dead = false;
    apiGet<{ decisions: (Omit<AdjDecisionRow, "verdict"> & { verdict: string })[] }>("/api/decide")
      .then((d) => {
        // verdict 由引擎按枚举写入，JSON 边界在这里收口为 Verdict（全库唯一一次）
        if (!dead) setAdjRows((d.decisions ?? []).map((r) => ({ ...r, verdict: r.verdict as Verdict })));
      })
      .catch(() => {
        // 拉取失败置空由下一轮 rev 变化重拉（轮询寿命与页面同）；不 toast——留痕是附属视图，别拿网络抖动打扰人
        if (!dead) setAdjRows([]);
      });
    return () => {
      dead = true;
    };
  }, [ont?.rev]);
  const ontRef = useRef<OntologyResp | null>(null);
  const cardRef = useRef<Card>(null);
  const formStateRef = useRef<ObjectFormState>({ busy: false, actionForm: null, actionDirty: false });
  const onFormState = useCallback((s: ObjectFormState) => { formStateRef.current = s; }, []);
  const localBusy = useRef(false);
  useEffect(() => { cardRef.current = card; }, [card]);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []); // 卸载清定时器

  const showToast = useCallback((text: string) => {
    setToast({ text, sticky: false });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }, []);
  /** 错误类提示：常驻不自动消失，用户点关闭才消失（配置不合法这类提示闪一下等于没说）。 */
  const showError = useCallback((text: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ text, sticky: true });
  }, []);
  /** 网络层失败（fetch reject）的统一提示。服务端拒绝（ApiError）带上游文案，不走这里。 */
  const netErr = useCallback((e: unknown) => showError(`网络错误：${e instanceof Error ? e.message : String(e)}`), [showError]);
  /** 失败的统一分流：服务端拒绝直接显示上游文案，网络层失败加前缀。 */
  const failToast = useCallback((e: unknown) => (e instanceof ApiError ? showError(e.message) : netErr(e)), [showError, netErr]);

  // 画布当监视器：每 2 秒轮询工作副本（隐页暂停）——轮询纪律收在 revWatcher module，
  // 这里只留「变化来了干什么」：本页写豁免在 busy()，表单开着走 onFormBlocked，失败一次走 onFailOnce。
  const watcher = useRevWatcher({
    busy: () => localBusy.current,
    formBusy: () => formStateRef.current.busy,
    onFrame: (data) => {
      const prev = ontRef.current;
      applyOnt(data);
      if (prev) reloadPairs(); // 外部改动（MCP agent 改草稿）跟着刷新计数：快照命中不过模型；首轮由挂载 effect 负责
      // 开着的对象卡对应类已不在草稿里：收卡（策略在 ontFrame）
      const open = cardRef.current;
      if (open?.kind === "object" && shouldCloseObjectCard(open.name, data)) {
        setCard(null);
        showToast("这个对象已从草稿里去掉");
        return;
      }
      if (prev) showToast(externalToast(prev, data)); // 首轮由 refresh 负责，不弹
    },
    onFormBlocked: () => showToast("草稿有更新：保存会合并最新内容，同一字段以你后保存的为准"),
    onFailOnce: () => showError("没法自动刷新画布，请重新打开本页"),
  });

  /** 每次拿到本体 JSON 都过这里：state、rev、ETag 一起记——本页写入的 refresh 与轮询共用这一句。 */
  const applyOnt = useCallback(
    (data: OntologyResp) => {
      ontRef.current = data;
      watcher.noteApplied(data.rev); // rev/ETag 与轮询监视器同步（同一份 etagOf）
      setOnt(data);
    },
    [watcher]
  );
  const refresh = useCallback(() => apiGet<OntologyResp>("/api/ontology").then(applyOnt), [applyOnt]);
  // 表结构随连接变化：挂载拉一次，抽屉里接入成功后由 onConnected 再拉（抽屉原地更新）
  const reloadSchema = useCallback(() => apiGet<IntrospectResp>("/api/list_tables").then(setSchema).catch(netErr), [netErr]);
  // 疑似重复列表：每次从服务端按当前草稿重算（已裁的、被合并撤掉的都不再来）
  const pairsLoadedOnce = useRef(false);
  const loadPairs = useCallback(async () => {
    const data = await apiGet<{ candidates?: PairAdvice[] }>("/api/list_candidates");
    pairsLoadedOnce.current = true;
    setPairs(data.candidates ?? []);
  }, []);
  /** 静默补拉待定计数：失败吞掉——主写已落库，计数只是工具条上的提示，开待定卡时必重拉补上。 */
  const reloadPairs = useCallback(() => loadPairs().catch(() => {}), [loadPairs]);
  // 首轮加载：本体、表结构、待定计数（依赖已列全，只跑挂载这一次）
  useEffect(() => {
    refresh().catch(netErr); // 首轮加载失败也要说
    reloadSchema();
    loadPairs().catch(netErr); // 工具条「待定」徽章计数的首轮
  }, [refresh, netErr, loadPairs, reloadSchema]);

  // 开待定卡必重拉：待定对要当前草稿算出的（快照命中不过模型，这一下基本免费）
  useEffect(() => {
    if (bottom === "pending") loadPairs().catch(netErr);
  }, [bottom, loadPairs, netErr]);
  // 待定清零时自动收卡（Agent 判完的瞬间卡跟着消失——没有就应该没有）；首拉完成前不误收
  useEffect(() => {
    if (bottom === "pending" && pairsLoadedOnce.current && pairs.length === 0) setBottom(null);
  }, [bottom, pairs]);

  /** 本页一切写路径的唯一入口：写期间 localBusy 置位，轮询不动作也不 toast 成「外部改动」。
   *  finally 里一定放下——失败也放（写成功但 refresh 失败同样放，让下一轮轮询把已落地的草稿拉回来）。 */
  const withLocalWrite = useCallback(
    async (fn: () => Promise<unknown>): Promise<boolean> => {
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

  /** 编辑操作统一入口：发给草稿，刷新视图，错误进 toast。网络层失败也要说。 */
  const op = useCallback(
    async (body: Record<string, unknown>) =>
      withLocalWrite(async () => {
        await apiPost("/api/edit_draft", body);
        if (body.op === "update_object" && typeof body.new_name === "string") {
          const open = cardRef.current;
          if (open?.kind === "object" && open.name === body.name) setCard({ kind: "object", name: body.new_name });
        }
        await refresh();
        // 界面状态 op（摆位/弯折）跟着鼠标走且不改类集，不拉计数；其余编辑都可能改变候选对，补拉
        if (!isUiStateOp(String(body.op))) await reloadPairs();
      }),
    [withLocalWrite, refresh, reloadPairs]
  );

  const saveLayout = useCallback(
    (positions: Record<string, { x: number; y: number }>, opts?: { clearBends?: boolean; clearPins?: boolean }) => {
      // 整理布局带清弯折/钉点旗标（一把回到干净状态）；拖动存摆位不带
      void op({ op: "save_layout", positions, ...(opts?.clearBends ? { clear_bends: true } : {}), ...(opts?.clearPins ? { clear_pins: true } : {}) });
    },
    [op]
  );

  /** 发布类动作的同一副骨架：防连点 +（可选）确认 + 本地写闸 + toast + 刷新。差异只剩请求、文案与收不收卡。 */
  const mutate = async (run: () => Promise<string>, opts?: { confirm?: string; closeCard?: boolean }) => {
    if (publishing) return; // 防连点：发布/放弃/回滚同一把闸（重复发布会产生空版本）
    if (opts?.confirm && !window.confirm(opts.confirm)) return;
    setPublishing(true);
    try {
      await withLocalWrite(async () => {
        showToast(await run());
        if (opts?.closeCard) setCard(null);
        await refresh();
        await reloadPairs(); // 发布/放弃/回滚都会换草稿内容，计数跟着补
      });
    } finally {
      setPublishing(false);
    }
  };

  const publish = () =>
    mutate(async () => `已发布 v${(await apiPost<{ version: number }>("/api/publish")).version}，问数与动作即刻生效`);

  const discard = () =>
    mutate(
      async () => {
        await apiDel("/api/publish");
        return "已放弃改动，回到已发布快照";
      },
      { closeCard: true }
    );

  /** 放弃的两段式确认：第一段按钮进入警告态，4 秒内再点才执行。不依赖浏览器原生弹窗（会被「禁止再显示对话框」或自动化环境吞掉）。 */
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(() => {
    if (!confirmDiscard) return;
    const t = setTimeout(() => setConfirmDiscard(false), 4000);
    return () => clearTimeout(t);
  }, [confirmDiscard]);

  const discardWithConfirm = () => {
    if (!confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    setConfirmDiscard(false);
    discard();
  };

  /** 回到某版：内容覆盖到当前画布（未发布），版本列表在 VersionsCard 自取。 */
  const rollback = (version: number) =>
    mutate(
      async () => {
        await apiPost("/api/versions", { version });
        return `已用 v${version} 覆盖当前画布（还没发布）`;
      },
      { closeCard: true }
    );

  // Esc 关一切浮卡。输入控件里的 Esc 不拦——那边的 onBlur 自动保存语义不能被关卡吃掉。
  // Esc：动作表单开着时不关整卡（表单的取消在 ObjectCard 内自闭环，含脏改动确认）；否则关浮卡 / 留痕视图 / 抽屉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea,select")) return;
      if (formStateRef.current.actionForm) return; // 表单开着：ObjectCard 的 Esc 自理（取消表单，不关卡）
      setCard(null);
      setBottom(null);
      setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 多选表 → 生成对象 → 直接上画布并收起抽屉（选表与按钮在 SchemaDrawer 里）。
   *  与 MCP 同两步：propose_objects 只建议，edit_draft import_objects 才落地。返回成功与否：抽屉据此决定清不清勾选。 */
  const generateFromTables = async (tables: { connection: string; table: string }[]) => {
    if (generating) return false;
    setGenerating(true);
    try {
      return await withLocalWrite(async () => {
        const { object_types } = await apiPost<{ object_types: Record<string, unknown> }>("/api/propose_objects", { tables });
        await apiPost("/api/edit_draft", { op: "import_objects", objects: object_types });
        showToast(`已生成对象：${Object.keys(object_types).join("、")}（草稿，发布后生效）。唯一键和判定让 Agent 在对话里接着做`);
        setDrawerOpen(false);
        await refresh();
        await reloadPairs(); // 新对象上画布，疑似重复计数立刻就位
        return true;
      });
    } finally {
      setGenerating(false);
    }
  };

  const objects: CanvasObject[] = useMemo(
    () =>
      Object.entries(ont?.object_types ?? {}).map(([name, t]) => {
        const st = ont ? classStages(ont, name) : null;
        const srcLabel = (key: string) => sourceLabel(t.sources, key);
        return {
          name,
          description: t.description,
          kind: t.kind,
          identity: t.identity,
          properties: Object.entries(t.properties).map(([p, d]: [string, any]) => ({
            name: p,
            type: d.type,
            derived: Boolean(d.derived),
            description: d.description,
          })),
          sources: Object.entries(t.sources ?? {}).map(([srcName, s]: [string, any]) => ({
            key: srcName,
            label: sourceLabel(t.sources, srcName),
          })),
          actions: Object.keys(t.actions ?? {}),
          state: ont?.states?.[name],
          stages: st
            ? {
                property: st.property,
                items: st.items.map((it) => ({ value: it.value, hint: stageHint(it.when, srcLabel) })),
                sourceKeys: stageSourceKeys(st.items),
              }
            : undefined,
        };
      }),
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

  // 列 → 本体属性 的反查：规则收在引擎的 lineage（纯函数单源），这里只喂当前草稿
  const columnTarget = (connection: string, table: string, column: string): string =>
    ont ? columnTargetOf(ont, connection, table, column) : "未映射";

  const sel: ObjectType | null = card?.kind === "object" ? ((ont?.object_types?.[card.name] as ObjectType | undefined) ?? null) : null;

  // 「留痕」待定计数 = 还没定案的疑似重复对数（唯一键是 Agent 建稿的一步，不再单列计数）；没有待定不出牌
  const pendingCount = pairs.length;

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
          const fs = formStateRef.current;
          if (fs.actionForm && fs.actionDirty && cardRef.current?.kind === "object" && cardRef.current.name !== name) {
            if (!window.confirm("动作表单里有没保存的改动，切换会丢掉。继续？")) return;
          }
          setCard({ kind: "object", name });
        }}
        onSelectLink={(name) => setCard({ kind: "linkDetail", name })}
        onConnectRequest={(from, to, pins) => setCard({ kind: "link", from, to, pins })}
        onReconnectLink={async (name, from, to, moved) => {
          // 拖的那头钉新位置：pins 随 update_link 同车（界面状态一把落库，不再是接力 op）
          const ok = await op({ op: "update_link", name, from, to, ...(moved?.pin ? { pins: { [moved.end]: moved.pin } } : {}) });
          if (ok) showToast(`关系已改接为 ${from} → ${to}（发布后生效）`);
        }}
        onBendChange={(name, bend) => void op({ op: "save_edge_bend", name, bend })} // 拉弯/拉直：静默存，与摆位同理
        onLayoutChange={saveLayout}
        decisions={decisionRowsOf(ont?.class_conclusions, adjRows)}
      />

      {/* 左上一条工具条：品牌和入口同一行，只放任务按钮（连接数据源在左下数据源抽屉里）。顺序是留痕 → 待定 → 发布。 */}
      <div className="float-card float-tl dock">
        <Bezel pad="6px 8px">
          <div className="dock-bar">
            <div className="dock-brand">{brand}</div>
            <i className="dock-split" aria-hidden />
            <button
              className={`btn${bottom === "log" ? " is-on" : ""}`}
              title="Agent 的判定与证据（只读）"
              onClick={() => setBottom(bottom === "log" ? null : "log")}
            >
              留痕
            </button>
            {pendingCount > 0 && (
              <button
                className={`btn${bottom === "pending" ? " is-on" : ""}`}
                title={`还有 ${pendingCount} 对等着 Agent 判定`}
                onClick={() => setBottom(bottom === "pending" ? null : "pending")}
              >
                待定<span className="btn-badge">{pendingCount}</span>
              </button>
            )}
            <i className="dock-split" aria-hidden />
            <button className={`btn${card?.kind === "versions" ? " is-on" : ""}`} title="版本历史" onClick={() => setCard(card?.kind === "versions" ? null : { kind: "versions" })}>
              {ont ? versionLabel(ont) : "已发布 v…"} ▾
            </button>
            {ont?.dirty ? (
              <>
                <button className="btn-cta" title={publishTitle(ont)} onClick={publish} disabled={publishing}>
                  发布 v{(ont?.version ?? 1) + 1}
                </button>
                <button
                  className={`btn${confirmDiscard ? " is-danger" : ""}`}
                  onClick={discardWithConfirm}
                  disabled={publishing}
                  title={
                    confirmDiscard
                      ? ont.version
                        ? "再点一次执行放弃"
                        : "再点一次执行放弃（草稿会清空回到空白——这个空间还没有发布过）"
                      : ont.version
                        ? "回到已发布快照（未发布的改动全部丢弃）"
                        : "清空草稿回到空白（这个空间还没有发布过）"
                  }
                >
                  {confirmDiscard ? "确认放弃？" : "放弃"}
                </button>
              </>
            ) : (
              <button className="btn" onClick={() => showToast("没有未发布的改动——画布和已发布一致")}>发布</button>
            )}
            <i className="dock-split" aria-hidden />
            <button className={`btn${card?.kind === "questions" ? " is-on" : ""}`} onClick={() => setCard(card?.kind === "questions" ? null : { kind: "questions" })}>验收问题集</button>
          </div>
        </Bezel>
      </div>

      {/* 空画布引导：没有任何对象时指路；数据源抽屉开着时收起——它引导的正是开抽屉，开着时是重复噪音，还压抽屉上沿 */}
      {ont && objects.length === 0 && !drawerOpen && (
        <div className="float-card" style={{ top: "40%", left: "50%", translate: "-50% -50%", width: 380 }}>
          <Bezel pad={18} coreStyle={{ fontSize: 13, lineHeight: 2, color: "var(--ink-2)" }}>
            画布还是空的。点左下角「数据源」接入源库，勾选表生成对象；发布后问数与动作就能看见。
          </Bezel>
        </div>
      )}

      {/* 版本历史卡：点某版把内容覆盖到当前画布（未发布）；列表自取数（cards/VersionsCard） */}
      {card?.kind === "versions" && (
        <VersionsCard ont={ont} rollbacking={publishing} onRollback={(v) => void rollback(v)} onError={netErr} onClose={() => setCard(null)} />
      )}

      {/* 验收问题集卡 */}
      {card?.kind === "questions" && <QuestionsCard onClose={() => setCard(null)} showToast={showToast} version={ont?.version} />}

      {/* 底中两张互斥卡：留痕（已落定的判定与证据）/ 待定（召回提出、还没判定的对）。抽屉开着时上移避让，两者不互关 */}
      {bottom === "log" && (
        <DecisionLog
          rows={adjRows.map((r) => ({ classes: [r.class_a, r.class_b] as [string, string], verdict: r.verdict, note: r.llm_advice, rate: r.rate, count_hit: r.evidence?.count_hit, fields: r.evidence?.fields }))}
          drawerOpen={drawerOpen}
          onClose={() => setBottom(null)}
        />
      )}
      {bottom === "pending" && (
        <PendingPairs
          pairs={pairs.map((p) => ({ classes: [p.class_a, p.class_b] as [string, string], tendency: p.tendency, reason: p.reason }))}
          drawerOpen={drawerOpen}
          onClose={() => setBottom(null)}
        />
      )}

      {/* 左下：数据源抽屉开关（常驻）。抽屉开着时抬到抽屉上沿之上（.is-open，让位链在 globals.css）：float-card(z20) 会压住 drawer(z15) 内容，抽屉左下角的可点内容不能被它拦住 */}
      <div className={`float-card schema-toggle${drawerOpen ? " is-open" : ""}`}>
        <button className="btn" onClick={() => setDrawerOpen((v) => !v)}>{drawerOpen ? "收起" : "数据源"}</button>
      </div>

      {/* toast：瞬时反馈 */}
      {toast && (
        <div className="float-card" style={{ top: "var(--below-dock)", left: "50%", translate: "-50% 0", zIndex: 40, maxWidth: "min(760px, calc(100vw - 24px))" }}>
          <Bezel pad="8px 16px" coreStyle={{ fontSize: 13, display: "flex", alignItems: "center", gap: 12 }}>
            <span>{toast.text}</span>
            {toast.sticky && (
              <button className="chip" aria-label="关闭提示" style={{ flexShrink: 0 }} onClick={() => setToast(null)}>
                ✕
              </button>
            )}
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
                // 钉点随建线同车（界面状态一把落库）：端点就是连的时候手选的位置；「没给的端不进记录」用服务端同一原语
                const pins = definedPinEnds(card.pins);
                const ok = await op(pins ? { ...body, pins } : body);
                if (ok) {
                  setCard(null);
                  showToast("关系已进草稿（发布后生效）");
                }
              }}
            />
          </Bezel>
        </div>
      )}

      {/* 右侧：关系详情卡（点边弹出，cards/LinkDetailCard） */}
      {card?.kind === "linkDetail" && ont?.link_types?.[card.name] && (
        <LinkDetailCard
          name={card.name}
          link={ont.link_types[card.name]}
          op={op}
          showToast={showToast}
          onRenamed={(v) => setCard({ kind: "linkDetail", name: v })} // 边以关系名为键：卡跟新名走
          onClose={() => setCard(null)}
        />
      )}

      {/* 右侧：对象编辑卡（cards/ObjectCard） */}
      {ont && sel && card?.kind === "object" && (
        <ObjectCard
          key={card.name} // 换卡即重挂：卡内表单状态自然清
          name={card.name}
          sel={sel}
          states={ont.states}
          actionChanges={ont.action_changes}
          ont={ont}
          op={op}
          refresh={refresh}
          closeCard={() => setCard(null)}
          showToast={showToast}
          onFormState={onFormState}
          currentRev={watcher.currentRev}
        />
      )}

      {/* 底部抽屉：数据源（左栏接源、右栏表结构勾选生成；只看列定义与采样，不取业务行） */}
      {drawerOpen && (
        <SchemaDrawer
          schema={schema}
          columnTarget={columnTarget}
          onGenerate={generateFromTables}
          onConnected={(msg) => {
            showToast(msg);
            reloadSchema();
          }}
          showToast={showToast}
        />
      )}
    </div>
  );
}
