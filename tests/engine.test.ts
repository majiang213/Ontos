// 引擎 golden 测试 —— 覆盖演示剧本的每一拍。
// 配置是附录 C 种子；源库是 SQLite fixture；断言全部对着文章的预期行为。

import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configSchema } from "../lib/schema/config";
import { runQuery } from "../lib/engine/query";
import { runAction } from "../lib/engine/action";
import { freshDriver } from "../lib/engine/load";
import type { QueryRequest } from "../lib/schema/request";

const config = configSchema.parse(load(readFileSync(join(process.cwd(), "lib/config/ontology.yaml"), "utf8")));

const q = (req: QueryRequest) => runQuery(config, freshDriver(), req);

describe("M7 查询", () => {
  it("在役设备：派生 status 按 when 规则判定", () => {
    const { rows } = q({ object: "equipment", properties: ["name", "status"], filter: { status: "in_service" } });
    expect(rows.length).toBe(97); // 40 台重合 - 3 台报废 + 60 台设备独有
    expect(rows.every((r) => r.status === "in_service")).toBe(true);
  });

  it("在途设备：采购源有行、设备源无行", () => {
    const { rows } = q({ object: "equipment", properties: ["serial_no"], filter: { status: "in_transit" } });
    expect(rows.length).toBe(81); // 121 - 40
  });

  it("报废规则排在在役前面", () => {
    const { rows } = q({ object: "equipment", properties: ["serial_no"], filter: { status: "scrapped" } });
    expect(rows.length).toBe(3);
  });

  it("identity 认准一台；同名属性按声明顺序取（采购源优先）", () => {
    const { rows } = q({ object: "equipment", identity: "SN-40085", properties: ["name", "status"] });
    expect(rows).toEqual([{ name: "精密机床-86号", status: "in_service" }]); // purchase 声明在前
  });

  it("expand 沿 match 进入部门；反向名 has_equipment 从部门查设备", () => {
    const { rows } = q({
      object: "equipment",
      properties: ["name"],
      filter: { status: "in_service" },
      expand: [{ relation: "belongs_to", properties: ["name"] }],
    });
    expect(rows[0].belongs_to).toEqual([{ name: expect.any(String) }]);

    const back = q({ object: "department", identity: "D01", expand: [{ relation: "has_equipment", properties: ["serial_no"] }] });
    expect((back.rows[0].has_equipment as unknown[]).length).toBeGreaterThan(0);
  });

  it("聚合：按部门分组数设备", () => {
    const { rows } = q({
      object: "equipment",
      filter: { status: "in_service" },
      aggregate: { group_by: ["dept"], metrics: [{ count: "*" }] },
    });
    expect(rows.length).toBe(8);
    expect(rows.reduce((a, r) => a + (r.count as number), 0)).toBe(97);
  });

  it("名字对不上配置，引擎拒绝", () => {
    expect(() => q({ object: "equipment", filter: { no_such_prop: 1 } })).toThrow();
    expect(() => q({ object: "no_such_class" })).toThrow();
  });

  it("时间区间履历：生效日不晚于当天、失效日空按至今", () => {
    const D = Math.floor(Date.UTC(2025, 5, 1) / 1000);
    const { rows } = q({
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
  it("验收一台在途设备：设备源、资产源各插一行，立一张保修卡；再读已在役、在保、转化成立", () => {
    const driver = freshDriver();
    const res = runAction(config, driver, { action: "convert", object: "equipment", identity: "SN-40217" });
    expect(res.ok).toBe(true);
    expect(res.projections.filter((p) => p.ok).length).toBe(3);

    const after = runQuery(config, driver, {
      object: "equipment",
      identity: "SN-40217",
      properties: ["status", "in_warranty"],
      filter: { status: "in_service" },
    });
    expect(after.rows).toEqual([{ status: "in_service", in_warranty: true }]);

    // 转化关系成立：出发阶段的源有行，到达阶段整条命中
    const linked = runQuery(config, driver, { object: "equipment", identity: "SN-40217", filter: { $link: { converted: true } } });
    expect(linked.rows.length).toBe(1);
  });

  it("重复验收被前置拦下：阶段不再是在途", () => {
    const driver = freshDriver();
    runAction(config, driver, { action: "convert", object: "equipment", identity: "SN-40217" });
    const again = runAction(config, driver, { action: "convert", object: "equipment", identity: "SN-40217" });
    expect(again.ok).toBe(false);
    expect(again.stage).toBe("pre");
  });

  it("调拨：新部门必须能认到、不得与当前相同；成功后部门改掉", () => {
    const driver = freshDriver();
    const badDept = runAction(config, driver, {
      action: "transfer", object: "equipment", identity: "SN-40085", request: { dept: "D99" },
    });
    expect(badDept.ok).toBe(false); // D99 认不到部门

    const sameDept = runAction(config, driver, {
      action: "transfer", object: "equipment", identity: "SN-40085", request: { dept: "D06" },
    });
    expect(sameDept.ok).toBe(false); // 与当前相同

    const okRes = runAction(config, driver, {
      action: "transfer", object: "equipment", identity: "SN-40085", request: { dept: "D07" },
    });
    expect(okRes.ok).toBe(true);
    const after = runQuery(config, driver, { object: "equipment", identity: "SN-40085", properties: ["dept"] });
    expect(after.rows[0].dept).toBe("D07");
  });

  it("报废：改的是源列属性 mark，派生 status 随后算成报废；报废不能再报废", () => {
    const driver = freshDriver();
    expect(runAction(config, driver, { action: "scrap", object: "equipment", identity: "SN-40085" }).ok).toBe(true);
    const after = runQuery(config, driver, { object: "equipment", identity: "SN-40085", properties: ["status"] });
    expect(after.rows[0].status).toBe("scrapped");
    expect(runAction(config, driver, { action: "scrap", object: "equipment", identity: "SN-40085" }).ok).toBe(false);
  });

  it("登记：$exists 为假才放行；只插映射了全部所赋属性的源", () => {
    const driver = freshDriver();
    const dup = runAction(config, driver, {
      action: "register", object: "equipment", identity: "SN-40085", request: { name: "x", dept: "D07" },
    });
    expect(dup.ok).toBe(false); // 已有个体不当新生

    const res = runAction(config, driver, {
      action: "register", object: "equipment", identity: "SN-90001", request: { name: "新机床", dept: "D07" },
    });
    expect(res.ok).toBe(true);
    expect(res.projections.length).toBe(1); // 采购、资产缺 dept，不插
    expect(res.projections[0].source).toBe("device");
  });

  it("结束维修：前置用设备出发的关系名，效应过滤落在维修自己的字段上", () => {
    const driver = freshDriver();
    const res = runAction(config, driver, { action: "finish_repair", object: "equipment", identity: "SN-40085" });
    expect(res.ok).toBe(true);
    const repairs = runQuery(config, driver, { object: "repair", filter: { serial_no: "SN-40085" }, properties: ["is_open"] });
    expect(repairs.rows[0].is_open).toBe(false);
  });

  it("调岗：关旧任职、开新任职，任职编号按 generate 发出", () => {
    const driver = freshDriver();
    const res = runAction(config, driver, {
      action: "transfer_post", object: "person", identity: "P001", request: { title: "经理", dept: "D07" },
    });
    expect(res.ok).toBe(true);
    const after = runQuery(config, driver, {
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

  it("配置里没有的动作，引擎拒绝", () => {
    const res = runAction(config, freshDriver(), { action: "fly", object: "equipment", identity: "SN-40085" });
    expect(res.ok).toBe(false);
  });
});
