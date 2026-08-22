// 连线预览 —— 与 FloatingEdge 同一套边框附着算法：拖到目标节点身上时预览线就钉在
// 最终边会走的两个边框点上，松手后渲染的边与预览一致（默认预览是钉在连接点上的，会骗）。
"use client";

import { getStraightPath, type ConnectionLineComponentProps } from "@xyflow/react";
import { borderPoint, rectOf } from "./FloatingEdge";

export default function FloatingConnectionLine({ fromNode, toNode, toX, toY }: ConnectionLineComponentProps) {
  const from = rectOf(fromNode);
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  let start = borderPoint(from, { x: toX, y: toY });
  let end = { x: toX, y: toY };
  // 落到别的节点身上（含 150px 吸附半径内）：两端都按边框点预览，与松手后的边一致
  if (toNode && toNode.id !== fromNode.id) {
    const to = rectOf(toNode);
    const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
    start = borderPoint(from, toCenter);
    end = borderPoint(to, fromCenter);
  }
  const [path] = getStraightPath({ sourceX: start.x, sourceY: start.y, targetX: end.x, targetY: end.y });
  return <path className="react-flow__connection-path" d={path} fill="none" />;
}
