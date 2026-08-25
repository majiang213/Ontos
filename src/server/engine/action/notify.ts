// 告知（inform）变更事件生成 —— 效应计划 + 投影结果进，变更事件数组出（《ontos-article.md》§6.5）。
// 纯拼装：不查库、不外发（本期预留），随动作结果返回，不静默丢弃。
// 抽出自 action.ts：事件形状可单测，不必跑完整动作执行。计划（Planned）是成品——
// createTarget 与 cls 都在计划时定死，本文件只读不求值，不理解「from: generated 不重复发号」这类取值约定。

import type { ActionDef, OntologyConfig } from "../../schema/config";
import type { ActionRequest } from "../../schema/request";
import { resolveValue, type EvalContext } from "../query/expr";
import { MSG } from "../../errors";
import type { Planned, ProjectionRecord } from "./action";

/** 变更事件的一条条目：谁被做了什么。能拿到 change_id 时补 change_id 与 line_id（change_id#序号）。 */
export interface NotificationLine {
  op: string;
  object_class: string;
  target: string | null;
  change_id?: string;
  line_id?: string;
}

export interface NotificationRecord {
  object: string;
  to: string[];
  properties: Record<string, unknown>;
  lines: NotificationLine[];
  delivered: false;
  note: string;
}

/** 变更事件按效应列表逐项生成条目。create 的 target 读计划的 createTarget（识别值在 planEffect 定死，这里不再求值）。 */
export function buildNotifications(
  config: OntologyConfig,
  action: ActionDef,
  plan: Planned[],
  req: ActionRequest,
  ctx: EvalContext,
  projections: ProjectionRecord[]
): NotificationRecord[] {
  const anyFail = projections.some((r) => !r.ok);
  return (action.inform ?? []).map((inf) => {
    const properties = Object.fromEntries(Object.entries(inf.properties).map(([prop, spec]) => [prop, resolveValue(spec, prop, ctx)]));
    // 事件 identity 不靠属性名约定：properties 没填事件类的 identity 时，把全部已解析值按声明顺序用 | 拼接（附录 B）
    const idProp = config.object_types[inf.object]?.identity;
    if (idProp && properties[idProp] == null) {
      const vals = Object.values(properties);
      if (vals.length > 0 && vals.every((v) => v != null)) properties[idProp] = vals.map(String).join("|");
    }
    const changeId = idProp ? properties[idProp] : undefined;
    // 条目：效应逐项、项内每个目标个体各一条，带 op / object_class / target；能拿到 change_id 就补 change_id 与 line_id（change_id#序号）
    const lines: NotificationLine[] = plan.flatMap((p): NotificationLine[] => {
      if (p.kind === "create") return [{ op: p.kind, object_class: p.cls.name, target: p.createTarget }]; // 识别值在计划时已定死（generated 为 null）
      const keys = p.kind === "link" ? [String(req.identity)] : p.targets.map((t) => t.key);
      return keys.map((k) => ({ op: p.kind, object_class: p.cls.name, target: k })); // link 的 cls 也是计划带过来的成品
    });
    return {
      object: inf.object,
      to: inf.to,
      properties,
      lines: lines.map((l, i) =>
        changeId == null ? l : { ...l, change_id: String(changeId), line_id: `${changeId}#${i + 1}` }
      ),
      delivered: false,
      note: anyFail ? MSG.notifyDeferredWithFailure : MSG.notifyDeferred,
    };
  });
}
