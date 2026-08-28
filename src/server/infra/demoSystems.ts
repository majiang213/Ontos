// 演示系统种子 —— 「一家公司 · 三波接入 · 十二套源系统」的配方与注释（docs/真模型端到端测试.md）。
// 本文件是叶子模块：只引 node 内建设——scripts/demo-seed.ts 要用裸 node（type stripping）直接跑本文件，
// 引进仓库其它 TS 模块（扩展名省略的相对导入）会让那条命令炸掉，所以种子配方与注释数据全部住这里。
// 内容分三类：
//   ① 共享配方：设备核心三表（采购 121 / 设备 100 / 资产 0 行）与部门、履历——内存 seedDemo 与文件库同一份；
//   ② 文件专属配方：点检 / 维修（独立库 15 行）/ 招聘 / 人事宽表 / 办公账号 / 客货四库——只进 writeDemoFiles，不进 seedDemo；
//   ③ sidecar 注释：${dbPath}.comments.json 的读 / 写 / 文件名回退（SQLite 没有列注释，文件连接靠它带注释）。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** 演示库目录（相对仓库根）：gitignored，播种命令打印绝对路径。 */
export const DEMO_DIR_REL = ".ontos-demo";

/** 十二套演示系统：给人看的名字（title）、连接表单该填的连接名（snake_case）、库文件名。 */
export const DEMO_SYSTEMS = [
  { title: "采购系统", connection: "purchase_sys", file: "purchase.db" },
  { title: "设备台账", connection: "device_sys", file: "device.db" },
  { title: "资产系统", connection: "asset_sys", file: "asset.db" },
  { title: "维修工单", connection: "repair_sys", file: "repair.db" },
  { title: "点检系统", connection: "inspect_sys", file: "inspect.db" },
  { title: "招聘系统", connection: "recruit_sys", file: "recruit.db" },
  { title: "人事系统", connection: "hr_sys", file: "hr.db" },
  { title: "办公账号", connection: "oa_sys", file: "oa.db" },
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
    device: { name: "设备名称", serial_no: "设备序列号", dept_id: "所属部门编号", status: "台账状态" },
    department: { dept_id: "部门编号", dept_name: "部门名称" },
    repair: { repair_no: "维修单号", serial_no: "设备序列号", started_at: "维修开始时间", ended_at: "维修结束时间" },
    assignment: { asgn_no: "履历编号", sn: "设备序列号", dept_id: "部门编号", valid_from: "生效时间", valid_to: "失效时间" },
  },
  asset_sys: {
    asset: { asset_name: "资产名称", sn: "设备序列号" },
    warranty_card: { card_id: "保修卡号", sn: "设备序列号", expiry: "保修到期时间" },
  },
  repair_sys: {
    repair: { repair_no: "维修单号", serial_no: "设备序列号", symptom: "故障现象", started_at: "维修开始时间", ended_at: "维修结束时间" },
  },
  inspect_sys: {
    instrument: { name: "仪器名称", serial_no: "设备序列号", inspect_cycle_days: "点检周期（天）", last_inspect_at: "上次点检时间" },
  },
  recruit_sys: {
    candidate: { candidate_no: "候选人编号", name: "姓名", mobile: "手机号", id_no: "身份证号" },
  },
  hr_sys: {
    person: { person_no: "人员编号", name: "姓名", id_no: "身份证号", mobile: "手机号" },
    appointment: { appt_no: "任职编号", person_no: "人员编号", title: "职务", dept_id: "部门编号", valid_from: "生效时间", valid_to: "失效时间" },
  },
  oa_sys: {
    account: { login: "登录名", person_no: "人员编号", email: "邮箱", is_contractor: "是否外包", name: "姓名" },
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

export const DEMO_DEPTS = ["D01", "D02", "D03", "D04", "D05", "D06", "D07", "D08"];
const DEPT_NAMES = ["研发部", "生产一部", "质检部", "仓储部", "维修部", "采购部", "生产部", "行政部"];

/* 共享配方：内存 seedDemo 与文件 writeDemoFiles 同一份（采购 121 含 SN-40217、设备 100、资产 0 行——
   引擎 golden 与走查对错板吃的是同一批数字）。 */

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

/** 资产两表（asset + warranty_card）：都 0 行——0 行仍裁「同一」是演示要点。 */
export function createAssetTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE asset (asset_id INTEGER PRIMARY KEY AUTOINCREMENT, asset_name TEXT, sn TEXT UNIQUE)`);
  db.exec(`CREATE TABLE warranty_card (card_id INTEGER PRIMARY KEY AUTOINCREMENT, sn TEXT UNIQUE, expiry INTEGER)`);
}

/* ---------- 文件专属配方（只进 writeDemoFiles，不进内存 seedDemo） ---------- */

/** 采购库第二张表：办公采购订单（没有序列号），约 25 行——给第三波「采购 order × 销售 order 仅名称相似」埋伏。 */
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

/** 点检 60 台：40 台与设备重合（含 3 台台账 scrapped——点检不管报废）+ 20 台点检独有。 */
function seedInspectFile(db: DatabaseSync, now: number): void {
  db.exec(`CREATE TABLE instrument (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, serial_no TEXT, inspect_cycle_days INTEGER, last_inspect_at INTEGER)`);
  const ins = db.prepare(`INSERT INTO instrument (name, serial_no, inspect_cycle_days, last_inspect_at) VALUES (?, ?, ?, ?)`);
  const cycles = [30, 90, 180];
  for (let i = 0; i < 60; i++) {
    const sn = i < 40 ? sn4(80 + i) : `SN-8${pad(i - 40, 4)}`;
    ins.run(`点检仪-${pad(i + 1, 3)}号`, sn, cycles[i % cycles.length], now - ((i % 30) + 1) * 86400);
  }
}

/** 人名（hr.db 与 oa.db / recruit.db 前 30 个共用：同一批人）。P001 / C001 是张三。 */
function personName(i: number): string {
  return i === 0 ? "张三" : `员工-${pad(i + 1, 3)}`;
}

/** 人事宽表 50 行：前 30 人 id_no / mobile 与招聘前 30 个相同（阶段命中）；后 20 人只有人事行（老员工）。
 *  oa.db 的前 35 个账号从这份读姓名与编号（两库同人同名）。 */
function hrPersonRows(): { person_no: string; name: string; id_no: string; mobile: string }[] {
  const rows: { person_no: string; name: string; id_no: string; mobile: string }[] = [];
  for (let j = 0; j < 50; j++) {
    rows.push({
      person_no: `P${pad(j + 1, 3)}`,
      name: personName(j),
      id_no: j < 30 ? `11010119900101${pad(j, 3)}X` : `11010119910101${pad(j - 30, 3)}X`,
      mobile: j < 30 ? `138${pad(j, 8)}` : `139${pad(j - 30, 8)}`, // 人事独有的 20 人换 139 段：误把手机当唯一键也不出幻影交集
    });
  }
  return rows;
}

/** 走查人事库：宽表 person（50 行）+ 任职 appointment（每人一条在任，部门用同一套 D01–D08 组织编码）。
 *  与内存 hr_sys 窄表（只有张三）是两份 DDL——内存那份留在 fixture.ts 的 seedDemo 里。 */
function seedHrFile(db: DatabaseSync, now: number): void {
  db.exec(`CREATE TABLE person (person_no TEXT PRIMARY KEY, name TEXT, id_no TEXT, mobile TEXT)`);
  db.exec(`CREATE TABLE appointment (id INTEGER PRIMARY KEY AUTOINCREMENT, appt_no TEXT UNIQUE, person_no TEXT, title TEXT, dept_id TEXT, valid_from INTEGER, valid_to INTEGER)`);
  const insP = db.prepare(`INSERT INTO person (person_no, name, id_no, mobile) VALUES (?, ?, ?, ?)`);
  const insA = db.prepare(`INSERT INTO appointment (appt_no, person_no, title, dept_id, valid_from, valid_to) VALUES (?, ?, ?, ?, ?, ?)`);
  const titles = ["专员", "主管", "经理", "工程师"];
  hrPersonRows().forEach((p, j) => {
    insP.run(p.person_no, p.name, p.id_no, p.mobile);
    insA.run(`${p.person_no}-20250101-0001`, p.person_no, titles[j % titles.length], DEMO_DEPTS[j % DEMO_DEPTS.length], now - 500 * 86400, null);
  });
}

/** 招聘 80 行：id_no 前 30 个与人事相同；手机号按行号轮换三种脏法，phone 规则都洗得回同一串。 */
function seedRecruitFile(db: DatabaseSync): void {
  db.exec(`CREATE TABLE candidate (candidate_no TEXT PRIMARY KEY, name TEXT, mobile TEXT, id_no TEXT)`);
  const ins = db.prepare(`INSERT INTO candidate (candidate_no, name, mobile, id_no) VALUES (?, ?, ?, ?)`);
  for (let i = 0; i < 80; i++) {
    const clean = `138${pad(i, 8)}`;
    const mobile =
      i % 3 === 0
        ? `+86 ${clean.slice(0, 3)}-${clean.slice(3, 7)}-${clean.slice(7)}` // 带国家码与分隔符
        : i % 3 === 1
          ? `${clean.slice(0, 3)}-${clean.slice(3, 7)}-${clean.slice(7)}` // 只带分隔符
          : clean; // 干净
    ins.run(`C${pad(i + 1, 3)}`, i < 30 ? personName(i) : `候选人-${pad(i + 1, 3)}`, mobile, `11010119900101${pad(i, 3)}X`);
  }
}

/** 办公账号 40 行：35 个对得上人事 P001…P035（姓名同人），5 个外包只有账号（对不上人事）。
 *  name 列给部分重叠可上移的同名公共属性（没有同名也能裁，公共对象只带唯一键）。 */
function seedOaFile(db: DatabaseSync): void {
  db.exec(`CREATE TABLE account (login TEXT PRIMARY KEY, person_no TEXT, email TEXT, is_contractor INTEGER, name TEXT)`);
  const ins = db.prepare(`INSERT INTO account (login, person_no, email, is_contractor, name) VALUES (?, ?, ?, ?, ?)`);
  const people = hrPersonRows();
  for (let k = 0; k < 40; k++) {
    if (k < 35) {
      const p = people[k];
      ins.run(p.person_no.toLowerCase(), p.person_no, `${p.person_no.toLowerCase()}@example.com`, 0, p.name);
    } else {
      const no = `CX${pad(k - 34, 2)}`;
      ins.run(no.toLowerCase(), no, `${no.toLowerCase()}@example.com`, 1, `外包-${pad(k - 34, 2)}`);
    }
  }
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
 *  表名 order 与采购 order 撞名——第三波「仅名称相似」的那一对。 */
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

/** 应收发票 40 张：order_no 对得上部分销售单，但它不是销售订单那一类（跳过 / 仅名称相似）。 */
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

/** 每个文件建哪些表、灌哪些行（CREATE 清单按文件分叉：device.db 不建 repair，hr.db 用宽表，purchase.db 多一张 order）。
 *  实建了哪些表不再另报名字——sidecar 过滤直接读 sqlite_master（配方改了不会忘记同步第二处）。 */
const FILE_RECIPES: { connection: string; seed: (db: DatabaseSync, now: number) => void }[] = [
  { connection: "purchase_sys", seed: (db) => { createPoItem(db); insertPoItems(db); createPurchaseOrder(db); } },
  { connection: "device_sys", seed: (db) => { createDevice(db); insertDevices(db); createDepartment(db); insertDepartments(db); createAssignment(db); insertAssignment(db); } },
  { connection: "asset_sys", seed: (db) => { createAssetTables(db); } },
  { connection: "repair_sys", seed: (db, now) => seedRepairFile(db, now) },
  { connection: "inspect_sys", seed: (db, now) => seedInspectFile(db, now) },
  { connection: "recruit_sys", seed: (db) => seedRecruitFile(db) },
  { connection: "hr_sys", seed: (db, now) => seedHrFile(db, now) },
  { connection: "oa_sys", seed: (db) => seedOaFile(db) },
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
  return out;
}
