// 元数据库测试 —— 共享库 + workspace_id 的读写与重启不丢。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { freshMetaStore, type MetaStore } from "../server/meta/store";
import { Verdict } from "../server/schema/verdict";

let tmp: string;
let store: MetaStore;
const WORKSPACE = "default";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ontos-meta-"));
  store = freshMetaStore(join(tmp, "meta.db"));
});

afterEach(async () => {
  await store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("元数据库", () => {
  it("交集按对一行：并发 recordOverlap 同对 10 次，库里恰一行且是最后一写", async () => {
    // 并发竞态回归：旧形态 DELETE+INSERT 两条，并发重算同一对会双行并存
    const o = { class_a: "eq_a", class_b: "eq_b", source_a: "s1", source_b: "s2" };
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.recordOverlap(WORKSPACE, { ...o, norm_rule: "raw", count_a: 10 + i, count_b: 20, count_hit: i, rate: i / 20 })));
    const rows = await store.listOverlaps(WORKSPACE);
    const pair = rows.filter((r) => r.class_a === "eq_a" && r.class_b === "eq_b");
    expect(pair.length).toBe(1);
    expect(pair[0].count_hit).toBe(9); // 最后一写赢（sqlite 同步驱动下 Promise.all 按发起序落库）
  });

  it("连接：保存/更新/列表/删除", async () => {
    await store.saveConnection(WORKSPACE, { name: "purchase_sys", type: "mysql", host: "127.0.0.1", port: 3306, db_name: "purchase", ro_user: "ro" });
    await store.saveConnection(WORKSPACE, { name: "device_sys", type: "pg", host: "127.0.0.1", port: 5432, db_name: "device" });
    expect((await store.listConnections(WORKSPACE)).length).toBe(2);
    await store.saveConnection(WORKSPACE, { name: "purchase_sys", type: "mysql", host: "10.0.0.1", port: 3306, db_name: "purchase" }); // 同名更新
    const list = await store.listConnections(WORKSPACE);
    expect(list.length).toBe(2);
    expect(list.find((c) => c.name === "purchase_sys")?.host).toBe("10.0.0.1");
    await store.deleteConnection(WORKSPACE, "device_sys");
    expect((await store.listConnections(WORKSPACE)).length).toBe(1);
  });

  it("裁决留痕与交集计数：写入可读，交集只存计数", async () => {
    await store.recordDecision(WORKSPACE, {
      class_a: "在途设备", class_b: "在役设备", source_a: "purchase", source_b: "device",
      llm_advice: "倾向阶段：字段高度重合，设备侧多状态/启用日", rate: 0.33,
      evidence: { norm_rule: "serial", sample_a: 121, sample_b: 100, hit: 40 },
      verdict: Verdict.Stage, decided_by: "demo",
    });
    const list = await store.listDecisions(WORKSPACE);
    expect(list.length).toBe(1);
    expect(list[0].verdict).toBe(Verdict.Stage);
    await store.recordOverlap(WORKSPACE, { class_a: "a", class_b: "b", norm_rule: "serial", count_a: 121, count_b: 100, count_hit: 40, rate: 40 / 121 });
    const overlaps = await store.listOverlaps(WORKSPACE);
    expect(overlaps.length).toBe(1);
    // 只落计数：行里没有任何值集合字段
    expect(Object.keys(overlaps[0]).every((k) => !/value|set|ids/i.test(k))).toBe(true);
  });

  it("验收问题集：增删、状态随版本更新、失败原因落 detail", async () => {
    await store.addQuestion(WORKSPACE, "在役设备及其所属部门");
    await store.addQuestion(WORKSPACE, "现在还有多少在途设备");
    const [q1] = await store.listQuestions(WORKSPACE);
    expect(q1.status).toBe("未跑");
    await store.setQuestionStatus(WORKSPACE, q1.id, "通过", 2);
    expect((await store.listQuestions(WORKSPACE))[0].status).toBe("通过");
    expect((await store.listQuestions(WORKSPACE))[0].version).toBe(2);
    // 失败原因落库；下次通过时清掉
    await store.setQuestionStatus(WORKSPACE, q1.id, "答案不符", 3, "期望 1 行，实得 81 行");
    expect((await store.listQuestions(WORKSPACE))[0].detail).toBe("期望 1 行，实得 81 行");
    await store.setQuestionStatus(WORKSPACE, q1.id, "通过", 4);
    expect((await store.listQuestions(WORKSPACE))[0].detail).toBeNull();
    await store.removeQuestion(WORKSPACE, q1.id);
    expect((await store.listQuestions(WORKSPACE)).length).toBe(1);
  });

  it("日志：写读往返；不存结果集", async () => {
    await store.logQuery(WORKSPACE, { question: "在役设备", query_json: "{}", row_count: 97, ok: true, duration_ms: 12 });
    await store.logAction(WORKSPACE, { action: "convert", object_type: "equipment", subject: "SN-40217", projections: [{ source: "device", ok: true }], ok: true });
    expect((await store.listQueryLogs(WORKSPACE)).length).toBe(1);
    expect((await store.listActionLogs(WORKSPACE)).length).toBe(1);
  });

  it("重启不丢：关掉重开同一文件，数据还在", async () => {
    await store.saveConnection(WORKSPACE, { name: "purchase_sys", type: "mysql", host: "h", port: 1 });
    await store.close();
    const reopened = freshMetaStore(join(tmp, "meta.db"));
    expect((await reopened.listConnections(WORKSPACE)).length).toBe(1);
    await reopened.close();
    store = freshMetaStore(join(tmp, "meta.db")); // afterEach 的 close 用
  });

  it("workspace_id 隔离：两个空间的同一张表互不可见", async () => {
    await store.saveConnection("default", { name: "a_sys", type: "mysql", host: "h", port: 1 });
    await store.saveConnection("lab", { name: "b_sys", type: "mysql", host: "h", port: 2 });
    expect((await store.listConnections("default")).map((c) => c.name)).toEqual(["a_sys"]);
    expect((await store.listConnections("lab")).map((c) => c.name)).toEqual(["b_sys"]);
  });
});
