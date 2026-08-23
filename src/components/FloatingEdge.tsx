// 浮动边 —— 连接点不定死在节点中心点：按两端节点的相对方位，
// 在节点边框上各自算附着点，多根边自然散开。自环（转化关系）画成节点上方的小环。
// 线身弯折：中点的捏点（悬停/有弯折时出现）拖动把线拉弯，弯折量存摆位表，拖回中点附近即拉直。
"use client";

import { useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, useInternalNode, useReactFlow, type EdgeProps } from "@xyflow/react";
import { NODE_H, NODE_W } from "./layout";

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

interface BendData {
  bend?: Bend;
  showKnob?: boolean; // 悬停/详情卡打开时露出捏点
  commitBend?: (name: string, bend: Bend | null) => void;
}

export default function FloatingEdge({ id, source, target, label, style, markerEnd, interactionWidth, data }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const rf = useReactFlow();
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
  const s = borderPoint(sRect, tCenter);
  const t = borderPoint(tRect, sCenter);
  // 二次贝塞尔：控制点 = 两端节点中心连线的中点 + 弯折偏移；零偏移即直线（Q 退化为共线）
  const mid = { x: (sCenter.x + tCenter.x) / 2, y: (sCenter.y + tCenter.y) / 2 };
  const c = { x: mid.x + bend.dx, y: mid.y + bend.dy };
  const path = `M ${s.x},${s.y} Q ${c.x},${c.y} ${t.x},${t.y}`;
  // 曲线上 t=0.5 的点（捏点与标签的位置）：(s + 2c + t) / 4
  const curveMid = { x: (s.x + 2 * c.x + t.x) / 4, y: (s.y + 2 * c.y + t.y) / 4 };

  const onKnobDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
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
          <div className="edge-label" style={{ transform: `translate(-50%,-50%) translate(${curveMid.x}px,${curveMid.y}px)` }}>
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
      </EdgeLabelRenderer>
    </>
  );
}
