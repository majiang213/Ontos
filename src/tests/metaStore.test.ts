// 元数据库测试 —— 共享库 + workspace_id 的读写与重启不丢。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { freshMetaStore, type MetaStore } from "../server/meta/store";
import { Verdict } from "../server/engine/verdict";

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
  it("一次性迁移：旧双列拼工作行（draft 优先、缺键回退 layout 列）、版本表重建出可空 version、老列删除、幂等", async () => {
    // 造一座老形状的库：workspace 带 layout/draft_json；version 表 version NOT NULL + revert_of
    const legacy = join(tmp, "legacy.db");
    const db = new DatabaseSync(legacy);
    db.exec(`
      CREATE TABLE onto_workspace (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, seed_from TEXT, layout TEXT, draft_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE onto_version (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id INTEGER NOT NULL, version INTEGER NOT NULL, yaml TEXT NOT NULL, canvas_json TEXT, origin TEXT NOT NULL DEFAULT 'publish', revert_of INTEGER, note TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (workspace_id, version));
      INSERT INTO onto_workspace (name, layout, draft_json) VALUES
        ('dirty_ws', '{"nodes":{"equipment":{"x":1,"y":2}},"edges":{},"pins":{}}', '{"config":{"object_types":{"vendor":{"kind":"thing","properties":{}}}},"layout":{"equipment":{"x":9,"y":9}}}'),
        ('fallback_ws', '{"nodes":{"equipment":{"x":1,"y":2}},"edges":{"holds":{"dx":3,"dy":4}},"pins":{}}', '{"config":{"object_types":{"vendor":{"kind":"thing","properties":{}}}}}'),
        ('clean_ws', '{"nodes":{"equipment":{"x":5,"y":6}},"edges":{},"pins":{}}', NULL);
      INSERT INTO onto_version (workspace_id, version, yaml, origin) VALUES (1, 1, 'object_types: {}', 'publish'), (2, 1, 'object_types: {}', 'publish'), (3, 1, 'object_types: {}', 'publish');
    `);
    db.close();

    const migrated = freshMetaStore(legacy);
    // 草稿本体进工作行；draft 里有 layout 时 draft 优先
    const p1 = (await migrated.getWorkingPack("dirty_ws")) as { config: { object_types: Record<string, unknown> }; layout: Record<string, { x: number; y: number }> };
    expect(p1.config.object_types.vendor).toBeDefined();
    expect(p1.layout.equipment).toEqual({ x: 9, y: 9 });
    // draft 缺界面状态键：回退到 layout 列
    const p2 = (await migrated.getWorkingPack("fallback_ws")) as { layout: Record<string, unknown>; edgeBends: Record<string, { dx: number; dy: number }> };
    expect(p2.layout.equipment).toEqual({ x: 1, y: 2 });
    expect(p2.edgeBends.holds).toEqual({ dx: 3, dy: 4 });
    // 只存过摆位（无草稿）的空间：也造工作行，pack 不带 config（本体由 getDraft 用已发布补上）
    const p3 = (await migrated.getWorkingPack("clean_ws")) as { config?: unknown; layout: Record<string, { x: number; y: number }> };
    expect(p3.config).toBeUndefined();
    expect(p3.layout.equipment).toEqual({ x: 5, y: 6 });
    // 版本表重建：version 可空、revert_of 没了；编号行还在
    const vcols = new DatabaseSync(legacy).prepare(`PRAGMA table_info(onto_version)`).all() as { name: string; notnull: number }[];
    expect(vcols.find((c) => c.name === "version")?.notnull).toBe(0);
    expect(vcols.some((c) => c.name === "revert_of")).toBe(false);
    expect((await migrated.listVersions("dirty_ws")).map((v) => v.version)).toEqual([1]); // 工作行不进版本列表
    // 老列删了
    const wcols = (new DatabaseSync(legacy).prepare(`PRAGMA table_info(onto_workspace)`).all() as { name: string }[]).map((c) => c.name);
    expect(wcols).not.toContain("layout");
    expect(wcols).not.toContain("draft_json");
    await migrated.close();
    // 幂等：再开一次不重复造工作行、不炸
    const again = freshMetaStore(legacy);
    expect(JSON.stringify(await again.getWorkingPack("dirty_ws"))).toContain("vendor");
    await again.close();
  });

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
      verdict: Verdict.Stage, decided_by: "demo",
    });
    const list = await store.listDecisions(WS);
    expect(list.length).toBe(1);
    expect(list[0].verdict).toBe(Verdict.Stage);
    await store.recordOverlap(WS, { class_a: "a", class_b: "b", norm_rule: "serial", count_a: 121, count_b: 100, count_hit: 40, rate: 40 / 121 });
    const overlaps = await store.listOverlaps(WS);
    expect(overlaps.length).toBe(1);
    // 只落计数：行里没有任何值集合字段
    expect(Object.keys(overlaps[0]).every((k) => !/value|set|ids/i.test(k))).toBe(true);
  });

  it("验收问题集：增删、状态随版本更新、失败原因落 detail", async () => {
    await store.addQuestion(WS, "在役设备及其所属部门");
    await store.addQuestion(WS, "现在还有多少在途设备");
    const [q1] = await store.listQuestions(WS);
    expect(q1.status).toBe("未跑");
    await store.setQuestionStatus(WS, q1.id, "通过", 2);
    expect((await store.listQuestions(WS))[0].status).toBe("通过");
    expect((await store.listQuestions(WS))[0].version).toBe(2);
    // 失败原因落库；下次通过时清掉
    await store.setQuestionStatus(WS, q1.id, "答案不符", 3, "期望 1 行，实得 81 行");
    expect((await store.listQuestions(WS))[0].detail).toBe("期望 1 行，实得 81 行");
    await store.setQuestionStatus(WS, q1.id, "通过", 4);
    expect((await store.listQuestions(WS))[0].detail).toBeNull();
    await store.removeQuestion(WS, q1.id);
    expect((await store.listQuestions(WS)).length).toBe(1);
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
