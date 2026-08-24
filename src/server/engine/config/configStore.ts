// 配置存储 —— 工作副本（草稿）与已发布版本的唯一出入口。
// 存储模型（onto_version 一表两用）：version IS NULL 的工作行 = 可变头，画布全部内容（本体 + 界面状态）只活在它的 canvas_json；
// 编号行 = 不可变历史（yaml 给问数；canvas_json 给「回到某版」还原画布）。
//   编辑画布/拖摆位 → 写工作行。发布 → 工作行复制成编号行。回滚/放弃 → 编号行覆盖工作行。
// 内存 Store 是热缓存。

import { dump, load } from "js-yaml";
import { configSchema, type OntologyConfig } from "../../schema/config";
import { isUiStateOp, type DraftOpInput as DraftOp } from "../../schema/ops";
import { metaStore } from "../../meta/store";
import { DraftReject } from "../../errors";
import { runtime } from "../../runtime";
import { validateActionShapes, validateSemantics } from "./validate";
import { DEFAULT_WS, seedYamlFor } from "../infra/workspace";
import { applyOp } from "./applyOp";
import { applyPack, canvasSnapshot, persistWorkingCopy, unpackCanvas, type DraftState } from "./pack";

/* ---------- 已发布 ---------- */

export interface Store {
  published?: { config: OntologyConfig; version: number };
  draft?: DraftState; // DraftState 不加 rev：discard 会清空、rollback 会整份换 draft 对象，rev 挂 Store 上才能只加不回零
  rev: number; // 进程内单调，只加不回零；新建 Store 为 0。画布监视器与 MCP base_rev 都读它
}
// 每个工作空间一份内存态（已发布快照 + 工作副本），互不串；挂运行态（runtime.ts）
function storeOf(ws: string): Store {
  const stores = (runtime().stores ??= new Map());
  let s = stores.get(ws);
  if (!s) {
    s = { rev: 0 };
    stores.set(ws, s);
  }
  return s;
}

/** 草稿修订号：内容每变一次 +1（含发布/放弃/回滚），只加不回零；save_*（摆位/弯折/钉点等界面状态）不算。GET /api/ontology、list_classes space=draft、apply_draft 与 base_rev 比较一律读它。 */
export function getRev(ws: string = DEFAULT_WS): number {
  return storeOf(ws).rev;
}

/* 每工作空间一条写队列：applyDraft 校验之后有 await（摆位/取已发布），两个请求在 await 处交错时备份回退会对错对象。
   失败也续链（prev.then(task, task)）：前一次 DraftReject 不拖死后续写入。全仓只有这一层队列——MCP / REST 不许再套。 */
const tails = new Map<string, Promise<void>>();

function enqueue<T>(ws: string, task: () => Promise<T>): Promise<T> {
  const prev = tails.get(ws) ?? Promise.resolve();
  const run = prev.then(task, task); // 前一次拒绝也跑这一次
  tails.set(ws, run.then(() => undefined, () => undefined)); // 只续链，吞掉结果；拒绝仍传给调用方
  return run;
}

async function loadPublished(ws: string): Promise<{ config: OntologyConfig; version: number }> {
  const { version, yaml } = await metaStore().latestVersion(ws, seedYamlFor(ws));
  const config = configSchema.parse(load(yaml));
  validateSemantics(config);
  return { config, version };
}

export async function getPublished(ws: string = DEFAULT_WS): Promise<{ config: OntologyConfig; version: number }> {
  const store = storeOf(ws);
  if (!store.published) store.published = await loadPublished(ws);
  return store.published;
}

export async function getDraft(ws: string = DEFAULT_WS): Promise<DraftState> {
  const store = storeOf(ws);
  if (!store.draft) {
    const { config, version } = await getPublished(ws);
    const saved = await metaStore().getWorkingPack(ws);
    // 界面状态的后备：最近已发布版的画布包（老行可能只有 yaml，那就空着，画布走 dagre）
    const pubPack = unpackCanvas((await metaStore().versionCanvas(ws, version)) ?? {});
    const fallback = { layout: pubPack.layout ?? {}, edgeBends: pubPack.edgeBends ?? {}, edgePins: pubPack.edgePins ?? {} };
    if (saved !== undefined) {
      const pack = unpackCanvas(saved);
      let draft: OntologyConfig;
      if (pack.config === undefined) {
        draft = structuredClone(config); // 迁移留下的摆位-only 工作行：本体用已发布，首次写入即补全 pack
      } else {
        try {
          draft = configSchema.parse(pack.config);
        } catch (e) {
          throw new DraftReject(`工作副本读不回来：${e instanceof Error ? e.message : String(e)}`);
        }
      }
      store.draft = { draft: structuredClone(draft), baseVersion: version, dirty: !sameConfig(draft, config), layout: {}, edgeBends: {}, edgePins: {} };
      applyPack(store.draft, pack, fallback);
    } else {
      // 还没有工作行：从已发布造一行落库——此后这空间恒有可变头
      store.draft = { draft: structuredClone(config), baseVersion: version, dirty: false, layout: {}, edgeBends: {}, edgePins: {} };
      applyPack(store.draft, {}, fallback);
      await persistWorkingCopy(ws, store.draft);
    }
  }
  store.draft.edgeBends ??= {}; // 热更新前建的内存态没有这字段
  store.draft.edgePins ??= {};
  return store.draft;
}

/* ---------- 写路径的收尾原语（applyDraft / mutateDraft / publish / rollback 共用） ---------- */

/** rev += 1 的纪律只有这一条：内容写进 Store 之后、下一个 await 之前——晚一拍，监视器带旧 ETag 会 304，把已改的草稿当成没变。 */
function bumpRev(ws: string): void {
  storeOf(ws).rev += 1;
}

/** 校验过了再清界面状态死键：对象没了清摆位、关系没了清弯折和钉点（校验失败回退时不调，不丢）。只改内存态，落库由收尾统一做。 */
function gcCanvasState(state: DraftState): void {
  for (const name of Object.keys(state.layout)) if (!state.draft.object_types[name]) delete state.layout[name];
  for (const name of Object.keys(state.edgeBends)) if (!state.draft.link_types[name]) delete state.edgeBends[name];
  for (const name of Object.keys(state.edgePins)) if (!state.draft.link_types[name]) delete state.edgePins[name];
}

/** 每步改完立即校验（结构 + 语义 + 动作形状四查），不合法整体回退——坏草稿不能攒到发布一刻才炸。
 *  动作形状四查只走草稿写入/发布路径；loadPublished/rollbackTo 不查（历史坏配置加载放行）。 */
function validateDraftOrThrow(state: DraftState, backup: OntologyConfig): void {
  try {
    const parsed = configSchema.parse(structuredClone(state.draft));
    validateSemantics(parsed);
    validateActionShapes(parsed);
  } catch (e) {
    state.draft = backup;
    throw new DraftReject(e instanceof Error ? e.message : String(e));
  }
}

/** 草稿写路径的统一收尾：rev → 清界面状态死键 → 按结构重算 dirty（改出去又改回来要能收回来）→ 落工作行。 */
async function commitDraft(ws: string, state: DraftState): Promise<void> {
  bumpRev(ws);
  gcCanvasState(state);
  state.dirty = !sameConfig(state.draft, (await getPublished(ws)).config);
  await persistWorkingCopy(ws, state);
}

/* ---------- 编辑操作（作用于工作副本） ----------
   op 解释器在 ./applyOp（REST 画布与 MCP 同走一处，只做内存修改）；这里留队列、按 UI_STATE_OPS 分流、备份、校验、收尾。 */

export async function applyDraft(input: DraftOp, ws: string = DEFAULT_WS, opts?: { base_rev?: number }): Promise<DraftState> {
  return enqueue(ws, async () => {
    // base_rev 只在 MCP 信封出现（REST 画布不传，队列里后到的写入赢）；比较必须在同一个 task 开头——比在队列外会被并发吞掉
    if (opts?.base_rev !== undefined && opts.base_rev !== getRev(ws)) {
      throw new DraftReject(`草稿已变（rev=${getRev(ws)}），请重新读取再改`);
    }
    const state = await getDraft(ws);
    const published = (await getPublished(ws)).config;
    // 界面状态 op（名单在 ops.ts 的 UI_STATE_OPS）：改内存 + 落工作行就完事——不校验、不加 rev、不算本体改动
    if (isUiStateOp(input.op)) {
      applyOp(state, input, published);
      await persistWorkingCopy(ws, state);
      return state;
    }
    const backup = structuredClone(state.draft);
    applyOp(state, input, published);
    // 每步操作后立即校验，不合法整体回退（含 import_objects 这类批量：fields 指向不存在属性的坏草稿不能攒到发布一刻才炸）
    validateDraftOrThrow(state, backup);
    await commitDraft(ws, state);
    return state;
  });
}

/** 直接改草稿（裁决应用等成组改动走这里）：改完立即校验，不合法就回退并抛 DraftReject——不让坏草稿攒到发布一刻才炸。 */
export async function mutateDraft(fn: (draft: OntologyConfig) => void, ws: string = DEFAULT_WS): Promise<DraftState> {
  return enqueue(ws, async () => {
  const state = await getDraft(ws);
  const backup = structuredClone(state.draft);
  try {
    fn(state.draft);
  } catch (e) {
    state.draft = backup; // 回退
    throw new DraftReject(e instanceof Error ? e.message : String(e));
  }
  validateDraftOrThrow(state, backup); // 与 applyDraft 同闸：裁决产物也得过动作形状四查
  await commitDraft(ws, state); // 被撤的类/关系顺手清摆位、弯折、钉点（裁决的 dropClass 不走 delete_object）
  return state;
  });
}

/* ---------- 发布与放弃 ---------- */

export async function publish(ws: string = DEFAULT_WS): Promise<{ version: number }> {
  return enqueue(ws, async () => {
  const state = await getDraft(ws);
  if (!state.dirty) return { version: state.baseVersion }; // 无改动不产空版本
  const config = configSchema.parse(structuredClone(state.draft)); // 结构校验
  try {
    validateSemantics(config); // 语义校验
    validateActionShapes(config); // 动作形状四查（效应 link/转化成对/取值来源/认人写明）
  } catch (e) {
    throw new DraftReject(e instanceof Error ? e.message : String(e)); // 归一到类型，路由不用嗅探文案
  }
  const version = (await metaStore().latestVersion(ws, seedYamlFor(ws))).version + 1; // 版本号以库里的链为准
  await metaStore().insertVersion(ws, version, dump(config, { lineWidth: 120, noRefs: true }), "publish", canvasSnapshot(state)); // YAML 给问数；canvas_json 给画布回到这版
  storeOf(ws).published = { config, version }; // 换掉已发布快照：引擎下一次 getPublished 即读新版
  state.baseVersion = version;
  await commitDraft(ws, state); // 已并进版本链：dirty 重算为 false，工作副本随之清空
  await fillDecisionVersions(version, ws); // 裁决留痕的生效版本随发布回填
  return { version };
  });
}

export async function discard(ws: string = DEFAULT_WS): Promise<void> {
  return enqueue(ws, async () => {
  const state = await getDraft(ws);
  const published = await getPublished(ws);
  state.draft = structuredClone(published.config); // 内容回到已发布；摆位/弯折/钉点保留（界面状态不随草稿丢）
  state.dirty = false;
  await persistWorkingCopy(ws, state); // 工作行写成已发布内容——放弃必须重启后也干净
  bumpRev(ws); // 放弃也是内容变化：监视器要靠它刷回已发布
  try {
    await metaStore().abandonPendingDecisions(ws); // 草稿里裁过又没发布的留痕标记「已放弃」，不挂到无关的下一次发布上
  } catch {
    // 留痕是附属，不挡放弃
  }
  });
}

/* ---------- 版本历史与回滚 ---------- */

export function listVersions(ws: string = DEFAULT_WS): Promise<{ version: number; createdAt: string; origin: string }[]> {
  return metaStore().listVersions(ws);
}

/** 把某次已发布版本覆盖到当前工作副本（对象、线、摆位）。不插入新版本，问数仍读已发布。 */
export async function rollbackTo(version: number, ws: string = DEFAULT_WS): Promise<{ version: number }> {
  return enqueue(ws, async () => {
  const yaml = await metaStore().versionYaml(ws, version);
  if (yaml === undefined) throw new DraftReject(`版本不存在：v${version}`);
  const snap = await metaStore().versionCanvas(ws, version);
  const pack = snap !== undefined ? unpackCanvas(snap) : { config: undefined }; // 老行没有 canvas_json：config 从 yaml 解
  let config: OntologyConfig;
  try {
    config = configSchema.parse(pack.config ?? load(yaml));
    validateSemantics(config);
  } catch (e) {
    throw new DraftReject(`配置不合法：v${version} 的内容读不回来（${e instanceof Error ? e.message : String(e)}）`);
  }
  const state = await getDraft(ws);
  state.draft = structuredClone(config);
  // 界面状态缺键（老行/读回校验没过的键）保留现状
  applyPack(state, pack, { layout: state.layout, edgeBends: state.edgeBends, edgePins: state.edgePins });
  await commitDraft(ws, state);
  return { version };
  });
}

/** 发布成功后回填：把还没绑版本的裁决留痕挂上这个版本。回填失败不影响发布。 */
async function fillDecisionVersions(version: number, ws: string): Promise<void> {
  try {
    await metaStore().backfillDecisionVersions(ws, version);
  } catch {
    // 留痕是附属，不挡发布
  }
}

/** 键序无关的结构比较：zod parse 会按 schema 重排键，直接 JSON.stringify 会误判 modified。 */
export function sameConfig(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}
