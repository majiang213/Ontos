// 画布自动布局：无关系时均匀网格（别排成一条线），有关系时 dagre 分层（被引用方在上）。
// ADR 0011：有连线的图一层一行不折行，排完用路由当验收器迭代加宽走廊——0 条线穿节点、取直率达标。
import { describe, expect, it } from "vitest";
import { edgeBlocked, estimateHeight, layoutObjects, NODE_W, type CanvasLink, type CanvasObject } from "../components/canvas/layout";
import { edgePath, type RouteEnd } from "../components/canvas/router";
import { floatingEndsOf, type Pt } from "../components/canvas/geometry";
import { countEdgeCrossings, crosses, samplePath } from "./canvasPath";
import { overlapLinksOf } from "../components/canvas/sharedOrigin";

const obj = (name: string): CanvasObject => ({
  name,
  kind: "thing",
  properties: [{ name: "name", type: "string", derived: false }],
  sources: [],
  actions: [],
});

/** 内容更接近真实节点（多字段/来源/动作/描述/阶段），让估算高度走完整分支。 */
const richObj = (name: string, o: { props?: number; sources?: number; actions?: number; stages?: number; description?: boolean } = {}): CanvasObject => ({
  name,
  kind: "thing",
  description: o.description ? "描述" : undefined,
  properties: Array.from({ length: o.props ?? 1 }, (_, i) => ({ name: `p${i}`, type: "string", derived: false })),
  sources: Array.from({ length: o.sources ?? 0 }, (_, i) => ({ key: `s${i}`, label: `src.t${i}` })),
  actions: Array.from({ length: o.actions ?? 0 }, (_, i) => `act${i}`),
  ...(o.stages ? { stages: { property: "p0", items: Array.from({ length: o.stages }, (_, i) => ({ value: `v${i}`, hint: "h" })), sourceKeys: [] } } : {}),
});

/** 布局位置 + 估算高度 → 节点矩形（pad 外扩可选：验收口径与渲染实测口径）。 */
function rectsOf(pos: Map<string, { x: number; y: number }>, heightOf: Map<string, number>, pad = 0) {
  return [...pos].map(([name, p]) => ({ x: p.x - pad, y: p.y - pad, w: NODE_W + pad * 2, h: (heightOf.get(name) ?? 0) + pad * 2 }));
}

/** 边的浮动附着端点（无钉点）：与 FloatingEdge、布局验收共用 floatingEndsOf——一处定义，不各写口径。 */
function edgeEnds(l: CanvasLink, pos: Map<string, { x: number; y: number }>, heightOf: Map<string, number>): [RouteEnd, RouteEnd] {
  const rect = (name: string) => {
    const p = pos.get(name)!;
    return { x: p.x, y: p.y, w: NODE_W, h: heightOf.get(name)! };
  };
  return floatingEndsOf(rect(l.from), rect(l.to));
}

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

describe("边感知布局（ADR 0011：0 穿节点、取直率、折行纪律）", () => {
  /** demo 种子同形态：被引用方在上，跨两层长边 + 富节点（阶段/动作多）。 */
  const hubObjects = [
    richObj("department", { props: 2, sources: 1, description: true }),
    richObj("person", { props: 2, sources: 1, actions: 1, description: true }),
    richObj("change_line", { props: 5, description: true }),
    richObj("equipment", { props: 5, sources: 3, actions: 6, stages: 3, description: true }),
    richObj("appointment", { props: 7, sources: 1, description: true }),
    richObj("change", { props: 5, description: true }),
    richObj("assignment", { props: 5, sources: 1, description: true }),
    richObj("warranty_card", { props: 2, sources: 1, description: true }),
    richObj("repair", { props: 5, sources: 1, description: true }),
  ];
  const hubLinks: CanvasLink[] = [
    { name: "belongs_to", from: "equipment", to: "department", kind: "match" },
    { name: "of_equipment", from: "assignment", to: "equipment", kind: "match" },
    { name: "of_department", from: "assignment", to: "department", kind: "match" },
    { name: "covers", from: "warranty_card", to: "equipment", kind: "match" },
    { name: "on_equipment", from: "repair", to: "equipment", kind: "match" },
    { name: "held_by", from: "appointment", to: "person", kind: "match" },
    { name: "posted_in", from: "appointment", to: "department", kind: "match" },
    { name: "has_line", from: "change", to: "change_line", kind: "match" },
  ];
  const hubPos = layoutObjects(hubObjects, hubLinks);
  const hubHeight = new Map(hubObjects.map((o) => [o.name, estimateHeight(o)] as const));

  it("0 条线穿节点：每条边的实际渲染路径（edgePath）采样不落进任何节点", () => {
    const rects = rectsOf(hubPos, hubHeight);
    for (const l of hubLinks) {
      const [from, to] = edgeEnds(l, hubPos, hubHeight);
      const { d } = edgePath(from, to, rects);
      expect(crosses(samplePath(d), rects, from.point, to.point), `${l.name} 的路径穿过节点`).toBe(false);
    }
  });

  it("取直率 100%：布局后每条边都直接出曲线，不走绕障", () => {
    for (const l of hubLinks) {
      expect(edgeBlocked(l, hubPos, hubHeight), `${l.name} 走了绕障`).toBe(false);
    }
  });

  it("确定性：同输入两次布局结果逐键相等", () => {
    const again = layoutObjects(hubObjects, hubLinks);
    expect([...again].sort((a, b) => a[0].localeCompare(b[0]))).toEqual([...hubPos].sort((a, b) => a[0].localeCompare(b[0])));
  });

  it("宽层不折行：一层 5 个对象仍是一行（等距、不换行）", () => {
    const children = ["c1", "c2", "c3", "c4", "c5"];
    const objects = [obj("parent"), ...children.map(obj)];
    const links = children.map((c, i) => ({ name: `l${i}`, from: c, to: "parent", kind: "match" })) as CanvasLink[];
    const pos = layoutObjects(objects, links);
    const ys = new Set(children.map((c) => pos.get(c)!.y));
    expect(ys.size).toBe(1); // 同一行：不折行
    expect(pos.get("parent")!.y).toBeLessThan(pos.get("c1")!.y); // 被引用方在上
    const xs = children.map((c) => pos.get(c)!.x).sort((a, b) => a - b);
    expect(new Set(xs.map((_, i) => xs[i + 1] - xs[i]).slice(0, -1)).size).toBe(1); // 列距一致
  });

  it("孤立尾层折行成网格：5 个没线的对象排成 3 列 × 2 行，全部在连线部分下方", () => {
    const tail = ["x1", "x2", "x3", "x4", "x5"];
    const objects = [obj("a"), obj("b"), ...tail.map(obj)];
    const pos = layoutObjects(objects, [{ name: "l", from: "b", to: "a", kind: "match" }]);
    const maxConnY = Math.max(pos.get("a")!.y, pos.get("b")!.y);
    expect(Math.min(...tail.map((n) => pos.get(n)!.y))).toBeGreaterThan(maxConnY);
    expect(new Set(tail.map((n) => pos.get(n)!.y)).size).toBe(2); // 2 行
    expect(new Set(tail.map((n) => pos.get(n)!.x)).size).toBe(3); // 3 列
  });

  it("密集图取直率 ≥ 80%：4 层 × 3 列、长边跨两层，绕障边不超过 20%", () => {
    const names = ["a1", "a2", "a3", "b1", "b2", "b3", "c1", "c2", "c3", "d1", "d2", "d3"];
    const objects = names.map(obj);
    const link = (name: string, from: string, to: string): CanvasLink => ({ name, from, to, kind: "match" });
    const links: CanvasLink[] = [
      ...["b1", "b2", "b3"].map((n, i) => link(`b${i + 1}`, n, `a${i + 1}`)),
      ...["c1", "c2", "c3"].map((n, i) => link(`c${i + 1}`, n, `a${i + 1}`)),
      ...["d1", "d2", "d3"].map((n, i) => link(`d${i + 1}`, n, `b${i + 1}`)),
      link("x1", "d1", "a2"),
      link("x2", "c2", "b3"),
      link("x3", "b2", "a3"),
    ];
    const pos = layoutObjects(objects, links);
    const heightOf = new Map(objects.map((o) => [o.name, estimateHeight(o)] as const));
    const blocked = links.filter((l) => edgeBlocked(l, pos, heightOf)).length;
    expect(blocked / links.length).toBeLessThanOrEqual(0.2);
    // 交叉数是观察指标（ADR 0011：不当闸门）：打印供比对，不断言
    const rects = rectsOf(pos, heightOf);
    const paths = links.map((l) => {
      const [from, to] = edgeEnds(l, pos, heightOf);
      return { id: l.name, samples: samplePath(edgePath(from, to, rects).d) };
    });
    console.info(`[观察] 密集图交叉数：${countEdgeCrossings(paths)} / ${links.length} 条边`);
  });

  it("长链：10 个对象一条链逐层下行，每层一行、全直连、0 穿节点", () => {
    const names = Array.from({ length: 10 }, (_, i) => `n${i + 1}`);
    const objects = names.map(obj);
    const links: CanvasLink[] = names.slice(0, -1).map((n, i) => ({ name: `l${i}`, from: n, to: names[i + 1], kind: "match" }));
    const pos = layoutObjects(objects, links);
    const heightOf = new Map(objects.map((o) => [o.name, estimateHeight(o)] as const));
    // 一层一行：反向进图后 n10 在最上、n1 在最下，y 严格递减
    for (let i = 1; i < names.length; i++) {
      expect(pos.get(names[i])!.y).toBeLessThan(pos.get(names[i - 1])!.y);
    }
    for (const l of links) {
      expect(edgeBlocked(l, pos, heightOf), `${l.name} 走了绕障`).toBe(false);
    }
    const rects = rectsOf(pos, heightOf);
    for (const l of links) {
      const [from, to] = edgeEnds(l, pos, heightOf);
      const { d } = edgePath(from, to, rects);
      expect(crosses(samplePath(d), rects, from.point, to.point), `${l.name} 的路径穿过节点`).toBe(false);
    }
  });
});
