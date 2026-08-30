// SQLite fixture 驱动 —— 演示层：继承裸驱动 SqliteDriver（sqliteDriver.ts），只加演示关注点（seedDemo 种子 / seeded 工厂）。
// 两种用途：引擎 golden 测试；test 空间的离线演示种子。用户接入的 sqlite 文件库不走本类（裸 SqliteDriver + sidecar 注释）。
// 种子数据按演示剧本（ADR 0012）：采购 121 台（含验收主角 SN-40217）、设备 100 台、序列号重合 40 台（交集率约三分之一）、
// 资产 52（40 生产转固 + 12 办公转固）、保修卡 30（前 10 张过期，主角的卡由验收动作现建）、处置档案 8、点检 60、IT 40+12、门禁 45、OA 六表。
// 设备核心配方（CREATE/INSERT）与十二套文件库共用 demoSystems.ts 的同一份——内存的连接清单在这里分叉：
// 内存 device_sys 带 repair 2 行（走查文件库里维修独立成 repair_sys 15 行）；人事/招聘已撤（ADR 0012）。
// 演示问数剧本不住这里：它是演示实现的编译脚本，在 llm/demo.ts（demoQueries）。

import type { SourceDriver } from "./driver";
import { SqliteDriver } from "./sqliteDriver";
import {
  DEMO_COMMENTS,
  createAccessTables,
  createAssetTables,
  createAssignment,
  createDepartment,
  createDevice,
  createInstrument,
  createItTables,
  createOaTables,
  createPoItem,
  insertAssets,
  insertAssignment,
  insertDepartments,
  insertDevices,
  insertDisposals,
  insertInstruments,
  insertPoItems,
  insertWarrantyCards,
  realNow,
} from "./demoSystems";

/** 测试用：每次拿全新的 fixture（不经注册表）。 */
export function freshDriver(): SourceDriver {
  return SqliteFixtureDriver.seeded();
}

export class SqliteFixtureDriver extends SqliteDriver {
  static seeded(clock: () => number = realNow): SqliteFixtureDriver {
    const d = new SqliteFixtureDriver();
    seedDemo(d, clock);
    return d;
  }
}

/* 演示剧本数据（内存七连，引擎 golden 的世界；CREATE/INSERT 核心与文件库共用 demoSystems，内存专属部分留本函数）：
   - 采购源 po_item 121 行（SN-40000 ~ SN-40119，外加验收主角 SN-40217）
   - 设备源 device 100 行：40 台序列号与采购重合（SN-40080 ~ SN-40119，其中 3 台已报废），60 台设备独有（SN-60000 ~ SN-60059）
   - 车间 D01~D08；资产 52、保修卡 31、处置档案 8；点检 60；IT 40+12；门禁 45；OA 六表
   - 日期一律 UTC Unix 秒（INTEGER） */
export function seedDemo(d: SqliteFixtureDriver, clock: () => number = realNow) {
  const now = clock();

  const purchase = d.register("purchase_sys");
  createPoItem(purchase);
  insertPoItems(purchase);

  const device = d.register("device_sys");
  createDevice(device);
  createDepartment(device);
  createAssignment(device);
  // 内存专属：repair 挂在设备库（走查文件库里维修独立成 repair_sys，device.db 不建这张表）
  device.exec(`CREATE TABLE repair (id INTEGER PRIMARY KEY AUTOINCREMENT, repair_no TEXT UNIQUE, serial_no TEXT, started_at INTEGER, ended_at INTEGER)`);
  insertDevices(device);
  insertDepartments(device);
  const insRepair = device.prepare(`INSERT INTO repair (repair_no, serial_no, started_at, ended_at) VALUES (?, ?, ?, ?)`);
  insRepair.run("R-20260801-0001", "SN-40085", now - 3 * 86400, null); // 在役，有一条未结束维修
  insRepair.run("R-20260701-0002", "SN-40090", now - 40 * 86400, now - 30 * 86400);
  insertAssignment(device);

  const asset = d.register("asset_sys");
  createAssetTables(asset);
  insertAssets(asset);
  insertWarrantyCards(asset, now);
  insertDisposals(asset, now);

  const inspect = d.register("inspect_sys");
  createInstrument(inspect);
  insertInstruments(inspect, now);

  const it = d.register("it_sys");
  createItTables(it, now);

  const access = d.register("access_sys");
  createAccessTables(access, now);

  const oa = d.register("oa_sys");
  createOaTables(oa, now);

  // 演示列注释（SQLite 无列注释，种子手写）：内省时随列下发，生成对象时进字段说明。
  // 注释数据单源在 demoSystems.DEMO_COMMENTS；对照不上的表/列内省时自然落空，无害。
  for (const [connection, tables] of Object.entries(DEMO_COMMENTS)) {
    for (const [table, map] of Object.entries(tables)) {
      d.setComments(connection, table, map);
    }
  }
}
