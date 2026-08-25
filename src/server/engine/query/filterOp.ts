// 过滤运算符表 —— 内存比较与下推编成 Condition 的唯一出处。
// SQL 文本仍由 driver 按 Condition 渲染（方言接缝）；「空=至今」的运算符名单在 schema/config（单源），这里只消费。
// 运算符块判定 isOpObject 在 schema/spec/filterSpec（单源，此处再导出只是迁就既有消费方，不另写判定）。

import { treatsExpectedNullAsUntilNow, treatsNullAsUntilNow } from "../../schema/config";
import { isOpObject } from "../../schema/spec/filterSpec";
import type { Condition, CondOp } from "../infra/driver";
import { MSG } from "../../errors";

export { isOpObject };

const num = (v: unknown) => typeof v === "number";

/** 单个运算符在内存里是否成立。actual 为 undefined（没有这个值）一律不成立。
 *  dateLike 时 null 按「空=至今」：actual 为空时 gt/gte 成立；expected 为空时 lt/lte 成立。 */
export function compare(actual: unknown, op: string, expected: unknown, dateLike: boolean): boolean {
  if (actual === undefined) return false;
  if (actual === null) {
    if (op === "eq") return expected === null;
    if (op === "ne") return expected !== null;
    if (dateLike && treatsNullAsUntilNow(op)) return true;
    return false;
  }
  if (expected === null) {
    if (dateLike && treatsExpectedNullAsUntilNow(op)) return true; // expected 侧与 actual 侧同一条「空=至今」，名单同出处
    if (treatsNullAsUntilNow(op)) return false;
    if (op === "ne") return true;
    return false;
  }
  switch (op) {
    case "eq": return actual === expected;
    case "ne": return actual !== expected;
    case "lt": return num(actual) && num(expected) && (actual as number) < (expected as number);
    case "lte": return num(actual) && num(expected) && (actual as number) <= (expected as number);
    case "gt": return num(actual) && num(expected) && (actual as number) > (expected as number);
    case "gte": return num(actual) && num(expected) && (actual as number) >= (expected as number);
    case "in": return Array.isArray(expected) && expected.includes(actual);
    case "contains": return String(actual).includes(String(expected));
    default: throw new Error(MSG.operatorUnknown(op));
  }
}

/** 一条已求值的运算符编成可下推 Condition。返回 null = 不下推（语义只能内存核对）。 */
export function pushCondition(column: string, op: string, expected: unknown, dateLike: boolean): Condition | null {
  if (expected === undefined) return null;
  if (expected === null) {
    if (op === "eq") return { column, op: "null" };
    if (op === "ne") return { column, op: "notnull" };
    return null; // 与 null 比大小：空按至今，下推会改变语义
  }
  return {
    column,
    op: op as CondOp,
    value: expected,
    dateLike: dateLike || undefined,
    nullLoose: dateLike && treatsNullAsUntilNow(op) ? true : undefined,
  };
}
