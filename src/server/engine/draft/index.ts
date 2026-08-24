// draft 包对外门面 —— 改工作副本这条链的公共口：
// 受理（editDraft / mutateDraft）、当前两份（getDraft / getPublished / getRev）、版本链（publish / discard / rollbackTo / listVersions）。
// 内部文件的依赖方向：editDraft → commit → current → canvasPack；ops/* → refs / canvasState / skeletons；views 只读纯函数。

export { editDraft, mutateDraft } from "./editDraft";
export { getDraft, getPublished, getRev } from "./current";
export { discard, listVersions, publish, rollbackTo } from "./versions";
export { sameConfig } from "./sameConfig";
export type { DraftState } from "./canvasPack";
