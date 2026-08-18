// SQLite fixture 驱动 —— 每个连接一个内存库，用真实 SQL 执行下推与写回。
// 两种用途：引擎 golden 测试；没有 MySQL/PG 时的离线演示。
// 种子数据按演示剧本：采购 120 台、设备 100 台、序列号重合 40 台（交集率约三分之一）。

import { DatabaseSync } from "node:sqlite";
import {
  buildSelect,
  conditionSql,
  maskValue,
  quoteFor,
  type Condition,
  type SourceDriver,
} from "./driver";
import { EngineReject } from "./individual";

const quote = quoteFor("sqlite"); // 与方言层同一套引号（含双写转义）
// node:sqlite 的参数类型是 SQLInputValue；引擎产出的 unknown[] 在这一处收口断言。
// node:sqlite 不认 boolean，绑定前归一成 1/0。
const bind = (params: unknown[]) => params.map((v) => (typeof v === "boolean" ? (v ? 1 : 0) : v)) as never[];

export class SqliteFixtureDriver implements SourceDriver {
  readonly dialect: "sqlite" | "mysql" | "pg" = "sqlite"; // 测试可覆写模拟他种方言的写回行为
  private dbs = new Map<string, DatabaseSync>();

  /** 注册一个连接，返回它的内存库（建表、插种子用）。同名覆盖先关旧句柄。 */
  register(connection: string): DatabaseSync {
    this.dbs.get(connection)?.close();
    const db = new DatabaseSync(":memory:");
    this.dbs.set(connection, db);
    return db;
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
    const cols = Object.keys(row);
    const sql = `INSERT INTO ${quote(table)} (${cols.map(quote).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
    this.db(connection).prepare(sql).run(...bind(cols.map((c) => row[c])));
  }

  async update(connection: string, table: string, set: Record<string, unknown>, conditions: Condition[]): Promise<number> {
    const setCols = Object.keys(set);
    const setSql = setCols.map((c) => `${quote(c)} = ?`).join(", ");
    const parts = conditions.map((c) => conditionSql(c, quote));
    const where = parts.length ? ` WHERE ${parts.map((p) => p.sql).join(" AND ")}` : "";
    const params = [...setCols.map((c) => set[c]), ...parts.flatMap((p) => p.params)];
    const res = this.db(connection).prepare(`UPDATE ${quote(table)} SET ${setSql}${where}`).run(...bind(params));
    return Number(res.changes);
  }

  async delete(connection: string, table: string, conditions: Condition[]): Promise<number> {
    const parts = conditions.map((c) => conditionSql(c, quote));
    const where = parts.length ? ` WHERE ${parts.map((p) => p.sql).join(" AND ")}` : "";
    const res = this.db(connection)
      .prepare(`DELETE FROM ${quote(table)}${where}`)
      .run(...bind(parts.flatMap((p) => p.params)));
    return Number(res.changes);
  }

  async sample(connection: string, table: string, limit = 3) {
    const rows = this.db(connection).prepare(`SELECT * FROM ${quote(table)} LIMIT ?`).all(...bind([limit])) as Record<string, unknown>[];
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

  async introspect(connection: string): Promise<{ name: string; columns: { name: string; type: string; pk: boolean }[] }[]> {
    const db = this.db(connection);
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[];
    return tables.map((t) => ({
      name: t.name,
      columns: (db.prepare(`PRAGMA table_info("${t.name}")`).all() as { name: string; type: string; pk: number }[]).map(
        (c) => ({ name: c.name, type: c.type, pk: c.pk === 1 })
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
}
