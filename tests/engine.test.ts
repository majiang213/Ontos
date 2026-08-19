// 引擎 golden 测试 —— 覆盖演示剧本的每一拍。
// 配置是附录 C 种子；源库是 SQLite fixture；断言全部对着文章的预期行为。

import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configSchema } from "../lib/schema/config";
import { queryRequestSchema } from "../lib/schema/request";
import { runQuery } from "../lib/engine/query";
import { EngineReject } from "../lib/engine/individual";
import { runAction } from "../lib/engine/action";
import { freshDriver } from "../lib/engine/load";
import { SqliteFixtureDriver, seedDemo } from "../lib/engine/fixture";
import { generateValue } from "../lib/engine/expr";
import type { QueryRequest } from "../lib/schema/request";

const config = configSchema.parse(load(readFileSync(join(process.cwd(), "lib/config/ontology.yaml"), "utf8")));

const q = (req: QueryRequest) => runQuery(config, freshDriver(), req);

describe("M7 查询", () => {
  it("在役设备：派生 status 按 when 规则判定", async () => {
    const { rows } = await q({ object: "equipment", properties: ["name", "status"], filter: { status: "in_service" } });
    expect(rows.length).toBe(97); // 40 台重合 - 3 台报废 + 60 台设备独有
    expect(rows.every((r) => r.status === "in_service")).toBe(true);
  });

  it("在途设备：采购源有行、设备源无行", async () => {
    const { rows } = await q({ object: "equipment", properties: ["serial_no"], filter: { status: "in_transit" } });
    expect(rows.length).toBe(81); // 121 - 40
  });

  it("报废规则排在在役前面", async () => {
    const { rows } = await q({ object: "equipment", properties: ["serial_no"], filter: { status: "scrapped" } });
    expect(rows.length).toBe(3);
  });

  it("identity 认准一台；同名属性按声明顺序取（采购源优先）", async () => {
    const { rows } = await q({ object: "equipment", identity: "SN-40085", properties: ["name", "status"] });
    expect(rows).toEqual([{ name: "精密机床-86号", status: "in_service" }]); // purchase 声明在前
  });

  it("expand 沿 match 进入部门；反向名 has_equipment 从部门查设备", async () => {
    const { rows } = await q({
      object: "equipment",
      properties: ["name"],
      filter: { status: "in_service" },
      expand: [{ relation: "belongs_to", properties: ["name"] }],
    });
    expect(rows.some((r) => Array.isArray(r.belongs_to) && r.belongs_to.length > 0)).toBe(true); // 不赌无 order 的行序

    const back = await q({ object: "department", identity: "D01", expand: [{ relation: "has_equipment", properties: ["serial_no"] }] });
    expect(back.rows[0].name).toBe("研发部"); // 没点 properties 也要返回全部属性
    expect((back.rows[0].has_equipment as unknown[]).length).toBeGreaterThan(0);
  });

  it("聚合：按部门分组数设备", async () => {
    const { rows } = await q({
      object: "equipment",
      filter: { status: "in_service" },
      aggregate: { group_by: ["dept"], metrics: [{ count: "*" }] },
    });
    expect(rows.length).toBe(8);
    expect(rows.reduce((a, r) => a + (r.count as number), 0)).toBe(97);
  });

  it("名字对不上配置，引擎拒绝", async () => {
    await expect(q({ object: "equipment", filter: { no_such_prop: 1 } })).rejects.toThrow();
    await expect(q({ object: "no_such_class" })).rejects.toThrow();
  });

  it("时间区间履历：生效日不晚于当天、失效日空按至今", async () => {
    const D = Math.floor(Date.UTC(2025, 5, 1) / 1000);
    const { rows } = await q({
      object: "equipment",
      identity: "SN-40090",
      expand: [
        {
          relation: "assignments",
          properties: ["dept_id"],
          filter: { valid_from: { lte: D }, valid_to: { gte: D } },
          expand: [{ relation: "of_department", properties: ["name"] }],
        },
      ],
    });
    const asg = rows[0].assignments as Record<string, unknown>[];
    expect(asg.length).toBe(1);
    expect(asg[0].of_department).toEqual([{ name: "生产一部" }]);
  });
});

describe("M8 动作", () => {
  it("验收一台在途设备：设备源、资产源各插一行，立一张保修卡；再读已在役、在保、转化成立", async () => {
    const driver = freshDriver();
    const res = await runAction(config, driver, { action: "convert", object: "equipment", identity: "SN-40217" });
    expect(res.ok).toBe(true);
    expect(res.projections.filter((p) => p.ok).length).toBe(3);

    const after = await runQuery(config, driver, {
      object: "equipment",
      identity: "SN-40217",
      properties: ["status", "in_warranty"],
      filter: { status: "in_service" },
    });
    expect(after.rows).toEqual([{ status: "in_service", in_warranty: true }]);

    // 转化关系成立：出发阶段的源有行，到达阶段整条命中
    const linked = await runQuery(config, driver, { object: "equipment", identity: "SN-40217", filter: { $link: { converted: true } } });
    expect(linked.rows.length).toBe(1);
  });

  it("重复验收被前置拦下：阶段不再是在途", async () => {
    const driver = freshDriver();
    await runAction(config, driver, { action: "convert", object: "equipment", identity: "SN-40217" });
    const again = await runAction(config, driver, { action: "convert", object: "equipment", identity: "SN-40217" });
    expect(again.ok).toBe(false);
    expect(again.stage).toBe("pre");
  });

  it("调拨：新部门必须能认到、不得与当前相同；成功后部门改掉", async () => {
    const driver = freshDriver();
    const badDept = await runAction(config, driver, {
      action: "transfer", object: "equipment", identity: "SN-40085", request: { dept: "D99" },
    });
    expect(badDept.ok).toBe(false); // D99 认不到部门

    const sameDept = await runAction(config, driver, {
      action: "transfer", object: "equipment", identity: "SN-40085", request: { dept: "D06" },
    });
    expect(sameDept.ok).toBe(false); // 与当前相同

    const okRes = await runAction(config, driver, {
      action: "transfer", object: "equipment", identity: "SN-40085", request: { dept: "D07" },
    });
    expect(okRes.ok).toBe(true);
    const after = await runQuery(config, driver, { object: "equipment", identity: "SN-40085", properties: ["dept"] });
    expect(after.rows[0].dept).toBe("D07");
  });

  it("报废：改的是源列属性 mark，派生 status 随后算成报废；报废不能再报废", async () => {
    const driver = freshDriver();
    expect((await runAction(config, driver, { action: "scrap", object: "equipment", identity: "SN-40085" })).ok).toBe(true);
    const after = await runQuery(config, driver, { object: "equipment", identity: "SN-40085", properties: ["status"] });
    expect(after.rows[0].status).toBe("scrapped");
    expect((await runAction(config, driver, { action: "scrap", object: "equipment", identity: "SN-40085" })).ok).toBe(false);
  });

  it("登记：$exists 为假才放行；只插映射了全部所赋属性的源", async () => {
    const driver = freshDriver();
    const dup = await runAction(config, driver, {
      action: "register", object: "equipment", identity: "SN-40085", request: { name: "x", dept: "D07" },
    });
    expect(dup.ok).toBe(false); // 已有个体不当新生

    const res = await runAction(config, driver, {
      action: "register", object: "equipment", identity: "SN-90001", request: { name: "新机床", dept: "D07" },
    });
    expect(res.ok).toBe(true);
    expect(res.projections.length).toBe(1); // 采购、资产缺 dept，不插
    expect(res.projections[0].source).toBe("device");
  });

  it("结束维修：前置用设备出发的关系名，效应过滤落在维修自己的字段上", async () => {
    const driver = freshDriver();
    const res = await runAction(config, driver, { action: "finish_repair", object: "equipment", identity: "SN-40085" });
    expect(res.ok).toBe(true);
    const repairs = await runQuery(config, driver, { object: "repair", filter: { serial_no: "SN-40085" }, properties: ["is_open"] });
    expect(repairs.rows[0].is_open).toBe(false);
  });

  it("调岗：关旧任职、开新任职，任职编号按 generate 发出", async () => {
    const driver = freshDriver();
    const res = await runAction(config, driver, {
      action: "transfer_post", object: "person", identity: "P001", request: { title: "经理", dept: "D07" },
    });
    expect(res.ok).toBe(true);
    const after = await runQuery(config, driver, {
      object: "person", identity: "P001",
      expand: [{ relation: "appointments", properties: ["title", "dept", "is_current", "appt_no"] }],
    });
    const appts = after.rows[0].appointments as Record<string, unknown>[];
    expect(appts.length).toBe(2);
    const current = appts.filter((a) => a.is_current === true);
    expect(current.length).toBe(1);
    expect(current[0].title).toBe("经理");
    expect(String(current[0].appt_no)).toMatch(/^P001-\d{8}-0001$/); // 日期段与旧记录天然不撞
  });

  it("配置里没有的动作，引擎拒绝", async () => {
    const res = await runAction(config, freshDriver(), { action: "fly", object: "equipment", identity: "SN-40085" });
    expect(res.ok).toBe(false);
  });
});

describe("过滤与展开的边界", () => {
  it("$link 挂 match 关系：true 留有关联的，false 留没有的", async () => {
    const linked = await q({ object: "equipment", properties: ["serial_no"], filter: { $link: { belongs_to: true } } });
    expect(linked.rows.length).toBe(100); // 设备源 100 行都有部门
    const unlinked = await q({ object: "equipment", properties: ["serial_no"], filter: { $link: { belongs_to: false } } });
    expect(unlinked.rows.length).toBe(81); // 采购独有的 81 台没有部门
  });

  it("expand 的配对属性为空：关系不成立，返回空数组而不是全表", async () => {
    const { rows } = await q({ object: "equipment", identity: "SN-40217", expand: [{ relation: "belongs_to", properties: ["name"] }] });
    expect(rows[0].belongs_to).toEqual([]); // 在途设备没有 dept
  });

  it("两个属性相比 + ISO 日期字面量", async () => {
    const { rows } = await q({ object: "assignment", filter: { valid_from: { lte: { property: "valid_to" } } } });
    expect(rows.length).toBe(1);
    const iso = await q({ object: "assignment", filter: { valid_from: { lte: "2025-06-01" }, valid_to: { gte: "2025-06-01" } } });
    expect(iso.rows.length).toBe(1);
  });

  it("非法表达式拒绝（now-1 不合法），未知运算符拒绝", async () => {
    await expect(q({ object: "assignment", filter: { valid_from: { gte: "now-1" } } })).rejects.toThrow();
    await expect(q({ object: "equipment", filter: { dept: { between: 1 } } })).rejects.toThrow();
  });

  it("查询过滤不许用前置专有的 $exists / $request", async () => {
    await expect(q({ object: "equipment", filter: { $exists: true } })).rejects.toThrow();
  });

  it("contains 与 in 运算符", async () => {
    expect((await q({ object: "equipment", filter: { serial_no: { contains: "SN-60" } } })).rows.length).toBe(60);
    expect((await q({ object: "equipment", filter: { dept: { in: ["D07", "D08"] } } })).rows.length).toBe(24);
  });

  it("布尔派生取 false：没立保修卡的都是过保设备", async () => {
    expect((await q({ object: "equipment", filter: { in_warranty: false } })).rows.length).toBe(181);
    const driver = freshDriver();
    await runAction(config, driver, { action: "convert", object: "equipment", identity: "SN-40217" });
    const after = await runQuery(config, driver, { object: "equipment", properties: ["serial_no"], filter: { in_warranty: false } });
    expect(after.rows.length).toBe(180);
    expect(after.rows.every((r) => r.serial_no !== "SN-40217")).toBe(true);
  });

  it("order 与 limit；limit 超过 1000 被 schema 拒绝", async () => {
    const { rows } = await q({ object: "equipment", filter: { status: "in_transit" }, properties: ["serial_no"], order: { serial_no: "desc" }, limit: 5 });
    expect(rows.length).toBe(5);
    expect(rows[0].serial_no).toBe("SN-40217");
    expect(() => queryRequestSchema.parse({ object: "equipment", limit: 1001 })).toThrow();
  });

  it("聚合四则：组内多行才能验出真算（avg/sum/min/max/count 各断具体值）", async () => {
    const driver = freshDriver();
    // 同一 serial_no 插两行不同 started_at，组内多行；ended_at 留空验 count 字段语义
    await driver.insert("device_sys", "repair", { repair_no: "R-X1", serial_no: "SN-GRP", started_at: 100, ended_at: null });
    await driver.insert("device_sys", "repair", { repair_no: "R-X2", serial_no: "SN-GRP", started_at: 300, ended_at: null });
    const { rows } = await runQuery(config, driver, {
      object: "repair",
      filter: { serial_no: "SN-GRP" },
      aggregate: { group_by: ["serial_no"], metrics: [{ avg: "started_at" }, { min: "started_at" }, { max: "started_at" }, { sum: "started_at" }, { count: "*" }, { count: "ended_at" }] },
    });
    expect(rows).toEqual([{ serial_no: "SN-GRP", avg_started_at: 200, min_started_at: 100, max_started_at: 300, sum_started_at: 400, count: 2, count_ended_at: 0 }]);
    await expect(q({ object: "repair", aggregate: { group_by: ["serial_no"], metrics: [{ median: "started_at" }] } })).rejects.toThrow();
  });

  it("取数路径记录下推与内存核对", async () => {
    const { path } = await q({ object: "equipment", identity: "SN-40085", properties: ["name"] });
    expect(path.some((l) => l.includes("下推 device_sys.device"))).toBe(true);
    // 派生过滤留内存核对：path 里必须看到这一笔
    const mem = await q({ object: "equipment", filter: { status: "in_service" }, properties: ["serial_no"] });
    expect(mem.path.some((l) => l.includes("内存核对"))).toBe(true);
  });
});

describe("M8 动作的边界与补偿", () => {
  it("转化关系的展开：验收后 converted 带回自身行", async () => {
    const driver = freshDriver();
    await runAction(config, driver, { action: "convert", object: "equipment", identity: "SN-40217" });
    const { rows } = await runQuery(config, driver, { object: "equipment", identity: "SN-40217", expand: [{ relation: "converted", properties: ["serial_no"] }] });
    expect(rows[0].converted).toEqual([{ serial_no: "SN-40217" }]);
  });

  it("条件更新未命中：读到的值被并发改掉，该条投影判失败", async () => {
    class SneakyDriver extends SqliteFixtureDriver {
      private done = false;
      async update(connection: string, table: string, set: Record<string, unknown>, conditions: import("../lib/engine/driver").Condition[]): Promise<number> {
        if (table === "device" && !this.done) {
          this.done = true;
          await super.update("device_sys", "device", { dept_id: "D99" }, [{ column: "serial_no", op: "eq", value: "SN-40085" }]);
        }
        return super.update(connection, table, set, conditions);
      }
    }
    const driver = new SneakyDriver();
    seedDemo(driver);
    const res = await runAction(config, driver, { action: "transfer", object: "equipment", identity: "SN-40085", request: { dept: "D07" } });
    expect(res.ok).toBe(false);
    expect(res.projections[0].error).toContain("条件更新未命中");
  });

  it("部分失败：成功的投影不回滚，失败条目进结果；首条失败时重发可补偿", async () => {
    class FaultDriver extends SqliteFixtureDriver {
      failTables = new Set<string>();
      async insert(connection: string, table: string, row: Record<string, unknown>) {
        if (this.failTables.has(table)) throw new Error(`注入故障：${table}`);
        return super.insert(connection, table, row);
      }
    }
    // 情形一：device 插入失败（状态没变），重发畅通
    const d1 = new FaultDriver();
    seedDemo(d1);
    d1.failTables.add("device");
    const first = await runAction(config, d1, { action: "convert", object: "equipment", identity: "SN-40217" });
    expect(first.ok).toBe(false);
    expect(first.stage).toBe("project");
    d1.failTables.clear();
    const retry = await runAction(config, d1, { action: "convert", object: "equipment", identity: "SN-40217" });
    expect(retry.ok).toBe(true);

    // 情形二：asset 插入失败（设备源已插，状态已变在役），重发被前置拦下——按 §6.3 走人工修库
    const d2 = new FaultDriver();
    seedDemo(d2);
    d2.failTables.add("asset");
    const partial = await runAction(config, d2, { action: "convert", object: "equipment", identity: "SN-40217" });
    expect(partial.ok).toBe(false);
    expect(partial.projections.some((p) => p.source === "device" && p.ok)).toBe(true); // 成功的留在库里
    d2.failTables.clear();
    const blocked = await runAction(config, d2, { action: "convert", object: "equipment", identity: "SN-40217" });
    expect(blocked.ok).toBe(false);
    expect(blocked.stage).toBe("pre");
  });

  it("$request 两个参数互比，不读源", async () => {
    const c2 = structuredClone(config);
    c2.object_types.equipment.actions!.register2 = {
      pre: { $exists: false, $request: { valid_from: { lte: { property: "valid_to", from: "request" } } } },
      effect: [{ create: { object: "equipment", properties: { serial_no: { from: "identity" } } } }],
    };
    const bad = await runAction(c2, freshDriver(), {
      action: "register2", object: "equipment", identity: "SN-90002",
      request: { valid_from: "2026-03-01", valid_to: "2026-01-01" },
    });
    expect(bad.ok).toBe(false);
    expect(bad.stage).toBe("pre");
    const good = await runAction(c2, freshDriver(), {
      action: "register2", object: "equipment", identity: "SN-90002",
      request: { valid_from: "2026-01-01", valid_to: "2026-03-01" },
    });
    expect(good.ok).toBe(true);
  });

  it("delete 效应：删掉有行的源；认人不写 identity/filter 被拒", async () => {
    const c2 = structuredClone(config);
    c2.object_types.equipment.actions!.unregister = {
      effect: [{ delete: { object: "equipment", identity: { from: "identity" } } }],
    };
    const driver = freshDriver();
    const res = await runAction(c2, driver, { action: "unregister", object: "equipment", identity: "SN-40085" });
    expect(res.ok).toBe(true);
    expect(res.projections.length).toBe(2); // purchase + device 都有行
    expect((await runQuery(config, driver, { object: "equipment", identity: "SN-40085" })).rows.length).toBe(0);

    c2.object_types.equipment.actions!.bad_delete = { effect: [{ delete: { object: "equipment" } }] };
    const bad = await runAction(c2, freshDriver(), { action: "bad_delete", object: "equipment", identity: "SN-40085" });
    expect(bad.ok).toBe(false);
    expect(bad.stage).toBe("effect");
  });

  it("公理 mutex 挂在源列属性上：同一属性被赋两个值则拦下", async () => {
    const c2 = structuredClone(config);
    c2.object_types.equipment.axioms!.dept_one = { type: "mutex", property: "dept" };
    c2.object_types.equipment.actions!.double_move = {
      effect: [
        { update: { object: "equipment", identity: { from: "identity" }, properties: { dept: "D01" } } },
        { update: { object: "equipment", identity: { from: "identity" }, properties: { dept: "D02" } } },
      ],
    };
    const res = await runAction(c2, freshDriver(), { action: "double_move", object: "equipment", identity: "SN-40085" });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("axiom");
  });

  it("inform 预留：生成变更事件但不外发", async () => {
    const res = await runAction(config, freshDriver(), {
      action: "transfer_post", object: "person", identity: "P001", request: { title: "经理", dept: "D07" },
    });
    expect(res.ok).toBe(true);
    expect(res.notifications?.length).toBe(1);
    expect(res.notifications?.[0].delivered).toBe(false);
    expect(res.notifications?.[0].to).toEqual(["payroll"]);
    expect(res.notifications?.[0].lines.map((l) => l.op)).toEqual(["update", "create"]);
    expect(res.notifications?.[0].lines[1].targets).toEqual([]); // create 行的识别值是 from: generated，不重复发号
    expect(String(res.notifications?.[0].properties.change_id)).toMatch(/^transfer_post\|P001\|\d+$/); // change_id 三项合成
  });
});

describe("源条目级对齐键 key", () => {
  it("某源没有 identity 列时按该源的 key 对齐", async () => {
    const driver = new SqliteFixtureDriver();
    const sa = driver.register("sa");
    sa.exec(`CREATE TABLE t1 (id INTEGER PRIMARY KEY, emp_no TEXT, v1 TEXT)`);
    sa.prepare(`INSERT INTO t1 (emp_no, v1) VALUES ('E1', '甲')`).run();
    const sb = driver.register("sb");
    sb.exec(`CREATE TABLE t2 (id INTEGER PRIMARY KEY, card_no TEXT, v2 TEXT)`);
    sb.prepare(`INSERT INTO t2 (card_no, v2) VALUES ('E1', '乙')`).run();
    const c2 = structuredClone(config);
    c2.object_types.employee = {
      kind: "thing",
      identity: "emp_no",
      properties: {
        emp_no: { type: "string" },
        card_no: { type: "string" },
        v1: { type: "string" },
        v2: { type: "string" },
      },
      sources: {
        x: { connection: "sa", table: "t1", pk: "id", fields: { emp_no: "emp_no", v1: "v1" } },
        y: { connection: "sb", table: "t2", pk: "id", key: "card_no", fields: { card_no: "card_no", v2: "v2" } },
      },
    };
    const { rows } = await runQuery(c2, driver, { object: "employee", identity: "E1", properties: ["v1", "v2"] });
    expect(rows).toEqual([{ v1: "甲", v2: "乙" }]);
  });
});

describe("表达式与发号", () => {
  it("uuid v7 是合法 UUID 形态", async () => {
    const v = await generateValue("c", "p", { type: "string", generate: [{ uuid: "v7" }] }, {});
    expect(v).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("sequence 的 start 生效（走真实发号路径）", async () => {
    const c2 = structuredClone(config);
    c2.object_types.appointment.properties.appt_no.generate = [
      { from: "identity" },
      "-",
      { date: "now/d", format: "yyyyMMdd" },
      "-",
      { sequence: { start: 100, width: 4 } },
    ];
    const driver = freshDriver();
    const res = await runAction(c2, driver, {
      action: "transfer_post", object: "person", identity: "P001", request: { title: "经理", dept: "D07" },
    });
    expect(res.ok).toBe(true);
    const after = await runQuery(c2, driver, {
      object: "person", identity: "P001",
      expand: [{ relation: "appointments", properties: ["appt_no", "is_current"] }],
    });
    const cur = (after.rows[0].appointments as Record<string, unknown>[]).find((a) => a.is_current === true);
    expect(String(cur!.appt_no)).toMatch(/-0100$/);
  });
});

describe("第三轮修复的回归", () => {
  it("源库脏数据不崩：脏日期串参与两属性相比按原值处理", async () => {
    const driver = freshDriver();
    await driver.insert("device_sys", "assignment", { asgn_no: "A-DIRTY", sn: "SN-X", dept_id: "D01", valid_from: "2024-13-99", valid_to: null });
    const { rows } = await runQuery(config, driver, { object: "assignment", filter: { valid_from: { lte: { property: "valid_to" } } } });
    expect(rows.length).toBe(2); // 不抛错；与「至今」比，任何值都不晚于至今
  });

  it("now 开头的普通文本不被误判为表达式", async () => {
    expect((await q({ object: "equipment", filter: { name: "nowadays" } })).rows.length).toBe(0); // 不抛错、不命中
  });

  it("与 null 比大小留在内存核对（下推会改变语义）", async () => {
    // 内存语义：expected 为空（至今）时 lt 成立；若被下推成 col < NULL 会恒假
    expect((await q({ object: "assignment", filter: { valid_from: { lt: null } } })).rows.length).toBe(1);
  });

  it("效应里的过滤不许用 $request（只属于前置）", async () => {
    const c2 = structuredClone(config);
    c2.object_types.equipment.actions!.bad_filter = {
      effect: [{ update: { object: "equipment", filter: { $request: { dept: "D01" } }, properties: { dept: "D01" } } }],
    };
    const res = await runAction(c2, freshDriver(), { action: "bad_filter", object: "equipment", identity: "SN-40085" });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("effect");
  });

  it("order 键名校验；聚合结果也走 order/limit", async () => {
    await expect(q({ object: "equipment", order: { nope: "asc" } })).rejects.toThrow();
    const { rows } = await q({
      object: "repair",
      aggregate: { group_by: ["serial_no"], metrics: [{ max: "started_at" }] },
      order: { max_started_at: "desc" },
    });
    expect(rows.length).toBe(2);
    expect(rows[0].max_started_at as number).toBeGreaterThan(rows[1].max_started_at as number);
    await expect(
      q({ object: "repair", aggregate: { group_by: ["serial_no"], metrics: [{ max: "started_at" }] }, order: { nope: "asc" } })
    ).rejects.toThrow();
  });

  it("公理校验取值失败按 axiom 阶段拒答，不抛 500", async () => {
    const c2 = structuredClone(config);
    c2.object_types.equipment.axioms!.dept_one = { type: "mutex", property: "dept" };
    c2.object_types.equipment.actions!.gen_move = {
      effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { dept: { from: "generated" } } } }],
    };
    const res = await runAction(c2, freshDriver(), { action: "gen_move", object: "equipment", identity: "SN-40085" });
    expect(res.ok).toBe(false);
    expect(res.stage).toBe("axiom"); // dept 没有 generate，取值失败
  });

  it("update 多 target：零承接的逐个记失败", async () => {
    const c2 = structuredClone(config);
    c2.object_types.equipment.actions!.sweep = {
      effect: [{ update: { object: "equipment", filter: { status: "in_transit" }, properties: { dept: "D01" } } }],
    };
    const res = await runAction(c2, freshDriver(), { action: "sweep", object: "equipment", identity: "SN-40217" });
    expect(res.ok).toBe(false);
    expect(res.projections.length).toBe(81); // 在途设备都没有设备源行，dept 无处承接
    expect(res.projections.every((p) => !p.ok)).toBe(true);
  });

  it("update 多 target：取值失败的逐个记失败、批不中断", async () => {
    const c2 = structuredClone(config);
    c2.object_types.equipment.actions!.sweep2 = {
      effect: [{ update: { object: "equipment", filter: { status: "in_transit" }, properties: { mark: { from: "generated" } } } }],
    };
    const res = await runAction(c2, freshDriver(), { action: "sweep2", object: "equipment", identity: "SN-40217" });
    expect(res.ok).toBe(false);
    expect(res.projections.length).toBe(81);
    expect(res.projections.every((p) => p.error?.includes("取值失败"))).toBe(true); // mark 没有 generate
  });

  it("inform 生成失败给占位记录，不影响动作结果", async () => {
    const c2 = structuredClone(config);
    c2.object_types.person.actions!.transfer_post.inform![0].properties.occurred_at = { from: "generated" } as never;
    const res = await runAction(c2, freshDriver(), {
      action: "transfer_post", object: "person", identity: "P001", request: { title: "经理", dept: "D07" },
    });
    expect(res.ok).toBe(true);
    expect(res.notifications?.[0].note).toContain("变更事件生成失败");
  });

  it("表达式判定只落在操作数位：等值位是纯文本，操作数位非法即拒", async () => {
    expect((await q({ object: "equipment", filter: { name: "nowhere 部门" } })).rows.length).toBe(0); // 不抛、不命中
    await expect(q({ object: "repair", filter: { started_at: { gt: "current.qty-1d" } } })).rejects.toThrow();
  });
});

describe("第五轮修复的回归", () => {
  it("等值位的日期字面量也解析：ISO 串与表达式都能命中", async () => {
    expect((await q({ object: "assignment", filter: { valid_from: "2025-01-01" } })).rows.length).toBe(1);
    // now/d 不赌日历：与「测试内现算的今天 0 点（UTC）」结果必须一致
    const todayUtc = new Date();
    todayUtc.setUTCHours(0, 0, 0, 0);
    const iso = todayUtc.toISOString().slice(0, 10);
    const byExpr = await q({ object: "assignment", filter: { valid_from: "now/d" } });
    const byIso = await q({ object: "assignment", filter: { valid_from: iso } });
    expect(byExpr.rows).toEqual(byIso.rows);
  });

  it("写回按方言归一日期：mysql 写 UTC 串，sqlite 写 Unix 秒", async () => {
    class Mysqlish extends SqliteFixtureDriver {
      override readonly dialect = "mysql" as const;
    }
    const mysqlDriver = new Mysqlish();
    seedDemo(mysqlDriver);
    const res = await runAction(config, mysqlDriver, { action: "transfer_post", object: "person", identity: "P001", request: { title: "经理", dept: "D07" } });
    expect(res.ok).toBe(true);
    // mysql 方言：date 属性写进库里的是 UTC 串
    const rows = await mysqlDriver.select("hr_sys", "appointment", ["valid_from", "valid_to"], [{ column: "person_no", op: "eq", value: "P001" }]);
    const newRow = rows.find((r) => typeof r.valid_from === "string");
    expect(newRow).toBeDefined();
    expect(String(newRow!.valid_from)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // sqlite 方言：照旧写 Unix 秒数字
    const liteDriver = freshDriver();
    await runAction(config, liteDriver, { action: "transfer_post", object: "person", identity: "P001", request: { title: "主管", dept: "D02" } });
    const rows2 = await liteDriver.select("hr_sys", "appointment", ["valid_from"], [{ column: "person_no", op: "eq", value: "P001" }]);
    expect(rows2.every((r) => typeof r.valid_from === "number")).toBe(true);
  });

  it("操作数 { property } 点错名/取不到值是 EngineReject（422），不是裸 500", async () => {
    // ghost_prop 不存在：值侧错名与键侧同口径
    await expect(q({ object: "equipment", filter: { name: { ne: { property: "ghost_prop" } } } })).rejects.toThrow(EngineReject);
    // dept 对部分个体无值（在途设备没映射到部门）：同样 EngineReject 而非裸 Error
    await expect(q({ object: "equipment", filter: { name: { ne: { property: "dept" } } } })).rejects.toThrow(EngineReject);
  });

  it("派生求值中的源库故障不被误报成 422（基础设施故障原样上抛）", async () => {
    class Fault extends SqliteFixtureDriver {
      override async select(c: string, t: string, cols: string[], conds: import("../lib/engine/driver").Condition[], limit?: number) {
        if (c === "asset_sys") throw new Error("库宕了");
        return super.select(c, t, cols, conds, limit);
      }
    }
    const driver = new Fault();
    seedDemo(driver);
    // in_warranty 派生经 $link covers 查 asset_sys.warranty_card：源库故障必须原样上抛，不能包成 EngineReject
    const err = await runQuery(config, driver, { object: "equipment", identity: "SN-40000", properties: ["in_warranty"] }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(EngineReject);
  });

  it("date 过滤下推按方言归一：mysql 绑 UTC 串，sqlite 绑秒（读侧与写回同规则）", async () => {
    const seen: unknown[] = [];
    class SpyMysql extends SqliteFixtureDriver {
      override readonly dialect = "mysql" as const;
      override async select(c: string, t: string, cols: string[], conds: import("../lib/engine/driver").Condition[], limit?: number) {
        for (const c2 of conds) seen.push(c2.value);
        return super.select(c, t, cols, conds, limit);
      }
    }
    const mysqlDriver = new SpyMysql();
    seedDemo(mysqlDriver);
    // 只断言绑参形态（fixture 内层是 INTEGER 秒，mysql 方言的串绑参查不到行是当然的——这里验的是下推归一）
    await runQuery(config, mysqlDriver, { object: "assignment", filter: { valid_from: { gte: "2025-01-01" } } });
    expect(seen.some((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v as string))).toBe(true);
    // sqlite 对照：绑定的是 Unix 秒数字
    const seen2: unknown[] = [];
    class SpySqlite extends SqliteFixtureDriver {
      override async select(c: string, t: string, cols: string[], conds: import("../lib/engine/driver").Condition[], limit?: number) {
        for (const c2 of conds) seen2.push(c2.value);
        return super.select(c, t, cols, conds, limit);
      }
    }
    const liteDriver = new SpySqlite();
    seedDemo(liteDriver);
    await runQuery(config, liteDriver, { object: "assignment", filter: { valid_from: { gte: "2025-01-01" } } });
    expect(seen2.some((v) => typeof v === "number")).toBe(true);
  });

  it("create 幂等：补偿重发不重复插（已有行的源跳过）", async () => {
    class FaultDriver extends SqliteFixtureDriver {
      fail = true;
      async insert(connection: string, table: string, row: Record<string, unknown>) {
        if (this.fail && table === "device") throw new Error("注入故障");
        return super.insert(connection, table, row);
      }
    }
    const d = new FaultDriver();
    seedDemo(d);
    await runAction(config, d, { action: "convert", object: "equipment", identity: "SN-40217" }); // device 失败、asset/warranty 成功
    d.fail = false;
    const retry = await runAction(config, d, { action: "convert", object: "equipment", identity: "SN-40217" });
    expect(retry.ok).toBe(true);
    const cards = await runQuery(config, d, { object: "warranty_card", filter: { serial_no: "SN-40217" } });
    expect(cards.rows.length).toBe(1); // 不是两张
  });

  it("generate 的 { property, from } 项按点名的属性取值", async () => {
    const v = await generateValue("c", "p", { type: "string", generate: [{ property: "title", from: "request" }] }, { request: { title: "经理" } });
    expect(v).toBe("经理");
    await expect(generateValue("c", "p", { type: "string", generate: [{ property: "nope", from: "request" }] }, { request: {} })).rejects.toThrow(); // 缺参不拼 "undefined"
  });

  it("in 的元素级解析：ISO 日期串也能命中", async () => {
    expect((await q({ object: "assignment", filter: { valid_from: { in: ["2025-01-01"] } } })).rows.length).toBe(1);
  });

  it("order 键必须在返回属性里；关系必须 match/transition 二选一且必居其一", async () => {
    await expect(q({ object: "equipment", properties: ["name"], order: { serial_no: "asc" } })).rejects.toThrow();
    expect(() => configSchema.parse({ object_types: {}, link_types: { bad: { from: "a", to: "b" } } })).toThrow();
  });

  it("转化关系不支持嵌套展开，拒绝", async () => {
    const driver = freshDriver();
    await runAction(config, driver, { action: "convert", object: "equipment", identity: "SN-40217" });
    await expect(
      runQuery(config, driver, {
        object: "equipment",
        identity: "SN-40217",
        expand: [{ relation: "converted", properties: ["serial_no"], expand: [{ relation: "belongs_to" }] }],
      })
    ).rejects.toThrow();
  });

  it("效应取值缺请求参数：报错指到缺哪个参数", async () => {
    const res = await runAction(config, freshDriver(), {
      action: "register", object: "equipment", identity: "SN-90003", request: { dept: "D07" }, // 缺 name
    });
    expect(res.ok).toBe(false);
    expect(res.projections.some((p) => p.error?.includes("缺参数：name"))).toBe(true);
  });
});
