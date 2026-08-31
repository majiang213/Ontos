// applyOp 直测：解释器只做内存修改——手工 DraftState + published 即可，不经队列、不碰元库。
// save_* 的落库在 editDraft 的界面状态分流（editDraft.test 的 rev 纪律覆盖），这里证「改内存」这一半。

import { describe, expect, it } from "vitest";
import { applyOp } from "../server/features/ontology/ops";
import type { DraftState } from "../server/features/ontology/canvasPack";
import type { OntologyConfig } from "../server/schema/config";
import { applyVerdict } from "../server/features/integrate/applyVerdict";
import { Verdict } from "../server/schema/verdict";
import { classStages } from "../server/features/ontology/stages";

const published = { object_types: {}, link_types: {} } as OntologyConfig;

const freshState = (): DraftState => ({
  draft: {
    object_types: {
      a: { kind: "thing", properties: { x: { type: "string" } } },
      b: { kind: "thing", properties: { y: { type: "string" } } },
    },
    link_types: { belongs_to: { from: "a", to: "b", match: [{ from: "x", to: "y" }] } },
  } as unknown as DraftState["draft"],
  baseVersion: 1,
  dirty: false,
  layout: {},
  edgeBends: {},
  edgePins: {},
});

describe("applyOp（脱离队列与元库直测）", () => {
  it("save_layout / save_edge_bend 只改内存；关系不存在则 DraftReject", () => {
    const state = freshState();
    applyOp(state, { op: "save_layout", positions: { equipment: { x: 1, y: 2 } } }, published);
    expect(state.layout.equipment).toEqual({ x: 1, y: 2 });
    applyOp(state, { op: "save_edge_bend", name: "belongs_to", bend: { dx: 3, dy: 4 } }, published);
    expect(state.edgeBends.belongs_to).toEqual({ dx: 3, dy: 4 });
    applyOp(state, { op: "save_edge_bend", name: "belongs_to", bend: null }, published);
    expect(state.edgeBends.belongs_to).toBeUndefined(); // null = 拉直
    expect(() => applyOp(state, { op: "save_edge_bend", name: "ghost", bend: null }, published)).toThrow(/关系不存在/);
  });

  it("建链拒机器拼名：{from}_to_{to} / {from}_{to} 是拼出来的形状，不是领域谓词（T3）", () => {
    const state = freshState();
    for (const name of ["a_to_b", "a_b"]) {
      try {
        applyOp(state, { op: "create_link", name, from: "a", to: "b", match: { from: "x", to: "y" } }, published);
        expect.unreachable(`应拒机器拼名 ${name}`);
      } catch (e) {
        expect((e as Error).message).toContain("机器拼接");
      }
    }
    expect(state.draft.link_types.a_to_b).toBeUndefined();
    // 领域谓词名照常建
    applyOp(state, { op: "create_link", name: "serves_a", from: "a", to: "b", match: { from: "x", to: "y" } }, published);
    expect(state.draft.link_types.serves_a).toBeDefined();
  });

  it("钉点随建线/改接同车：create_link 写 edgePins；update_link 按端合并（改名写新名）", () => {
    const state = freshState();
    applyOp(
      state,
      { op: "create_link", name: "l1", from: "a", to: "b", match: { from: "x", to: "y" }, pins: { source: { side: "top", t: 0.5 }, target: { side: "left", t: 0.2 } } },
      published
    );
    expect(state.edgePins.l1).toEqual({ source: { side: "top", t: 0.5 }, target: { side: "left", t: 0.2 } });
    // 改接按端合并：只给 target，source 端不动
    applyOp(state, { op: "update_link", name: "l1", pins: { target: { side: "right", t: 0.9 } } }, published);
    expect(state.edgePins.l1).toEqual({ source: { side: "top", t: 0.5 }, target: { side: "right", t: 0.9 } });
    // 改名：钉点写在新名下；弯折与钉点都跟边改名走（不成孤儿）
    applyOp(state, { op: "save_edge_bend", name: "l1", bend: { dx: 5, dy: 6 } }, published);
    applyOp(state, { op: "update_link", name: "l1", new_name: "l2", pins: { source: { side: "bottom", t: 0.1 } } }, published);
    expect(state.edgePins.l2).toEqual({ source: { side: "bottom", t: 0.1 }, target: { side: "right", t: 0.9 } });
    expect(state.edgePins.l1).toBeUndefined();
    expect(state.edgeBends.l2).toEqual({ dx: 5, dy: 6 });
    expect(state.edgeBends.l1).toBeUndefined();
  });

  it("save_layout 带 clear_bends/clear_pins：整理布局一把清空弯折与钉点（拖动存摆位不带旗标，不清）", () => {
    const state = freshState();
    applyOp(state, { op: "save_edge_bend", name: "belongs_to", bend: { dx: 1, dy: 2 } }, published);
    applyOp(state, { op: "update_link", name: "belongs_to", pins: { source: { side: "top", t: 0.5 } } }, published); // 钉点随改接同车写入
    applyOp(state, { op: "save_layout", positions: { a: { x: 1, y: 1 } } }, published);
    expect(state.edgeBends.belongs_to).toEqual({ dx: 1, dy: 2 }); // 不带旗标不动
    expect(state.edgePins.belongs_to).toEqual({ source: { side: "top", t: 0.5 } });
    applyOp(state, { op: "save_layout", positions: { a: { x: 2, y: 2 } }, clear_bends: true, clear_pins: true }, published);
    expect(state.edgeBends).toEqual({});
    expect(state.edgePins).toEqual({});
  });

  it("内容 op 同样只改内存：create_object 落草稿，重复名 DraftReject", () => {
    const state = freshState();
    applyOp(state, { op: "create_object", name: "vendor", kind: "thing" }, published);
    expect(state.draft.object_types.vendor.kind).toBe("thing");
    expect(() => applyOp(state, { op: "create_object", name: "vendor", kind: "thing" }, published)).toThrow(/类已存在/);
  });

  it("update_object 改类名：关系两端、摆位跟着走", () => {
    const state = freshState();
    state.layout.a = { x: 10, y: 20 };
    applyOp(state, { op: "update_object", name: "a", new_name: "asset" }, published);
    expect(state.draft.object_types.a).toBeUndefined();
    expect(state.draft.object_types.asset).toBeDefined();
    expect(state.draft.link_types.belongs_to.from).toBe("asset");
    expect(state.layout.asset).toEqual({ x: 10, y: 20 });
    expect(state.layout.a).toBeUndefined();
  });

  it("update_object 改类名：动作里 pre 与效应过滤的 $link 键跟着换", () => {
    const state = freshState();
    state.draft.link_types.a_to_in_service = {
      from: "a",
      to: "a",
      inverse: "a_from_in_transit",
      card: "1:1",
      transition: { property: "status", from: "in_transit", to: "in_service" },
    };
    state.draft.object_types.a.actions = {
      convert_to_in_service: {
        description: "转化为in_service",
        pre: { status: "in_transit", $link: { a_to_in_service: false } },
        effect: [
          { link: "a_to_in_service" },
          { update: { object: "a", identity: { from: "identity" }, properties: { name: { from: "request" } }, filter: { $link: { a_to_in_service: true } } } },
        ],
      },
    };
    applyOp(state, { op: "update_object", name: "a", new_name: "asset" }, published);
    const act = state.draft.object_types.asset.actions!.convert_to_in_service;
    expect(state.draft.link_types.asset_to_in_service).toBeDefined();
    expect((act.pre as Record<string, unknown>).$link).toEqual({ asset_to_in_service: false });
    const upd = act.effect!.find((e) => "update" in e)! as { update: { filter: Record<string, unknown> } };
    expect(upd.update.filter).toEqual({ $link: { asset_to_in_service: true } }); // 效应过滤里的 $link 键跟着换
  });
});

describe("edit_stages（改时期名与较早来源，转化跟着走）", () => {
  function staged(): DraftState {
    const draft: OntologyConfig = {
      object_types: {
        po: {
          kind: "thing",
          identity: "sn",
          properties: { sn: { type: "string" }, name: { type: "string" } },
          sources: { sa: { connection: "purchase_sys", table: "po_item", fields: { sn: "sn", name: "item_name" } } },
        },
        dev: {
          kind: "thing",
          identity: "sn",
          properties: { sn: { type: "string" }, name: { type: "string" } },
          sources: { sb: { connection: "device_sys", table: "device", fields: { sn: "serial_no", name: "name" } } },
        },
      },
      link_types: {},
    };
    applyVerdict(draft, { class_a: "po", class_b: "dev" }, Verdict.Stage, { from: "in_transit", to: "in_service" });
    return { draft, baseVersion: 1, dirty: false, layout: {}, edgeBends: {}, edgePins: {} };
  }

  it("改时期名：派生取值、转化边、动作名一次换完", () => {
    const state = staged();
    const items = classStages(state.draft, "po")!.items.map((it) => ({
      value: it.value === "in_transit" ? "candidate" : it.value === "in_service" ? "employed" : it.value,
      when: it.when,
    }));
    applyOp(state, { op: "edit_stages", object: "po", items }, published);
    expect(classStages(state.draft, "po")!.items.map((i) => i.value)).toEqual(["candidate", "employed"]);
    expect(state.draft.object_types.po.properties.status.values).toEqual(["candidate", "employed"]);
    expect(state.draft.link_types.po_to_employed.transition).toEqual({ property: "status", from: "candidate", to: "employed" });
    expect(state.draft.object_types.po.actions!.convert_to_employed).toBeDefined();
    expect(state.draft.object_types.po.actions!.convert_to_in_service).toBeUndefined();
  });

  it("时期中文名：随 edit_stages 落值域；改标识不丢中文名；缺了=清掉", () => {
    const state = staged();
    const withLabels = classStages(state.draft, "po")!.items.map((it, i) => ({
      value: it.value,
      when: it.when,
      label: ["候选", "在职"][i],
    }));
    applyOp(state, { op: "edit_stages", object: "po", items: withLabels }, published);
    const values = state.draft.object_types.po.properties.status.values;
    expect(values).toEqual([
      { value: "in_transit", label: "候选" },
      { value: "in_service", label: "在职" },
    ]);

    // 改标识：值域里中文名跟着这个时期走
    const renamed = withLabels.map((it) => (it.value === "in_transit" ? { ...it, value: "candidate" } : it));
    applyOp(state, { op: "edit_stages", object: "po", items: renamed }, published);
    expect(state.draft.object_types.po.properties.status.values).toEqual([
      { value: "candidate", label: "候选" },
      { value: "in_service", label: "在职" },
    ]);

    // 缺 label = 清掉；全无中文名时值域退回裸字符串形状
    const cleared = renamed.map((it) => ({ value: it.value, when: it.when }));
    applyOp(state, { op: "edit_stages", object: "po", items: cleared }, published);
    expect(state.draft.object_types.po.properties.status.values).toEqual(["candidate", "in_service"]);
  });

  it("手写转化动作（不止一条效应）只改时期名，不整条换成骨架", () => {
    const state = staged();
    const extra = {
      description: "转化并登记",
      pre: { status: "in_transit" },
      effect: [{ link: "po_to_in_service" }, { create: { object: "po", properties: { name: { from: "request" } } } }],
    };
    state.draft.object_types.po.actions = { convert: extra as never };
    const items = classStages(state.draft, "po")!.items.map((it) => ({
      value: it.value === "in_transit" ? "candidate" : it.value === "in_service" ? "employed" : it.value,
      when: it.when,
    }));
    applyOp(state, { op: "edit_stages", object: "po", items }, published);
    expect(state.draft.object_types.po.actions!.convert.effect).toHaveLength(2);
    expect((state.draft.object_types.po.actions!.convert.pre as { status: string }).status).toBe("candidate");
    expect(state.draft.object_types.po.actions!.convert_to_employed).toBeUndefined();
  });

  it("自动名的转化动作被人改过：改时期名只换键与引用，不整条覆盖（前置与效应过滤的 $link 跟着换）", () => {
    const state = staged();
    const act = state.draft.object_types.po.actions!.convert_to_in_service;
    act.description = "转为在役（手工备注）";
    act.pre = { status: "in_transit", $link: { po_to_in_service: false }, warranty: "有" };
    act.effect = [
      { link: "po_to_in_service" },
      { update: { object: "po", identity: { from: "identity" }, properties: { name: { from: "request" } }, filter: { $link: { po_to_in_service: true } } } },
    ];
    const items = classStages(state.draft, "po")!.items.map((it) => ({
      value: it.value === "in_transit" ? "candidate" : it.value === "in_service" ? "employed" : it.value,
      when: it.when,
    }));
    applyOp(state, { op: "edit_stages", object: "po", items }, published);
    const a = state.draft.object_types.po.actions!.convert_to_employed;
    expect(a).toBeDefined();
    expect(state.draft.object_types.po.actions!.convert_to_in_service).toBeUndefined(); // 键名跟随新时期
    expect(a.description).toBe("转为在役（手工备注）"); // 改过的字不丢
    expect(a.pre).toEqual({ status: "candidate", $link: { po_to_employed: false }, warranty: "有" }); // 时期值与关系引用跟着换
    const upd = a.effect!.find((e) => "update" in e)! as { update: { filter: Record<string, unknown> } };
    expect(upd.update.filter).toEqual({ $link: { po_to_employed: true } }); // 效应过滤里的 $link 键跟着换
  });

  it("when 条件等价与键序无关：异序同条件判重复、改名映射不丢", () => {
    const state = staged();
    const status = state.draft.object_types.po.properties.status;
    (status.derived as { when: Record<string, unknown>; value: string }[]) = [
      { when: { purchase: true, device: false }, value: "in_transit" },
      { when: { device: true }, value: "in_service" },
    ];
    const cur = classStages(state.draft, "po")!;
    // 异序同条件 → 条件重复被拒（键序不同的同一份条件是同一条）
    expect(() =>
      applyOp(state, { op: "edit_stages", object: "po", items: [
        { value: "x", when: cur.items[0].when },
        { value: "y", when: { device: false, purchase: true } },
      ] }, published)
    ).toThrow(/条件重复/);
    // 改名映射不因键序丢失：两键条件异序仍认出是同一条
    const items = cur.items.map((it) => ({
      value: it.value === "in_transit" ? "candidate" : it.value,
      when: it.value === "in_transit" ? { device: false, purchase: true } : it.when,
    }));
    applyOp(state, { op: "edit_stages", object: "po", items }, published);
    expect(classStages(state.draft, "po")!.items.map((i) => i.value)).toEqual(["candidate", "in_service"]);
    expect(state.draft.link_types.po_to_in_service.transition).toEqual({ property: "status", from: "candidate", to: "in_service" });
  });

  it("三条阶段：改一条名，报废规则还在", () => {
    const state = staged();
    const status = state.draft.object_types.po.properties.status;
    status.values = ["in_transit", "in_service", "scrapped"];
    (status.derived as { when: Record<string, unknown>; value: string }[]).push({ when: { sb: { mark: "scrapped" } }, value: "scrapped" });
    const items = classStages(state.draft, "po")!.items.map((it) => ({
      value: it.value === "in_service" ? "online" : it.value,
      when: it.when,
    }));
    expect(items).toHaveLength(3);
    applyOp(state, { op: "edit_stages", object: "po", items }, published);
    expect(classStages(state.draft, "po")!.items.map((i) => i.value)).toEqual(["in_transit", "online", "scrapped"]);
    expect((state.draft.object_types.po.properties.status.derived as { value: string }[]).map((r) => r.value)).toEqual(["in_transit", "online", "scrapped"]);
  });
});
