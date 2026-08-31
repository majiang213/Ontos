// 演示系统种子 —— 「一家公司 · 设备一生 + 办公线 · 八套连接系统」的配方与注释（docs/真模型端到端测试.md，ADR 0012）。
// 本文件是叶子模块：只引 node 内建设——scripts/demo-seed.ts 要用裸 node（type stripping）直接跑本文件，
// 引进仓库其它 TS 模块（扩展名省略的相对导入）会让那条命令炸掉，所以种子配方与注释数据全部住这里。
// 内容分三类：
//   ① 共享配方：设备核心（采购 121 / 设备 100 / 资产 52 / 保修卡 31 / 处置档案 8）与部门、履历、
//      点检、办公三系统（IT / 门禁 / OA）——内存 seedDemo 与文件库同一份；
//   ② 文件专属配方：采购 order（办公采购订单）/ 维修独立库 15 行 / 客货四库——只进 writeDemoFiles，不进 seedDemo；
//   ③ sidecar 注释：${dbPath}.comments.json 的读 / 写 / 文件名回退（SQLite 没有列注释，文件连接靠它带注释）。
// 人事（hr_sys）与招聘（recruit_sys）已撤（ADR 0012）：人员线由办公账号 + 门禁卡承担。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 演示库目录（相对仓库根）：gitignored，播种命令打印绝对路径。 */
export const DEMO_DIR_REL = ".ontos-demo";

/** 十二套演示系统：给人看的名字（title）、连接表单该填的连接名（snake_case）、库文件名。
 *  撤人事/招聘（ADR 0012），客货四系统留作原料（不连不裁）。 */
export const DEMO_SYSTEMS = [
  { title: "采购系统", connection: "purchase_sys", file: "purchase.db" },
  { title: "设备台账", connection: "device_sys", file: "device.db" },
  { title: "资产系统", connection: "asset_sys", file: "asset.db" },
  { title: "维修工单", connection: "repair_sys", file: "repair.db" },
  { title: "点检系统", connection: "inspect_sys", file: "inspect.db" },
  { title: "IT 系统", connection: "it_sys", file: "it.db" },
  { title: "门禁系统", connection: "access_sys", file: "access.db" },
  { title: "办公系统", connection: "oa_sys", file: "oa.db" },
  { title: "客户档案", connection: "crm_sys", file: "crm.db" },
  { title: "销售系统", connection: "sales_sys", file: "sales.db" },
  { title: "仓库系统", connection: "wms_sys", file: "wms.db" },
  { title: "应收发票", connection: "ar_sys", file: "ar.db" },
] as const;

/** 列注释（连接 → 表 → 列 → 白话注释）：内存 seedDemo 经 setComments 下发；文件库写成 sidecar。
 *  device_sys.repair 的注释只服务内存 fixture（文件 device.db 不建 repair，sidecar 按实建表过滤）。 */
export const DEMO_COMMENTS: Record<string, Record<string, Record<string, string>>> = {
  purchase_sys: {
    po_item: { item_name: "采购条目名称", sn: "设备序列号" },
    order: { order_no: "采购单号", supplier_name: "供应商", amount: "金额" },
  },
  device_sys: {
    device: { name: "设备名称", serial_no: "设备序列号", dept_id: "所属车间编号", status: "台账状态" },
    department: { dept_id: "车间编号", dept_name: "车间名称" },
    repair: { repair_no: "维修单号", serial_no: "设备序列号", started_at: "维修开始时间", ended_at: "维修结束时间" },
    assignment: { asgn_no: "履历编号", sn: "设备序列号", dept_id: "车间编号", valid_from: "生效时间", valid_to: "失效时间" },
  },
  asset_sys: {
    asset: { asset_name: "资产名称", sn: "设备序列号" },
    warranty_card: { card_id: "保修卡号", sn: "设备序列号", expiry: "保修到期时间" },
    disposal: { record_no: "处置记录号", sn: "设备序列号", disposed_at: "处置时间", reason: "处置原因" },
  },
  repair_sys: {
    repair: { repair_no: "维修单号", serial_no: "设备序列号", symptom: "故障现象", started_at: "维修开始时间", ended_at: "维修结束时间" },
  },
  inspect_sys: {
    instrument: { name: "点检对象名称", serial_no: "设备序列号", inspect_cycle_days: "点检周期（天）", last_inspect_at: "上次点检时间" },
  },
  it_sys: {
    device: { asset_tag: "资产编号", sn: "设备序列号", model: "型号", holder: "领用人", status: "状态" },
    ticket: { ticket_no: "报修单号", asset_tag: "资产编号", reporter: "报修人", status: "状态", opened_at: "报修时间" },
  },
  access_sys: {
    card_holder: { card_no: "门禁卡号", holder: "持卡人", name: "姓名", issued_at: "发卡时间" },
  },
  oa_sys: {
    account: { login: "登录名", name: "姓名", email: "邮箱", dept_id: "所属部门编号", is_contractor: "是否外包" },
    dept: { dept_id: "部门编号", dept_name: "部门名称" },
    room: { room_no: "会议室编号", name: "会议室名称", capacity: "容量" },
    booking: { booking_no: "预订编号", room_no: "会议室编号", booker: "预订人", booked_date: "预订日期", slot: "时段" },
    supply: { item_no: "用品编号", name: "用品名称", stock: "库存" },
    requisition: { req_no: "领用单号", item_no: "用品编号", requester: "领用人", qty: "数量", req_date: "领用日期" },
  },
  crm_sys: {
    customer: { customer_no: "客户编号", name: "客户名称", phone: "联系电话", owner_login: "负责人" },
  },
  sales_sys: {
    customer: { cust_no: "客户编号", name: "客户名称", payment_term: "账期" },
    order: { order_no: "销售单号", cust_no: "客户编号", sku: "物料号", amount: "金额" },
  },
  wms_sys: {
    stock: { sku: "物料号", qty: "库存数量", warehouse: "仓库" },
  },
  ar_sys: {
    invoice: { invoice_no: "发票号", customer_no: "客户编号", order_no: "销售单号", amount: "金额", due_date: "到期日" },
  },
};

/* ---------- sidecar 列注释（${dbPath}.comments.json） ---------- */

export type SidecarComments = Record<string, Record<string, string>>;
export type SidecarRead = { kind: "missing" } | { kind: "ok"; comments: SidecarComments } | { kind: "corrupt" };

/** sidecar 与库文件成对：同目录同文件名加后缀（不是 basename 拼法——目录不能丢）。 */
export function sidecarPathFor(dbPath: string): string {
  return `${dbPath}.comments.json`;
}

/** 读 sidecar：不存在 / 合法 / 损坏三态分开（损坏≠不存在：损坏不许回退种子注释悄悄盖住）。 */
export function readSidecarComments(dbPath: string): SidecarRead {
  const p = sidecarPathFor(dbPath);
  if (!existsSync(p)) return { kind: "missing" };
  try {
    const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "corrupt" };
    for (const cols of Object.values(raw)) {
      if (!cols || typeof cols !== "object" || Array.isArray(cols)) return { kind: "corrupt" };
      if (Object.values(cols).some((v) => typeof v !== "string")) return { kind: "corrupt" };
    }
    return { kind: "ok", comments: raw as SidecarComments };
  } catch {
    return { kind: "corrupt" };
  }
}

/** 文件名回退：操作者只拷了 .db 没拷 sidecar 时，按库文件名对 DEMO_SYSTEMS 找回种子注释。 */
export function demoCommentsForFile(dbPath: string): SidecarComments | undefined {
  const sys = DEMO_SYSTEMS.find((s) => s.file === basename(dbPath));
  return sys ? DEMO_COMMENTS[sys.connection] : undefined;
}

/* ---------- 行配方 ---------- */

/** 真实时钟（UTC Unix 秒）：演示种子的相对日期按注入时钟算，测试可钉死。 */
export const realNow = (): number => Math.floor(Date.now() / 1000);

const pad = (n: number, w: number) => String(n).padStart(w, "0");
const sn4 = (i: number) => `SN-4${pad(i, 4)}`;
const sn7 = (i: number) => `SN-7${pad(i, 4)}`; // 办公设备序列号段

export const DEMO_DEPTS = ["D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08"];
const DEPT_NAMES = ["一车间", "二车间", "总装车间", "机加工车间", "质检车间", "维修车间", "仓储区", "动力车间"]; // 台账口径：车间/产线（与 OA 行政组织同形异义）

/** OA 行政组织（与台账车间同形异义的另一侧）：O01–O06。 */
export const OA_DEPTS = ["O01", "O02", "O03", "O04", "O05", "O06"];
const OA_DEPT_NAMES = ["综合部", "财务部", "IT部", "市场部", "销售部", "行政部"];

/* 共享配方：内存 seedDemo 与文件 writeDemoFiles 同一份（采购 121 含 SN-40217、设备 100、资产 52、
   保修卡 30 前 10 张过期、处置档案 8——引擎 golden 与走查对错板吃的是同一批数字）。 */

export function createPoItem(db: DatabaseSync): void {
  db.exec(`CREATE TABLE po_item (po_id INTEGER PRIMARY KEY AUTOINCREMENT, item_name TEXT, sn TEXT UNIQUE)`);
}

/** 采购 121 行：SN-40000…SN-40119 + 验收主角 SN-40217（只在采购源，在途）。 */
export function insertPoItems(db: DatabaseSync): void {
  const ins = db.prepare(`INSERT INTO po_item (item_name, sn) VALUES (?, ?)`);
  for (let i = 0; i < 120; i++) ins.run(`精密机床-${i + 1}号`, sn4(i));
  ins.run("精密机床-217号", "SN-40217");
}

export function createDevice(db: DatabaseSync): void {
  db.exec(`CREATE TABLE device (dev_id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, serial_no TEXT UNIQUE, dept_id TEXT, status TEXT)`);
}

/** 设备 100 台：SN-40080…SN-40119 与采购重合 40 台（前 3 台台账 scrapped），SN-60000…SN-60059 设备独有。 */
export function insertDevices(db: DatabaseSync): void {
  const ins = db.prepare(`INSERT INTO device (name, serial_no, dept_id, status) VALUES (?, ?, ?, ?)`);
  for (let i = 80; i < 120; i++) ins.run(`机床台账-${i + 1}号`, sn4(i), DEMO_DEPTS[i % DEMO_DEPTS.length], i < 83 ? "scrapped" : null);
  for (let i = 0; i < 60; i++) ins.run(`在役仪表-${i + 1}号`, `SN-6${pad(i, 4)}`, DEMO_DEPTS[i % DEMO_DEPTS.length], null);
}

export function createDepartment(db: DatabaseSync): void {
  db.exec(`CREATE TABLE department (dept_id TEXT PRIMARY KEY, dept_name TEXT)`);
}

export function insertDepartments(db: DatabaseSync): void {
  const ins = db.prepare(`INSERT INTO department (dept_id, dept_name) VALUES (?, ?)`);
  DEMO_DEPTS.forEach((id, i) => ins.run(id, DEPT_NAMES[i]));
}

export function createAssignment(db: DatabaseSync): void {
  db.exec(`CREATE TABLE assignment (id INTEGER PRIMARY KEY AUTOINCREMENT, asgn_no TEXT UNIQUE, sn TEXT, dept_id TEXT, valid_from INTEGER, valid_to INTEGER)`);
}

/** 一条履历：SN-40090 自 2025-01-01 起属于 D02，至今有效（时间区间关系演示）。 */
export function insertAssignment(db: DatabaseSync): void {
  db.prepare(`INSERT INTO assignment (asgn_no, sn, dept_id, valid_from, valid_to) VALUES (?, ?, ?, ?, ?)`)
    .run("A-20250101-0001", "SN-40090", "D02", Math.floor(Date.UTC(2025, 0, 1) / 1000), null);
}

/** 资产三表：asset 52 行（40 台生产设备转固 + 12 台办公设备转固）；保修卡 31 张（含验收主角）；
 *  处置档案 8 条（3 条台账 scrapped + 5 条已从台账移除）。 */
export function createAssetTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE asset (asset_id INTEGER PRIMARY KEY AUTOINCREMENT, asset_name TEXT, sn TEXT UNIQUE)`);
  db.exec(`CREATE TABLE warranty_card (card_id INTEGER PRIMARY KEY AUTOINCREMENT, sn TEXT UNIQUE, expiry INTEGER)`);
  db.exec(`CREATE TABLE disposal (record_no TEXT PRIMARY KEY, sn TEXT UNIQUE, disposed_at INTEGER, reason TEXT)`);
}

/** 资产 52 行：生产设备 40 台（SN-40080…SN-40119 全量转固）+ 办公设备 12 台（SN-70001…SN-70012）。
 *  device × asset 类等价、it_device × asset 部分重叠都靠这批交集。 */
export function insertAssets(db: DatabaseSync): void {
  const ins = db.prepare(`INSERT INTO asset (asset_name, sn) VALUES (?, ?)`);
  for (let i = 80; i < 120; i++) ins.run(`机床资产-${i + 1}号`, sn4(i));
  for (let i = 1; i <= 12; i++) ins.run(`办公资产-${pad(i, 3)}号`, sn7(i));
}

/** 保修卡 30 张：SN-40080…SN-40109（前 10 张已过期，后 20 张未过期）。
 *  验收主角 SN-40217 的卡由 convert 动作现建（不在种子里）。保修期内 = 20。 */
export function insertWarrantyCards(db: DatabaseSync, now: number): void {
  const ins = db.prepare(`INSERT INTO warranty_card (sn, expiry) VALUES (?, ?)`);
  for (let i = 80; i < 110; i++) ins.run(sn4(i), now - (i < 90 ? 400 : -200) * 86400);
}

/** 处置档案 8 条：SN-40080…SN-40082（台账 scrapped，交集 3）+ SN-41003…SN-41007（台账已移除）。
 *  device × disposal 生命周期（在役→已处置）的交集 = 3。 */
export function insertDisposals(db: DatabaseSync, now: number): void {
  const ins = db.prepare(`INSERT INTO disposal (record_no, sn, disposed_at, reason) VALUES (?, ?, ?, ?)`);
  const reasons = ["老化报废", "事故损毁", "技术淘汰"];
  for (let i = 0; i < 8; i++) {
    const sn = i < 3 ? sn4(80 + i) : `SN-41${pad(i, 3)}`;
    ins.run(`DSP-2026-${pad(i + 1, 4)}`, sn, now - (10 - i) * 86400, reasons[i % reasons.length]);
  }
}

/** 点检对象 60 台：40 台与设备重合（含 3 台台账 scrapped——点检不管报废）+ 20 台点检独有。 */
export function createInstrument(db: DatabaseSync): void {
  db.exec(`CREATE TABLE instrument (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, serial_no TEXT, inspect_cycle_days INTEGER, last_inspect_at INTEGER)`);
}

export function insertInstruments(db: DatabaseSync, now: number): void {
  const ins = db.prepare(`INSERT INTO instrument (name, serial_no, inspect_cycle_days, last_inspect_at) VALUES (?, ?, ?, ?)`);
  const cycles = [30, 90, 180];
  for (let i = 0; i < 60; i++) {
    const sn = i < 40 ? sn4(80 + i) : `SN-8${pad(i - 40, 4)}`;
    ins.run(`点检仪-${pad(i + 1, 3)}号`, sn, cycles[i % cycles.length], now - ((i % 30) + 1) * 86400);
  }
}

/** IT 两表：办公设备 40 台（SN-70001…SN-70040，前 12 台已转固进资产）+ IT 报修单 12 条。 */
export function createItTables(db: DatabaseSync, now: number): void {
  db.exec(`CREATE TABLE device (asset_tag TEXT PRIMARY KEY, sn TEXT UNIQUE, model TEXT, holder TEXT, status TEXT)`);
  db.exec(`CREATE TABLE ticket (ticket_no TEXT PRIMARY KEY, asset_tag TEXT, reporter TEXT, status TEXT, opened_at INTEGER)`);
  const insD = db.prepare(`INSERT INTO device (asset_tag, sn, model, holder, status) VALUES (?, ?, ?, ?, ?)`);
  const models = ["笔记本电脑", "台式机", "显示器", "打印机"];
  const statuses = ["在用", "闲置", "报废"];
  for (let i = 1; i <= 40; i++) {
    const login = i <= 35 ? `u${pad(i, 3)}` : null; // 后 5 台闲置无领用人
    insD.run(`IT-${pad(i, 4)}`, sn7(i), models[i % models.length], login, i <= 37 ? statuses[0] : statuses[1]);
  }
  const insT = db.prepare(`INSERT INTO ticket (ticket_no, asset_tag, reporter, status, opened_at) VALUES (?, ?, ?, ?, ?)`);
  for (let i = 1; i <= 12; i++) {
    insT.run(`ITR-202608-${pad(i, 4)}`, `IT-${pad(i, 4)}`, `u${pad((i % 30) + 1, 3)}`, i <= 10 ? "closed" : "open", now - (i + 1) * 86400);
  }
}

/** 门禁卡 45 张：35 张对得上办公账号（正式员工都有卡）+ 10 张持卡人对不上账号（访客/已离职）。 */
export function createAccessTables(db: DatabaseSync, now: number): void {
  db.exec(`CREATE TABLE card_holder (card_no TEXT PRIMARY KEY, holder TEXT, name TEXT, issued_at INTEGER)`);
  const ins = db.prepare(`INSERT INTO card_holder (card_no, holder, name, issued_at) VALUES (?, ?, ?, ?)`);
  for (let i = 1; i <= 45; i++) {
    const holder = i <= 35 ? `u${pad(i, 3)}` : `u9${pad(i - 35, 2)}`;
    ins.run(`C-${pad(i, 4)}`, holder, `持卡人-${pad(i, 3)}`, now - (60 - i) * 86400);
  }
}

/** OA 六表：账号 40（35 正式 + 5 外包）、部门 6、会议室 8、预订 20、用品 25、领用单 18。
 *  与台账车间的部门表同形异义（行政组织 vs 车间）。 */
export function createOaTables(db: DatabaseSync, now: number): void {
  db.exec(`CREATE TABLE account (login TEXT PRIMARY KEY, name TEXT, email TEXT, dept_id TEXT, is_contractor INTEGER)`);
  db.exec(`CREATE TABLE dept (dept_id TEXT PRIMARY KEY, dept_name TEXT)`);
  db.exec(`CREATE TABLE room (room_no TEXT PRIMARY KEY, name TEXT, capacity INTEGER)`);
  db.exec(`CREATE TABLE booking (booking_no TEXT PRIMARY KEY, room_no TEXT, booker TEXT, booked_date INTEGER, slot TEXT)`);
  db.exec(`CREATE TABLE supply (item_no TEXT PRIMARY KEY, name TEXT, stock INTEGER)`);
  db.exec(`CREATE TABLE requisition (req_no TEXT PRIMARY KEY, item_no TEXT, requester TEXT, qty INTEGER, req_date INTEGER)`);

  const insA = db.prepare(`INSERT INTO account (login, name, email, dept_id, is_contractor) VALUES (?, ?, ?, ?, ?)`);
  for (let i = 1; i <= 40; i++) {
    const login = `u${pad(i, 3)}`;
    const dept = OA_DEPTS[(i - 1) % OA_DEPTS.length];
    insA.run(login, i <= 35 ? `员工-${pad(i, 3)}` : `外包-${pad(i - 35, 2)}`, `${login}@example.com`, dept, i > 35 ? 1 : 0);
  }
  const insD = db.prepare(`INSERT INTO dept (dept_id, dept_name) VALUES (?, ?)`);
  OA_DEPTS.forEach((id, i) => insD.run(id, OA_DEPT_NAMES[i]));

  const insR = db.prepare(`INSERT INTO room (room_no, name, capacity) VALUES (?, ?, ?)`);
  const roomNames = ["泰山厅", "华山厅", "衡山厅", "恒山厅", "嵩山厅", "黄山厅", "庐山厅", "峨眉厅"];
  roomNames.forEach((name, i) => insR.run(`R-${pad(i + 1, 2)}`, name, 8 + (i % 5) * 6));

  const insB = db.prepare(`INSERT INTO booking (booking_no, room_no, booker, booked_date, slot) VALUES (?, ?, ?, ?, ?)`);
  for (let i = 1; i <= 20; i++) {
    insB.run(`B-202608-${pad(i, 4)}`, `R-${pad((i % 8) + 1, 2)}`, `u${pad((i % 35) + 1, 3)}`, now + (i % 7) * 86400, i % 2 ? "上午" : "下午");
  }

  const insS = db.prepare(`INSERT INTO supply (item_no, name, stock) VALUES (?, ?, ?)`);
  const supplyNames = ["打印纸", "签字笔", "笔记本", "胶带", "订书机", "文件夹", "便利贴", "硒鼓", "鼠标", "键盘", "U盘", "电池", "垃圾袋", "洗手液", "抽纸", "纸杯", "茶叶", "咖啡", "文件篮", "回形针", "长尾夹", "燕尾夹", "橡皮筋", "白板笔", "记号笔"];
  for (let i = 1; i <= 25; i++) insS.run(`SP-${pad(i, 4)}`, supplyNames[i - 1], 10 + ((i * 37) % 90));

  const insQ = db.prepare(`INSERT INTO requisition (req_no, item_no, requester, qty, req_date) VALUES (?, ?, ?, ?, ?)`);
  for (let i = 1; i <= 18; i++) {
    insQ.run(`RQ-202608-${pad(i, 4)}`, `SP-${pad((i % 25) + 1, 4)}`, `u${pad((i % 35) + 1, 3)}`, 1 + (i % 5), now - (20 - i) * 86400);
  }
}

/* ---------- 文件专属配方（只进 writeDemoFiles，不进内存 seedDemo） ---------- */

/** 采购库第二张表：办公采购订单（没有序列号），约 25 行——order × po_item 部分与整体（订单含条目）不定案的埋伏。 */
function createPurchaseOrder(db: DatabaseSync): void {
  db.exec(`CREATE TABLE "order" (order_id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT UNIQUE, supplier_name TEXT, amount REAL)`);
  const ins = db.prepare(`INSERT INTO "order" (order_no, supplier_name, amount) VALUES (?, ?, ?)`);
  const suppliers = ["晨光文具", "办公之家", "优选耗材"];
  for (let i = 0; i < 25; i++) ins.run(`PO-202607-${pad(i + 1, 4)}`, suppliers[i % suppliers.length], 200 + ((i * 137) % 4800));
}

/** 维修工单独立库 15 行：序列号全部来自在役设备（不含 3 台 scrapped）；一条未结束（ended_at 空）。 */
function seedRepairFile(db: DatabaseSync, now: number): void {
  db.exec(`CREATE TABLE repair (repair_no TEXT PRIMARY KEY, serial_no TEXT, symptom TEXT, started_at INTEGER, ended_at INTEGER)`);
  const serials = [
    "SN-40085", "SN-40090", // 与内存种子那两单同一台，便于眼熟
    "SN-40083", "SN-40084", "SN-40086", "SN-40087", "SN-40088", "SN-40089", "SN-40091", "SN-40092", "SN-40093",
    "SN-60000", "SN-60001", "SN-60002", "SN-60003",
  ];
  const symptoms = ["异响", "过热", "精度超差"];
  const ins = db.prepare(`INSERT INTO repair (repair_no, serial_no, symptom, started_at, ended_at) VALUES (?, ?, ?, ?, ?)`);
  serials.forEach((sn, i) => ins.run(`R-202608-${pad(i + 1, 4)}`, sn, symptoms[i % symptoms.length], now - (i + 2) * 86400, i === 0 ? null : now - (i + 1) * 86400));
}

/** 客户档案 40 行：前 30 个与销售客户同号同名（部分重叠的硬证据）；后 10 个档案独有（不跟销售独有撞名）。 */
function seedCrmFile(db: DatabaseSync): void {
  db.exec(`CREATE TABLE customer (customer_no TEXT PRIMARY KEY, name TEXT, phone TEXT, owner_login TEXT)`);
  const ins = db.prepare(`INSERT INTO customer (customer_no, name, phone, owner_login) VALUES (?, ?, ?, ?)`);
  for (let i = 0; i < 40; i++) {
    ins.run(`CUST-${pad(i + 1, 3)}`, i < 30 ? `客户-${pad(i + 1, 3)}` : `档案客户-${pad(i + 1, 3)}`, `0106000${pad(i + 1, 4)}`, `sales0${(i % 2) + 1}`);
  }
}

/** 销售库两张表：客户 40 行（前 30 个与档案同号同名，10 个销售独有）；订单 60 行（用 25 种 sku，其中 20 种仓库有）。
 *  表名 order 与采购 order 撞名（原料库保留，不入剧本）。 */
function seedSalesFile(db: DatabaseSync): void {
  db.exec(`CREATE TABLE customer (cust_no TEXT PRIMARY KEY, name TEXT, payment_term TEXT)`);
  db.exec(`CREATE TABLE "order" (order_id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT UNIQUE, cust_no TEXT, sku TEXT, amount REAL)`);
  const insC = db.prepare(`INSERT INTO customer (cust_no, name, payment_term) VALUES (?, ?, ?)`);
  const terms = ["月结30天", "月结60天", "预付"];
  for (let i = 0; i < 40; i++) {
    insC.run(i < 30 ? `CUST-${pad(i + 1, 3)}` : `SALE-${pad(i + 1, 3)}`, i < 30 ? `客户-${pad(i + 1, 3)}` : `销售客户-${pad(i + 1, 3)}`, terms[i % terms.length]);
  }
  const insO = db.prepare(`INSERT INTO "order" (order_no, cust_no, sku, amount) VALUES (?, ?, ?, ?)`);
  for (let i = 0; i < 60; i++) {
    insO.run(`SO-202608-${pad(i + 1, 4)}`, `CUST-${pad((i % 30) + 1, 3)}`, `SKU-${pad((i % 25) + 1, 3)}`, 500 + ((i * 211) % 9500));
  }
}

/** 仓库 30 种 sku：20 种与销售订单重合（销售另 5 种独有），10 种只在库里。 */
function seedWmsFile(db: DatabaseSync): void {
  db.exec(`CREATE TABLE stock (sku TEXT PRIMARY KEY, qty INTEGER, warehouse TEXT)`);
  const ins = db.prepare(`INSERT INTO stock (sku, qty, warehouse) VALUES (?, ?, ?)`);
  for (let k = 0; k < 30; k++) {
    ins.run(k < 20 ? `SKU-${pad(k + 1, 3)}` : `SKU-1${pad(k - 19, 2)}`, 50 + ((k * 37) % 200), k % 2 ? "二仓" : "一仓");
  }
}

/** 应收发票 40 张：order_no 对得上部分销售单，但它不是销售订单那一类（原料库保留）。 */
function seedArFile(db: DatabaseSync, now: number): void {
  db.exec(`CREATE TABLE invoice (invoice_no TEXT PRIMARY KEY, customer_no TEXT, order_no TEXT, amount REAL, due_date INTEGER)`);
  const ins = db.prepare(`INSERT INTO invoice (invoice_no, customer_no, order_no, amount, due_date) VALUES (?, ?, ?, ?, ?)`);
  for (let i = 0; i < 40; i++) {
    ins.run(`INV-2026-${pad(i + 1, 4)}`, `CUST-${pad((i % 40) + 1, 3)}`, `SO-202608-${pad(i + 1, 4)}`, 1000 + ((i * 733) % 49000), now + (i + 10) * 86400);
  }
}

/* ---------- 写文件 ---------- */

export interface DemoFileInfo {
  title: string;
  connection: string;
  path: string;
}

/** 每个文件建哪些表、灌哪些行（CREATE 清单按文件分叉：device.db 不建 repair，purchase.db 多一张 order）。
 *  实建了哪些表不再另报名字——sidecar 过滤直接读 sqlite_master（配方改了不会忘记同步第二处）。 */
const FILE_RECIPES: { connection: string; seed: (db: DatabaseSync, now: number) => void }[] = [
  { connection: "purchase_sys", seed: (db, now) => { createPoItem(db); insertPoItems(db); createPurchaseOrder(db); } },
  { connection: "device_sys", seed: (db, now) => { createDevice(db); insertDevices(db); createDepartment(db); insertDepartments(db); createAssignment(db); insertAssignment(db); } },
  { connection: "asset_sys", seed: (db, now) => { createAssetTables(db); insertAssets(db); insertWarrantyCards(db, now); insertDisposals(db, now); } },
  { connection: "repair_sys", seed: (db, now) => seedRepairFile(db, now) },
  { connection: "inspect_sys", seed: (db, now) => { createInstrument(db); insertInstruments(db, now); } },
  { connection: "it_sys", seed: (db, now) => createItTables(db, now) },
  { connection: "access_sys", seed: (db, now) => createAccessTables(db, now) },
  { connection: "oa_sys", seed: (db, now) => createOaTables(db, now) },
  { connection: "crm_sys", seed: (db) => seedCrmFile(db) },
  { connection: "sales_sys", seed: (db) => seedSalesFile(db) },
  { connection: "wms_sys", seed: (db) => seedWmsFile(db) },
  { connection: "ar_sys", seed: (db, now) => seedArFile(db, now) },
];

/** 把十二套演示系统写成可连接的 sqlite 文件 + 列注释 sidecar。幂等：重复运行整份覆盖。
 *  只写文件——不动元库、不注册连接（连接由操作者在画布表单里接）。返回连接表单该填的字段（绝对路径）。 */
export function writeDemoFiles(dir: string = join(process.cwd(), DEMO_DIR_REL), clock: () => number = realNow): DemoFileInfo[] {
  const absDir = resolve(dir);
  const now = clock();
  mkdirSync(absDir, { recursive: true });
  const byConnection = new Map<string, (typeof DEMO_SYSTEMS)[number]>(DEMO_SYSTEMS.map((s) => [s.connection, s]));
  const out: DemoFileInfo[] = [];
  for (const recipe of FILE_RECIPES) {
    const sys = byConnection.get(recipe.connection)!;
    const path = join(absDir, sys.file);
    rmSync(path, { force: true }); // 已有文件整份覆盖
    rmSync(sidecarPathFor(path), { force: true });
    const db = new DatabaseSync(path);
    let tables: string[];
    try {
      recipe.seed(db, now);
      tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as { name: string }[]).map((t) => t.name);
    } finally {
      db.close();
    }
    // sidecar 只写本文件实建表的注释（device_sys 的 repair 注释只服务内存 fixture）
    const all = DEMO_COMMENTS[recipe.connection] ?? {};
    const comments = Object.fromEntries(Object.entries(all).filter(([t]) => tables.includes(t)));
    writeFileSync(sidecarPathFor(path), `${JSON.stringify(comments, null, 2)}\n`);
    out.push({ title: sys.title, connection: sys.connection, path });
  }
  // 清理已从 DEMO_SYSTEMS 撤除的旧文件（如 hr_sys/recruit_sys 时代的残留）：连接表单按目录扫 *.db，
  // 不清理会让已撤系统重新出现在下拉里（与「十二套」宣传不符）
  const managed = new Set(DEMO_SYSTEMS.flatMap((s) => [s.file, `${s.file}.comments.json`]));
  for (const f of readdirSync(absDir)) {
    if (managed.has(f)) continue;
    if (f.endsWith(".db") || f.endsWith(".db.comments.json")) rmSync(join(absDir, f), { force: true });
  }
  return out;
}
