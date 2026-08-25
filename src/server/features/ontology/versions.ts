// 版本链 —— 「版本链怎么动」：发布 = 工作副本复制成编号行（YAML 给问数；canvas_json 给「回到某版」还原画布）；
// 放弃 = 工作副本回到已发布；回滚 = 某个编号行覆盖工作副本（不产新版本，问数仍读已发布）。

import { dump, load } from "js-yaml";
import { configSchema, type OntologyConfig } from "../../schema/config";
import { DraftReject, MSG, codeOf, type Result } from "../../errors";
import type { EngineEnv } from "../env";
import { DEFAULT_WORKSPACE, seedYamlFor } from "../../infra/workspace";
import { applyPack, canvasSnapshot, persistWorkingCopy, unpackCanvas } from "./canvasPack";
import { bumpRev, commitDraft, validateFull } from "./commit";
import { enqueue, getDraft, getPublished, storeOf } from "./current";
import { validateSemantics } from "./validate";

export async function publish(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<Result<{ version: number }>> {
  try {
    const value = await enqueue(env, workspace, async () => {
      const state = await getDraft(env, workspace);
      if (!state.dirty) return { version: state.baseVersion }; // 无改动不产空版本
      let config: OntologyConfig;
      try {
        config = validateFull(state.draft); // 三查单源（结构 + 语义 + 动作形状四查，与草稿写入同闸）
      } catch (e) {
        throw new DraftReject(e instanceof Error ? e.message : String(e)); // 归一到类型，路由不用嗅探文案
      }
      const version = (await env.meta.latestVersion(workspace, seedYamlFor(workspace))).version + 1; // 版本号以库里的链为准
      await env.meta.insertVersion(workspace, version, dump(config, { lineWidth: 120, noRefs: true }), "publish", canvasSnapshot(state)); // YAML 给问数；canvas_json 给画布回到这版
      storeOf(env, workspace).published = { config, version }; // 换掉已发布快照：引擎下一次 getPublished 即读新版
      state.baseVersion = version;
      await commitDraft(env, workspace, state); // 已并进版本链：dirty 重算为 false，工作副本随之清空
      await fillDecisionVersions(env, version, workspace); // 裁决留痕的生效版本随发布回填
      return { version };
    });
    return { code: 200, message: MSG.resultPublished(value.version), value };
  } catch (e) {
    const code = codeOf(e);
    if (code !== null) return { code, message: e instanceof Error ? e.message : String(e) };
    throw e;
  }
}

export async function discard(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<Result<void>> {
  try {
    await enqueue(env, workspace, async () => {
      const state = await getDraft(env, workspace);
      const published = await getPublished(env, workspace);
      state.draft = structuredClone(published.config); // 内容回到已发布；摆位/弯折/钉点保留（界面状态不随草稿丢）
      state.dirty = false;
      await persistWorkingCopy(env, workspace, state); // 工作行写成已发布内容——放弃必须重启后也干净
      bumpRev(env, workspace); // 放弃也是内容变化：监视器要靠它刷回已发布
      try {
        await env.meta.abandonPendingDecisions(workspace); // 草稿里裁过又没发布的留痕标记「已放弃」，不挂到无关的下一次发布上
      } catch {
        // 留痕是附属，不挡放弃
      }
    });
    return { code: 200, message: MSG.resultDiscarded, value: undefined };
  } catch (e) {
    const code = codeOf(e);
    if (code !== null) return { code, message: e instanceof Error ? e.message : String(e) };
    throw e;
  }
}

export function listVersions(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<{ version: number; createdAt: string; origin: string }[]> {
  return env.meta.listVersions(workspace);
}

/** 把某次已发布版本覆盖到当前工作副本（对象、线、摆位）。不插入新版本，问数仍读已发布。 */
export async function rollbackTo(env: EngineEnv, version: number, workspace: string = DEFAULT_WORKSPACE): Promise<Result<{ version: number }>> {
  try {
    const value = await enqueue(env, workspace, async () => {
      const yaml = await env.meta.versionYaml(workspace, version);
      if (yaml === undefined) throw new DraftReject(MSG.versionNotFound(version));
      const snap = await env.meta.versionCanvas(workspace, version);
      const pack = snap !== undefined ? unpackCanvas(snap) : { config: undefined }; // 老行没有 canvas_json：config 从 yaml 解
      let config: OntologyConfig;
      try {
        config = configSchema.parse(pack.config ?? load(yaml));
        validateSemantics(config);
      } catch (e) {
        throw new DraftReject(MSG.versionUnreadable(version, e instanceof Error ? e.message : String(e)));
      }
      const state = await getDraft(env, workspace);
      state.draft = structuredClone(config);
      // 界面状态缺键（老行/读回校验没过的键）保留现状
      applyPack(state, pack, { layout: state.layout, edgeBends: state.edgeBends, edgePins: state.edgePins });
      await commitDraft(env, workspace, state);
      return { version };
    });
    return { code: 200, message: MSG.resultRolledBack(value.version), value };
  } catch (e) {
    const code = codeOf(e);
    if (code !== null) return { code, message: e instanceof Error ? e.message : String(e) };
    throw e;
  }
}

/** 发布成功后回填：把还没绑版本的裁决留痕挂上这个版本。回填失败不影响发布。 */
async function fillDecisionVersions(env: EngineEnv, version: number, workspace: string): Promise<void> {
  try {
    await env.meta.backfillDecisionVersions(workspace, version);
  } catch {
    // 留痕是附属，不挡发布
  }
}
