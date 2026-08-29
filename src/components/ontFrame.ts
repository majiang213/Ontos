// 帧 → 视图模型：GET /api/ontology 的响应形状（轮询帧）、外部改动 toast、收卡策略。
// revWatcher 管「什么时候有新帧」，这里管「帧来了视图模型怎么变」。第二个消费方（非画布页）出现时不再各写一份。

import type { BorderPin } from "../server/schema/ops";
import type { ClassConclusion } from "../server/schema/config";

/** 本体视图响应：画布读工作副本（已发布 + 未发布改动）。rev 是 Store.rev，轮询监视器按它判变没变（ETag 同值）。 */
export interface OntologyResp {
  rev: number;
  version: number;
  dirty: boolean;
  layout: Record<string, { x: number; y: number }>;
  edgeBends: Record<string, { dx: number; dy: number }>; // 线的弯折点（界面状态，随摆位存）
  edgePins: Record<string, { source?: BorderPin; target?: BorderPin }>; // 端点钉点
  states: Record<string, "new" | "modified" | "same">;
  deleted: string[];
  action_changes: { added: string[]; overwritten: string[]; removed: string[] }; // 类名.动作名
  object_types: Record<string, any>;
  link_types: Record<string, any>;
  class_conclusions?: ClassConclusion[];
}

export interface MonitorFrame {
  object_types: Record<string, unknown>;
  action_changes?: { added: string[]; overwritten: string[]; removed: string[] };
}

/** 轮询发现外部改动时的 toast 文案。判定顺序钉死：先动作差集与对象键差集的组合，再单对象键，最后默认句——
 *  禁止「对象键不变 → 默认句」把动作句做成死代码。 */
export function externalToast(prev: MonitorFrame, next: MonitorFrame): string {
  const prevKeys = new Set(Object.keys(prev.object_types));
  const added = Object.keys(next.object_types).filter((k) => !prevKeys.has(k));
  const removed = [...prevKeys].filter((k) => !(k in next.object_types));
  const ac = next.action_changes ?? { added: [], overwritten: [], removed: [] };
  const actionNames = [...new Set([...ac.added, ...ac.overwritten, ...ac.removed])];
  const objPart =
    added.length && removed.length
      ? `新对象：${added.join("、")}；已去掉：${removed.join("、")}`
      : added.length
        ? `新对象：${added.join("、")}`
        : removed.length
          ? `已去掉：${removed.join("、")}`
          : "";
  const actPart = actionNames.length ? `动作有更新：${actionNames.join("、")}` : "";
  if (objPart && actPart) return `草稿有更新，已刷新（${objPart}；${actPart}）`;
  if (actPart) return `草稿有更新，已刷新（${actPart}）`;
  if (objPart) return `草稿有更新，已刷新（${objPart}）`;
  return "草稿有更新，已刷新";
}

/** 外部改动后的收卡策略：开着的对象卡对应类已不在草稿里，收掉（通用策略，不是某张卡的特例）。 */
export function shouldCloseObjectCard(openName: string | null, data: OntologyResp): boolean {
  return openName !== null && !(openName in data.object_types);
}

/** 空白种子版本：v1 且没有任何对象——空白空间注册时自动落的空本体 v1，不算「发布过」。 */
export function isBlankSeed(ont: Pick<OntologyResp, "version" | "object_types">): boolean {
  return ont.version === 1 && Object.keys(ont.object_types).length === 0;
}

/** 左上版本钮的标签（加载中占位不在此处：调用方对 null 帧自己写「已发布 v…」）。 */
export function versionLabel(ont: Pick<OntologyResp, "version" | "object_types">): string {
  return isBlankSeed(ont) ? "未发布" : `已发布 v${ont.version}`;
}

/** 发布钮的 title 点名将发生的变化：将删除的类 + 动作差集里实际发生的子集（三个动词不永远并排）。
 *  没有可点名的变化返回 undefined（title 不出现）。 */
export function publishTitle(ont: Pick<OntologyResp, "deleted" | "action_changes">): string | undefined {
  const parts: string[] = [];
  if (ont.deleted?.length) parts.push(`将删除：${ont.deleted.join("、")}`);
  const ac = ont.action_changes;
  if (ac?.added.length) parts.push(`将新增的动作：${ac.added.join("、")}`);
  if (ac?.overwritten.length) parts.push(`将更新的动作：${ac.overwritten.join("、")}`);
  if (ac?.removed.length) parts.push(`将删除的动作：${ac.removed.join("、")}`);
  return parts.length ? parts.join("；") : undefined;
}
