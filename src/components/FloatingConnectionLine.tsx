// 连线预览 —— 与 FloatingEdge 同一套边框附着算法：拖到目标节点身上时预览线就钉在
// 最终边会走的两个边框点上，松手后渲染的边与预览一致（默认预览是钉在连接点上的，会骗）。
// 预览箭头方向 = 关系的方向：新建恒指向落点（reversed=false）；改接已有线的源端时指回固定端（reversed=true）。
"use client";

import { getStraightPath, type ConnectionLineComponentProps } from "@xyflow/react";
import { borderPoint, rectOf } from "./FloatingEdge";

// 与最终边同一款箭头（MarkerType.ArrowClosed 同参数同色 #b1b1b7，SVG marker 不吃 CSS var，故写死）
const ARROW_ID = "ontos-conn-arrow";

export default function FloatingConnectionLine({ fromNode, toNode, toX, toY, reversed = false }: ConnectionLineComponentProps & { reversed?: boolean }) {
  const from = rectOf(fromNode);
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  let start = borderPoint(from, { x: toX, y: toY });
  let end = { x: toX, y: toY };
  // 落到别的节点身上（含吸附半径内）：两端都按边框点预览，与松手后的边一致
  if (toNode && toNode.id !== fromNode.id) {
    const to = rectOf(toNode);
    const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
    start = borderPoint(from, toCenter);
    end = borderPoint(to, fromCenter);
  }
  const [path] = getStraightPath({ sourceX: start.x, sourceY: start.y, targetX: end.x, targetY: end.y });
  return (
    <>
      <defs>
        <marker id={ARROW_ID} markerWidth="12.5" markerHeight="12.5" viewBox="-10 -10 20 20" refX="0" refY="0" orient="auto-start-reverse" markerUnits="strokeWidth">
          <path d="M -5,-4 L 5,0 L -5,4 Z" fill="#b1b1b7" stroke="none" />
        </marker>
      </defs>
      <path
        className="react-flow__connection-path"
        d={path}
        fill="none"
        markerStart={reversed ? `url(#${ARROW_ID})` : undefined}
        markerEnd={reversed ? undefined : `url(#${ARROW_ID})`}
      />
    </>
  );
}
