// 过滤运算符表：内存比较与下推编成 Condition 走同一张表。

import { describe, expect, it } from "vitest";
import { compare, isOpObject, pushCondition, treatsNullAsUntilNow } from "../server/engine/query/filterOp";
import { buildSelect } from "../server/engine/infra/driver";

describe("compare：空=至今", () => {
  it("date 实际为空：gt/gte 成立，lt 不成立", () => {
    expect(compare(null, "gte", 100, true)).toBe(true);
    expect(compare(null, "gt", 100, true)).toBe(true);
    expect(compare(null, "lt", 100, true)).toBe(false);
    expect(compare(null, "eq", null, true)).toBe(true);
  });

  it("date 期望为空：lt/lte 成立，gt 不成立", () => {
    expect(compare(50, "lte", null, true)).toBe(true);
    expect(compare(50, "lt", null, true)).toBe(true);
    expect(compare(50, "gte", null, true)).toBe(false);
  });

  it("非 date 的 null 不按至今", () => {
    expect(compare(null, "gte", 100, false)).toBe(false);
    expect(compare(50, "lte", null, false)).toBe(false);
  });
});

describe("pushCondition：与 compare 同一张表", () => {
  it("eq null → IS NULL；ne null → IS NOT NULL；比大小不下推", () => {
    expect(pushCondition("c", "eq", null, true)).toEqual({ column: "c", op: "null" });
    expect(pushCondition("c", "ne", null, true)).toEqual({ column: "c", op: "notnull" });
    expect(pushCondition("c", "gte", null, true)).toBeNull();
    expect(pushCondition("c", "lt", null, true)).toBeNull();
  });

  it("date 的 gt/gte 才带 nullLoose；lt 不带", () => {
    expect(pushCondition("valid_to", "gte", 100, true)).toEqual({
      column: "valid_to",
      op: "gte",
      value: 100,
      dateLike: true,
      nullLoose: true,
    });
    expect(pushCondition("valid_to", "lt", 100, true)).toEqual({
      column: "valid_to",
      op: "lt",
      value: 100,
      dateLike: true,
    });
    expect(pushCondition("qty", "gte", 100, false)).toEqual({ column: "qty", op: "gte", value: 100 });
  });

  it("undefined 不下推", () => {
    expect(pushCondition("c", "eq", undefined, false)).toBeNull();
  });
});

describe("SQL 渲染读同一张表", () => {
  it("nullLoose 且 treatsNullAsUntilNow 才 OR IS NULL", () => {
    expect(treatsNullAsUntilNow("gte")).toBe(true);
    expect(treatsNullAsUntilNow("lt")).toBe(false);
    const gte = pushCondition("valid_to", "gte", 100, true)!;
    const sql = buildSelect("t", [], [gte], "pg");
    expect(sql.sql).toContain(`OR "valid_to" IS NULL`);
    const lt = pushCondition("valid_to", "lt", 100, true)!;
    expect(buildSelect("t", [], [lt], "pg").sql).not.toContain("IS NULL");
  });
});

describe("isOpObject", () => {
  it("运算符块才是；裸 { property, from } 不是", () => {
    expect(isOpObject({ gte: 1, lte: 2 })).toBe(true);
    expect(isOpObject({ property: "dept", from: "current" })).toBe(false);
    expect(isOpObject(null)).toBe(false);
  });
});
