// 当前两份 —— 「这个空间现在生效的是哪两份」：已发布快照 + 工作副本（内存热缓存，每空间一份，挂运行态互不串）。
// 空间的运行时态也归这里：storeOf（内存态）、enqueue（每空间一条写队列）、getRev（草稿修订号）。

import { load } from "js-yaml";
import { configSchema, type OntologyConfig } from "../../schema/config";
import { metaStore } from "../../meta/store";
import { enqueueKeyed, runtime } from "../../runtime";
import { validateSemantics } from "./validate";
import { DEFAULT_WS, seedYamlFor } from "../infra/workspace";
import { readWorkingCopy, type DraftState } from "./canvasPack";

export interface Store {
  published?: { config: OntologyConfig; version: number };
  draft?: DraftState; // DraftState 不加 rev：discard 会清空、rollback 会整份换 draft 对象，rev 挂 Store 上才能只加不回零
  rev: number; // 进程内单调，只加不回零；新建 Store 为 0。画布监视器与 MCP base_rev 都读它
}

/** 每个工作空间一份内存态（已发布快照 + 工作副本），互不串；挂运行态（runtime.ts）。
 *  导出给 commit（bumpRev）与 versions（发布换已发布快照）——rev 挂 Store 上，离了 storeOf 写不了。 */
export function storeOf(ws: string): Store {
  const stores = (runtime().stores ??= new Map());
  let s = stores.get(ws);
  if (!s) {
    s = { rev: 0 };
    stores.set(ws, s);
  }
  return s;
}

/** 草稿修订号：内容每变一次 +1（含发布/放弃/回滚），只加不回零；save_*（摆位/弯折/钉点等界面状态）不算。
 *  GET /api/ontology、list_classes space=draft、edit_draft 与 base_rev 比较一律读它。加 rev 的纪律见 commit.bumpRev。 */
export function getRev(ws: string = DEFAULT_WS): number {
  return storeOf(ws).rev;
}

/* 每工作空间一条写队列：editDraft 校验之后有 await（摆位/取已发布），两个请求在 await 处交错时备份回退会对错对象。
   失败也续链（prev.then(task, task)）：前一次 DraftReject 不拖死后续写入。
   全仓两层队列各护各的：本层护草稿写入，runAction 的 actionTails 护动作执行（发号与 create 幂等）——原语同在 runtime.enqueueKeyed。
   队列挂在 runtime() 上（与它保护的 stores 同一层）：挂模块级会在 Next dev 多路由包下各持一条，串行化恰好失效。 */
export function enqueue<T>(ws: string, task: () => Promise<T>): Promise<T> {
  return enqueueKeyed(runtime().tails ??= new Map(), ws, task);
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

/** 工作副本（读接口）：内存没有就从工作行水合（首访会经 readWorkingCopy 造一行落库——读接口有写副作用，名字说清）。 */
export async function getDraft(ws: string = DEFAULT_WS): Promise<DraftState> {
  const store = storeOf(ws);
  if (!store.draft) {
    const { config, version } = await getPublished(ws);
    store.draft = await readWorkingCopy(ws, config, version);
  }
  store.draft.edgeBends ??= {}; // 热更新前建的内存态没有这字段
  store.draft.edgePins ??= {};
  return store.draft;
}
