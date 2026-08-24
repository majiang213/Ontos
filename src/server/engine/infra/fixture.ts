// SQLite fixture 驱动 —— 每个连接一个内存库，用真实 SQL 执行下推与写回。
// 三种用途：引擎 golden 测试；test 空间的离线演示种子；用户接入的 sqlite 文件库的驱动（load.ts registerSaved 复用本类）。
// 种子数据按演示剧本：采购 121 台（含验收主角 SN-40217）、设备 100 台、序列号重合 40 台（交集率约三分之一）。
// 演示问数剧本也住这里（demoQueries）：test 空间离线回退的确定性编译脚本，引擎 llmSlot 只读不写。

import { DatabaseSync } from "node:sqlite";
import { buildInsert, buildSelect, buildStatement, maskValue, type Condition, type SourceDriver, type TableInfo } from "./driver";
import type { QueryRequest } from "../../schema/request";
import { EngineReject } from "../../errors";

// node:sqlite 的参数类型是 SQLInputValue；引擎产出的 unknown[] 在这一处收口断言。
// node:sqlite 不认 boolean，绑定前归一成 1/0。
const bind = (params: unknown[]) => params.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)) as never[];

export class SqliteFixtureDriver implements SourceDriver {
  readonly dialect: "sqlite" | "mysql" | "pg" = "sqlite"; // 测试可覆写模拟他种方言的写回行为
  private dbs = new Map<string, DatabaseSync>();
  private comments = new Map<string, Map<string, Record<string, string>>>(); // connection → table → 列名 → 中文注释（SQLite 没有列注释，演示注释由种子手写）

  /** 注册一个连接，返回它的内存库（建表、插种子用）。同名覆盖先关旧句柄。 */
  register(connection: string): DatabaseSync {
    this.dbs.get(connection)?.close();
    const db = new DatabaseSync(":memory:");
    this.dbs.set(connection, db);
    return db;
  }

  /** 给某张表的列挂中文注释（SQLite 无列注释，演示数据靠这里补）。 */
  setComments(connection: string, table: string, map: Record<string, string>): void {
    const perTable = this.comments.get(connection) ?? new Map<string, Record<string, string>>();
    perTable.set(table, map);
    this.comments.set(connection, perTable);
  }

  /** 注册一个 SQLite 文件库作为连接（连接表单里的 sqlite 类型走这里）。同名覆盖先关旧句柄。 */
  registerFile(connection: string, path: string): void {
    this.dbs.get(connection)?.close();
    this.dbs.set(connection, new DatabaseSync(path));
  }

  private db(connection: string): DatabaseSync {
    const db = this.dbs.get(connection);
    if (!db) throw new EngineReject(`未注册的连接：${connection}`);
    return db;
  }

  async select(connection: string, table: string, columns: string[], conditions: Condition[], limit?: number) {
    const { sql, params } = buildSelect(table, columns, conditions, "sqlite", limit);
    return this.db(connection).prepare(sql).all(...bind(params)) as Record<string, unknown>[];
  }

  async insert(connection: string, table: string, row: Record<string, unknown>) {
    const { sql, params } = buildInsert("sqlite", table, row);
    this.db(connection).prepare(sql).run(...bind(params));
  }

  async update(connection: string, table: string, set: Record<string, unknown>, conditions: Condition[]): Promise<number> {
    const { sql, params } = buildStatement("sqlite", "update", table, { set, conditions });
    const res = this.db(connection).prepare(sql).run(...bind(params));
    return Number(res.changes);
  }

  async delete(connection: string, table: string, conditions: Condition[]): Promise<number> {
    const { sql, params } = buildStatement("sqlite", "delete", table, { conditions });
    const res = this.db(connection).prepare(sql).run(...bind(params));
    return Number(res.changes);
  }

  async sample(connection: string, table: string, limit = 3) {
    const { sql, params } = buildSelect(table, [], [], "sqlite", limit);
    const rows = this.db(connection).prepare(sql).all(...bind(params)) as Record<string, unknown>[];
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, maskValue(k, v)])));
  }

  /** 释放全部库句柄（删连接、测试收尾用）。 */
  async close(): Promise<void> {
    for (const db of this.dbs.values()) db.close();
    this.dbs.clear();
  }

  static seeded(): SqliteFixtureDriver {
    const d = new SqliteFixtureDriver();
    seedDemo(d);
    return d;
  }

  /** M1 雏形：连接清单与表结构（内省）。 */
  connections(): string[] {
    return [...this.dbs.keys()];
  }

  async introspect(connection: string): Promise<TableInfo[]> {
    const db = this.db(connection);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[];
    return tables.map((t) => ({
      name: t.name,
      columns: (db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string; type: string; pk: number }[]).map(
        (c) => ({ name: c.name, type: c.type, pk: c.pk === 1, ...(this.comments.get(connection)?.get(t.name)?.[c.name] ? { comment: this.comments.get(connection)!.get(t.name)![c.name] } : {}) })
      ),
    }));
  }
}

/* 演示剧本数据：
   - 采购源 po_item 121 行（SN-40000 ~ SN-40119，外加验收主角 SN-40217）
   - 设备源 device 100 行：40 台序列号与采购重合（SN-40080 ~ SN-40119，其中 3 台已报废），60 台设备独有（SN-60000 ~ SN-60059）
   - 部门 D01~D08；D07 生产部（调拨演示目标）
   - 日期一律 UTC Unix 秒（INTEGER） */
export function seedDemo(d: SqliteFixtureDriver) {
  const sn4 = (i: number) => `SN-4${String(i).padStart(4, "0")}`;
  const now = Math.floor(Date.now() / 1000);
  const DEPTS = ["D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08"];

  const purchase = d.register("purchase_sys");
  purchase.exec(`CREATE TABLE po_item (po_id INTEGER PRIMARY KEY AUTOINCREMENT, item_name TEXT, sn TEXT)`);
  const insPo = purchase.prepare(`INSERT INTO po_item (item_name, sn) VALUES (?, ?)`);
  for (let i = 0; i < 120; i++) insPo.run(`精密机床-${i + 1}号`, sn4(i));
  insPo.run("精密机床-217号", "SN-40217"); // 验收演示的主角：只在采购源（在途）

  const device = d.register("device_sys");
  device.exec(`CREATE TABLE device (dev_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, serial_no TEXT, dept_id TEXT, status TEXT)`);
  device.exec(`CREATE TABLE department (dept_id TEXT PRIMARY KEY, dept_name TEXT)`);
  device.exec(`CREATE TABLE repair (id INTEGER PRIMARY KEY AUTOINCREMENT, repair_no TEXT, serial_no TEXT, started_at INTEGER, ended_at INTEGER)`);
  device.exec(`CREATE TABLE assignment (id INTEGER PRIMARY KEY AUTOINCREMENT, asgn_no TEXT, sn TEXT, dept_id TEXT, valid_from INTEGER, valid_to INTEGER)`);
  const insDev = device.prepare(`INSERT INTO device (name, serial_no, dept_id, status) VALUES (?, ?, ?, ?)`);
  for (let i = 80; i < 120; i++) insDev.run(`机床台账-${i + 1}号`, sn4(i), DEPTS[i % DEPTS.length], i < 83 ? "scrapped" : null);
  for (let i = 0; i < 60; i++) insDev.run(`在役仪表-${i + 1}号`, `SN-6${String(i).padStart(4, "0")}`, DEPTS[i % DEPTS.length], null);
  const deptNames = ["研发部", "生产一部", "质检部", "仓储部", "维修部", "采购部", "生产部", "行政部"];
  const insDept = device.prepare(`INSERT INTO department (dept_id, dept_name) VALUES (?, ?)`);
  DEPTS.forEach((id, i) => insDept.run(id, deptNames[i]));
  const insRepair = device.prepare(`INSERT INTO repair (repair_no, serial_no, started_at, ended_at) VALUES (?, ?, ?, ?)`);
  insRepair.run("R-20260801-0001", "SN-40085", now - 3 * 86400, null); // 在役，有一条未结束维修
  insRepair.run("R-20260701-0002", "SN-40090", now - 40 * 86400, now - 30 * 86400);
  // 一条履历：SN-40090 自 2025-01-01 起属于 D02，至今有效（时间区间关系演示）
  device
    .prepare(`INSERT INTO assignment (asgn_no, sn, dept_id, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)`)
    .run("A-20250101-0001", "SN-40090", "D02", Math.floor(Date.UTC(2025, 0, 1) / 1000), null);

  const asset = d.register("asset_sys");
  asset.exec(`CREATE TABLE asset (asset_id INTEGER PRIMARY KEY AUTOINCREMENT, asset_name TEXT, sn TEXT)`);
  asset.exec(`CREATE TABLE warranty_card (card_id INTEGER PRIMARY KEY AUTOINCREMENT, sn TEXT, expiry INTEGER)`);

  const hr = d.register("hr_sys");
  hr.exec(`CREATE TABLE person (person_no TEXT PRIMARY KEY, name TEXT)`);
  hr.exec(`CREATE TABLE appointment (id INTEGER PRIMARY KEY AUTOINCREMENT, appt_no TEXT, person_no TEXT, title TEXT, dept_id TEXT, valid_from INTEGER, valid_to INTEGER)`);
  hr.prepare(`INSERT INTO person (person_no, name) VALUES (?, ?)`).run("P001", "张三");
  hr.prepare(`INSERT INTO appointment (appt_no, person_no, title, dept_id, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("P001-20250101-0001", "P001", "专员", "D01", now - 500 * 86400, null); // 一条在任

  // 演示列注释（SQLite 无列注释，种子手写）：内省时随列下发，生成对象时进字段说明
  d.setComments("purchase_sys", "po_item", { item_name: "采购条目名称", sn: "设备序列号" });
  d.setComments("device_sys", "device", { name: "设备名称", serial_no: "设备序列号", dept_id: "所属部门编号", status: "台账状态" });
  d.setComments("device_sys", "department", { dept_id: "部门编号", dept_name: "部门名称" });
  d.setComments("device_sys", "repair", { repair_no: "维修单号", serial_no: "设备序列号", started_at: "维修开始时间", ended_at: "维修结束时间" });
  d.setComments("device_sys", "assignment", { asgn_no: "履历编号", sn: "设备序列号", dept_id: "部门编号", valid_from: "生效时间", valid_to: "失效时间" });
  d.setComments("asset_sys", "asset", { asset_name: "资产名称", sn: "设备序列号" });
  d.setComments("asset_sys", "warranty_card", { card_id: "保修卡号", sn: "设备序列号", expiry: "保修到期时间" });
  d.setComments("hr_sys", "person", { person_no: "人员编号", name: "姓名" });
  d.setComments("hr_sys", "appointment", { appt_no: "任职编号", person_no: "人员编号", title: "职务", dept_id: "部门编号", valid_from: "生效时间", valid_to: "失效时间" });
}

/* ---------- 演示问数剧本（test 空间离线回退的编译脚本） ----------
   正则 → 查询，顺序即优先级，最后一条兜底。这是演示数据，不是引擎逻辑：
   llmSlot 的 CannedSlot 从这里读，引擎源码不出现领域词。 */

export const demoQueries: { pattern: RegExp; query: QueryRequest }[] = [
  {
    pattern: /每个部门|各部门|多少台|多少设备/,
    query: { object: "equipment", filter: { status: "in_service" }, aggregate: { group_by: ["dept"], metrics: [{ count: "*" }] } },
  },
  {
    pattern: /过保/,
    query: { object: "equipment", properties: ["name", "serial_no"], filter: { in_warranty: false } },
  },
  {
    pattern: /在途/,
    query: { object: "equipment", properties: ["name", "serial_no"], filter: { status: "in_transit" } },
  },
  {
    pattern: /报废/,
    query: { object: "equipment", properties: ["name", "serial_no"], filter: { status: "scrapped" } },
  },
  {
    pattern: /在役|部门/,
    query: { object: "equipment", properties: ["name"], filter: { status: "in_service" }, expand: [{ relation: "belongs_to", properties: ["name"] }] },
  },
  {
    pattern: /.*/,
    query: { object: "equipment", properties: ["name", "status"] },
  },
];
