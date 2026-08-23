// 浮动边 —— 连接点不定死在节点中心点：按两端节点的相对方位，
// 在节点边框上各自算附着点，多根边自然散开。自环（转化关系）画成节点上方的小环。
// 线身编辑：中点捏点拖弯（存摆位表，拖回中点拉直）；两端捏点钉在真实的边框附着点上，拖到别的对象即改接。
"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, useInternalNode, useReactFlow, useStoreApi, type EdgeProps } from "@xyflow/react";
import { XYHandle } from "@xyflow/system";
import { NODE_H, NODE_W } from "./layout";
import { connectTrack, xyDragArgs } from "./connectTrack";
import { edgePath, type RouteRect, type Side } from "./router";

interface Pt {
  x: number;
  y: number;
}

/** 中心连线与节点矩形边框的交点。连线预览（FloatingConnectionLine）共用这套算法：拖的时候什么样，松手就什么样。 */
export function borderPoint(from: { x: number; y: number; w: number; h: number }, to: Pt): Pt {
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  const dx = to.x - cx;
  const dy = to.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(Math.abs(from.w / 2 / (dx || 1e-6)), Math.abs(from.h / 2 / (dy || 1e-6)));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

export function rectOf(node: { internals: { positionAbsolute: { x: number; y: number } }; measured: { width?: number; height?: number } }) {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    w: node.measured.width ?? NODE_W, // 未测量回退与布局计算同一常量（layout.ts）
    h: node.measured.height ?? NODE_H,
  };
}

/** 弯折量：相对两端节点中心连线中点的偏移（flow 坐标系单位）。 */
export interface Bend {
  dx: number;
  dy: number;
}

/** 端点钉点：钉在某条边的 t 比例处（0..1）。拖节点时端点跟着自己的节点走。 */
export interface BorderPin {
  side: "top" | "bottom" | "left" | "right";
  t: number;
}

/** 钉点 → 边框上的实际点。 */
export function pinPoint(r: { x: number; y: number; w: number; h: number }, pin: BorderPin): Pt {
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

/** 离 p 最近的边框点 → 钉点 + 实际点。连线落点/抓取点钉在哪，由它定。 */
export function closestBorderPin(r: { x: number; y: number; w: number; h: number }, p: Pt): { pin: BorderPin; point: Pt } {
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

interface BendData {
  bend?: Bend;
  pins?: { source?: BorderPin; target?: BorderPin }; // 端点钉点：缺省浮动（按相对方位取边框交点）
  obstacles?: RouteRect[]; // 全部节点的矩形：绕障路由用（含本边的两端节点——桩负责进出）
  showKnob?: boolean; // 悬停/详情卡打开时露出捏点（弯折点 + 两端改接点）
  commitBend?: (name: string, bend: Bend | null) => void;
  commitReconnect?: (name: string, from: string, to: string, movedEnd: "source" | "target") => void;
  setReconnecting?: (v: boolean) => void; // 预览箭头方向跟着改接状态走
}

/** 点在矩形的哪条边上（浮动端点反推法线方向；钉点直接带 side，不走这里）。 */
function sideOf(r: RouteRect, p: Pt): Side {
  const d = [
    { s: "top" as Side, d: Math.abs(p.y - r.y) },
    { s: "bottom" as Side, d: Math.abs(p.y - (r.y + r.h)) },
    { s: "left" as Side, d: Math.abs(p.x - r.x) },
    { s: "right" as Side, d: Math.abs(p.x - (r.x + r.w)) },
  ];
  return d.sort((a, b) => a.d - b.d)[0].s;
}

export default function FloatingEdge({ id, source, target, label, style, markerEnd, interactionWidth, data }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const rf = useReactFlow();
  const store = useStoreApi();
  const [dragBend, setDragBend] = useState<Bend | null>(null); // 拖着的时候用本地态，松手才入库
  const dragRef = useRef<{ startX: number; startY: number; base: Bend; zoom: number } | null>(null);
  if (!sourceNode || !targetNode) return null;

  // 自环：节点上方一个小半环（不提供弯折）
  if (source === target) {
    const r = rectOf(sourceNode);
    const cx = r.x + r.w / 2;
    const loopR = 20;
    const path = `M ${cx - loopR},${r.y} A ${loopR} ${loopR} 0 1 1 ${cx + loopR},${r.y}`;
    return (
      <>
        <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
        {label && (
          <EdgeLabelRenderer>
            <div className="edge-label" style={{ transform: `translate(-50%,-100%) translate(${cx}px,${r.y - 2 * loopR - 4}px)` }}>
              {label}
            </div>
          </EdgeLabelRenderer>
        )}
      </>
    );
  }

  const d = (data ?? {}) as BendData;
  const bend: Bend = dragBend ?? d.bend ?? { dx: 0, dy: 0 };
  const bent = Boolean(dragBend) || Boolean(d.bend && (d.bend.dx !== 0 || d.bend.dy !== 0));

  const sRect = rectOf(sourceNode);
  const tRect = rectOf(targetNode);
  const sCenter = { x: sRect.x + sRect.w / 2, y: sRect.y + sRect.h / 2 };
  const tCenter = { x: tRect.x + tRect.w / 2, y: tRect.y + tRect.h / 2 };
  // 端点：有钉点用钉点（用户手选的位置），没钉点浮动（对着对方端点/中心取边框交点）
  const tPinPoint = d.pins?.target ? pinPoint(tRect, d.pins.target) : null;
  const sPinPoint = d.pins?.source ? pinPoint(sRect, d.pins.source) : null;
  const s = sPinPoint ?? borderPoint(sRect, tPinPoint ?? tCenter);
  const t = tPinPoint ?? borderPoint(tRect, sPinPoint ?? sCenter);
  // 绕障 + 曲线：edgePath 一处组（router.ts）——正交骨架不穿任何节点，再过点平滑；弯折捏点 = 路由必经的途经点
  const mid = { x: (sCenter.x + tCenter.x) / 2, y: (sCenter.y + tCenter.y) / 2 };
  const waypoint = bent ? { x: mid.x + bend.dx, y: mid.y + bend.dy } : null;
  const routed = edgePath(
    { point: s, side: d.pins?.source?.side ?? sideOf(sRect, s) },
    { point: t, side: d.pins?.target?.side ?? sideOf(tRect, t) },
    d.obstacles ?? [],
    waypoint
  );
  const path = routed.d;
  // 捏点压在线上（弯着在途经点，直着在曲线中点）；标签沿中点切向的法线整个让出线身——
  // 推开距离按标签实测量（法向支撑半径 + 10），竖线配宽标签也碰不到
  const curveMid = waypoint ?? routed.mid;
  const labelRef = useRef<HTMLDivElement>(null);
  const [push, setPush] = useState(20);
  const dirX = routed.dir.x;
  const dirY = routed.dir.y;
  useLayoutEffect(() => {
    const el = labelRef.current;
    if (!el) return;
    const nx = -dirY; // 法向
    const ny = dirX;
    const half = (Math.abs(nx) * el.offsetWidth + Math.abs(ny) * el.offsetHeight) / 2; // 矩形在法向上的支撑半径
    setPush(half + 10);
  }, [dirX, dirY, label]);
  const labelPos = { x: curveMid.x - dirY * push, y: curveMid.y + dirX * push };

  // 改接：抓住端点捏点拖到别的对象。复用 XYHandle 的拖拽机（与新建连线同一条预览线、同一套吸附）；
  // 捏点钉在真实的边框附着点上（内置锚点钉在节点上/下中点，跟浮动边对不上，故不用）
  const onAnchorDown = (e: React.PointerEvent<HTMLDivElement>, end: "source" | "target") => {
    if (e.button !== 0) return;
    e.stopPropagation(); // 不 preventDefault：吞 pointerdown 默认行为会连带吞掉 click；nopan 类已拦平移
    const fixed = end === "source" ? { nodeId: target, type: "target" as const } : { nodeId: source, type: "source" as const };
    let connected = false; // XYHandle 松手不吃释放位置（只吃最后一次采样），落空要自己补命中
    d.setReconnecting?.(true);
    XYHandle.onPointerDown(
      e.nativeEvent,
      xyDragArgs(store, {
        handleDomNode: e.currentTarget, // 只用于定位 document；连接点类型由 edgeUpdaterType 定
        isTarget: fixed.type === "target",
        nodeId: fixed.nodeId,
        edgeUpdaterType: fixed.type, // 语义是「不动那端的连接点类型」：决定预览 fromHandle.type，进而决定预览箭头朝向
        onConnect: (connection) => {
          connected = true;
          d.setReconnecting?.(false);
          const { source: ns, target: nt } = connection;
          if (!ns || !nt || ns === nt) return; // 自连不改接
          if (ns === source && nt === target) return; // 拖回原位
          d.commitReconnect?.(id, ns, nt, end);
        },
        onConnectEnd: (evt, connectionState) => {
          store.getState().onConnectEnd?.(evt, connectionState); // 走一遍画布的清尾（connectTrack 复位）
          d.setReconnecting?.(false);
          // 补命中：松手点在别的节点身上即改接（与新建连线的松手补命中同规则）
          if (!connected && evt && "clientX" in evt) {
            const hit = document.elementFromPoint(evt.clientX, evt.clientY)?.closest(".react-flow__node")?.getAttribute("data-id");
            if (hit) {
              const ns = end === "source" ? hit : source;
              const nt = end === "target" ? hit : target;
              if (ns !== nt && !(ns === source && nt === target)) {
                connectTrack.last = rf.screenToFlowPosition({ x: evt.clientX, y: evt.clientY }); // 钉点按松手处算
                d.commitReconnect?.(id, ns, nt, end);
              }
            }
          }
        },
        onReconnectEnd: () => d.setReconnecting?.(false),
      })
    );
  };

  const onKnobDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation(); // 不 preventDefault：理由同上；弯折走自己的 pointermove 监听，不受影响
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // 合成事件没有活动指针，捕获会抛——拖动监听挂在 window 上，不影响
    }
    dragRef.current = { startX: e.clientX, startY: e.clientY, base: bend, zoom: rf.getZoom() };
    const onMove = (ev: PointerEvent) => {
      const g = dragRef.current;
      if (!g) return;
      setDragBend({ dx: g.base.dx + (ev.clientX - g.startX) / g.zoom, dy: g.base.dy + (ev.clientY - g.startY) / g.zoom });
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove);
      const g = dragRef.current;
      dragRef.current = null;
      setDragBend(null);
      if (!g) return;
      const final = { dx: g.base.dx + (ev.clientX - g.startX) / g.zoom, dy: g.base.dy + (ev.clientY - g.startY) / g.zoom };
      // 拖回中点附近（10 个 flow 单位内）吸附成直线
      const straight = Math.hypot(final.dx, final.dy) < 10;
      d.commitBend?.(id, straight ? null : final);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
      <EdgeLabelRenderer>
        {label && (
          <div ref={labelRef} className="edge-label" style={{ transform: `translate(-50%,-50%) translate(${labelPos.x}px,${labelPos.y}px)` }}>
            {label}
          </div>
        )}
        {(d.showKnob || bent || dragBend) && (
          <div
            className={`edge-bend-knob nodrag nopan${bent ? " is-bent" : ""}`}
            style={{ transform: `translate(-50%,-50%) translate(${curveMid.x}px,${curveMid.y}px)` }}
            onPointerDown={onKnobDown}
            title="拖动把线拉弯，拖回中点拉直"
          />
        )}
        {/* 端点捏点：钉在线的真实两端（边框附着点），探出节点 7px 保证整个点都能抓；拖到别的对象即改接 */}
        {d.showKnob &&
          ([[s, sCenter, "source"], [t, tCenter, "target"]] as [Pt, Pt, "source" | "target"][]).map(([bp, center, end]) => {
            const len = Math.hypot(bp.x - center.x, bp.y - center.y) || 1;
            const ax = bp.x + ((bp.x - center.x) / len) * 7;
            const ay = bp.y + ((bp.y - center.y) / len) * 7;
            return (
              <div
                key={end}
                className="edge-bend-knob edge-end-knob nodrag nopan"
                style={{ transform: `translate(-50%,-50%) translate(${ax}px,${ay}px)` }}
                onPointerDown={(e) => onAnchorDown(e, end)}
                title="拖到别的对象即改接这一头"
              />
            );
          })}
      </EdgeLabelRenderer>
    </>
  );
}
