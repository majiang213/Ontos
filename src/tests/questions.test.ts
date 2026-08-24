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

describe("验收问题集跑批（真路由）", () => {
  // 直接打 POST /api/questions?run=1，不在测试里重实现跑批；与仓库运行态隔离
  let tmp: string;
  beforeEach(async () => {
    tmp = await setupRuntime("ontos-q-");
  });
  afterEach(async () => {
    await cleanupRuntime(tmp);
  });

  it("期望行数对上记通过、对不上记答案不符；失败明细落库，版本落上", async () => {
    const meta = (await import("../server/meta/store")).metaStore();
    const { POST } = await import("../app/api/questions/route");
    await meta.addQuestion("test", "在役设备及其所属部门", "97"); // 种子恰有 97 台在役
    await meta.addQuestion("test", "还有多少在途设备", "1"); // 故意答错（实际 81）
    const res = await POST(new Request("http://x/api/questions?ws=test&run=1", { method: "POST" }) as never);
    const data = await res.json();
    const pass = data.results.find((r: { question: string }) => r.question === "在役设备及其所属部门");
    const fail = data.results.find((r: { question: string }) => r.question === "还有多少在途设备");
    expect(pass.status).toBe("通过");
    expect(fail.status).toBe("答案不符");
    expect(fail.detail).toContain("期望 1 行");
    // 状态、明细与版本落库
    const stored = await meta.listQuestions("test");
    expect(stored.find((q) => q.question === "在役设备及其所属部门")?.status).toBe("通过");
    expect(stored.find((q) => q.question === "还有多少在途设备")?.detail).toContain("实得 81 行");
    expect(stored.every((q) => q.version === 1)).toBe(true);
  });

  it("期望写 字段=值：结果里至少一行对上记通过，对不上记答案不符", async () => {
    const meta = (await import("../server/meta/store")).metaStore();
    const { POST } = await import("../app/api/questions/route");
    await meta.addQuestion("test", "还有多少在途设备", "serial_no=SN-40217"); // 在途里有这台
    await meta.addQuestion("test", "有多少报废设备", "serial_no=SN-40217"); // 报废里没有这台
    const res = await POST(new Request("http://x/api/questions?ws=test&run=1", { method: "POST" }) as never);
    const data = await res.json();
    const hit = data.results.find((r: { question: string }) => r.question === "还有多少在途设备");
    const miss = data.results.find((r: { question: string }) => r.question === "有多少报废设备");
    expect(hit.status).toBe("通过");
    expect(miss.status).toBe("答案不符");
    expect(miss.detail).toContain("serial_no");
    expect(miss.detail).toContain("SN-40217");
  });

  it("body 给 { id } 只跑那一条；GET 列表带当前已发布版本", async () => {
    const meta = (await import("../server/meta/store")).metaStore();
    const { GET, POST } = await import("../app/api/questions/route");
    await meta.addQuestion("test", "还有多少在途设备", "81");
    await meta.addQuestion("test", "在役设备及其所属部门", "97");
    const [q1, q2] = await meta.listQuestions("test");
    const res = await POST(
      new Request("http://x/api/questions?ws=test&run=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: q1.id }) }) as never
    );
    const data = await res.json();
    expect(data.results.length).toBe(1);
    expect(data.results[0].status).toBe("通过");
    const stored = await meta.listQuestions("test");
    expect(stored.find((q) => q.id === q1.id)?.status).toBe("通过");
    expect(stored.find((q) => q.id === q2.id)?.status).toBe("未跑"); // 没跑到的那条不动
    // 不存在的 id → 400
    const bad = await POST(
      new Request("http://x/api/questions?ws=test&run=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: 9999 }) }) as never
    );
    expect(bad.status).toBe(400);
    // GET 带当前已发布版本，界面据此标「待重跑」
    const list = await (await GET(new Request("http://x/api/questions?ws=test") as never)).json();
    expect(list.version).toBe(1);
  });

  it("对草稿试跑：用草稿的配置，不落验收记录；已发布跑批不受影响", async () => {
    const meta = (await import("../server/meta/store")).metaStore();
    const s = await import("../server/engine/draft");
    const { POST } = await import("../app/api/questions/route");
    await meta.addQuestion("test", "在役设备及其所属部门", "97"); // 种子恰有 97 台在役
    await meta.addQuestion("test", "有过保的设备吗", "1");
    // 草稿里删掉派生属性 in_warranty（无引用可删）；已发布里它还在
    await s.editDraft({ op: "remove_property", object: "equipment", name: "in_warranty" }, "test");
    // 草稿试跑：在役照过；过保这条在草稿里找不到 in_warranty，执行出错
    const dres = await POST(new Request("http://x/api/questions?ws=test&run=1&target=draft", { method: "POST" }) as never);
    const ddata = await dres.json();
    expect(ddata.version).toBeNull();
    expect(ddata.results.find((r: { question: string }) => r.question === "在役设备及其所属部门").status).toBe("通过");
    expect(ddata.results.find((r: { question: string }) => r.question === "有过保的设备吗").status).toBe("执行出错");
    // 不落库：两条仍是「未跑」
    expect((await meta.listQuestions("test")).every((q) => q.status === "未跑")).toBe(true);
    // 已发布跑批：in_warranty 还在，过保这条正常执行；状态与版本落库
    const pres = await POST(new Request("http://x/api/questions?ws=test&run=1", { method: "POST" }) as never);
    const pdata = await pres.json();
    expect(pdata.results.find((r: { question: string }) => r.question === "有过保的设备吗").status).not.toBe("执行出错");
    expect((await meta.listQuestions("test")).every((q) => q.version === 1)).toBe(true);
  });

  it("期望写法不认识：新增时直接 400，白话提示", async () => {
    const { POST } = await import("../app/api/questions/route");
    const res = await POST(
      new Request("http://x/api/questions?ws=test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "随便问问", expected: "大概 3 行吧" }),
      }) as never
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("纯数字");
  });
});
