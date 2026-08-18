// 浮动边 —— 连接点不定死在节点中心点：按两端节点的相对方位，
// 在节点边框上各自算附着点，多根边自然散开。自环（转化关系）画成节点上方的小环。
"use client";

import { BaseEdge, EdgeLabelRenderer, getStraightPath, useInternalNode, type EdgeProps } from "@xyflow/react";

interface Pt {
  x: number;
  y: number;
}

/** 中心连线与节点矩形边框的交点。 */
function borderPoint(from: { x: number; y: number; w: number; h: number }, to: Pt): Pt {
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  const dx = to.x - cx;
  const dy = to.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(Math.abs(from.w / 2 / (dx || 1e-6)), Math.abs(from.h / 2 / (dy || 1e-6)));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function rectOf(node: { internals: { positionAbsolute: { x: number; y: number } }; measured: { width?: number; height?: number } }) {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    w: node.measured.width ?? 300,
    h: node.measured.height ?? 160,
  };
}

export default function FloatingEdge({ id, source, target, label, style, markerEnd, interactionWidth }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  if (!sourceNode || !targetNode) return null;

  // 自环：节点上方一个小半环
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

  const sRect = rectOf(sourceNode);
  const tRect = rectOf(targetNode);
  const sCenter = { x: sRect.x + sRect.w / 2, y: sRect.y + sRect.h / 2 };
  const tCenter = { x: tRect.x + tRect.w / 2, y: tRect.y + tRect.h / 2 };
  const s = borderPoint(sRect, tCenter);
  const t = borderPoint(tRect, sCenter);
  const [path, labelX, labelY] = getStraightPath({ sourceX: s.x, sourceY: s.y, targetX: t.x, targetY: t.y });

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />
      {label && (
        <EdgeLabelRenderer>
          <div className="edge-label" style={{ transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)` }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
