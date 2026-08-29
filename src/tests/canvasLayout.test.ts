// 画布自动布局：无关系时均匀网格（别排成一条线），有关系时 dagre 分层（被引用方在上）。
import { describe, expect, it } from "vitest";
import { layoutObjects, NODE_W, type CanvasLink, type CanvasObject } from "../components/canvas/layout";
import { overlapLinksOf } from "../components/canvas/sharedOrigin";

const obj = (name: string): CanvasObject => ({
  name,
  kind: "thing",
  properties: [{ name: "name", type: "string", derived: false }],
  sources: [],
  actions: [],
});

describe("无关系布局（均匀网格）", () => {
  it("6 个对象排成 3 列 × 2 行，行列等距、互不重叠", () => {
    const pos = layoutObjects([1, 2, 3, 4, 5, 6].map((i) => obj(`o${i}`)), []);
    expect(pos.size).toBe(6);
    const xs = [...pos.values()].map((p) => p.x);
    const ys = [...pos.values()].map((p) => p.y);
    // 3 列：同列 x 相同，列距 = NODE_W + 80
    expect(new Set(xs).size).toBe(3);
    const colXs = [...new Set(xs)].sort((a, b) => a - b);
    expect(colXs[1] - colXs[0]).toBe(NODE_W + 80);
    expect(colXs[2] - colXs[1]).toBe(NODE_W + 80);
    // 2 行：行距一致，且任何两节点不重叠
    expect(new Set(ys).size).toBe(2);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
  });

  it("全自环（阶段裁决只有转化关系）也走网格，不排成线", () => {
    const links: CanvasLink[] = [{ name: "convert", from: "o1", to: "o1", kind: "transition" }];
    const pos = layoutObjects([obj("o1"), obj("o2"), obj("o3"), obj("o4")], links);
    // 4 个对象 → 2 列 × 2 行
    expect(new Set([...pos.values()].map((p) => p.x)).size).toBe(2);
    expect(new Set([...pos.values()].map((p) => p.y)).size).toBe(2);
  });
});

describe("有关系布局（dagre 分层）", () => {
  it("被引用方在上：边 目标→来源 反向进图，来源的 y 更小", () => {
    const links: CanvasLink[] = [{ name: "belongs_to", from: "child", to: "parent", kind: "match" }];
    const pos = layoutObjects([obj("parent"), obj("child")], links);
    expect(pos.get("parent")!.y).toBeLessThan(pos.get("child")!.y);
  });

  it("部分有线：没线的对象排到分层区域下方一行，不混进根层", () => {
    const links: CanvasLink[] = [
      { name: "l1", from: "b", to: "a", kind: "match" },
      { name: "l2", from: "d", to: "c", kind: "match" },
    ];
    const objects = ["a", "b", "c", "d", "e", "f"].map(obj);
    const pos = layoutObjects(objects, links);
    const maxConnectedY = Math.max(...["a", "b", "c", "d"].map((n) => pos.get(n)!.y));
    // 两个没线对象都在分层区域下方同一行、等距、互不重叠
    expect(pos.get("e")!.y).toBeGreaterThan(maxConnectedY);
    expect(pos.get("f")!.y).toBe(pos.get("e")!.y);
    expect(pos.get("f")!.x).toBeGreaterThan(pos.get("e")!.x + NODE_W);
  });

  it("由来边把公共对象排到两个原类之上", () => {
    const names = ["asset", "device", "shared_asset_device"];
    const pos = layoutObjects(
      names.map(obj),
      overlapLinksOf([{ kind: "overlap", classes: ["asset", "device"], shared: "shared_asset_device" }])
    );
    expect(pos.get("shared_asset_device")!.y).toBeLessThan(pos.get("asset")!.y);
    expect(pos.get("shared_asset_device")!.y).toBeLessThan(pos.get("device")!.y);
  });
});
