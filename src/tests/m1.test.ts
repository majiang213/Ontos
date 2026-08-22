// M1 测试：方言 SQL 生成、驱动注册表、SQLite 文件连接、脱敏采样。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupRuntime, setupRuntime } from "./helpers";
import { buildInsert, buildSelect, buildStatement, maskValue } from "../server/engine/driver";
import "../server/engine/sqlDriver"; // 副作用导入：注册 PG 日期列的 type parser（1082/1114/1184）
import { DriverRegistry } from "../server/engine/registry";
import { SqliteFixtureDriver } from "../server/engine/fixture";

describe("方言 SQL 生成", () => {
  it("pg：占位符渲染成 $1..$n，标识符双引号", () => {
    const { sql, params } = buildSelect("device", ["name", "dept_id"], [
      { column: "dept_id", op: "eq", value: "D07" },
      { column: "status", op: "null" },
    ], "pg");
    expect(sql).toBe(`SELECT "name", "dept_id" FROM "device" WHERE "dept_id" = $1 AND "status" IS NULL`);
    expect(params).toEqual(["D07"]);
  });

  it("mysql：反引号 + ? 占位；update 的 set 在前条件在后", () => {
    const { sql, params } = buildStatement("mysql", "update", "device", {
      set: { dept_id: "D07" },
      conditions: [{ column: "serial_no", op: "eq", value: "SN-1" }],
    });
    expect(sql).toBe("UPDATE `device` SET `dept_id` = ? WHERE `serial_no` = ?");
    expect(params).toEqual(["D07", "SN-1"]);
  });

  it("pg insert：$1..$n；gt 带 OR IS NULL 只限 date（nullLoose）", () => {
    const { sql, params } = buildInsert("pg", "warranty_card", { sn: "SN-1", expiry: 123 });
    expect(sql).toBe(`INSERT INTO "warranty_card" ("sn", "expiry") VALUES ($1, $2)`);
    expect(params).toEqual(["SN-1", 123]);
    // date 属性（nullLoose）：空=至今，gt/gte 时 NULL 也算满足
    const gte = buildSelect("t", [], [{ column: "valid_to", op: "gte", value: 100, nullLoose: true }], "pg");
    expect(gte.sql).toContain(`OR "valid_to" IS NULL`);
    // 非 date 属性：没有这条宽松，NULL 不比大小
    const plain = buildSelect("t", [], [{ column: "qty", op: "gte", value: 100 }], "pg");
    expect(plain.sql).not.toContain("IS NULL");
  });

  it("contains 转义通配符；mysql 的 ESCAPE 字面量写两个反斜杠", () => {
    const { sql, params } = buildSelect("t", [], [{ column: "name", op: "contains", value: "50%" }], "mysql");
    expect(sql).toContain(`ESCAPE '\\\\'`); // SQL 文本里两个反斜杠，MySQL 解析成一个转义符
    expect(params[0]).toBe("%50\\%%");
    const pgLike = buildSelect("t", [], [{ column: "name", op: "contains", value: "50%" }], "pg");
    expect(pgLike.sql).toContain(`ESCAPE '\\'`); // pg/sqlite 一个就够
  });

  it("PG 日期列按串返回：TIMESTAMPTZ 转 ISO，DATE/TIMESTAMP 原样", async () => {
    const pg = (await import("pg")).default;
    const ts = pg.types.getTypeParser(1184)("2026-08-18 10:00:00+00");
    expect(ts).toBe("2026-08-18T10:00:00.000Z");
    expect(pg.types.getTypeParser(1082)("2026-08-18")).toBe("2026-08-18");
    expect(pg.types.getTypeParser(1114)("2026-08-18 10:00:00")).toBe("2026-08-18 10:00:00");
  });
});

describe("脱敏采样", () => {
  it("敏感列只留头尾，普通列不动", () => {
    expect(maskValue("id_card", "110101198001011234")).toBe("1101******34");
    expect(maskValue("mobile", "13800001111")).toBe("1380******11");
    expect(maskValue("name", "张三")).toBe("张三");
    expect(maskValue("sn", null)).toBe(null);
  });
});

describe("驱动注册表", () => {
  it("按连接名路由；未注册拒绝；内省与采样走通", async () => {
    const registry = new DriverRegistry();
    const fixture = SqliteFixtureDriver.seeded();
    for (const c of fixture.connections()) registry.register(c, fixture);
    const rows = await registry.select("device_sys", "department", ["dept_id", "dept_name"], []);
    expect(rows.length).toBe(8);
    await expect(registry.select("ghost", "t", [], [])).rejects.toThrow("未注册");
    const tables = await registry.introspect("device_sys");
    expect(tables.map((t) => t.name)).toContain("device");
    // 列注释随内省下發（fixture 种子手写；真库走 information_schema / col_description）
    expect(tables.find((t) => t.name === "department")?.columns.find((c) => c.name === "dept_name")?.comment).toBe("部门名称");
    const sample = await registry.sample("device_sys", "department", 3);
    expect(sample.length).toBe(3);
  });
});

describe("SQLite 文件连接（连接表单的 sqlite 类型）", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ontos-sqlite-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("文件库注册后可内省、可采样、可查；采样链路上敏感列真脱敏", async () => {
    const file = join(tmp, "ext.db");
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE meter (meter_no TEXT PRIMARY KEY, reading INTEGER, mobile TEXT)`);
    db.prepare(`INSERT INTO meter VALUES ('M-01', 42, '13800001111')`).run();
    db.close();

    const fixture = new SqliteFixtureDriver();
    fixture.registerFile("ext_sys", file);
    const registry = new DriverRegistry();
    registry.register("ext_sys", fixture);

    const tables = await registry.introspect("ext_sys");
    expect(tables.map((t) => t.name)).toEqual(["meter"]);
    expect(tables[0].columns.find((c) => c.name === "meter_no")?.pk).toBe(true);
    const rows = await registry.select("ext_sys", "meter", ["meter_no", "reading"], []);
    expect(rows).toEqual([{ meter_no: "M-01", reading: 42 }]);
    // 链路断言：mobile 是敏感列，采样回来的必须是脱敏形态而不是原文
    const sample = await registry.sample("ext_sys", "meter", 1);
    expect(sample[0].mobile).toBe("1380******11");
    expect(sample[0].meter_no).toBe("M-01");
  });
});

describe("连接生命周期", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await setupRuntime("ontos-conn-");
  });
  afterEach(async () => {
    await cleanupRuntime(tmp);
  });

  it("相对路径 sqlite 按运行态 cwd 解析并落库", async () => {
    const { saveConnection, getDriverRegistry } = await import("../server/engine/load");
    writeFileSync(join(tmp, "rel_demo.db"), "");
    const r = await saveConnection("default", { name: "rel_db", type: "sqlite", db_name: "rel_demo.db" }, false);
    expect(r.saved).toBe(true);
    const tables = await (await getDriverRegistry()).introspect("rel_db");
    expect(Array.isArray(tables)).toBe(true);
  });

  it("内置演示源不许覆盖；不在元库的删不了；已发布引用不能删", async () => {
    const { saveConnection, dropConnection } = await import("../server/engine/load");
    // 内置演示 fixture 只属于 test 空间
    await expect(saveConnection("test", { name: "device_sys", type: "mysql", host: "127.0.0.1", db_name: "x" })).rejects.toThrow(/内置演示源/);
    await expect(dropConnection("test", "device_sys")).rejects.toThrow(/内置演示源不能删/);
    await expect(dropConnection("test", "ghost")).rejects.toThrow(/连接不存在/);

    writeFileSync(join(tmp, "used.db"), "");
    await saveConnection("test", { name: "used_db", type: "sqlite", db_name: "used.db" }, false);
    const s = await import("../server/engine/configStore");
    await s.applyOp({
      op: "import_objects",
      objects: {
        gadget: {
          kind: "thing",
          identity: "no",
          properties: { no: { type: "string" } },
          sources: { s: { connection: "used_db", table: "t", pk: "id", fields: { no: "no" } } },
        },
      },
    }, "test");
    await s.publishDraft("test");
    await expect(dropConnection("test", "used_db")).rejects.toThrow(/仍被已发布本体引用/);
  });
});
