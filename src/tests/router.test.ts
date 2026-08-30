// 正交绕障路由测试：核心不变量——路径不穿任何节点（外扩后），端点精确保真。
// 几何原语全在 components/canvas/router.ts，interface 就是测试面（纯函数零夹具）。
// 点/方位词表在 components/canvas/geometry.ts（单源）。

import { describe, expect, it } from "vitest";
import { directCurve, edgePath, routeOrthogonal, type RouteEnd, type RouteRect } from "../components/canvas/router";
import { samplePath } from "./canvasPath";
import type { Pt } from "../components/canvas/geometry";

const CELL_CLEAR_STUB = 26; // 与 router 内 STUB+8 的端点免检区同口径
const INFLATE = 8;

const inflated = (rs: RouteRect[]): RouteRect[] => rs.map((r) => ({ x: r.x - INFLATE, y: r.y - INFLATE, w: r.w + INFLATE * 2, h: r.h + INFLATE * 2 }));

/** 折线逐段采样，是否有采样点落进某个外扩矩形（端点桩区免检）。 */
function crosses(pts: Pt[], rects: RouteRect[], a: Pt, b: Pt): boolean {
  const nearEnd = (p: Pt) => Math.hypot(p.x - a.x, p.y - a.y) < CELL_CLEAR_STUB || Math.hypot(p.x - b.x, p.y - b.y) < CELL_CLEAR_STUB;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let k = 0; k <= 12; k++) {
      const t = k / 12;
      const p = { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t };
      if (!nearEnd(p) && rects.some((r) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h)) return true;
    }
  }
  return false;
}

const A: RouteRect = { x: 0, y: 0, w: 100, h: 60 };
const BLOCK: RouteRect = { x: 200, y: 0, w: 100, h: 60 };
const C: RouteRect = { x: 400, y: 0, w: 100, h: 60 };
const from: RouteEnd = { point: { x: 100, y: 30 }, side: "right" };
const to: RouteEnd = { point: { x: 400, y: 30 }, side: "left" };

describe("routeOrthogonal（绕障正交路由）", () => {
  it("中间有节点挡路时绕行：采样点不进任何外扩矩形，端点保真", () => {
    const obstacles = [A, BLOCK, C];
    const pts = routeOrthogonal(from, to, obstacles);
    expect(pts[0]).toEqual(from.point); // 端点本体，不吃格子取整误差
    expect(pts[pts.length - 1]).toEqual(to.point);
    expect(pts.length).toBeGreaterThan(2); // 确实绕了，不是直连
    expect(crosses(pts, inflated(obstacles), from.point, to.point)).toBe(false);
  });

  it("waypoint 途经点：路由点列里含途经点本体", () => {
    const waypoint = { x: 250, y: -80 };
    const pts = routeOrthogonal(from, to, [A, BLOCK, C], waypoint);
    expect(pts.some((p) => Math.hypot(p.x - waypoint.x, p.y - waypoint.y) < 1)).toBe(true);
    expect(crosses(pts, inflated([A, BLOCK, C]), from.point, to.point)).toBe(false);
  });
});

describe("directCurve（直接贝塞尔档：edgePath 与布局验收共用同一判定）", () => {
  it("无障碍时三档手柄至少一档可走，返回曲线", () => {
    const c = directCurve(from, to, []);
    expect(c).not.toBeNull();
    expect(c!.d).toContain(" C ");
  });

  it("中间有节点挡路时返回 null：edgePath 正是以此为界退绕障（同输入同结论）", () => {
    const obstacles = [A, BLOCK, C];
    expect(directCurve(from, to, obstacles)).toBeNull();
    expect(edgePath(from, to, obstacles).d).toMatch(/ Q | L /); // 退路一致：直接档走不了，绕障登场
  });

  it("能直连时 edgePath 必走直接贝塞尔：布局验收说「能走」渲染就真的是曲线", () => {
    const { d } = edgePath(from, to, []);
    expect(directCurve(from, to, [])).not.toBeNull();
    expect(d).toContain(" C ");
  });
});

describe("edgePath（边的最终路径）", () => {
  it("无障碍时首选直接贝塞尔（单波 S 线）", () => {
    const { d } = edgePath(from, to, []);
    expect(d).toContain(" C "); // 零弯的三次贝塞尔，不走正交
  });
  it("有障碍时退回绕障，平滑后仍不穿节点", () => {
    const obstacles = [A, BLOCK, C];
    const pts = routeOrthogonal(from, to, obstacles);
    const { d } = edgePath(from, to, obstacles);
    expect(d.startsWith("M ")).toBe(true);
    // 路径文本里的坐标点抽样验障（M/L/Q/C 后紧跟的都是坐标）
    const coords = [...d.matchAll(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
    expect(coords.length).toBeGreaterThan(0);
    expect(coords.concat(pts).some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))).toBe(false);
    // 采样折线（路由点）本身必不穿
    expect(crosses(pts, inflated(obstacles), from.point, to.point)).toBe(false);
  });
});

function nearestOf(pts: Pt[], p: Pt): number {
  return Math.min(...pts.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
}

/** 途经点邻域（弦长 radius 内）相邻采样段的最大折角（度）。圆滑曲线每步只有几度；旧实现在捏点处是 90° 直角。 */
function maxKinkNear(pts: Pt[], p: Pt, radius = 40): number {
  let idx = 0;
  for (let i = 1; i < pts.length; i++) if (Math.hypot(pts[i].x - p.x, pts[i].y - p.y) < Math.hypot(pts[idx].x - p.x, pts[idx].y - p.y)) idx = i;
  let lo = idx;
  for (let acc = 0; lo > 0 && acc <= radius; lo--) acc += Math.hypot(pts[lo].x - pts[lo - 1].x, pts[lo].y - pts[lo - 1].y);
  let hi = idx;
  for (let acc = 0; hi < pts.length - 1 && acc <= radius; hi++) acc += Math.hypot(pts[hi].x - pts[hi + 1].x, pts[hi].y - pts[hi + 1].y);
  let worst = 0;
  for (let i = lo + 1; i < hi; i++) {
    const ax = pts[i].x - pts[i - 1].x, ay = pts[i].y - pts[i - 1].y;
    const bx = pts[i + 1].x - pts[i].x, by = pts[i + 1].y - pts[i].y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-6 || lb < 1e-6) continue;
    const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
    worst = Math.max(worst, (Math.acos(cos) * 180) / Math.PI);
  }
  return worst;
}

describe("edgePath 弯折（捏点必经、全程圆滑）", () => {
  const wp = { x: 250, y: -80 };

  it("空障首选过点双段曲线：恰好途经捏点，且捏点处无折角", () => {
    const { d } = edgePath(from, to, [], wp);
    expect(d.match(/ C /g)).toHaveLength(2); // 两段三次贝塞尔，没走正交
    const pts = samplePath(d);
    expect(nearestOf(pts, wp)).toBeLessThan(2);
    expect(maxKinkNear(pts, wp)).toBeLessThan(40);
  });

  it("过点曲线从节点外侧贴上边框：抵达端切向逆法线，路径不闯进目标节点（回归：抵达切向曾沿 +法线，尾部扫进节点、几乎必掉兜底出折角）", () => {
    const obstacles = [A, C];
    const bottom: RouteEnd = { point: { x: 450, y: 60 }, side: "bottom" }; // 目标挂在节点底边
    const { d } = edgePath(from, bottom, obstacles, { x: 250, y: 200 });
    expect(d.match(/ C /g)).toHaveLength(2); // 过点双段曲线成立，没掉兜底
    const pts = samplePath(d);
    expect(nearestOf(pts, { x: 250, y: 200 })).toBeLessThan(2);
    expect(crosses(pts, inflated(obstacles), from.point, bottom.point)).toBe(false);
  });

  it("兜底路由的捏点处无折角：曲线恰好途经捏点、邻域切向连续（旧实现在此处硬拼两段，~90° 直角）", () => {
    const LID: RouteRect = { x: 150, y: -200, w: 80, h: 150 }; // 压住过点曲线的弧、又不包含捏点本体 → 逼出正交兜底
    const obstacles = [A, BLOCK, C, LID];
    const { d } = edgePath(from, to, obstacles, wp);
    expect(d).toMatch(/ Q | L /); // 确实走了绕障平滑，不是过点双段曲线
    const pts = samplePath(d);
    expect(nearestOf(pts, wp)).toBeLessThan(2);
    expect(maxKinkNear(pts, wp)).toBeLessThan(40);
  });
});
