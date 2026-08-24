// 连线预览 —— 路径算法与最终边同一处（router.ts 的 edgePath）：起点 = 抓取处最近的边框点，终点 = 指针处最近的边框点
// （落在节点身上时），正交绕开所有节点；松手后渲染的边与预览一致。
// 预览箭头方向 = 关系的方向：新建恒指向落点（reversed=false）；改接已有线的源端时指回固定端（reversed=true）。
"use client";

import { useReactFlow, useStoreApi, type ConnectionLineComponentProps } from "@xyflow/react";
import { borderPoint, closestBorderPin, rectOf } from "./geometry";
import { currentSession } from "./connectSession";
import { edgePath, type RouteRect } from "./router";

// 与最终边同一款箭头（MarkerType.ArrowClosed 同参数同色 #b1b1b7，SVG marker 不吃 CSS var，故写死）
const ARROW_ID = "ontos-conn-arrow";

export default function FloatingConnectionLine({ fromNode, toNode, toX, toY, pointer: rawPointer, reversed = false }: ConnectionLineComponentProps & { reversed?: boolean }) {
  const rf = useReactFlow();
  const store = useStoreApi();
  const from = rectOf(fromNode);
  // 注意两处坑：吸附成功时 toX/toY 是把手中心（不是真指针）；而 pointer 是容器屏幕坐标——钉点要跟着手走，且一律换算回 flow 坐标
  const raw = rawPointer ?? { x: toX, y: toY };
  const vp = rf.getViewport();
  const pointer = { x: (raw.x - vp.x) / vp.zoom, y: (raw.y - vp.y) / vp.zoom };
  // 起点：抓取处最近的边框点（钉点候选）；拿不到跟踪点时退化为对着终点的边框交点
  const grab = currentSession()?.start;
  const startPin = grab ? closestBorderPin(from, grab) : null;
  // 终点：落在别的节点身上（含吸附半径内）= 指针处最近的边框点
  const endPin = toNode && toNode.id !== fromNode.id ? closestBorderPin(rectOf(toNode), pointer) : null;
  const start = startPin?.point ?? borderPoint(from, endPin?.point ?? pointer); // 退化：对着终点方向的边框交点
  const end = endPin?.point ?? pointer;
  // 与最终边同一路由（edgePath 一处）：绕开所有节点（含两端节点，桩负责进出），再过点平滑成曲线
  const obstacles: RouteRect[] = [];
  for (const n of store.getState().nodeLookup.values()) obstacles.push(rectOf(n));
  const path = startPin && endPin
    ? edgePath({ point: start, side: startPin.pin.side }, { point: end, side: endPin.pin.side }, obstacles).d
    : `M ${start.x},${start.y} L ${end.x},${end.y}`; // 没到任何节点身上：直线跟手
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
