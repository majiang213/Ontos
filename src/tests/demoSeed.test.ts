// 演示播种测试（PR1）：writeDemoFiles 写出的十二个文件库 + sidecar 注释；
// 内存 seedDemo 行为不动（golden 世界）；sidecar 两条加载路径（水合宽容 / 表单严格）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupRuntime, expectRejected, setupRuntime, unwrap } from "./helpers";
import { DEMO_SYSTEMS, readSidecarComments, sidecarPathFor, writeDemoFiles } from "../server/infra/demoSystems";
import { SqliteDriver } from "../server/infra/sqliteDriver";
import { SqliteFixtureDriver } from "../server/infra/fixture";
import { DriverRegistry } from "../server/infra/registry";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ontos-seed-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** 打开一个种子文件跑一条查询并关库（测试读取的唯一收口）。 */
function queryFile<T>(file: string, sql: string, all?: boolean): T {
  const db = new DatabaseSync(file);
  try {
    const stmt = db.prepare(sql);
    return (all ? stmt.all() : stmt.get()) as T;
  } finally {
    db.close();
  }
}

const tablesOf = (file: string): { name: string; n: number }[] =>
  queryFile<{ name: string }[]>(file, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`, true)
    .map((t) => ({ name: t.name, n: queryFile<{ n: number }>(file, `SELECT COUNT(*) n FROM "${t.name}"`).n }));

describe("writeDemoFiles：十二套文件库", () => {
  it("写出 12 个 .db + 12 个 sidecar，打印字段齐全；幂等覆盖", () => {
    const files = writeDemoFiles(tmp);
    expect(files.length).toBe(12);
    expect(files.map((f) => f.title)).toEqual(["采购系统", "设备台账", "资产系统", "维修工单", "点检系统", "招聘系统", "人事系统", "办公账号", "客户档案", "销售系统", "仓库系统", "应收发票"]);
    expect(files.map((f) => f.connection)).toEqual(DEMO_SYSTEMS.map((s) => s.connection));
    for (const f of files) {
      expect(f.path).toBe(join(tmp, DEMO_SYSTEMS.find((s) => s.connection === f.connection)!.file)); // 绝对路径
      expect(readSidecarComments(f.path).kind).toBe("ok"); // sidecar 成对存在
    }
    const again = writeDemoFiles(tmp); // 幂等：重跑覆盖，行数不翻倍
    expect(tablesOf(again.find((f) => f.connection === "purchase_sys")!.path).find((t) => t.name === "po_item")?.n).toBe(121);
  });

  it("行数与表清单按走查设计：device 无 repair、hr 宽表 50、repair 15、inspect 60、po_item 121 含 SN-40217、order 25、asset 0", () => {
    const files = writeDemoFiles(tmp);
    const at = (conn: string) => files.find((f) => f.connection === conn)!.path;
    expect(tablesOf(at("device_sys")).map((t) => `${t.name}:${t.n}`)).toEqual(["assignment:1", "department:8", "device:100"]); // 没有 repair
    const hr = tablesOf(at("hr_sys"));
    expect(hr.find((t) => t.name === "person")?.n).toBe(50);
    expect(hr.find((t) => t.name === "appointment")?.n).toBe(50);
    expect(tablesOf(at("repair_sys"))).toEqual([{ name: "repair", n: 15 }]);
    expect(tablesOf(at("inspect_sys"))).toEqual([{ name: "instrument", n: 60 }]);
    expect(tablesOf(at("purchase_sys"))).toEqual([{ name: "order", n: 25 }, { name: "po_item", n: 121 }]);
    expect(tablesOf(at("asset_sys"))).toEqual([
      { name: "asset", n: 0 },
      { name: "warranty_card", n: 0 },
    ]);
    expect(tablesOf(at("recruit_sys"))).toEqual([{ name: "candidate", n: 80 }]);
    expect(tablesOf(at("oa_sys"))).toEqual([{ name: "account", n: 40 }]);
    expect(tablesOf(at("crm_sys"))).toEqual([{ name: "customer", n: 40 }]);
    expect(tablesOf(at("sales_sys"))).toEqual([
      { name: "customer", n: 40 },
      { name: "order", n: 60 },
    ]);
    expect(tablesOf(at("wms_sys"))).toEqual([{ name: "stock", n: 30 }]);
    expect(tablesOf(at("ar_sys"))).toEqual([{ name: "invoice", n: 40 }]);

    // 关键内容：人事宽表带 id_no/mobile、张三在 30 人交集里、采购主角在库
    expect(queryFile<{ name: string }[]>(at("hr_sys"), `PRAGMA table_info(person)`, true).map((c) => c.name)).toEqual(["person_no", "name", "id_no", "mobile"]);
    expect(queryFile(at("hr_sys"), `SELECT * FROM person WHERE person_no = 'P001'`)).toMatchObject({ name: "张三", id_no: "11010119900101000X" });
    expect(queryFile(at("recruit_sys"), `SELECT id_no FROM candidate WHERE candidate_no = 'C001'`)).toEqual({ id_no: "11010119900101000X" }); // 与人事张三同一身份证
    expect(queryFile<{ n: number }>(at("purchase_sys"), `SELECT COUNT(*) n FROM po_item WHERE sn = 'SN-40217'`).n).toBe(1);
  });

  it("内省文件库：列注释从 sidecar 活下来；sqlite_master 里没有注释表", async () => {
    const files = writeDemoFiles(tmp);
    const at = (conn: string) => files.find((f) => f.connection === conn)!.path;
    const d = new SqliteDriver();
    d.registerFile("purchase_sys", at("purchase_sys"));
    d.registerFile("repair_sys", at("repair_sys"));
    const po = await d.introspect("purchase_sys");
    expect(po.find((t) => t.name === "po_item")?.columns.find((c) => c.name === "sn")?.comment).toBe("设备序列号");
    expect(po.find((t) => t.name === "order")?.columns.find((c) => c.name === "supplier_name")?.comment).toBe("供应商");
    // 唯一约束随内省下发（唯一键判据的硬信号）：po_item.sn UNIQUE、order.order_no 主键即唯一
    expect(po.find((t) => t.name === "po_item")?.columns.find((c) => c.name === "sn")?.unique).toBe(true);
    expect(po.find((t) => t.name === "po_item")?.columns.find((c) => c.name === "po_id")?.unique).toBeUndefined(); // 自增主键列不被误标（唯一性只认显式唯一索引）
    expect(po.find((t) => t.name === "order")?.columns.find((c) => c.name === "order_no")?.unique).toBe(true);
    const rep = await d.introspect("repair_sys");
    expect(rep[0].columns.find((c) => c.name === "symptom")?.comment).toBe("故障现象");
    // 注释不是库里的表：sqlite_master 只有业务表（表清单断言在上面用例，这里钉「没有 _ontos_comments 这类东西」）
    expect(tablesOf(at("purchase_sys")).map((t) => t.name)).not.toContain("_ontos_comments");
    await d.close();
  });

  it("sidecar 缺失：按库文件名回退种子注释；改了文件名则不加注释", async () => {
    const files = writeDemoFiles(tmp);
    const src = files.find((f) => f.connection === "purchase_sys")!.path;
    const bareDir = mkdtempSync(join(tmpdir(), "ontos-bare-"));
    try {
      // 只拷 .db、不拷 sidecar：文件名对得上 → 注释仍在
      cpSync(src, join(bareDir, "purchase.db"));
      const d1 = new SqliteDriver();
      d1.registerFile("p1", join(bareDir, "purchase.db"));
      const t1 = await d1.introspect("p1");
      expect(t1.find((t) => t.name === "po_item")?.columns.find((c) => c.name === "sn")?.comment).toBe("设备序列号");
      await d1.close();
      // 文件名对不上 DEMO_SYSTEMS：不加注释，连接照常
      cpSync(src, join(bareDir, "renamed.db"));
      const d2 = new SqliteDriver();
      d2.registerFile("p2", join(bareDir, "renamed.db"));
      const t2 = await d2.introspect("p2");
      expect(t2.find((t) => t.name === "po_item")?.columns.every((c) => c.comment === undefined)).toBe(true);
      await d2.close();
    } finally {
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("坏 sidecar 不抛错、不加注释、不回退种子注释，也不拖垮同注册表里的好库", async () => {
    const files = writeDemoFiles(tmp);
    const at = (conn: string) => files.find((f) => f.connection === conn)!.path;
    writeFileSync(sidecarPathFor(at("repair_sys")), "{ 这不是合法 JSON"); // 损坏
    const { registerSaved } = await import("../server/infra/connections");
    const registry = new DriverRegistry();
    const rec = (name: string, p: string) => ({ name, type: "sqlite", host: "", port: 0, db_name: p, ro_user: "", ro_pass: "", rw_user: "", rw_pass: "" }) as never;
    expect(() => {
      registerSaved(registry, rec("repair_sys", at("repair_sys"))); // 坏 sidecar：仍注册
      registerSaved(registry, rec("purchase_sys", at("purchase_sys"))); // 好库不受影响
    }).not.toThrow();
    const bad = await registry.introspect("repair_sys");
    expect(bad[0].name).toBe("repair"); // 表还在
    expect(bad[0].columns.every((c) => c.comment === undefined)).toBe(true); // 只是没注释，且没拿种子注释盖坏文件
    const good = await registry.introspect("purchase_sys");
    expect(good.find((t) => t.name === "po_item")?.columns.find((c) => c.name === "sn")?.comment).toBe("设备序列号");
  });
});

describe("内存 seedDemo 不动（golden 世界）", () => {
  it("四连行数不变：po_item 121 / device 100 / asset 0 / 内存 repair 仍 2 行挂 device_sys / person 窄表张三", async () => {
    const d = SqliteFixtureDriver.seeded();
    const count = async (conn: string, table: string, pk: string) => (await d.select(conn, table, [pk], [])).length;
    expect(await count("purchase_sys", "po_item", "po_id")).toBe(121);
    expect(await count("device_sys", "device", "dev_id")).toBe(100);
    expect(await count("device_sys", "repair", "id")).toBe(2); // 内存不拆维修
    expect(await count("asset_sys", "asset", "asset_id")).toBe(0);
    expect(await count("hr_sys", "person", "person_no")).toBe(1);
    // 内存 person 仍是窄表（没有 id_no / mobile）
    const tables = await d.introspect("hr_sys");
    expect(tables.find((t) => t.name === "person")?.columns.map((c) => c.name)).toEqual(["person_no", "name"]);
    // 内存注释仍在（经 DEMO_COMMENTS 单源下发）
    const dev = await d.introspect("device_sys");
    expect(dev.find((t) => t.name === "device")?.columns.find((c) => c.name === "serial_no")?.comment).toBe("设备序列号");
    expect(dev.find((t) => t.name === "repair")?.columns.find((c) => c.name === "repair_no")?.comment).toBe("维修单号");
    await d.close();
  });
});

describe("saveConnection 的 sidecar 严路径", () => {
  let rtmp: string;
  beforeEach(async () => {
    rtmp = await setupRuntime("ontos-seedconn-");
  });
  afterEach(async () => {
    await cleanupRuntime(rtmp);
  });

  it("坏 sidecar：ConnectionReject 拒在表单，不落库；好 sidecar 照常保存", async () => {
    const { saveConnection } = await import("../server/infra/connections");
    const meta = (await import("../server/meta/store")).metaStore();
    // 造一个合法库 + 坏 sidecar（运行态 cwd 是临时目录）
    const db = new DatabaseSync(join(rtmp, "bad.db"));
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
    db.close();
    writeFileSync(join(rtmp, "bad.db.comments.json"), "{ 坏掉");
    await expectRejected(saveConnection("default", { name: "bad_db", type: "sqlite", db_name: "bad.db" }, true), /注释文件读不出/, 400);
    expect(await meta.listConnections("default")).toEqual([]); // 没落库
    // 好 sidecar：照常保存
    const ok = new DatabaseSync(join(rtmp, "good.db"));
    ok.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
    ok.close();
    writeFileSync(join(rtmp, "good.db.comments.json"), JSON.stringify({ t: { id: "编号" } }));
    const r = unwrap(await saveConnection("default", { name: "good_db", type: "sqlite", db_name: "good.db" }, true));
    expect(r.saved).toBe(true);
    expect(r.tables?.length).toBe(1); // 表单 toast「读到 N 张表」吃这份
    expect((await meta.listConnections("default")).map((c) => c.name)).toEqual(["good_db"]);
  });

  it("水合宽容：保存后 sidecar 变坏，重启注册不炸、好库进得去、坏的那个只是没注释", async () => {
    const { getDriverRegistry } = await import("../server/infra/connections");
    const meta = (await import("../server/meta/store")).metaStore();
    for (const name of ["one.db", "two.db"]) {
      const db = new DatabaseSync(join(rtmp, name));
      db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY)`);
      db.close();
    }
    await meta.saveConnection("default", { name: "one_db", type: "sqlite", db_name: join(rtmp, "one.db") } as never);
    await meta.saveConnection("default", { name: "two_db", type: "sqlite", db_name: join(rtmp, "two.db") } as never);
    writeFileSync(join(rtmp, "one.db.comments.json"), "{ 坏掉"); // 保存之后 sidecar 才坏
    const registry = await getDriverRegistry("default"); // 水合：不抛
    expect(registry.has("one_db")).toBe(true); // 仍注册
    expect(registry.has("two_db")).toBe(true);
    expect((await registry.introspect("one_db"))[0].columns.every((c) => c.comment === undefined)).toBe(true); // 没注释，也不回退种子注释
  });
});
