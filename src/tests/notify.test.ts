// 变更事件生成（buildNotifications）直测：不跑完整动作执行，直接钉事件形状。
// 钉的点：change_id 合成规则（identity 已填用之；没填按声明顺序 | 拼接）、条目的 op/object_class/target、
// create 只读计划的 createTarget（识别值在 planEffect 定死，执行链覆盖）、link 的 target 是请求识别值、投影失败进 note。

import { describe, expect, it } from "vitest";
import { buildNotifications } from "../server/engine/action/notify";
import type { Planned, ProjectionRecord } from "../server/engine/action/action";
import type { ActionDef, OntologyConfig } from "../server/schema/config";
import type { ActionRequest } from "../server/schema/request";
import type { EvalContext } from "../server/engine/query/expr";
import type { Cls, Individual } from "../server/engine/query/individual";

const config = {
  object_types: {
    change: {
      kind: "event",
      identity: "change_id",
      properties: {
        change_id: { type: "string" },
        action_name: { type: "string" },
        object_class: { type: "string" },
        target: { type: "string" },
      },
    },
    equipment: { kind: "thing", identity: "serial_no", properties: { serial_no: { type: "string" }, mark: { type: "string" } } },
    warranty_card: { kind: "thing", identity: "serial_no", properties: { serial_no: { type: "string" } } },
  },
  link_types: {},
} as unknown as OntologyConfig;

const cls = (name: string): Cls => ({ name, def: config.object_types[name] });
const ind = (key: string): Individual => ({ key, rows: {} });
const okProj: ProjectionRecord[] = [{ source: "s", table: "t", op: "update", ok: true }];

const action = (properties: Record<string, any>): ActionDef => ({
  effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { mark: "x" } } }],
  inform: [{ object: "change", to: ["out1"], properties }],
});

const req: ActionRequest = { action: "scrap", object: "equipment", identity: "SN-1" };
const ctx: EvalContext = { identity: "SN-1", action: "scrap", object: "equipment", request: {} };

describe("buildNotifications（变更事件形状）", () => {
  it("identity 没填：全部已解析值按声明顺序 | 拼接成 change_id；条目逐目标带 change_id 与 line_id", () => {
    const plan: Planned[] = [
      { kind: "update", cls: cls("equipment"), targets: [ind("SN-1"), ind("SN-2")], setSpec: { mark: "scrapped" } },
    ];
    const [n] = buildNotifications(config, action({ action_name: { from: "action" }, object_class: { from: "object" }, target: { from: "identity" } }), plan, req, ctx, okProj);
    expect(n.properties).toEqual({ action_name: "scrap", object_class: "equipment", target: "SN-1", change_id: "scrap|equipment|SN-1" });
    expect(n.lines).toEqual([
      { op: "update", object_class: "equipment", target: "SN-1", change_id: "scrap|equipment|SN-1", line_id: "scrap|equipment|SN-1#1" },
      { op: "update", object_class: "equipment", target: "SN-2", change_id: "scrap|equipment|SN-1", line_id: "scrap|equipment|SN-1#2" },
    ]);
    expect(n.delivered).toBe(false);
    expect(n.note).not.toContain("有投影失败");
  });

  it("identity 已填：用之，不合成；请求参数取值", () => {
    const [n] = buildNotifications(
      config,
      action({ change_id: { from: "request" }, action_name: { from: "action" } }),
      [{ kind: "delete", cls: cls("equipment"), targets: [ind("SN-1")] }],
      { ...req, request: { change_id: "CHG-7" } },
      { ...ctx, request: { change_id: "CHG-7" } },
      okProj
    );
    expect(n.properties.change_id).toBe("CHG-7");
    expect(n.lines).toEqual([{ op: "delete", object_class: "equipment", target: "SN-1", change_id: "CHG-7", line_id: "CHG-7#1" }]);
  });

  it("合成跳过：有解析值为 null 时 change_id 缺省，条目不补 change_id/line_id", () => {
    const [n] = buildNotifications(
      config,
      action({ action_name: { from: "action" }, object_class: null }), // null 字面量：全值含 null，不拼
      [{ kind: "delete", cls: cls("equipment"), targets: [ind("SN-1")] }],
      req,
      ctx,
      okProj
    );
    expect(n.properties.change_id).toBeUndefined();
    expect(n.lines).toEqual([{ op: "delete", object_class: "equipment", target: "SN-1" }]);
  });

  it("create：target 只读计划的 createTarget（generated 的 null 是计划时就定好的结论）", () => {
    const plan: Planned[] = [
      { kind: "create", cls: cls("warranty_card"), propSpec: { serial_no: "WC-9" }, createTarget: "WC-9" },
      { kind: "create", cls: cls("warranty_card"), propSpec: { serial_no: { from: "generated" } }, createTarget: null },
    ];
    const [n] = buildNotifications(config, action({ action_name: { from: "action" } }), plan, req, ctx, okProj);
    expect(n.lines.map((l) => [l.op, l.object_class, l.target])).toEqual([
      ["create", "warranty_card", "WC-9"],
      ["create", "warranty_card", null],
    ]);
  });

  it("link：object_class 取计划带的类，target 是请求识别值；投影失败进 note", () => {
    const plan: Planned[] = [{ kind: "link", cls: cls("equipment"), linkName: "converted", subject: ind("SN-1") }];
    const [n] = buildNotifications(config, action({ action_name: { from: "action" } }), plan, req, ctx, [
      { source: "-", table: "-", op: "update", ok: false, error: "x" },
    ]);
    expect(n.lines.map((l) => [l.op, l.object_class, l.target])).toEqual([["link", "equipment", "SN-1"]]);
    expect(n.note).toContain("有投影失败");
  });
});
