// 画布自动布局：无关系时天际线网格；有关系时 dagre 分成左右列（被引用方在左），没连线的排到右侧。
// ADR 0011：奇数列错开，排完用路由当验收器——0 条线穿节点、取直率达标，列距只在确实少穿节点时加宽。
import { describe, expect, it } from "vitest";
import { CARD_W, edgeBlocked, edgeEndLabel, edgeLabelBox, estimateHeight, layoutObjects, NODE_W, type CanvasLink, type CanvasObject } from "../components/canvas/layout";
import { edgePath, type RouteEnd } from "../components/canvas/router";
import { floatingEndsOf, labelPushOf } from "../components/canvas/geometry";
import { countEdgeCrossings, crosses, samplePath } from "./canvasPath";
import { overlapEdgesOf, type DecisionRow } from "../components/canvas/sharedOrigin";
import { Verdict } from "../server/schema/verdict";

const obj = (name: string): CanvasObject => ({
  name,
  kind: "thing",
  properties: [{ name: "name", type: "string", derived: false }],
  sources: [],
  actions: [],
});

describe("estimateHeight（整理布局用的卡片高度不能矮过实测）", () => {
  // t6run 画布上量到的卡片高度。偏矮会让下一行叠进这张卡片。
  const measured: { h: number; o: CanvasObject }[] = [
    { h: 601, o: richMeasured("equipment", 35, 11, 3, ["asset_sys.asset", "inspect_sys.instrument", "set_fields", "convert_to_in_service", "convert_to_scrapped", "同形异义 · purchase_order", "同形异义 · assignment", "同形异义 · repair", "同形异义 · warranty_card", "同形异义 · it_device", "生命周期 · disposal", "部分重叠 · instrument"]) },
    { h: 263, o: richMeasured("account", 32, 5, 0, ["oa_sys.account", "set_fields", "同形异义 · card_holder"]) },
    { h: 246, o: richMeasured("it_device", 22, 5, 0, ["it_sys.device", "set_fields", "同形异义 · ticket", "同形异义 · equipment"]) },
    { h: 221, o: richMeasured("requisition", 8, 5, 0, ["oa_sys.requisition", "同形异义 · supply"]) },
    { h: 185, o: richMeasured("department", 2, 2, 0, ["device_sys.department", "set_fields", "同形异义 · dept"]) },
    { h: 180, o: richMeasured("purchase_order", 0, 3, 0, ["purchase_sys.order", "set_fields", "同形异义 · equipment"]) },
  ];
  it("不低于实测，高出不超过一行标签", () => {
    for (const { h, o } of measured) {
      const est = estimateHeight(o);
      expect(est, o.name).toBeGreaterThanOrEqual(h);
      expect(est - h, o.name).toBeLessThanOrEqual(24);
    }
  });
});

function richMeasured(name: string, descLen: number, props: number, stages: number, tagLabels: string[]): CanvasObject {
  return {
    name,
    description: descLen ? "设".repeat(descLen) : undefined,
    kind: "thing",
    properties: Array.from({ length: props }, (_, i) => ({ name: `p${i}`, type: "string", derived: false })),
    sources: [],
    actions: [],
    tagLabels,
    ...(stages ? { stages: { property: "status", items: Array.from({ length: stages }, (_, i) => ({ value: `v${i}`, hint: "h" })), sourceKeys: [] } } : {}),
  };
}

describe("edgeEndLabel（线端副标注只取短名）", () => {
  it("停在括号、逗号、句号之前；没有描述时用对象名", () => {
    expect(edgeEndLabel("设备（同一台设备的采购在途、台账在役、转固资产与点检视角，sn 对齐）", "equipment")).toBe("设备");
    expect(edgeEndLabel("OA系统用户账号，包含登录名、姓名、邮箱、所属部门及是否外包信息", "account")).toBe("OA系统用户账号");
    expect(edgeEndLabel("门禁卡持有人，每张门禁卡对应一个持卡人记录。", "card_holder")).toBe("门禁卡持有人");
    expect(edgeEndLabel("设备保修卡，记录设备保修到期时间。", "warranty_card")).toBe("设备保修卡");
    expect(edgeEndLabel(undefined, "room")).toBe("room");
    expect(edgeEndLabel("   ", "room")).toBe("room");
  });
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

describe("线说明留在线上", () => {
  const hasCard: CanvasLink = {
    name: "has_card",
    from: "account",
    to: "card_holder",
    kind: "match",
    description: "谁的卡：账号持有的门禁卡（holder 引用列配对）",
    fromLabel: "OA系统用户账号",
    toLabel: "门禁卡持有人",
  };

  it("长说明按 220 宽估算，短名仍是窄标签", () => {
    expect(edgeLabelBox(hasCard).w).toBe(220);
    expect(edgeLabelBox({ name: "l", from: "b", to: "a", kind: "match" }).w).toBeLessThan(CARD_W);
  });

  it("整理布局把相邻两列拉开，说明停在线中点，不再被推离线", () => {
    const objects = [richObj("account", { props: 5, description: true }), obj("card_holder")];
    const pos = layoutObjects(objects, [hasCard]);
    const left = pos.get("card_holder")!;
    const right = pos.get("account")!;
    const hL = estimateHeight(objects[1]);
    const hR = estimateHeight(objects[0]);
    const box = edgeLabelBox(hasCard);
    expect(right.x - (left.x + CARD_W)).toBeGreaterThanOrEqual(box.w + 16);
    const [s, t] = floatingEndsOf({ x: left.x, y: left.y, w: CARD_W, h: hL }, { x: right.x, y: right.y, w: CARD_W, h: hR });
    const mid = { x: (s.point.x + t.point.x) / 2, y: (s.point.y + t.point.y) / 2 };
    const obstacles = [
      { x: left.x, y: left.y, w: CARD_W, h: hL },
      { x: right.x, y: right.y, w: CARD_W, h: hR },
    ];
    expect(labelPushOf(mid, { x: 1, y: 0 }, box, obstacles, 12)).toEqual({ push: 12, shift: 0 });
  });

  it("短说明不拉列距；长说明旁边没连线的列距仍是基本列距", () => {
    const short = layoutObjects([obj("a"), obj("b")], [{ name: "l", from: "b", to: "a", kind: "match" }]);
    expect(short.get("b")!.x - short.get("a")!.x).toBe(NODE_W + 80);
    const objects = [obj("a"), obj("b"), obj("c"), obj("d"), obj("e")];
    const pos = layoutObjects(objects, [{ ...hasCard, from: "b", to: "a" }]);
    expect(pos.get("b")!.x - pos.get("a")!.x).toBeGreaterThan(NODE_W + 80);
    const iso = ["c", "d", "e"].map((n) => pos.get(n)!.x).sort((a, b) => a - b);
    expect(iso[0]).toBe(pos.get("b")!.x + NODE_W + 80);
    expect(new Set(iso).size).toBe(2);
    expect(iso[iso.length - 1] - iso[0]).toBe(NODE_W + 80);
  });
});

describe("有关系布局（dagre 分层）", () => {
  it("被引用方在左：边 目标→来源 反向进图，来源的 x 更小", () => {
    const links: CanvasLink[] = [{ name: "belongs_to", from: "child", to: "parent", kind: "match" }];
    const pos = layoutObjects([obj("parent"), obj("child")], links);
    expect(pos.get("parent")!.x).toBeLessThan(pos.get("child")!.x);
  });

  it("部分有线：没线的对象排到连线部分右侧，不混进有线的列", () => {
    const links: CanvasLink[] = [
      { name: "l1", from: "b", to: "a", kind: "match" },
      { name: "l2", from: "d", to: "c", kind: "match" },
    ];
    const objects = ["a", "b", "c", "d", "e", "f"].map(obj);
    const pos = layoutObjects(objects, links);
    const maxConnectedX = Math.max(...["a", "b", "c", "d"].map((n) => pos.get(n)!.x));
    expect(pos.get("e")!.x).toBeGreaterThan(maxConnectedX);
    expect(pos.get("f")!.x).toBeGreaterThan(maxConnectedX);
    expect(pos.get("f")!.x).not.toBe(pos.get("e")!.x);
  });

  it("由来边把公共对象排到两个原类左侧", () => {
    const names = ["asset", "device", "shared_asset_device"];
    const pos = layoutObjects(
      names.map(obj),
      overlapEdgesOf([{ classes: ["asset", "device"], verdict: Verdict.Overlap, shared: "shared_asset_device" }])
    );
    expect(pos.get("shared_asset_device")!.x).toBeLessThan(pos.get("asset")!.x);
    expect(pos.get("shared_asset_device")!.x).toBeLessThan(pos.get("device")!.x);
  });

  it("高卡片不把没连线的对象挤到自己脚下", () => {
    const tall = richObj("equipment", { props: 12, sources: 5, actions: 3, stages: 3, description: true });
    const pos = layoutObjects([tall, obj("card"), obj("loose")], [{ name: "covered_by", from: "equipment", to: "card", kind: "match" }]);
    const tallH = estimateHeight(tall);
    expect(pos.get("card")!.x).toBeLessThan(pos.get("equipment")!.x);
    expect(pos.get("loose")!.x).toBeGreaterThan(pos.get("equipment")!.x);
    expect(pos.get("loose")!.y).toBeLessThan(tallH);
    const rects = [
      { ...pos.get("equipment")!, h: tallH },
      { ...pos.get("card")!, h: estimateHeight(obj("card")) },
      { ...pos.get("loose")!, h: estimateHeight(obj("loose")) },
    ];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      const overlap = a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlap).toBe(false);
    }
  });
});

describe("边感知布局（ADR 0011：0 穿节点、取直率、折行纪律）", () => {
  /** demo 种子同形态：被引用方在左，跨列长边 + 富节点（阶段/动作多）。 */
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

  it("同一层排成一列：5 个来源共用一个 x，被引用方在它们左侧", () => {
    const children = ["c1", "c2", "c3", "c4", "c5"];
    const objects = [obj("parent"), ...children.map(obj)];
    const links = children.map((c, i) => ({ name: `l${i}`, from: c, to: "parent", kind: "match" })) as CanvasLink[];
    const pos = layoutObjects(objects, links);
    const xs = new Set(children.map((c) => pos.get(c)!.x));
    expect(xs.size).toBe(1); // 同一列：不拆到旁边去
    expect(pos.get("parent")!.x).toBeLessThan(pos.get("c1")!.x);
    const ys = children.map((c) => pos.get(c)!.y).sort((a, b) => a - b);
    expect(new Set(ys).size).toBe(children.length); // 列内上下分开，不叠在同一个点
  });

  it("没连线的对象排到右侧：5 个排成 3 列，不垫在连线部分下面", () => {
    const tail = ["x1", "x2", "x3", "x4", "x5"];
    const objects = [obj("a"), obj("b"), ...tail.map(obj)];
    const pos = layoutObjects(objects, [{ name: "l", from: "b", to: "a", kind: "match" }]);
    const maxConnX = Math.max(pos.get("a")!.x, pos.get("b")!.x);
    expect(Math.min(...tail.map((n) => pos.get(n)!.x))).toBeGreaterThan(maxConnX);
    expect(new Set(tail.map((n) => pos.get(n)!.x)).size).toBe(3);
  });

  it("密集图：跨列的边可以绕行，但绕障路径不穿节点，列距也不被空撑开", () => {
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
    const xs = [...new Set([...pos.values()].map((p) => p.x))].sort((a, b) => a - b);
    // 列距最多加宽一步（加宽确实减少了穿节点才留下），不会把 6 轮都走完
    expect(xs[xs.length - 1] - xs[0]).toBeLessThanOrEqual((xs.length - 1) * (NODE_W + 80 + 24));
    const rects = rectsOf(pos, heightOf);
    const paths = links.map((l) => {
      const [from, to] = edgeEnds(l, pos, heightOf);
      const { d } = edgePath(from, to, rects);
      expect(crosses(samplePath(d), rects, from.point, to.point), `${l.name} 的路径穿过节点`).toBe(false);
      return { id: l.name, samples: samplePath(d) };
    });
    console.info(`[观察] 密集图交叉数：${countEdgeCrossings(paths)} / ${links.length} 条边`);
  });

  it("长链：10 个对象逐列向左，相邻全直连、0 穿节点", () => {
    const names = Array.from({ length: 10 }, (_, i) => `n${i + 1}`);
    const objects = names.map(obj);
    const links: CanvasLink[] = names.slice(0, -1).map((n, i) => ({ name: `l${i}`, from: n, to: names[i + 1], kind: "match" }));
    const pos = layoutObjects(objects, links);
    const heightOf = new Map(objects.map((o) => [o.name, estimateHeight(o)] as const));
    // 反向进图后 n10 在最左、n1 在最右，x 严格递减
    for (let i = 1; i < names.length; i++) {
      expect(pos.get(names[i])!.x).toBeLessThan(pos.get(names[i - 1])!.x);
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
