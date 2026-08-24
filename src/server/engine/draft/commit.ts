// 落定 —— 「一步改动怎样才算落定」：三查（结构 + 语义 + 动作形状）不合法整体回退，坏草稿不攒到发布一刻才炸；
// 合法则统一收尾：rev → 清界面状态死键 → 重算 dirty → 落工作行。
// editDraft / mutateDraft / publish / discard / rollbackTo 五个入口共用这一份，不各写各的收尾。

import { configSchema, type OntologyConfig } from "../../schema/config";
import { DraftReject } from "../../errors";
import { gcDeadKeys } from "./canvasState";
import { persistWorkingCopy, type DraftState } from "./canvasPack";
import { getPublished, storeOf } from "./current";
import { sameConfig } from "./sameConfig";
import { validateActionShapes, validateSemantics } from "./validate";

/** rev += 1 的纪律只有这一条：内容写进 Store 之后、下一个 await 之前——晚一拍，监视器带旧 ETag 会 304，把已改的草稿当成没变。 */
export function bumpRev(ws: string): void {
  storeOf(ws).rev += 1;
}

/** 三道校验单源（结构 + 语义 + 动作形状四查）：草稿写入与发布同调这一份。
 *  rollbackTo/loadPublished 只用前两道（configSchema.parse + validateSemantics，不走本函数）——
 *  历史已发布的坏配置加载放行，运行期由 action.ts 兜底；「哪里查几道」的边界就是有没有调本函数。 */
export function validateFull(raw: OntologyConfig): OntologyConfig {
  const parsed = configSchema.parse(structuredClone(raw));
  validateSemantics(parsed);
  validateActionShapes(parsed);
  return parsed;
}

/** 每步改完立即校验（三查见 validateFull），不合法整体回退——坏草稿不能攒到发布一刻才炸。 */
export function validateDraftOrThrow(state: DraftState, backup: OntologyConfig): void {
  try {
    validateFull(state.draft);
  } catch (e) {
    state.draft = backup;
    throw new DraftReject(e instanceof Error ? e.message : String(e));
  }
}

/** 草稿写路径的统一收尾：rev → 清界面状态死键 → 按结构重算 dirty（改出去又改回来要能收回来）→ 落工作行。 */
export async function commitDraft(ws: string, state: DraftState): Promise<void> {
  bumpRev(ws);
  gcDeadKeys(state);
  state.dirty = !sameConfig(state.draft, (await getPublished(ws)).config);
  await persistWorkingCopy(ws, state);
}
