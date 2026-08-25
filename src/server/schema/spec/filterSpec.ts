// 过滤树走查器 + 操作数形状规则 —— 附录 B「过滤」一节的单一事实源。
// 校验（validate）、值形状核对（individual）、引用扫描（draft/refs）、下推（query）都消费它。
// 新增保留字只改这里；关系解析也随之收在本文件（schema 层，引擎各文件不再各自心算）。

import type { Filter, LinkType, OntologyConfig } from "../config";
import { FILTER_OPS } from "../config";
import { MSG } from "../../errors";

/** 关系解析（唯一出处）：正向名在 from 侧（目标 to），反向名（inverse）在 to 侧（目标 from）。找不到返回 undefined。 */
export function resolveLink(config: OntologyConfig, clsName: string, name: string): { link: LinkType; reversed: boolean } | undefined {
  const direct = config.link_types[name];
  if (direct && direct.from === clsName) return { link: direct, reversed: false };
  for (const link of Object.values(config.link_types)) {
    if (link.inverse === name && link.to === clsName) return { link, reversed: true };
  }
  return undefined;
}

/** 关系名 → 目标类；未解析返回 null（报不报错由调用方定）。 */
export function linkTarget(config: OntologyConfig, clsName: string, name: string): string | null {
  const r = resolveLink(config, clsName, name);
  return r ? (r.reversed ? r.link.from : r.link.to) : null;
}

export type FilterVisit = {
  /** 属性条件键。cls 是该键所属的类（$link 嵌套里是目标类）。 */
  prop?: (cls: string, key: string, value: unknown, depth: number) => void;
  /** $link 条目：target 已解析（未解析为 null）。返回 false 不递归进子过滤（默认递归）。 */
  link?: (cls: string, name: string, target: string | null, sub: unknown, depth: number) => false | void;
  /** $request / $exists 等 $ 键（内容不递归）。 */
  special?: (cls: string, key: string, value: unknown) => void;
};

/**
 * 递归走查一棵过滤树。config 给 null 时只做结构遍历（target 一律 null），供不关心关系解析的消费方。
 * $link 的子过滤按目标类递归；子值是 true/false（存在性写法）只发事件不递归。
 */
export function walkFilter(config: OntologyConfig | null, clsName: string, filter: Filter, visit: FilterVisit, depth = 0): void {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$link") {
      for (const [ln, sub] of Object.entries(v as Filter)) {
        const target = config ? linkTarget(config, clsName, ln) : null;
        const recurse = visit.link?.(clsName, ln, target, sub, depth);
        if (recurse !== false && sub !== null && typeof sub === "object" && !Array.isArray(sub)) {
          walkFilter(config, target ?? clsName, sub as Filter, visit, depth + 1);
        }
      }
      continue;
    }
    if (k.startsWith("$")) {
      visit.special?.(clsName, k, v);
      continue;
    }
    visit.prop?.(clsName, k, v, depth);
  }
}

/* ---------- 操作数形状规则（过滤的取值位） ----------
   字面量（含日期表达式串）与「字面量数组」放过；运算符块逐运算符递归；
   { property } 组合的 from 只许 current/request；裸 { from } 只许 identity。
   validate 的静态核对用这里；query/compare.resolveOperand 是同一套形状的运行期求值。 */

export function checkOperand(v: unknown, where: string): void {
  if (Array.isArray(v)) {
    for (const x of v) {
      if (x !== null && typeof x === "object") throw new Error(MSG.cfgOperandArrayLiteral(where));
    }
    return;
  }
  if (v === null || typeof v !== "object") return; // 字面量
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length > 0 && keys.every((k) => (FILTER_OPS as readonly string[]).includes(k))) {
    for (const k of keys) checkOperand(rec[k], where); // 运算符块：每个运算符的值还是操作数
    return;
  }
  if (typeof rec.property === "string") {
    const from = rec.from === undefined ? "current" : rec.from;
    if (from !== "current" && from !== "request") throw new Error(MSG.cfgValueFromBad(where, JSON.stringify(v)));
    return; // 效应过滤逐个体求值，current 合法
  }
  if (rec.from === "identity") return;
  throw new Error(MSG.cfgValueUnknown(where, JSON.stringify(v)));
}

/** 过滤树里每个属性条件的操作数逐个核对。 */
export function checkFilterOperands(filter: Record<string, unknown>, where: string): void {
  walkFilter(null, "", filter, {
    prop: (_cls, key, v) => checkOperand(v, `${where} 的 ${key}`),
  });
}
