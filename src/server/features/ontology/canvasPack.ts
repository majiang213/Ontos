// 画布包 —— 「工作副本怎么存取」：本体 config + 界面状态三键（layout / edgeBends / edgePins）⇆ canvas_json 的编解码，
// 工作行的读回水合（含迁移降级）与首访造行（「空间恒有可变头」由 readWorkingCopy 维持）。
// DraftState 也定义在这里：它就是「画布包」解开后的内存形。读回校验坏键当没有（按键降级），不拖死整包。

import { z } from "zod";
import { configSchema, type OntologyConfig } from "../../schema/config";
import { borderPinSchema, type BorderPin } from "../../schema/ops";
import type { EngineEnv } from "../env";
import { DraftReject, MSG } from "../../errors";
import { sameConfig } from "./sameConfig";

export interface DraftState {
  draft: OntologyConfig;
  baseVersion: number; // 基于哪个已发布版本
  dirty: boolean; // 与已发布是否有差异（按结构比较，每次操作后重算）
  layout: Record<string, { x: number; y: number }>; // 画布摆位（存 onto_workspace.layout 的 nodes）
  edgeBends: Record<string, { dx: number; dy: number }>; // 线的弯折（存同一列的 edges）；界面状态，不算本体改动
  edgePins: Record<string, { source?: BorderPin; target?: BorderPin }>; // 线端点钉点（存同一列的 pins）；界面状态
}

/** 落库用的整包：config + 界面状态三键。三键必有值——「老内存态缺键」的补丁只有一个落点（current.getDraft 的 ??=）。 */
export function canvasSnapshot(state: DraftState): { config: OntologyConfig; layout: DraftState["layout"]; edgeBends: DraftState["edgeBends"]; edgePins: DraftState["edgePins"] } {
  return { config: state.draft, layout: state.layout, edgeBends: state.edgeBends, edgePins: state.edgePins };
}

/* 画布包界面状态三键的浅校验（读回侧）：坏键当没有（按键降级），不拖死整包。config 键由调用方过 configSchema，坏了硬炸。 */
const packLayoutSchema = z.record(z.string(), z.object({ x: z.number(), y: z.number() }));
const packBendsSchema = z.record(z.string(), z.object({ dx: z.number(), dy: z.number() }));
const packPinsSchema = z.record(z.string(), z.looseObject({ source: borderPinSchema.optional().catch(undefined), target: borderPinSchema.optional().catch(undefined) })); // 单端坏钉点降级为没有，不拖垮整条记录

function validKey<S extends z.ZodType>(schema: S, v: unknown): z.infer<S> | undefined {
  const r = schema.safeParse(v);
  return r.success ? r.data : undefined;
}

/** 解画布包：全形 { config, layout, edgeBends, edgePins }；config 可缺（迁移留下的摆位-only 行，本体由调用方用已发布补）；
 *  旧格式顶上就是 object_types（按只有 config 处理）。 */
export function unpackCanvas(raw: unknown): { config?: unknown; layout?: DraftState["layout"]; edgeBends?: DraftState["edgeBends"]; edgePins?: DraftState["edgePins"] } {
  if (raw && typeof raw === "object" && ("config" in raw || "layout" in raw || "edgeBends" in raw || "edgePins" in raw)) {
    const o = raw as Record<string, unknown>;
    return {
      config: o.config,
      layout: validKey(packLayoutSchema, o.layout),
      edgeBends: validKey(packBendsSchema, o.edgeBends),
      edgePins: validKey(packPinsSchema, o.edgePins),
    };
  }
  return { config: raw };
}

/** 把包里的界面状态三键穿进 DraftState：缺键（或读回校验没过的）用 fallback——水合传已发布快照的，回滚传当前状态（保留现状）。 */
export function applyPack(
  state: DraftState,
  pack: { layout?: DraftState["layout"]; edgeBends?: DraftState["edgeBends"]; edgePins?: DraftState["edgePins"] },
  fallback: Pick<DraftState, "layout" | "edgeBends" | "edgePins">
): void {
  state.layout = pack.layout ?? fallback.layout;
  state.edgeBends = pack.edgeBends ?? fallback.edgeBends;
  state.edgePins = pack.edgePins ?? fallback.edgePins;
}

/** 工作行落库：画布全部内容（本体 + 界面状态）的唯一落点（onto_version 里 version IS NULL 的行）。
 *  CAS 语义：expectedRev = 写入者声明基于的修订号；bump=true——界面状态 op 也 bump（rev+1），
 *  内容写与界面写互相 CAS 检测（否则内容写盖掉并发摆位）。
 *  返回保存后的 rev；冲突返回 null（调用方决定重试或抛「草稿已变」）。 */
export async function persistWorkingCopy(env: EngineEnv, workspace: string, state: DraftState, expectedRev: number, bump: boolean): Promise<number | null> {
  return env.meta.saveWorkingPack(workspace, canvasSnapshot(state), expectedRev, bump);
}

/** 读工作行并水合成 DraftState；还没有工作行就从已发布造一行并落库——「空间恒有可变头」这个不变量由本函数维持。
 *  迁移降级：摆位-only 的老工作行本体用已发布（首次写入即补全 pack）；界面状态缺键用已发布版的画布包后备。 */
export async function readWorkingCopy(env: EngineEnv, workspace: string, config: OntologyConfig, version: number): Promise<DraftState> {
  const saved = await env.meta.getWorkingPack(workspace);
  // 界面状态的后备：最近已发布版的画布包（老行可能只有 yaml，那就空着，画布走 dagre）
  const pubPack = unpackCanvas((await env.meta.versionCanvas(workspace, version)) ?? {});
  const fallback = { layout: pubPack.layout ?? {}, edgeBends: pubPack.edgeBends ?? {}, edgePins: pubPack.edgePins ?? {} };
  if (saved === undefined) {
    const state: DraftState = { draft: structuredClone(config), baseVersion: version, dirty: false, layout: {}, edgeBends: {}, edgePins: {} };
    applyPack(state, {}, fallback);
    await persistWorkingCopy(env, workspace, state, 0, false); // 首访造行：无行时 saveDraftPack 走 INSERT 分支（expectedRev 0 起）
    return state;
  }
  const pack = unpackCanvas(saved.pack);
  let draft: OntologyConfig;
  if (pack.config === undefined) {
    draft = structuredClone(config); // 迁移留下的摆位-only 工作行：本体用已发布，首次写入即补全 pack
  } else {
    try {
      draft = configSchema.parse(pack.config);
    } catch (e) {
      throw new DraftReject(MSG.workingCopyUnreadable(e instanceof Error ? e.message : String(e)));
    }
  }
  const state: DraftState = { draft: structuredClone(draft), baseVersion: version, dirty: !sameConfig(draft, config), layout: {}, edgeBends: {}, edgePins: {} };
  applyPack(state, pack, fallback);
  return state;
}
