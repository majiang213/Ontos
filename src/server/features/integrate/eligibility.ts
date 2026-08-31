// 候选对资格 —— 「什么算疑似重复」的唯一出处（《ontos-article.md》§3.2）。
// 列表（candidates）/ 交集率（overlap）/ 定案（decide）共用同一套谓词，路由不再各自写闸。
// 资格 = 两边有源 ∧ 未定案。同一连接上的两张表也可以比（候选人表 vs 员工表）。共用连接不是否决。

import type { ObjectType } from "../../schema/config";

/** 类的连接集合（无源 = 空集）。 */
export function connectionsOf(t: ObjectType): Set<string> {
  return new Set(Object.values(t.sources ?? {}).map((s) => s.connection));
}

/** 成对键（无序）：查重与留痕共用同一构造。 */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

/** 两边都有源：无源的手工对象不进裁决。 */
export function hasSources(t: ObjectType): boolean {
  return Object.keys(t.sources ?? {}).length > 0;
}

/** 列表侧资格（candidates）：有源 ∧ 未定案。同一库两张表也成对。decidedKeys 用 pairKey 构造。 */
export function pairEligible(a: ObjectType, b: ObjectType, decidedKeys: Set<string>, nameA: string, nameB: string): boolean {
  return hasSources(a) && hasSources(b) && !decidedKeys.has(pairKey(nameA, nameB));
}


