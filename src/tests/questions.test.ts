// 验收问题集引擎层测试：期望写法解析/比对（纯函数）+ 失败分阶段（假槽位注入，真跑 runQuestions）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkExpected, parseExpected, runQuestions, EXPECTED_HINT } from "../server/engine/query/questions";
import type { LlmSlot } from "../server/engine/llmSlot";
import { cleanupRuntime, setupRuntime } from "./helpers";

describe("期望结果写法", () => {
  it("解析：留空 / 纯数字 / 字段=值；不认识的写法返回 null", () => {
    expect(parseExpected(undefined)).toEqual({ kind: "any" });
    expect(parseExpected("  ")).toEqual({ kind: "any" });
    expect(parseExpected("81")).toEqual({ kind: "rows", n: 81 });
    expect(parseExpected("阶段=在途")).toEqual({ kind: "cell", field: "阶段", value: "在途" });
    expect(parseExpected("dept = 研发部")).toEqual({ kind: "cell", field: "dept", value: "研发部" }); // 等号两边空白容忍
    expect(parseExpected("大概 3 行吧")).toBeNull();
    expect(parseExpected("=在途")).toBeNull(); // 字段空
    expect(parseExpected("阶段=")).toBeNull(); // 值空
  });

  it("比对：行数、字段=值（数字值按字符串比）、不符给白话原因", () => {
    const rows = [{ status: "在途", n: 3 }, { status: "在役", n: 4 }];
    expect(checkExpected(undefined, rows)).toBeNull(); // 留空：能查出就算过
    expect(checkExpected("2", rows)).toBeNull();
    expect(checkExpected("3", rows)).toBe("期望 3 行，实得 2 行");
    expect(checkExpected("status=在途", rows)).toBeNull();
    expect(checkExpected("n=3", rows)).toBeNull(); // 数字 3 对得上字符串 "3"
    expect(checkExpected("status=报废", rows)).toContain("没有一行的「status」等于「报废」");
    expect(checkExpected("乱写的", rows)).toBe(EXPECTED_HINT);
  });
});

describe("跑批失败分阶段（假槽位）", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await setupRuntime("ontos-qeng-");
  });
  afterEach(async () => {
    await cleanupRuntime(tmp);
  });

  const fakeSlot = (nlToQuery: LlmSlot["nlToQuery"]): LlmSlot => ({
    name: "fake-测试",
    nlToQuery,
    proposeObjects: async () => ({}),
    proposePairs: async () => [],
  });

  it("模型没产出记编译失败；查询过不了引擎记执行出错；原因都落库", async () => {
    const meta = (await import("../server/meta/store")).metaStore();
    await meta.addQuestion("test", "模型答不上来的问题");
    await meta.addQuestion("test", "查了不存在的类");
    const [q1, q2] = await meta.listQuestions("test");

    // 编译失败：槽位直接抛错
    const r1 = await runQuestions("test", { onlyId: q1.id, slot: fakeSlot(async () => { throw new Error("模型没输出合法 JSON"); }) });
    expect(r1.results[0].status).toBe("编译失败");
    expect(r1.results[0].detail).toContain("模型没输出合法 JSON");

    // 执行出错：编译产物合法，但查的类不存在（本体/映射的锅）
    const r2 = await runQuestions("test", { onlyId: q2.id, slot: fakeSlot(async () => ({ object: "ghost" }) as never) });
    expect(r2.results[0].status).toBe("执行出错");
    expect(r2.results[0].detail).toBeTruthy();

    const stored = await meta.listQuestions("test");
    expect(stored.find((q) => q.id === q1.id)?.status).toBe("编译失败");
    expect(stored.find((q) => q.id === q1.id)?.detail).toContain("模型没输出合法 JSON");
    expect(stored.find((q) => q.id === q2.id)?.status).toBe("执行出错");
    expect(stored.every((q) => q.version === 1)).toBe(true); // 版本一并落上
  });
});
