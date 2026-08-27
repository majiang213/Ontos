// 本体构建页 —— 纯画布页（无对话列）。
// 画布内容 = 工作副本（已发布 + 未发布改动）；发布走「发布 vN+1 / 放弃」；表结构收进底部抽屉。

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import OntologyCanvas from "./canvas/OntologyCanvas";
import type { CanvasLink, CanvasObject } from "./canvas/layout";
import type { BorderPin } from "./canvas/geometry";
import Bezel from "./cards/Bezel";
import DecisionPanel, { identityRows } from "./cards/DecisionPanel";
import { ApiError, apiGet, apiPost, apiDel } from "./workspaceClient";
import QuestionsCard from "./cards/QuestionsCard";
import { ConnectForm, CreateForm, LinkForm } from "./forms/forms";
import ObjectCard, { type ObjectFormState } from "./cards/ObjectCard";
import LinkDetailCard from "./cards/LinkDetailCard";
import VersionsCard from "./cards/VersionsCard";
import SchemaDrawer from "./cards/SchemaDrawer";
import { effectSummary, formCompatible } from "./forms/actionView";
import { externalToast, publishTitle, shouldCloseObjectCard, versionLabel, type OntologyResp } from "./ontFrame";
import { useRevWatcher } from "./revWatcher";
import { columnTarget as columnTargetOf } from "../server/features/ontology/lineage";
import { definedPinEnds } from "../server/features/ontology/canvasState";
import type { PairAdvice } from "../server/schema/verdict";
import type { ObjectType } from "../server/schema/config";

interface IntrospectResp {
  sources: {
    connection: string;
    error?: string;
    tables: { name: string; columns: { name: string; type: string; pk: boolean; comment?: string }[]; sample?: Record<string, unknown>[] }[];
  }[];
}

/** 浮卡（「同一时间只浮一张卡」的类型表达）：开一张 = 收其余，互斥由联合类型保证，不再手工维护。
 *  左上组（版本/新建/连接/问题集）与右侧组（连线表单/关系详情/对象编辑）同一联合——开任何一张都收上一张。
 *  例外：底中待确认面板与底部表结构抽屉是独立区域，不进联合。 */
type Card =
  | { kind: "versions" }
  | { kind: "create" }
  | { kind: "connect" }
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
  const [panelOpen, setPanelOpen] = useState(false);
  const [publishing, setPublishing] = useState(false); // 发布/放弃/回滚同一把闸（mutate 原语）
  const [generating, setGenerating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // 对象编辑卡与表结构抽屉已各自成 module（cards/ObjectCard、cards/SchemaDrawer）。
  // 页面只留：开哪张卡、卡内表单状态（ObjectCard 经 onFormState 报上来，写进 formStateRef 供守卫读）。
  const ontRef = useRef<OntologyResp | null>(null);
  const cardRef = useRef<Card>(null);
  const formStateRef = useRef<ObjectFormState>({ busy: false, actionForm: null, actionDirty: false });
  const onFormState = useCallback((s: ObjectFormState) => { formStateRef.current = s; }, []);
  const localBusy = useRef(false);
  useEffect(() => { cardRef.current = card; }, [card]);
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

  // 画布当监视器：每 2 秒轮询工作副本（隐页暂停）——轮询纪律收在 revWatcher module，
  // 这里只留「变化来了干什么」：本页写豁免在 busy()，表单开着走 onFormBlocked，失败一次走 onFailOnce。
  const watcher = useRevWatcher({
    busy: () => localBusy.current,
    formBusy: () => formStateRef.current.busy,
    onFrame: (data) => {
      const prev = ontRef.current;
      applyOnt(data);
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
    onFailOnce: () => showToast("没法自动刷新画布，请重新打开本页"),
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
  // 疑似重复列表：每次从服务端按当前草稿重算（已裁的、被合并撤掉的都不再来）
  const loadPairs = useCallback(async () => {
    const data = await apiGet<{ candidates?: PairAdvice[] }>("/api/list_candidates");
    setPairs(data.candidates ?? []);
  }, []);
  useEffect(() => {
    refresh().catch(netErr); // 首轮加载失败也要说
    apiGet<IntrospectResp>("/api/list_tables").then(setSchema).catch(netErr);
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

  /** 编辑操作统一入口：发给草稿，刷新视图，错误进 toast。网络层失败也要说。 */
  const op = useCallback(
    async (body: Record<string, unknown>) =>
      withLocalWrite(async () => {
        await apiPost("/api/edit_draft", body);
        await refresh();
      }),
    [withLocalWrite, refresh]
  );

  /** 待确认面板「确认唯一键」：有改动的对象逐个 set_identity，落草稿后重拉疑似重复；失败返回 false（面板不解锁）。 */
  const confirmIdentity = useCallback(
    async (selections: Record<string, string>): Promise<boolean> => {
      if (Object.values(selections).some((v) => !v)) return false; // 未设置的不落库：有源类取消唯一键会被校验闸拒
      const changed = Object.entries(selections).filter(
        ([name, v]) => v !== (ont?.object_types?.[name]?.identity ?? "")
      );
      const ok = await withLocalWrite(async () => {
        for (const [name, v] of changed) {
          await apiPost("/api/edit_draft", { op: "set_identity", object: name, name: v });
        }
        await refresh();
        await loadPairs(); // 无改动也重拉：区块二要的是当前草稿算出的候选对
      });
      if (ok && changed.length > 0) showToast(`唯一键已定：${changed.map(([n, v]) => `${n} → ${v}`).join("、")}`);
      return ok;
    },
    [ont, withLocalWrite, refresh, loadPairs, showToast]
  );

  /** 裁决一条后：重拉候选对（被合并撤掉的类，挂着它的条目随之消失）+ 刷新画布。空 msg = 不动草稿的结论。 */
  const onPairDone = useCallback(
    (msg: string) => {
      if (msg) showToast(msg);
      void withLocalWrite(async () => {
        await loadPairs();
        await refresh();
      });
    },
    [showToast, withLocalWrite, loadPairs, refresh]
  );

  const saveLayout = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      void op({ op: "save_layout", positions });
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
      { confirm: "放弃会连别人刚写的动作和你改的字段一起没。确定放弃？", closeCard: true }
    );

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
  // Esc：动作表单开着时不关整卡（表单的取消在 ObjectCard 内自闭环，含脏改动确认）；否则关浮卡 / 面板 / 抽屉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if ((e.target as HTMLElement | null)?.closest?.("input,textarea,select")) return;
      if (formStateRef.current.actionForm) return; // 表单开着：ObjectCard 的 Esc 自理（取消表单，不关卡）
      setCard(null);
      setPanelOpen(false);
      setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 多选表 → 生成对象 → 直接上画布并收起抽屉（选表与按钮在 SchemaDrawer 里）。
   *  与 MCP 同两步：propose_objects 只建议，edit_draft import_objects 才落地。 */
  const generateFromTables = async (tables: { connection: string; table: string }[]) => {
    if (generating) return;
    setGenerating(true);
    try {
      await withLocalWrite(async () => {
        const { object_types } = await apiPost<{ object_types: Record<string, unknown> }>("/api/propose_objects", { tables });
        await apiPost("/api/edit_draft", { op: "import_objects", objects: object_types });
        showToast(`已生成对象：${Object.keys(object_types).join("、")}（草稿，发布后生效）。点「待确认」定唯一键`);
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

  // 列 → 本体属性 的反查：规则收在引擎的 lineage（纯函数单源），这里只喂当前草稿
  const columnTarget = (connection: string, table: string, column: string): string =>
    ont ? columnTargetOf(ont, connection, table, column) : "未映射";

  const sel: ObjectType | null = card?.kind === "object" ? ((ont?.object_types?.[card.name] as ObjectType | undefined) ?? null) : null;

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
      />

      {/* 左上一条工具条：品牌和入口同一行。顺序是连接 → 待确认 → 发布。入口一律 btn，发布有改动时用 btn-cta。 */}
      <div className="float-card float-tl dock">
        <Bezel pad="6px 8px">
          <div className="dock-bar">
            <div className="dock-brand">{brand}</div>
            <i className="dock-split" aria-hidden />
            <button className={`btn${card?.kind === "connect" ? " is-on" : ""}`} onClick={() => setCard(card?.kind === "connect" ? null : { kind: "connect" })}>连接数据源</button>
            <button className={`btn${card?.kind === "create" ? " is-on" : ""}`} onClick={() => setCard(card?.kind === "create" ? null : { kind: "create" })}>新建对象</button>
            <i className="dock-split" aria-hidden />
            <button className={`btn${panelOpen ? " is-on" : ""}`} onClick={() => setPanelOpen((v) => !v)}>待确认</button>
            <i className="dock-split" aria-hidden />
            <button className={`btn${card?.kind === "versions" ? " is-on" : ""}`} title="版本历史" onClick={() => setCard(card?.kind === "versions" ? null : { kind: "versions" })}>
              {ont ? versionLabel(ont) : "已发布 v…"} ▾
            </button>
            {ont?.dirty ? (
              <>
                <button className="btn-cta" title={publishTitle(ont)} onClick={publish} disabled={publishing}>
                  发布 v{(ont?.version ?? 1) + 1}
                </button>
                <button className="btn" onClick={discard} disabled={publishing}>放弃</button>
              </>
            ) : (
              <button className="btn" onClick={() => showToast("没有未发布的改动——画布和已发布一致")}>发布</button>
            )}
            <i className="dock-split" aria-hidden />
            <button className={`btn${card?.kind === "questions" ? " is-on" : ""}`} onClick={() => setCard(card?.kind === "questions" ? null : { kind: "questions" })}>验收问题集</button>
          </div>
        </Bezel>
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

      {/* 版本历史卡：点某版把内容覆盖到当前画布（未发布）；列表自取数（cards/VersionsCard） */}
      {card?.kind === "versions" && (
        <VersionsCard ont={ont} rollbacking={publishing} onRollback={(v) => void rollback(v)} onError={netErr} onClose={() => setCard(null)} />
      )}

      {/* 验收问题集卡 */}
      {card?.kind === "questions" && <QuestionsCard onClose={() => setCard(null)} showToast={showToast} version={ont?.version} />}

      {/* 底中：待确认面板（唯一键 → 疑似重复，两段解锁）。打开时优先于发布条——同一时间底中只有这一张卡 */}
      {panelOpen && (
        <DecisionPanel
          rows={identityRows(ont?.object_types ?? {}, Object.keys(ont?.object_types ?? {}))}
          pairs={pairs}
          onConfirmIdentity={confirmIdentity}
          onPairDone={onPairDone}
          onClose={() => setPanelOpen(false)}
        />
      )}

      {/* 左下：表结构抽屉开关（常驻）。贴缩放钮右侧，见 .schema-toggle */}
      <div className="float-card schema-toggle">
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
        <div className="float-card float-tl dock-follow" style={{ width: 420, maxWidth: "calc(100vw - 24px)" }}>
          <Bezel>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>连接数据源</div>
            <ConnectForm
              onCancel={() => setCard(null)}
              onDone={async (msg) => {
                setCard(null);
                showToast(msg);
                try {
                  setSchema(await apiGet<IntrospectResp>("/api/list_tables"));
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
        <div className="float-card float-tl dock-follow" style={{ width: 300 }}>
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

      {/* 底部抽屉：表结构（只看列定义与采样，多选可生成对象） */}
      {drawerOpen && <SchemaDrawer schema={schema} columnTarget={columnTarget} onGenerate={generateFromTables} />}
    </div>
  );
}
