// 正交绕障路由 —— 线不从任何节点身上穿过：端点先沿所在边的法线探出一小段（桩），
// 再在网格上 A* 绕开所有节点（含端点自己的节点）。失败兜底为直连（总比对穿强）。
// 弯折捏点是曲线的必经途经点：首选过点的双段曲线，兜底路由里也恰好途经（过点弧）——捏点始终压在线上，线全程无折角。
// Pt / Side 的几何词表在 ./geometry（单源），本文件只留路由域类型。

import type { Pt, Side } from "./geometry";

export interface RouteRect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface RouteEnd {
  point: Pt;
  side: Side;
}

const CELL = 12; // 网格粒度（flow 单位）：节点最小间距 60，外扩后仍有两三格通道
const INFLATE = 8; // 节点外扩：线与节点身保持距离
const STUB = 18; // 端点沿法线探出的桩长（> INFLATE，桩尖必在障碍区外）
const MARGIN = 200; // 路由域外沿
const TURN = 3; // 转弯罚（直行一步代价 1）：压锯齿
const MAX_POPS = 60000; // A* 上限，超了兜底直连

const NORMAL: Record<Side, Pt> = { top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };

/** 三次贝塞尔求值。 */
function cubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  };
}

/** 采样点列是否全在障碍区外（端点桩区免检：端点本就在自家节点的外扩区里；via 途经点周围同口径免检——路由已强制可达）。 */
function clearOf(samples: Pt[], inflated: RouteRect[], a: Pt, b: Pt, via?: Pt): boolean {
  const r0 = STUB + 8;
  const nearEnd = (p: Pt) =>
    Math.hypot(p.x - a.x, p.y - a.y) < r0 || Math.hypot(p.x - b.x, p.y - b.y) < r0 || (via ? Math.hypot(p.x - via.x, p.y - via.y) < r0 : false);
  return !samples.some((p) => !nearEnd(p) && inflated.some((r) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h));
}

function inflateOf(obstacles: RouteRect[]): RouteRect[] {
  return obstacles.map((r) => ({ x: r.x - INFLATE, y: r.y - INFLATE, w: r.w + INFLATE * 2, h: r.h + INFLATE * 2 }));
}

/** 直接贝塞尔：切向沿两端法线，手柄长随间距取——零弯的单波 S 线，首选形态。 */
function directBezier(from: RouteEnd, to: RouteEnd, k: number, inflated: RouteRect[]): { d: string; mid: Pt; dir: Pt } | null {
  const dist = Math.hypot(to.point.x - from.point.x, to.point.y - from.point.y);
  const h = Math.min(Math.max(dist * k, 30), 220);
  const c1 = { x: from.point.x + NORMAL[from.side].x * h, y: from.point.y + NORMAL[from.side].y * h };
  const c2 = { x: to.point.x + NORMAL[to.side].x * h, y: to.point.y + NORMAL[to.side].y * h };
  const samples: Pt[] = [from.point];
  for (let i = 1; i <= 24; i++) samples.push(cubic(from.point, c1, c2, to.point, i / 24));
  if (!clearOf(samples, inflated, from.point, to.point)) return null;
  return { d: `M ${from.point.x},${from.point.y} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${to.point.x},${to.point.y}`, ...polylineMidDir(samples) };
}

/** 过途经点的曲线：两段 Hermite（途经点处切向取总跨向），出发顺法线出、抵达逆法线进——曲线始终从节点外侧贴上边框。
 *  途经点所在矩形剔出障碍（用户手拖的位置必须能到）；端部法线手柄从长到短试三档，贴边弧扫进外扩区就收紧再试。 */
function throughCurve(from: RouteEnd, waypoint: Pt, to: RouteEnd, obstacles: RouteRect[]): { d: string; mid: Pt; dir: Pt } | null {
  const contains = (r: RouteRect, p: Pt) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
  const inflated = inflateOf(obstacles).filter((r) => !contains(r, waypoint));
  const dA = Math.max(Math.hypot(waypoint.x - from.point.x, waypoint.y - from.point.y), 1);
  const dB = Math.max(Math.hypot(to.point.x - waypoint.x, to.point.y - waypoint.y), 1);
  const t1 = { x: (to.point.x - from.point.x) / 2, y: (to.point.y - from.point.y) / 2 };
  for (const k of [0.5, 0.3, 0.15]) {
    const t0 = { x: NORMAL[from.side].x * dA * k, y: NORMAL[from.side].y * dA * k };
    const t2 = { x: -NORMAL[to.side].x * dB * k, y: -NORMAL[to.side].y * dB * k }; // 逆法线：抵达切向指向边框，控制点留在节点外
    // Hermite → 贝塞尔：c1 = p0 + m0/3，c2 = p1 - m1/3
    const A1 = { x: from.point.x + t0.x / 3, y: from.point.y + t0.y / 3 };
    const A2 = { x: waypoint.x - t1.x / 3, y: waypoint.y - t1.y / 3 };
    const B1 = { x: waypoint.x + t1.x / 3, y: waypoint.y + t1.y / 3 };
    const B2 = { x: to.point.x - t2.x / 3, y: to.point.y - t2.y / 3 };
    const samples: Pt[] = [from.point];
    for (let i = 1; i <= 16; i++) samples.push(cubic(from.point, A1, A2, waypoint, i / 16));
    for (let i = 1; i <= 16; i++) samples.push(cubic(waypoint, B1, B2, to.point, i / 16));
    if (!clearOf(samples, inflated, from.point, to.point)) continue;
    const t1Len = Math.hypot(t1.x, t1.y) || 1;
    return {
      d: `M ${from.point.x},${from.point.y} C ${A1.x},${A1.y} ${A2.x},${A2.y} ${waypoint.x},${waypoint.y} C ${B1.x},${B1.y} ${B2.x},${B2.y} ${to.point.x},${to.point.y}`,
      mid: waypoint, // 捏点压在线上
      dir: { x: t1.x / t1Len, y: t1.y / t1Len }, // 途经点处的切向
    };
  }
  return null;
}

function stubOf(end: RouteEnd): Pt {
  const n = NORMAL[end.side];
  return { x: end.point.x + n.x * STUB, y: end.point.y + n.y * STUB };
}

/** 网格 A*：from/to 是自由点（桩尖/途经点），blocked 是 inflated 节点矩形；途经点所在格强制视为可走（捏点可能被拖进节点身上）。 */
function astar(from: Pt, to: Pt, blocked: RouteRect[], bounds: { x0: number; y0: number; cols: number; rows: number }): Pt[] | null {
  const { x0, y0, cols, rows } = bounds;
  const gi = (p: Pt) => ({ cx: Math.round((p.x - x0) / CELL), cy: Math.round((p.y - y0) / CELL) });
  const s = gi(from);
  const t = gi(to);
  const inRect = (cx: number, cy: number, r: RouteRect) => {
    const x = x0 + cx * CELL;
    const y = y0 + cy * CELL;
    return x > r.x - CELL && x < r.x + r.w && y > r.y - CELL && y < r.y + r.h; // 格点落入外扩矩形（含格本身的半格宽容）
  };
  const isFree = (cx: number, cy: number) => {
    if (cx < 0 || cy < 0 || cx > cols || cy > rows) return false;
    for (const r of blocked) if (inRect(cx, cy, r)) return false;
    return true;
  };
  // 状态 = 格 + 进入方向（0..3 / -1 起步），转弯罚要按方向记账
  const key = (cx: number, cy: number, dir: number) => (dir + 1) * (cols + 1) * (rows + 1) + cy * (cols + 1) + cx;
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const heap: { k: number; f: number }[] = [];
  const push = (k: number, f: number) => {
    heap.push({ k, f });
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].f <= heap[i].f) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const h = (cx: number, cy: number) => Math.abs(cx - t.cx) + Math.abs(cy - t.cy);
  const startKey = key(s.cx, s.cy, -1);
  dist.set(startKey, 0);
  push(startKey, h(s.cx, s.cy));
  const DIRS = [
    { x: 1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y: 1 },
    { x: 0, y: -1 },
  ];
  let pops = 0;
  let endKey = -1;
  while (heap.length && pops++ < MAX_POPS) {
    const { k } = pop();
    const g0 = dist.get(k);
    if (g0 === undefined) continue;
    const dirIn = Math.floor(k / ((cols + 1) * (rows + 1))) - 1;
    const rem = k % ((cols + 1) * (rows + 1));
    const cy = Math.floor(rem / (cols + 1));
    const cx = rem % (cols + 1);
    if (cx === t.cx && cy === t.cy) {
      endKey = k;
      break;
    }
    for (let d = 0; d < 4; d++) {
      const nx = cx + DIRS[d].x;
      const ny = cy + DIRS[d].y;
      if (!isFree(nx, ny)) continue;
      const cost = g0 + 1 + (dirIn >= 0 && dirIn !== d ? TURN : 0);
      const nk = key(nx, ny, d);
      if (cost < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, cost);
        prev.set(nk, k);
        push(nk, cost + h(nx, ny));
      }
    }
  }
  if (endKey < 0) return null;
  // 回溯出格子路径 → 格中心点列
  const cells: Pt[] = [];
  let k = endKey;
  while (k !== startKey) {
    const rem = k % ((cols + 1) * (rows + 1));
    const cy = Math.floor(rem / (cols + 1));
    const cx = rem % (cols + 1);
    cells.push({ x: x0 + cx * CELL, y: y0 + cy * CELL });
    k = prev.get(k)!;
  }
  cells.push({ x: x0 + s.cx * CELL, y: y0 + s.cy * CELL });
  cells.reverse();
  return cells;
}

/** 合并共线点（栅格路径是逐格的，收成拐角点列）。 */
function compress(pts: Pt[]): Pt[] {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const collinear = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
    if (!collinear) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** 二次贝塞尔求值。 */
function quad(p0: Pt, c: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y };
}

function unitOf(a: Pt, b: Pt): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l = Math.hypot(dx, dy);
  return l < 1e-6 ? { x: 1, y: 0 } : { x: dx / l, y: dy / l };
}

/** 过点弧：a → w → b 恰好途经 w，w 处切向取来去方向的角平分（两段三次贝塞尔，接缝 C1 连续——必经顶点处无折角）。
 *  reach ∈ (0,0.5]：两端切向手柄占腿长的比例，与过中点弧留直腿的口径一致。 */
function throughArc(w: Pt, a: Pt, b: Pt, reach: number): SmoothSeg {
  const u = unitOf(a, w); // 来方向（线身进入 w）
  const v = unitOf(w, b); // 去方向
  const bx = u.x + v.x;
  const by = u.y + v.y;
  const bl = Math.hypot(bx, by);
  const tau = bl < 1e-6 ? u : { x: bx / bl, y: by / bl }; // 角平分；来去相反（掉头）时退回 u
  const rin = Math.hypot(w.x - a.x, w.y - a.y);
  const rout = Math.hypot(b.x - w.x, b.y - w.y);
  const h = Math.max(Math.min(rin, rout) * reach, 2);
  const c1 = { x: a.x + u.x * rin * reach, y: a.y + u.y * rin * reach };
  const c2 = { x: w.x - tau.x * h, y: w.y - tau.y * h };
  const c3 = { x: w.x + tau.x * h, y: w.y + tau.y * h };
  const c4 = { x: b.x - v.x * rout * reach, y: b.y - v.y * rout * reach };
  const samples: Pt[] = [a];
  for (let k = 1; k <= 10; k++) samples.push(cubic(a, c1, c2, w, k / 10));
  for (let k = 1; k <= 10; k++) samples.push(cubic(w, c3, c4, b, k / 10));
  return { d: ` C ${c1.x},${c1.y} ${c2.x},${c2.y} ${w.x},${w.y} C ${c3.x},${c3.y} ${c4.x},${c4.y} ${b.x},${b.y}`, samples };
}

/** 采样点列按弧长的中点（标签/捏点的落位），以及中点处的单位切向（标签沿法线让开线身用）。 */
function polylineMid(pts: Pt[]): Pt {
  return polylineMidDir(pts).mid;
}

function polylineMidDir(pts: Pt[]): { mid: Pt; dir: Pt } {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + seg >= total / 2) {
      const k = seg === 0 ? 0 : (total / 2 - acc) / seg;
      const mid = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k };
      const dir = seg === 0 ? { x: 1, y: 0 } : { x: (pts[i].x - pts[i - 1].x) / seg, y: (pts[i].y - pts[i - 1].y) / seg };
      return { mid, dir };
    }
    acc += seg;
  }
  return { mid: pts[0], dir: { x: 1, y: 0 } };
}

interface SmoothSeg {
  d: string; // M 之后的部分
  samples: Pt[];
}

/** 流动曲线档：拐角当控制点、过每段中点（Q 曲线），首末段保持直线——切向全程沿正交腿，垂直进出边框不变，拐角扫成大弧。
 *  via = 必经顶点下标（弯折捏点）：该顶点不过 Q 弧、走过点弧——曲线恰好压住捏点，且捏点处无折角。 */
function flowTier(pts: Pt[], via = -1): SmoothSeg {
  const n = pts.length;
  if (n === 2) return { d: `L ${pts[1].x},${pts[1].y}`, samples: pts };
  const mids = pts.slice(0, -1).map((p, i) => ({ x: (p.x + pts[i + 1].x) / 2, y: (p.y + pts[i + 1].y) / 2 }));
  let d = `L ${mids[0].x},${mids[0].y}`;
  const samples: Pt[] = [pts[0], mids[0]];
  for (let i = 1; i <= n - 2; i++) {
    if (i === via) {
      const arc = throughArc(pts[i], mids[i - 1], mids[i], 0.5);
      d += arc.d;
      samples.push(...arc.samples);
    } else {
      d += ` Q ${pts[i].x},${pts[i].y} ${mids[i].x},${mids[i].y}`;
      for (let k = 1; k <= 12; k++) samples.push(quad(mids[i - 1], pts[i], mids[i], k / 12));
    }
  }
  d += ` L ${pts[n - 1].x},${pts[n - 1].y}`;
  samples.push(pts[n - 1]);
  return { d, samples };
}

/** 圆角折线档：每个拐角换成小圆弧（cap 限半径，默认 ≤14px 贴线；放宽到 40px 时走廊里读起来也是曲线）。via 同 flowTier——必经顶点走过点弧。 */
function roundedTier(pts: Pt[], via = -1, cap = 14): SmoothSeg {
  const n = pts.length;
  if (n === 2) return { d: `L ${pts[1].x},${pts[1].y}`, samples: pts };
  let d = "";
  const samples: Pt[] = [pts[0]];
  let prev = pts[0];
  for (let i = 1; i < n; i++) {
    const corner = pts[i];
    const next = pts[i + 1];
    if (!next) {
      d += ` L ${corner.x},${corner.y}`;
      samples.push(corner);
      break;
    }
    const legA = Math.hypot(corner.x - prev.x, corner.y - prev.y);
    const legB = Math.hypot(next.x - corner.x, next.y - corner.y);
    const r = Math.min(cap, legA * 0.45, legB * 0.45);
    if (i === via) {
      const u = unitOf(prev, corner);
      const v = unitOf(corner, next);
      const a = { x: corner.x - u.x * r, y: corner.y - u.y * r }; // 进弧点
      const b = { x: corner.x + v.x * r, y: corner.y + v.y * r }; // 出弧点
      d += ` L ${a.x},${a.y}`;
      samples.push(a);
      const arc = throughArc(corner, a, b, 0.5);
      d += arc.d;
      samples.push(...arc.samples);
      prev = b;
      continue;
    }
    const inX = corner.x - prev.x, inY = corner.y - prev.y;
    const outX = next.x - corner.x, outY = next.y - corner.y;
    const a = { x: corner.x - (inX / legA) * r, y: corner.y - (inY / legA) * r }; // 进角点
    const b = { x: corner.x + (outX / legB) * r, y: corner.y + (outY / legB) * r }; // 出角点
    d += ` L ${a.x},${a.y} Q ${corner.x},${corner.y} ${b.x},${b.y}`;
    samples.push(a);
    for (let k = 1; k <= 8; k++) samples.push(quad(a, corner, b, k / 8));
    prev = b;
  }
  return { d, samples };
}

/** 折线 → 平滑曲线。四档：流动曲线（拐角扫大弧）→ 大圆角（40px）→ 小圆角（14px）→ 原折线；逐档采样验障（外扩与免检同 clearOf 一处），碰节点就降档。
 *  via = 必经顶点下标（弯折捏点）：曲线恰好途经它，验障时捏点周围与端点桩区同口径免检。 */
function smoothPath(pts: Pt[], obstacles: RouteRect[], via = -1): { d: string; mid: Pt; dir: Pt } {
  const inflated = inflateOf(obstacles);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const viaPt = via >= 0 ? pts[via] : undefined;
  const tiers: ((p: Pt[], v: number) => SmoothSeg)[] = [flowTier, (p, v) => roundedTier(p, v, 40), (p, v) => roundedTier(p, v, 14)];
  for (const tier of tiers) {
    const { d, samples } = tier(pts, via);
    if (clearOf(samples, inflated, first, last, viaPt)) return { d: `M ${pts[0].x},${pts[0].y} ${d}`, ...polylineMidDir(samples) };
  }
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x},${p.y}`).join(" "); // 路由出来的折线本身必通
  return { d, ...polylineMidDir(pts) };
}

/** 绕障正交路由：返回含两端点在内的折线点列（首末是边框上的端点本体）。waypoint = 弯折途经点（捏点拖出来的）。 */
export function routeOrthogonal(from: RouteEnd, to: RouteEnd, obstacles: RouteRect[], waypoint?: Pt | null): Pt[] {
  const s = stubOf(from);
  const t = stubOf(to);
  const inflated = inflateOf(obstacles);
  const pts = [s, t, ...(waypoint ? [waypoint] : [])];
  const xs = pts.map((p) => p.x).concat(inflated.map((r) => r.x), inflated.map((r) => r.x + r.w));
  const ys = pts.map((p) => p.y).concat(inflated.map((r) => r.y), inflated.map((r) => r.y + r.h));
  const x0 = Math.min(...xs) - MARGIN;
  const y0 = Math.min(...ys) - MARGIN;
  const bounds = { x0, y0, cols: Math.ceil((Math.max(...xs) + MARGIN - x0) / CELL), rows: Math.ceil((Math.max(...ys) + MARGIN - y0) / CELL) };
  // 每腿剔掉含起讫点的矩形：讫点若是用户手拖的途经点（可能拖进了节点怀里），线必须能到；桩尖本就在外扩区沿
  const contains = (r: RouteRect, p: Pt) => p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
  const legBlocked = (a: Pt, b: Pt) => inflated.filter((r) => !contains(r, a) && !contains(r, b));
  const legs = waypoint
    ? [astar(s, waypoint, legBlocked(s, waypoint), bounds), astar(waypoint, t, legBlocked(waypoint, t), bounds)]
    : [astar(s, t, legBlocked(s, t), bounds)];
  if (legs.some((l) => l === null)) return [from.point, to.point]; // 兜不住就直连
  const mid = legs.map((leg, i) => {
    const exact = i === 0 ? s : waypoint!;
    const exactEnd = i === legs.length - 1 ? t : waypoint!;
    return compress([exact, ...leg!.slice(1, -1), exactEnd]); // 端点换成精确桩尖/途经点，吃掉格子取整误差
  });
  const joined = mid.length === 1 ? mid[0] : [...mid[0], ...mid[1].slice(1)];
  return compress([from.point, ...joined.slice(1, -1), to.point]);
}

/** 边的最终路径：默认一条直接贝塞尔（零弯单波，切向垂直边框，手柄长按间距取档）；采样撞节点才退到正交绕障+过点平滑。
 *  弯折捏点 = 曲线必经的途经点：先试过途经点的双段曲线（捏点压在线上），不行再绕障、必经顶点走过点弧——捏点始终压线、全程无折角。
 *  最终边（FloatingEdge）与连线预览（FloatingConnectionLine）共用这一处——拖的时候什么样、松手就什么样。 */
export function edgePath(from: RouteEnd, to: RouteEnd, obstacles: RouteRect[], waypoint?: Pt | null): { d: string; mid: Pt; dir: Pt } {
  if (waypoint) {
    const c = throughCurve(from, waypoint, to, obstacles);
    if (c) return c;
  } else {
    const inflated = inflateOf(obstacles);
    for (const k of [0.5, 0.8, 1.1]) {
      const c = directBezier(from, to, k, inflated);
      if (c) return c;
    }
  }
  const points = routeOrthogonal(from, to, obstacles, waypoint);
  if (waypoint) {
    const wi = points.findIndex((p) => Math.hypot(p.x - waypoint.x, p.y - waypoint.y) < 1);
    if (wi > 0 && wi < points.length - 1) return smoothPath(points, obstacles, wi); // 过点平滑：捏点压线且无折角
  }
  return smoothPath(points, obstacles);
}
