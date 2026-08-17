// 元数据库测试 —— 九张表的读写与重启不丢。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshMetaStore, type MetaStore } from "../lib/meta/store";

let tmp: string;
let store: MetaStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ontos-meta-"));
  store = freshMetaStore(join(tmp, "meta.db"));
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("元数据库", () => {
  it("连接：保存/更新/列表/删除", () => {
    store.saveConnection({ name: "purchase_sys", type: "mysql", host: "127.0.0.1", port: 3306, db_name: "purchase", ro_user: "ro" });
    store.saveConnection({ name: "device_sys", type: "pg", host: "127.0.0.1", port: 5432, db_name: "device" });
    expect(store.listConnections().length).toBe(2);
    store.saveConnection({ name: "purchase_sys", type: "mysql", host: "10.0.0.1", port: 3306, db_name: "purchase" }); // 同名更新
    const list = store.listConnections();
    expect(list.length).toBe(2);
    expect(list.find((c) => c.name === "purchase_sys")?.host).toBe("10.0.0.1");
    store.deleteConnection("device_sys");
    expect(store.listConnections().length).toBe(1);
  });

  it("裁决留痕与交集计数：写入可读，交集只存计数", () => {
    store.recordDecision({
      class_a: "在途设备", class_b: "在役设备", source_a: "purchase", source_b: "device",
      llm_advice: "倾向阶段：字段高度重合，设备侧多状态/启用日", rate: 0.33,
      evidence: { norm_rule: "serial", sample_a: 121, sample_b: 100, hit: 40 },
      verdict: "阶段", decided_by: "demo",
    });
    const list = store.listDecisions();
    expect(list.length).toBe(1);
    expect(list[0].verdict).toBe("阶段");
    store.recordOverlap({ class_a: "a", class_b: "b", norm_rule: "serial", count_a: 121, count_b: 100, count_hit: 40, rate: 40 / 121 });
    // 没有存任何序列号值——表结构里只有计数列
    const cols = (store as never as { db: { prepare(s: string): { all(): unknown[] } } }).db.prepare(`PRAGMA table_info(adj_overlap)`).all() as { name: string }[];
    expect(cols.map((c) => c.name).join(",")).not.toContain("values");
  });

  it("验收问题集：增删、状态随版本更新", () => {
    store.addQuestion("在役设备及其所属部门");
    store.addQuestion("现在还有多少在途设备");
    const [q1] = store.listQuestions();
    expect(q1.status).toBe("未跑");
    store.setQuestionStatus(q1.id, "通过", 2);
    expect(store.listQuestions()[0].status).toBe("通过");
    expect(store.listQuestions()[0].version).toBe(2);
    store.removeQuestion(q1.id);
    expect(store.listQuestions().length).toBe(1);
  });

  it("问数 API 台账：命名保存、同名更新、删除", () => {
    store.saveQueryApi("在役设备", "在役设备及其所属部门", '{"object":"equipment"}');
    store.saveQueryApi("在役设备", "在役设备及部门（改）", '{"object":"equipment","v":2}');
    const list = store.listQueryApis();
    expect(list.length).toBe(1);
    expect(list[0].question).toContain("改");
    store.deleteQueryApi(list[0].id);
    expect(store.listQueryApis().length).toBe(0);
  });

  it("日志：写读往返；不存结果集", () => {
    store.logQuery({ question: "在役设备", query_json: "{}", row_count: 97, ok: true, duration_ms: 12 });
    store.logAction({ action: "convert", object_type: "equipment", subject: "SN-40217", projections: [{ source: "device", ok: true }], ok: true });
    expect(store.listQueryLogs().length).toBe(1);
    expect(store.listActionLogs().length).toBe(1);
    const cols = (store as never as { db: { prepare(s: string): { all(): unknown[] } } }).db.prepare(`PRAGMA table_info(log_query)`).all() as { name: string }[];
    expect(cols.map((c) => c.name)).not.toContain("rows"); // 不存结果集
  });

  it("重启不丢：关掉重开同一文件，数据还在", () => {
    store.saveConnection({ name: "purchase_sys", type: "mysql", host: "h", port: 1 });
    store.close();
    const reopened = freshMetaStore(join(tmp, "meta.db"));
    expect(reopened.listConnections().length).toBe(1);
    reopened.close();
    store = freshMetaStore(join(tmp, "meta.db")); // afterEach 的 close 用
  });
});
