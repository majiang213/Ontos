// 告知（inform）变更事件生成 —— 效应计划 + 投影结果进，变更事件数组出（《ontos-article.md》§6.5）。
// 纯拼装：不查库、不外发（本期预留），随动作结果返回，不静默丢弃。
// 抽出自 action.ts：事件形状可单测，不必跑完整动作执行。

import type { ActionDef, OntologyConfig } from "../../schema/config";
import type { ActionRequest } from "../../schema/request";
import { resolveValue, type EvalContext } from "../query/expr";
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

/** 变更事件按效应列表逐项生成条目。create 的 target 取解析出的识别值（from: generated 的不重复发号）。 */
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
      if (p.kind === "create") {
        const idPropOfCls = p.cls.def.identity;
        const spec = idPropOfCls ? p.propSpec[idPropOfCls] : undefined;
        const resolvable = spec !== undefined && !(typeof spec === "object" && spec !== null && (spec as Record<string, unknown>).from === "generated");
        const v = resolvable ? resolveValue(spec, idPropOfCls!, ctx) : null;
        return [{ op: p.kind, object_class: p.cls.name, target: v == null ? null : String(v) }];
      }
      const keys = p.kind === "link" ? [String(req.identity)] : p.targets.map((t) => t.key);
      return keys.map((k) => ({ op: p.kind, object_class: p.kind === "link" ? req.object : p.cls.name, target: k }));
    });
    return {
      object: inf.object,
      to: inf.to,
      properties,
      lines: lines.map((l, i) =>
        changeId == null ? l : { ...l, change_id: String(changeId), line_id: `${changeId}#${i + 1}` }
      ),
      delivered: false,
      note: anyFail
        ? "告知本期预留，引擎不执行外发；有投影失败，事件按计划生成，与实际存在可能有差（§6.5）"
        : "告知本期预留，引擎不执行外发（机制见《ontos-article.md》§6.5）",
    };
  });
}
