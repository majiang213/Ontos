// SQLite fixture 驱动 —— 演示层：继承裸驱动 SqliteDriver（sqliteDriver.ts），只加演示关注点
// （列注释覆写 / seedDemo 种子 / seeded 工厂）。
// 两种用途：引擎 golden 测试；test 空间的离线演示种子。用户接入的 sqlite 文件库不走本类（裸 SqliteDriver）。
// 种子数据按演示剧本：采购 121 台（含验收主角 SN-40217）、设备 100 台、序列号重合 40 台（交集率约三分之一）。
// 演示问数剧本不住这里：它是罐头槽位的编译脚本，在 llm/canned.ts（demoQueries）。

import type { SourceDriver, TableInfo } from "./driver";
import { SqliteDriver } from "./sqliteDriver";

/** 测试用：每次拿全新的 fixture（不经注册表）。 */
export function freshDriver(): SourceDriver {
  return SqliteFixtureDriver.seeded();
}

export class SqliteFixtureDriver extends SqliteDriver {
  private comments = new Map<string, Map<string, Record<string, string>>>(); // connection → table → 列名 → 中文注释（SQLite 没有列注释，演示注释由种子手写）

  /** 给某张表的列挂中文注释（SQLite 无列注释，演示数据靠这里补）。 */
  setComments(connection: string, table: string, map: Record<string, string>): void {
    const perTable = this.comments.get(connection) ?? new Map<string, Record<string, string>>();
    perTable.set(table, map);
    this.comments.set(connection, perTable);
  }

  /** 内省叠加演示列注释（裸驱动没有注释概念）。 */
  override async introspect(connection: string): Promise<TableInfo[]> {
    const tables = await super.introspect(connection);
    return tables.map((t) => ({
      ...t,
      columns: t.columns.map((c) => {
        const comment = this.comments.get(connection)?.get(t.name)?.[c.name];
        return comment ? { ...c, comment } : c;
      }),
    }));
  }

  static seeded(): SqliteFixtureDriver {
    const d = new SqliteFixtureDriver();
    seedDemo(d);
    return d;
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
