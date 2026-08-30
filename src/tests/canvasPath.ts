// 画布路径测试辅助（router.test / canvasLayout.test 共用）：SVG 路径（M/L/Q/C）展成密集折线 +
// 验障 + 边对交叉计数。采样密度按控制多边形长度自适应（目标间距 ~20px，上限 64 点/段）——
// 定值 16 点对长边会漏检节点角（ADR 0011 点名的同类缺陷，测试侧不重犯）。

import type { Pt } from "../components/canvas/geometry";

const quadAt = (p0: Pt, c: Pt, p1: Pt, t: number): Pt => {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
};

const cubicAt = (p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt => {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  };
};

const polyLen = (pts: Pt[]): number => {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return acc;
};

/** SVG 路径（M/L/Q/C）展成密集折线：曲线段按控制多边形长度自适应采样。 */
export function samplePath(d: string): Pt[] {
  const out: Pt[] = [];
  let cur: Pt = { x: 0, y: 0 };
  for (const m of d.matchAll(/([MLQC])([^MLQC]+)/g)) {
    const cs = [...m[2].matchAll(/(-?\d+(?:\.\d+)?(?:e-?\d+)?),(-?\d+(?:\.\d+)?(?:e-?\d+)?)/g)].map((mm) => ({ x: Number(mm[1]), y: Number(mm[2]) }));
    if (m[1] === "Q") {
      for (let i = 0; i < cs.length; i += 2) {
        const n = Math.min(Math.max(Math.ceil(polyLen([cur, cs[i], cs[i + 1]]) / 20), 8), 64);
        for (let k = 1; k <= n; k++) out.push(quadAt(cur, cs[i], cs[i + 1], k / n));
        cur = cs[i + 1];
      }
    } else if (m[1] === "C") {
      for (let i = 0; i < cs.length; i += 3) {
        const n = Math.min(Math.max(Math.ceil(polyLen([cur, cs[i], cs[i + 1], cs[i + 2]]) / 20), 8), 64);
        for (let k = 1; k <= n; k++) out.push(cubicAt(cur, cs[i], cs[i + 1], cs[i + 2], k / n));
        cur = cs[i + 2];
      }
    } else {
      for (const p of cs) {
        out.push(p);
        cur = p;
      }
    }
  }
  return out;
}

/** 折线是否有采样点落进某个矩形（端点桩区免检，与 router 的 clearOf 同口径）。 */
export function crosses(pts: Pt[], rects: { x: number; y: number; w: number; h: number }[], a: Pt, b: Pt): boolean {
  const nearEnd = (p: Pt) => Math.hypot(p.x - a.x, p.y - a.y) < 26 || Math.hypot(p.x - b.x, p.y - b.y) < 26;
  return pts.some((p) => !nearEnd(p) && rects.some((r) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h));
}

/** 两条折线是否相交（交点落在两段内部 2% 之外才算：贴边不算交叉）。 */
export function polylinesCross(a: Pt[], b: Pt[]): boolean {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      const ax = a[i].x, ay = a[i].y, bx = a[i + 1].x, by = a[i + 1].y;
      const cx = b[j].x, cy = b[j].y, dx = b[j + 1].x, dy = b[j + 1].y;
      const det = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
      if (det === 0) continue;
      const u = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / det;
      const v = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / det;
      if (u > 0.02 && u < 0.98 && v > 0.02 && v < 0.98) return true;
    }
  }
  return false;
}

/** 边对交叉计数（观察指标，不当闸门：交叉数受 dagre order 影响，布局不承诺最小值）。 */
export function countEdgeCrossings(paths: { id: string; samples: Pt[] }[]): number {
  let n = 0;
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (polylinesCross(paths[i].samples, paths[j].samples)) n++;
    }
  }
  return n;
}
