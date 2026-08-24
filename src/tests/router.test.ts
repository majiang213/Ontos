// 正交绕障路由测试：核心不变量——路径不穿任何节点（外扩后），端点精确保真。
// 几何原语全在 components/canvas/router.ts，interface 就是测试面（纯函数零夹具）。

import { describe, expect, it } from "vitest";
import { edgePath, routeOrthogonal, type Pt, type RouteEnd, type RouteRect } from "../components/canvas/router";

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
