// 受理 —— 「一条改动怎么被受理」：排队 → base_rev 协商 → 按 UI_STATE_OPS 分流 → 解释（ops/）→ 落定（commit.ts）。
// 通道唯一入口：REST /api/edit_draft 与 MCP edit_draft 同走 editDraft（一条 op）；
// 裁决等成组改动走 mutateDraft（一个函数）——两个入口同一套校验与收尾。

import type { OntologyConfig } from "../../schema/config";
import { isUiStateOp, type DraftOpInput as DraftOp } from "../../schema/ops";
import { DraftReject, MSG } from "../../errors";
import { DEFAULT_WS } from "../infra/workspace";
import { applyOp } from "./ops";
import { persistWorkingCopy, type DraftState } from "./canvasPack";
import { commitDraft, validateDraftOrThrow } from "./commit";
import { enqueue, getDraft, getPublished, getRev } from "./current";

/** 受理一条 op：改工作副本，一次只改一步。base_rev 只在 MCP 信封出现（REST 画布不传，队列里后到的写入赢）。 */
export async function editDraft(input: DraftOp, ws: string = DEFAULT_WS, opts?: { base_rev?: number }): Promise<DraftState> {
  return enqueue(ws, async () => {
    // base_rev 的比较必须在同一个 task 开头——比在队列外会被并发吞掉
    if (opts?.base_rev !== undefined && opts.base_rev !== getRev(ws)) {
      throw new DraftReject(MSG.draftChanged(getRev(ws)));
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

/** 受理一个改草稿的函数（裁决应用等成组改动走这里）：改完立即校验，不合法就回退并抛 DraftReject——与 editDraft 同闸。 */
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
    validateDraftOrThrow(state, backup); // 与 editDraft 同闸：裁决产物也得过动作形状四查
    await commitDraft(ws, state); // 被撤的类/关系顺手清摆位、弯折、钉点（裁决的 dropClass 不走 delete_object）
    return state;
  });
}
