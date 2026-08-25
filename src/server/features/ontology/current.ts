// 当前两份 —— 「这个空间现在生效的是哪两份」：已发布快照 + 工作副本（内存热缓存，每空间一份，挂运行态互不串）。
// 空间的运行时态也归这里：storeOf（内存态）、enqueue（每空间一条写队列）、getRev（草稿修订号）。
// 依赖显式下传：stores / tails / meta 由边界经 EngineEnv 传入，本文件不摸全局单例。

import { load } from "js-yaml";
import { configSchema, type OntologyConfig } from "../../schema/config";
import { enqueueKeyed } from "../../enqueue";
import type { EngineEnv } from "../env";
import { validateSemantics } from "./validate";
import { DEFAULT_WORKSPACE, seedYamlFor } from "../../infra/workspace";
import { readWorkingCopy, type DraftState } from "./canvasPack";

export interface Store {
  published?: { config: OntologyConfig; version: number };
  draft?: DraftState; // DraftState 不加 rev：discard 会清空、rollback 会整份换 draft 对象，rev 挂 Store 上才能只加不回零
  rev: number; // 进程内单调，只加不回零；新建 Store 为 0。画布监视器与 MCP base_rev 都读它
}

/** 每个工作空间一份内存态（已发布快照 + 工作副本），互不串；Map 由全局组合根持有（engineEnv 组装）。
 *  导出给 commit（bumpRev）与 versions（发布换已发布快照）——rev 挂 Store 上，离了 storeOf 写不了。 */
export function storeOf(env: EngineEnv, workspace: string): Store {
  let s = env.stores.get(workspace);
  if (!s) {
    s = { rev: 0 };
    env.stores.set(workspace, s);
  }
  return s;
}

/** 草稿修订号：内容每变一次 +1（含发布/放弃/回滚），只加不回零；save_*（摆位/弯折/钉点等界面状态）不算。
 *  GET /api/ontology、list_classes space=draft、edit_draft 与 base_rev 比较一律读它。加 rev 的纪律见 commit.bumpRev。 */
export function getRev(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): number {
  return storeOf(env, workspace).rev;
}

/* 每工作空间一条写队列：editDraft 校验之后有 await（摆位/取已发布），两个请求在 await 处交错时备份回退会对错对象。
   失败也续链（prev.then(task, task)）：前一次 DraftReject 不拖死后续写入。
   全仓两层队列各护各的：本层护草稿写入，runAction 的 actionTails 护动作执行（发号与 create 幂等）——原语同在 enqueue.enqueueKeyed。
   队列挂在运行态上（与它保护的 stores 同一层）：挂模块级会在 Next dev 多路由包下各持一条，串行化恰好失效。 */
export function enqueue<T>(env: EngineEnv, workspace: string, task: () => Promise<T>): Promise<T> {
  return enqueueKeyed(env.tails, workspace, task);
}

async function loadPublished(env: EngineEnv, workspace: string): Promise<{ config: OntologyConfig; version: number }> {
  const { version, yaml } = await env.meta.latestVersion(workspace, seedYamlFor(workspace));
  const config = configSchema.parse(load(yaml));
  validateSemantics(config);
  return { config, version };
}

export async function getPublished(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<{ config: OntologyConfig; version: number }> {
  const store = storeOf(env, workspace);
  if (!store.published) store.published = await loadPublished(env, workspace);
  return store.published;
}

/** 工作副本（读接口）：内存没有就从工作行水合（首访会经 readWorkingCopy 造一行落库——读接口有写副作用，名字说清）。 */
export async function getDraft(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<DraftState> {
  const store = storeOf(env, workspace);
  if (!store.draft) {
    const { config, version } = await getPublished(env, workspace);
    store.draft = await readWorkingCopy(env, workspace, config, version);
  }
  store.draft.edgeBends ??= {}; // 「老内存态缺界面状态键」的补丁只在这一个落点（热更新前建的内存态没有这字段）
  store.draft.edgePins ??= {};
  return store.draft;
}
