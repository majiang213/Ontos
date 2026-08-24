// applyOp 直测：解释器只做内存修改——手工 DraftState + published 即可，不经队列、不碰元库。
// save_* 的落库在 applyDraft 的界面状态分流（configStore.test 的 rev 纪律覆盖），这里证「改内存」这一半。

import { describe, expect, it } from "vitest";
import { applyOp } from "../server/engine/config/applyOp";
import type { DraftState } from "../server/engine/config/pack";
import type { OntologyConfig } from "../server/schema/config";

const published = { object_types: {}, link_types: {} } as OntologyConfig;

const freshState = (): DraftState => ({
  draft: {
    object_types: {},
    link_types: { belongs_to: { from: "a", to: "b", match: [{ from: "x", to: "y" }] } },
  } as unknown as DraftState["draft"],
  baseVersion: 1,
  dirty: false,
  layout: {},
  edgeBends: {},
  edgePins: {},
});

describe("applyOp（脱离队列与元库直测）", () => {
  it("save_layout / save_edge_bend / save_edge_pin 只改内存；关系不存在则 DraftReject", () => {
    const state = freshState();
    applyOp(state, { op: "save_layout", positions: { equipment: { x: 1, y: 2 } } }, published);
    expect(state.layout.equipment).toEqual({ x: 1, y: 2 });
    applyOp(state, { op: "save_edge_bend", name: "belongs_to", bend: { dx: 3, dy: 4 } }, published);
    expect(state.edgeBends.belongs_to).toEqual({ dx: 3, dy: 4 });
    applyOp(state, { op: "save_edge_bend", name: "belongs_to", bend: null }, published);
    expect(state.edgeBends.belongs_to).toBeUndefined(); // null = 拉直
    applyOp(state, { op: "save_edge_pin", name: "belongs_to", end: "source", pin: { side: "top", t: 0.5 } }, published);
    expect(state.edgePins.belongs_to).toEqual({ source: { side: "top", t: 0.5 } });
    expect(() => applyOp(state, { op: "save_edge_bend", name: "ghost", bend: null }, published)).toThrow(/关系不存在/);
  });

  it("内容 op 同样只改内存：create_object 落草稿，重复名 DraftReject", () => {
    const state = freshState();
    applyOp(state, { op: "create_object", name: "vendor", kind: "thing" }, published);
    expect(state.draft.object_types.vendor.kind).toBe("thing");
    expect(() => applyOp(state, { op: "create_object", name: "vendor", kind: "thing" }, published)).toThrow(/类已存在/);
  });
});
