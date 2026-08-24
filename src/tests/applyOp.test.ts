// applyOp 直测：解释器只做内存修改——手工 DraftState + published 即可，不经队列、不碰元库。
// save_* 的落库在 applyDraft 的界面状态分流（configStore.test 的 rev 纪律覆盖），这里证「改内存」这一半。

import { describe, expect, it } from "vitest";
import { applyOp } from "../server/engine/config/applyOp";
import type { DraftState } from "../server/engine/config/pack";
import type { OntologyConfig } from "../server/schema/config";

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

  it("内容 op 同样只改内存：create_object 落草稿，重复名 DraftReject", () => {
    const state = freshState();
    applyOp(state, { op: "create_object", name: "vendor", kind: "thing" }, published);
    expect(state.draft.object_types.vendor.kind).toBe("thing");
    expect(() => applyOp(state, { op: "create_object", name: "vendor", kind: "thing" }, published)).toThrow(/类已存在/);
  });
});
