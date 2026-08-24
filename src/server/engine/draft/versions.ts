// 版本链 —— 「版本链怎么动」：发布 = 工作副本复制成编号行（YAML 给问数；canvas_json 给「回到某版」还原画布）；
// 放弃 = 工作副本回到已发布；回滚 = 某个编号行覆盖工作副本（不产新版本，问数仍读已发布）。

import { dump, load } from "js-yaml";
import { configSchema, type OntologyConfig } from "../../schema/config";
import { metaStore } from "../../meta/store";
import { DraftReject } from "../../errors";
import { DEFAULT_WS, seedYamlFor } from "../infra/workspace";
import { applyPack, canvasSnapshot, persistWorkingCopy, unpackCanvas } from "./canvasPack";
import { bumpRev, commitDraft, validateFull } from "./commit";
import { enqueue, getDraft, getPublished, storeOf } from "./current";
import { validateSemantics } from "./validate";

export async function publish(ws: string = DEFAULT_WS): Promise<{ version: number }> {
  return enqueue(ws, async () => {
    const state = await getDraft(ws);
    if (!state.dirty) return { version: state.baseVersion }; // 无改动不产空版本
    let config: OntologyConfig;
    try {
      config = validateFull(state.draft); // 三查单源（结构 + 语义 + 动作形状四查，与草稿写入同闸）
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
