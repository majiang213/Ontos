// 版本链 —— 「版本链怎么动」：发布 = 工作副本复制成编号行（YAML 给问数；canvas_json 给「回到某版」还原画布）；
// 放弃 = 工作副本回到已发布；回滚 = 某个编号行覆盖工作副本（不产新版本，问数仍读已发布）。
// 无写队列：全部读-改-CAS（expectedRev = 读到的 rev；冲突抛「草稿已变」）。

import { dump, load } from "js-yaml";
import { configSchema, type OntologyConfig } from "../../schema/config";
import { DraftReject, MSG, toResult, type Result } from "../../errors";
import type { EngineEnv } from "../env";
import { DEFAULT_WORKSPACE, seedYamlFor } from "../../infra/workspace";
import { applyPack, canvasSnapshot, persistWorkingCopy, versionCanvasPack } from "./canvasPack";
import { commitDraft, validateFull } from "./commit";
import { getDraft, getPublished, getRev } from "./current";
import { sameConfig } from "./sameConfig";
import { validateSemantics } from "./validate";

export async function publish(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<Result<{ version: number }>> {
  return toResult(async () => {
    const expectedRev = await getRev(env, workspace);
    const state = await getDraft(env, workspace);
    if (!state.dirty) return { version: state.baseVersion }; // 无改动不产空版本
    let config: OntologyConfig;
    try {
      config = validateFull(state.draft); // 三查单源（结构 + 语义 + 动作形状四查，与草稿写入同闸）
    } catch (e) {
      throw new DraftReject(e instanceof Error ? e.message : String(e)); // 归一到类型，路由不用嗅探文案
    }
    const version = (await env.meta.latestVersion(workspace, seedYamlFor(workspace))).version + 1; // 版本号以库里的链为准
    state.baseVersion = version;
    // CAS 先赢、版本行后落：失败的发布不进链（否则 422 的发布已推进 MAX(version)，重试还留幽灵行）。
    // 此刻 dirty 对旧已发布重算仍为 true；版本行插完后读方按新已发布重算即 false（dirty 不落库、读时重算）。
    const saved = await commitDraft(env, workspace, state, expectedRev, true); // 工作副本随之清空（CAS 消耗掉这一版）
    if (!saved) throw new DraftReject(MSG.draftChanged(await getRev(env, workspace)));
    try {
      await env.meta.insertVersion(workspace, version, dump(config, { lineWidth: 120, noRefs: true }), "publish", canvasSnapshot(state)); // YAML 给问数；canvas_json 给画布回到这版
    } catch (e) {
      // 并发发布撞版本号唯一：CAS 赢家只有一个能插行。撞上 = 另一方已把 N+1 插进链。
      // 不能直接按成功收尾：夹层写入会让「我们发布的内容」与「版本行里的内容」分叉（对方插行后有人再编辑，
      // 我们以新内容 CAS 获胜却撞上旧内容的版本行）——逐字比对，一致才按成功收尾，不一致则 422 让调用方重读重发。
      const latest = (await env.meta.latestVersion(workspace, seedYamlFor(workspace))).version;
      if (latest < version) throw e;
      // 逐字比对版本行内容：一致才按成功收尾，分叉则 422 让调用方重读重发（不谎报已发布）。
      // 老版本行可能没有画布包（只有 yaml），退到 yaml 比对——消除「无画布包必 422」的假冲突类。
      const rowPack = await versionCanvasPack(env, workspace, version);
      let rowConfig = rowPack.config;
      if (rowConfig === undefined) {
        const rowYaml = await env.meta.versionYaml(workspace, version);
        rowConfig = rowYaml !== undefined ? load(rowYaml) : undefined;
      }
      if (rowConfig === undefined || !sameConfig(rowConfig, state.draft)) {
        throw new DraftReject(MSG.draftChanged(await getRev(env, workspace)));
      }
    }
    await fillDecisionVersions(env, version, workspace); // 裁决留痕的生效版本随发布回填
    return { version };
  }, (v) => MSG.resultPublished(v.version));
}

export async function discard(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<Result<void>> {
  return toResult(async () => {
    const expectedRev = await getRev(env, workspace);
    const state = await getDraft(env, workspace);
    const published = await getPublished(env, workspace);
    state.draft = structuredClone(published.config); // 内容回到已发布；摆位/弯折/钉点保留（界面状态不随草稿丢）
    state.dirty = false;
    const saved = await persistWorkingCopy(env, workspace, state, expectedRev, true); // 放弃算内容变化：rev+1，监视器靠它刷回
    if (saved === null) throw new DraftReject(MSG.draftChanged(await getRev(env, workspace)));
    try {
      await env.meta.abandonPendingDecisions(workspace); // 草稿里裁过又没发布的留痕标记「已放弃」，不挂到无关的下一次发布上
    } catch {
      // 留痕是附属，不挡放弃
    }
  }, () => MSG.resultDiscarded);
}

export function listVersions(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<{ version: number; createdAt: string; origin: string }[]> {
  return env.meta.listVersions(workspace);
}

/** 把某次已发布版本覆盖到当前工作副本（对象、线、摆位）。不插入新版本，问数仍读已发布。 */
export async function rollbackTo(env: EngineEnv, version: number, workspace: string = DEFAULT_WORKSPACE): Promise<Result<{ version: number }>> {
  return toResult(async () => {
    const expectedRev = await getRev(env, workspace);
    const yaml = await env.meta.versionYaml(workspace, version);
    if (yaml === undefined) throw new DraftReject(MSG.versionNotFound(version));
    const pack = await versionCanvasPack(env, workspace, version); // 老行没有 canvas_json：config 从 yaml 解（pack.config 缺省 undefined）
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
    const saved = await commitDraft(env, workspace, state, expectedRev, true); // 回滚算内容变化：rev+1
    if (!saved) throw new DraftReject(MSG.draftChanged(await getRev(env, workspace)));
    return { version };
  }, (v) => MSG.resultRolledBack(v.version));
}

/** 发布成功后回填：把还没绑版本的裁决留痕挂上这个版本。回填失败不影响发布。 */
async function fillDecisionVersions(env: EngineEnv, version: number, workspace: string): Promise<void> {
  try {
    await env.meta.backfillDecisionVersions(workspace, version);
  } catch {
    // 留痕是附属，不挡发布
  }
}
