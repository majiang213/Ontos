// 受理 —— 「一条改动怎么被受理」：base_rev 协商 → 按 UI_STATE_OPS 分流 → 解释（ops/）→ 落定（commit.ts）。
// 通道唯一入口：REST /api/edit_draft 与 MCP edit_draft 同走 editDraft（一条 op）；
// 裁决等成组改动走 mutateDraft（一个函数）——两个入口同一套校验与收尾。

import type { OntologyConfig } from "../../schema/config";
import { isUiStateOp, type DraftOpInput as DraftOp } from "../../schema/ops";
import { DraftReject, MSG, codeOf, type Result } from "../../errors";
import type { EngineEnv } from "../env";
import { DEFAULT_WORKSPACE } from "../../infra/workspace";
import { applyOp } from "./ops";
import { persistWorkingCopy, type DraftState } from "./canvasPack";
import { commitDraft, validateDraftOrThrow } from "./commit";
import { getDraft, getPublished, getRev } from "./current";

/** 受理一条 op：改工作副本，一次只改一步。base_rev 只在 MCP 信封出现（REST 画布不传）。
 *  无写队列：读-改-CAS；冲突时 MCP 路径直接 422「草稿已变」，画布路径自动重读重试一次（保持"后写叠加应用"）。 */
export async function editDraft(env: EngineEnv, input: DraftOp, workspace: string = DEFAULT_WORKSPACE, opts?: { base_rev?: number }): Promise<Result<DraftState>> {
  try {
    const maxAttempts = opts?.base_rev !== undefined ? 1 : 2; // MCP 带 base_rev：冲突即拒；画布：重试一次
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const expectedRev = opts?.base_rev ?? (await getRev(env, workspace));
      const state = await getDraft(env, workspace);
      const published = (await getPublished(env, workspace)).config;
      // 界面状态 op（名单在 ops.ts 的 UI_STATE_OPS）：改内存 + CAS 落工作行就完事——不校验、不算本体改动。
      // 但界面状态写也 bump rev（bump=true）：工作副本整体版本化，内容写与界面写才能互相被 CAS 检测——
      // 否则内容写盖掉并发摆位（旧「摆位不催监视器」纪律在多实例下让位给正确性）。
      if (isUiStateOp(input.op)) {
        applyOp(state, input, published);
        const saved = await persistWorkingCopy(env, workspace, state, expectedRev, true);
        if (saved !== null) return { code: 200, message: MSG.resultDraftSaved, value: state };
        if (attempt === maxAttempts) throw new DraftReject(MSG.draftChanged(await getRev(env, workspace)));
        continue; // 被并发写推进：重读重试
      }
      const backup = structuredClone(state.draft);
      applyOp(state, input, published);
      // 每步操作后立即校验，不合法整体回退（含 import_objects 这类批量：fields 指向不存在属性的坏草稿不能攒到发布一刻才炸）
      validateDraftOrThrow(state, backup);
      const saved = await commitDraft(env, workspace, state, expectedRev, true);
      if (saved) return { code: 200, message: MSG.resultDraftSaved, value: state };
      if (attempt === maxAttempts) throw new DraftReject(MSG.draftChanged(await getRev(env, workspace)));
    }
    throw new DraftReject(MSG.draftChanged(await getRev(env, workspace))); // 理论不可达：循环内已抛
  } catch (e) {
    const code = codeOf(e);
    if (code !== null) return { code, message: e instanceof Error ? e.message : String(e) };
    throw e; // 意外异常是引擎故障，不进 Result（respond 兜 500）
  }
}

/** 受理一个改草稿的函数（裁决应用等成组改动走这里）：改完立即校验，不合法就回退并抛 DraftReject——与 editDraft 同闸。
 *  无队列：读-改-CAS；冲突直接抛（裁决应用非幂等，不重试——重试会把结论应用两遍）。 */
export async function mutateDraft(env: EngineEnv, fn: (draft: OntologyConfig) => void, workspace: string = DEFAULT_WORKSPACE): Promise<DraftState> {
  const expectedRev = await getRev(env, workspace);
  const state = await getDraft(env, workspace);
  const backup = structuredClone(state.draft);
  try {
    fn(state.draft);
  } catch (e) {
    state.draft = backup; // 回退
    throw new DraftReject(e instanceof Error ? e.message : String(e));
  }
  validateDraftOrThrow(state, backup); // 与 editDraft 同闸：裁决产物也得过动作形状四查
  const saved = await commitDraft(env, workspace, state, expectedRev, true); // 被撤的类/关系顺手清摆位、弯折、钉点（裁决的 dropClass 不走 delete_object）
  if (!saved) throw new DraftReject(MSG.draftChanged(await getRev(env, workspace)));
  return state;
}
