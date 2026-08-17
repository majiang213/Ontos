// SQLite fixture 驱动 —— 每个连接一个内存库，用真实 SQL 执行下推与写回。
// 两种用途：引擎 golden 测试；没有 MySQL/PG 时的离线演示。
// 种子数据按演示剧本：采购 120 台、设备 100 台、序列号重合 40 台（交集率约三分之一）。

import { DatabaseSync } from "node:sqlite";
import {
  buildSelect,
  conditionSql,
  type Condition,
  type SourceDriver,
} from "./driver";

const quote = (id: string) => `"${id}"`;

export class SqliteFixtureDriver implements SourceDriver {
  readonly dialect = "sqlite" as const;
  private dbs = new Map<string, DatabaseSync>();

  /** 注册一个连接，返回它的内存库（建表、插种子用）。 */
  register(connection: string): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    this.dbs.set(connection, db);
    return db;
  }

  private db(connection: string): DatabaseSync {
    const db = this.dbs.get(connection);
    if (!db) throw new Error(`未注册的连接：${connection}`);
    return db;
  }

  select(connection: string, table: string, columns: string[], conditions: Condition[]) {
    const { sql, params } = buildSelect(table, columns, conditions, quote);
    return this.db(connection).prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  }

  insert(connection: string, table: string, row: Record<string, unknown>) {
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${quote(table)} (${cols.map(quote).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    this.db(connection).prepare(sql).run(...(cols.map((c) => row[c]) as never[]));
  }

  update(connection: string, table: string, set: Record<string, unknown>, conditions: Condition[]): number {
    const setCols = Object.keys(set);
    const setSql = setCols.map((c) => `${quote(c)} = ?`).join(", ");
    const parts = conditions.map((c) => conditionSql(c, quote));
    const where = parts.length ? ` WHERE ${parts.map((p) => p.sql).join(" AND ")}` : "";
    const params = [...setCols.map((c) => set[c]), ...parts.flatMap((p) => p.params)];
    const res = this.db(connection).prepare(`UPDATE ${quote(table)} SET ${setSql}${where}`).run(...(params as never[]));
    return Number(res.changes);
  }

  delete(connection: string, table: string, conditions: Condition[]): number {
    const parts = conditions.map((c) => conditionSql(c, quote));
    const where = parts.length ? ` WHERE ${parts.map((p) => p.sql).join(" AND ")}` : "";
    const res = this.db(connection)
      .prepare(`DELETE FROM ${quote(table)}${where}`)
      .run(...(parts.flatMap((p) => p.params) as never[]));
    return Number(res.changes);
  }

  static seeded(): SqliteFixtureDriver {
    const d = new SqliteFixtureDriver();
    seedDemo(d);
    return d;
  }
}

/* 演示剧本数据：
   - 采购源 po_item 120 行（SN-40000 ~ SN-40119）
   - 设备源 device 100 行：40 台序列号与采购重合（SN-40080 ~ SN-40119，其中 3 台已报废），60 台设备独有（SN-60000 ~ SN-60059）
   - SN-40217 只在采购源（在途），是验收演示的主角
   - 部门 D01~D08；D07 生产部（调拨演示目标）
   - 日期一律 UTC Unix 秒（INTEGER） */
function seedDemo(d: SqliteFixtureDriver) {
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
}
