// 元数据库测试 —— 共享库 + workspace_id 的读写与重启不丢。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshMetaStore, type MetaStore } from "../server/meta/store";

let tmp: string;
let store: MetaStore;
const WS = "default";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ontos-meta-"));
  store = freshMetaStore(join(tmp, "meta.db"));
});

afterEach(async () => {
  await store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("元数据库", () => {
  it("连接：保存/更新/列表/删除", async () => {
    await store.saveConnection(WS, { name: "purchase_sys", type: "mysql", host: "127.0.0.1", port: 3306, db_name: "purchase", ro_user: "ro" });
    await store.saveConnection(WS, { name: "device_sys", type: "pg", host: "127.0.0.1", port: 5432, db_name: "device" });
    expect((await store.listConnections(WS)).length).toBe(2);
    await store.saveConnection(WS, { name: "purchase_sys", type: "mysql", host: "10.0.0.1", port: 3306, db_name: "purchase" }); // 同名更新
    const list = await store.listConnections(WS);
    expect(list.length).toBe(2);
    expect(list.find((c) => c.name === "purchase_sys")?.host).toBe("10.0.0.1");
    await store.deleteConnection(WS, "device_sys");
    expect((await store.listConnections(WS)).length).toBe(1);
  });

  it("裁决留痕与交集计数：写入可读，交集只存计数", async () => {
    await store.recordDecision(WS, {
      class_a: "在途设备", class_b: "在役设备", source_a: "purchase", source_b: "device",
      llm_advice: "倾向阶段：字段高度重合，设备侧多状态/启用日", rate: 0.33,
      evidence: { norm_rule: "serial", sample_a: 121, sample_b: 100, hit: 40 },
      verdict: "阶段", decided_by: "demo",
    });
    const list = await store.listDecisions(WS);
    expect(list.length).toBe(1);
    expect(list[0].verdict).toBe("阶段");
    await store.recordOverlap(WS, { class_a: "a", class_b: "b", norm_rule: "serial", count_a: 121, count_b: 100, count_hit: 40, rate: 40 / 121 });
    const overlaps = await store.listOverlaps(WS);
    expect(overlaps.length).toBe(1);
    // 只落计数：行里没有任何值集合字段
    expect(Object.keys(overlaps[0]).every((k) => !/value|set|ids/i.test(k))).toBe(true);
  });

  it("验收问题集：增删、状态随版本更新", async () => {
    await store.addQuestion(WS, "在役设备及其所属部门");
    await store.addQuestion(WS, "现在还有多少在途设备");
    const [q1] = await store.listQuestions(WS);
    expect(q1.status).toBe("未跑");
    await store.setQuestionStatus(WS, q1.id, "通过", 2);
    expect((await store.listQuestions(WS))[0].status).toBe("通过");
    expect((await store.listQuestions(WS))[0].version).toBe(2);
    await store.removeQuestion(WS, q1.id);
    expect((await store.listQuestions(WS)).length).toBe(1);
  });

  it("问数 API 台账：命名保存、同名更新、删除", async () => {
    await store.saveQueryApi(WS, "在役设备", "在役设备及其所属部门", '{"object":"equipment"}');
    await store.saveQueryApi(WS, "在役设备", "在役设备及部门（改）", '{"object":"equipment","v":2}');
    const list = await store.listQueryApis(WS);
    expect(list.length).toBe(1);
    expect(list[0].question).toContain("改");
    await store.deleteQueryApi(WS, list[0].id);
    expect((await store.listQueryApis(WS)).length).toBe(0);
  });

  it("日志：写读往返；不存结果集", async () => {
    await store.logQuery(WS, { question: "在役设备", query_json: "{}", row_count: 97, ok: true, duration_ms: 12 });
    await store.logAction(WS, { action: "convert", object_type: "equipment", subject: "SN-40217", projections: [{ source: "device", ok: true }], ok: true });
    expect((await store.listQueryLogs(WS)).length).toBe(1);
    expect((await store.listActionLogs(WS)).length).toBe(1);
  });

  it("重启不丢：关掉重开同一文件，数据还在", async () => {
    await store.saveConnection(WS, { name: "purchase_sys", type: "mysql", host: "h", port: 1 });
    await store.close();
    const reopened = freshMetaStore(join(tmp, "meta.db"));
    expect((await reopened.listConnections(WS)).length).toBe(1);
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
