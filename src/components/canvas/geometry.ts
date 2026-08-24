// 画布几何 —— 边框附着点、钉点、最近边框候选的纯函数层（从 FloatingEdge.tsx 抽出）。
// 深 module：渲染（FloatingEdge）、预览线（FloatingConnectionLine）、画布（OntologyCanvas）共用，
// 几何进测试面（geometry.test.ts，纯函数零夹具）。BorderPin 类型单源在 server/schema/ops（z.infer 派生）。

import { NODE_H, NODE_W } from "./layout";
import type { BorderPin } from "../../server/schema/ops";

export type { BorderPin };

export interface Pt {
  x: number;
  y: number;
}

/** 节点矩形（flow 坐标系）。与 router.ts 的 RouteRect 同形：绕障路由直接吃。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 边方位：与 BorderPin 的 side 同一词表（router.ts 原 Side 已收编于此）。 */
export type Side = BorderPin["side"];

/** 弯折量：相对两端节点中心连线中点的偏移（flow 坐标系单位）。 */
export interface Bend {
  dx: number;
  dy: number;
}

/** 中心连线与节点矩形边框的交点。连线预览（FloatingConnectionLine）共用这套算法：拖的时候什么样，松手就什么样。 */
export function borderPoint(from: Rect, to: Pt): Pt {
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  const dx = to.x - cx;
  const dy = to.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(Math.abs(from.w / 2 / (dx || 1e-6)), Math.abs(from.h / 2 / (dy || 1e-6)));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/** React Flow 节点 → 矩形。未测量回退与布局计算同一常量（layout.ts）。 */
export function rectOf(node: { internals: { positionAbsolute: { x: number; y: number } }; measured: { width?: number; height?: number } }): Rect {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    w: node.measured.width ?? NODE_W,
    h: node.measured.height ?? NODE_H,
  };
}

/** 钉点 → 边框上的实际点。 */
export function pinPoint(r: Rect, pin: BorderPin): Pt {
  switch (pin.side) {
    case "top":
      return { x: r.x + pin.t * r.w, y: r.y };
    case "bottom":
      return { x: r.x + pin.t * r.w, y: r.y + r.h };
    case "left":
      return { x: r.x, y: r.y + pin.t * r.h };
    case "right":
      return { x: r.x + r.w, y: r.y + pin.t * r.h };
  }
}

/** 离 p 最近的边框点 → 钉点 + 实际点。连线落点/抓取点钉在哪，由它定；
 *  浮动端点的法线方向也靠它反推（点已在边框上时，最近候选就是它自己——角点并列按声明序取先）。 */
export function closestBorderPin(r: Rect, p: Pt): { pin: BorderPin; point: Pt } {
  const cx = Math.min(Math.max(p.x, r.x), r.x + r.w);
  const cy = Math.min(Math.max(p.y, r.y), r.y + r.h);
  const cands: { pin: BorderPin; point: Pt }[] = [
    { pin: { side: "top", t: (cx - r.x) / r.w }, point: { x: cx, y: r.y } },
    { pin: { side: "bottom", t: (cx - r.x) / r.w }, point: { x: cx, y: r.y + r.h } },
    { pin: { side: "left", t: (cy - r.y) / r.h }, point: { x: r.x, y: cy } },
    { pin: { side: "right", t: (cy - r.y) / r.h }, point: { x: r.x + r.w, y: cy } },
  ];
  let best = cands[0];
  let bestD = Infinity;
  for (const c of cands) {
    const dist = Math.hypot(c.point.x - p.x, c.point.y - p.y);
    if (dist < bestD) {
      bestD = dist;
      best = c;
    }
  }
  return best;
}
