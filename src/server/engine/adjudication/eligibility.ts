// 候选对资格 —— 「什么算疑似重复」的唯一出处（《ontos-article.md》§3.2）。
// 列表（candidates）/ 交集率（overlap）/ 定案（decide）共用同一套谓词，路由不再各自写闸。
// 资格 = 两边有源 ∧ 无共同连接 ∧ 未定案；定案侧对同源对放行两个不动配置的结论（各自独立语义）。

import type { ObjectType } from "../../schema/config";
import { Verdict } from "./verdict";

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

/** 无共同连接：疑似重复只对跨源候选有意义。 */
export function isCrossSource(a: ObjectType, b: ObjectType): boolean {
  const conns = connectionsOf(b);
  return ![...connectionsOf(a)].some((c) => conns.has(c));
}

/** 列表侧资格（candidates）：有源 ∧ 跨源 ∧ 未定案。decidedKeys 用 pairKey 构造。 */
export function pairEligible(a: ObjectType, b: ObjectType, decidedKeys: Set<string>, nameA: string, nameB: string): boolean {
  return hasSources(a) && hasSources(b) && isCrossSource(a, b) && !decidedKeys.has(pairKey(nameA, nameB));
}

/** 同源对也允许裁的结论：两个都是「各自独立」语义，不动配置，所以不设跨源闸。 */
export const SAME_SOURCE_OK_VERDICTS = new Set<Verdict>([Verdict.NameSimilar, Verdict.Skip]);

/** 同源对的拒绝文案（交集率与定案共用）：资格谓词的文案与谓词同住。 */
export function sharedSourcesMsg(a: ObjectType, b: ObjectType): string {
  const shared = [...connectionsOf(a)].filter((c) => connectionsOf(b).has(c));
  return `这两个对象有共同来源（${shared.join("、")}），不算疑似重复`;
}
