// 当前两份 —— 「这个空间现在生效的是哪两份」：已发布快照 + 工作副本，全部读库（无状态：多实例一致）。
// rev 持久化在 onto_version 工作行的 rev 列；写走 CAS（saveDraftPack），本文件不再有内存态与写队列。

import { load } from "js-yaml";
import { configSchema, type OntologyConfig } from "../../schema/config";
import type { EngineEnv } from "../env";
import { validateSemantics } from "./validate";
import { DEFAULT_WORKSPACE, seedYamlFor } from "../../infra/workspace";
import { readWorkingCopy, type DraftState } from "./canvasPack";

/** 草稿修订号：每次写 +1（内容 op、界面状态 op、发布/放弃/回滚都算），只加不回零；界面状态写也 bump，
 *  内容写与界面写才能互相被 CAS 检测。持久化在 onto_version 工作行的 rev 列：跨实例一致、重启不复位。 */
export async function getRev(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<number> {
  return (await env.meta.getWorkingPack(workspace))?.rev ?? 0;
}

async function loadPublished(env: EngineEnv, workspace: string): Promise<{ config: OntologyConfig; version: number }> {
  const { version, yaml } = await env.meta.latestVersion(workspace, seedYamlFor(workspace));
  const config = configSchema.parse(load(yaml));
  validateSemantics(config);
  return { config, version };
}

export async function getPublished(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<{ config: OntologyConfig; version: number }> {
  return loadPublished(env, workspace); // 每请求读库：无内存缓存，跨实例立即可见
}

/** 工作副本（读接口）：读工作行水合；没有工作行从已发布造一行并落库（首访写库，名字说清）。 */
export async function getDraft(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<DraftState> {
  const { config, version } = await getPublished(env, workspace);
  return readWorkingCopy(env, workspace, config, version);
}
