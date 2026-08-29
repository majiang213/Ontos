// 类上的阶段 —— 转化关系用的派生枚举：有几条规则就有几个时期。
// 纯读取：画布节点条、对象卡阶段页、edit_stages 写前回读共用。
// 条件的全文白话（explainWhen）与出向转化（conversions）也在这里，对象卡阶段页直接消费。

import type { ActionDef, OntologyConfig, WhenRule } from "../../schema/config";
import { enumValueKey, enumValueLabel } from "../../schema/config";
import type { StageEditItem } from "../../schema/ops";
import { walkEffectItems } from "../../schema/spec/actionSpec";
import { filterText } from "./filterText";

/** 一条阶段：时期标识 + 判定条件（+ 中文名）。与 edit_stages 的线格式同一份声明，不写第二份。 */
export type StageItem = StageEditItem;

/** 一条出向转化：谁转成谁、沿哪条转化关系、由类上哪条动作执行。 */
export interface StageConversion {
  link: string;
  from: string;
  to: string;
  action?: string;
}

export interface ClassStages {
  property: string;
  items: StageItem[];
  conversions: StageConversion[];
}

function boolPresence(when: Record<string, unknown>): boolean {
  const vals = Object.values(when);
  return vals.length > 0 && vals.every((v) => typeof v === "boolean");
}

/** 一条派生规则怎么用白话说：来源有/没有；带列条件的只说「按规则」。 */
export function stageHint(when: Record<string, unknown>, label: (key: string) => string): string {
  if (!boolPresence(when)) return "按规则";
  return Object.entries(when)
    .map(([k, v]) => `${label(k)}${v ? "有" : "没有"}`)
    .join("、");
}

/** 布尔有/没有规则里点到的来源，节点上不再重复成普通标签。 */
export function stageSourceKeys(items: StageItem[]): string[] {
  const keys = new Set<string>();
  for (const it of items) {
    if (!boolPresence(it.when)) continue;
    for (const k of Object.keys(it.when)) keys.add(k);
  }
  return [...keys];
}

/* ---------- 条件的全文白话（对象卡阶段页用；画布节点条仍用 stageHint 短句） ----------
   渲染本体在 ./filterText（与动作前置摘要共用一份）。 */

/** 一条派生规则的全文白话：真值=这个源有这台；对象条件=有这台，且条件逐条展开。
 *  对象卡阶段页必须能不加第二次点击就读全条件（种子 scrapped 不再说「按规则」）。 */
export function explainWhen(when: Record<string, unknown>, label: (key: string) => string): string {
  return Object.entries(when)
    .map(([k, v]) => {
      if (v === false) return `${label(k)} 没有这台`;
      if (v !== null && typeof v === "object") return `${label(k)} 有这台，且 ${filterText(v as Record<string, unknown>)}`;
      return `${label(k)} 有这台`;
    })
    .join("、");
}

/** 重排一项（上移 dir=-1 / 下移 dir=1），中文名随块走。越界原样返回；不动原数组。 */
export function moveStageItem<T extends StageItem>(items: T[], i: number, dir: number): T[] {
  const j = i + dir;
  if (j < 0 || j >= items.length) return items;
  const out = items.map((row) => ({ ...row }));
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** 这条转化关系由类上哪条动作执行（效应里写 link: 该关系）。editStages 改接时与对象卡读转化摘要共用同一份判定。 */
export function conversionActionOf(cls: { actions?: Record<string, ActionDef> }, linkName: string): string | undefined {
  for (const [name, act] of Object.entries(cls.actions ?? {})) {
    let hit = false;
    walkEffectItems(act, { link: (ln) => { if (ln === linkName) hit = true; } });
    if (hit) return name;
  }
  return undefined;
}

/** 有自环转化、派生是 when 列表才给；对不上返回 null（节点不画阶段条）。条数 = 规则条数，不限两条。
 *  conversions 收同类上全部自环转化（出向：from→to 与执行动作），对象卡挂在对应阶段块下。 */
export function classStages(d: Pick<OntologyConfig, "object_types" | "link_types">, name: string): ClassStages | null {
  const cls = d.object_types[name];
  if (!cls) return null;
  const hit = Object.entries(d.link_types).find(([, l]) => l.from === name && l.to === name && l.transition);
  if (!hit) return null;
  const propName = hit[1].transition!.property;
  const prop = cls.properties[propName];
  if (!prop || !Array.isArray(prop.derived)) return null;
  const rules = prop.derived as WhenRule[];
  if (rules.length === 0) return null;
  const labelByKey = new Map((prop.values ?? []).map((v) => [String(enumValueKey(v)), enumValueLabel(v)]));
  const byValue = new Map<string, WhenRule>();
  for (const r of rules) if (!byValue.has(String(r.value))) byValue.set(String(r.value), r);
  const ordered: WhenRule[] = [];
  for (const v of prop.values ?? []) {
    const r = byValue.get(String(enumValueKey(v)));
    if (r) {
      ordered.push(r);
      byValue.delete(String(enumValueKey(v)));
    }
  }
  for (const r of rules) {
    if (byValue.has(String(r.value))) {
      ordered.push(r);
      byValue.delete(String(r.value));
    }
  }
  const conversions: StageConversion[] = Object.entries(d.link_types)
    .filter(([, l]) => l.from === name && l.to === name && l.transition?.property === propName)
    .map(([ln, l]) => ({
      link: ln,
      from: String(l.transition!.from),
      to: String(l.transition!.to),
      action: conversionActionOf(cls, ln),
    }));
  return {
    property: propName,
    items: ordered.map((r) => {
      const value = String(r.value);
      const label = labelByKey.get(value);
      return label ? { value, when: r.when, label } : { value, when: r.when };
    }),
    conversions,
  };
}
