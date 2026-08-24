// 浮动边 —— 连接点不定死在节点中心点：按两端节点的相对方位，
// 在节点边框上各自算附着点，多根边自然散开。自环（转化关系）画成节点上方的小环。
// 线身编辑：中点捏点拖弯（存摆位表，拖回中点拉直）；两端捏点钉在真实的边框附着点上，拖到别的对象即改接。
// 几何（边框附着点/钉点/最近边框候选）在 ./geometry；路由在 ./router。本文件只剩组件。
"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, useInternalNode, useReactFlow, useStoreApi, type EdgeProps } from "@xyflow/react";
import { XYHandle } from "@xyflow/system";
import { beginSession, fireSession, xyDragArgs } from "./connectSession";
import { edgePath, type RouteRect } from "./router";
import { borderPoint, closestBorderPin, pinPoint, rectOf, type Bend, type BorderPin, type Pt } from "./geometry";

interface BendData {
  bend?: Bend;
  pins?: { source?: BorderPin; target?: BorderPin }; // 端点钉点：缺省浮动（按相对方位取边框交点）
  obstacles?: RouteRect[]; // 全部节点的矩形：绕障路由用（含本边的两端节点——桩负责进出）
  showKnob?: boolean; // 悬停/详情卡打开时露出捏点（弯折点 + 两端改接点）
  commitBend?: (name: string, bend: Bend | null) => void;
  commitReconnect?: (name: string, from: string, to: string, movedEnd: "source" | "target") => void;
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
    // 浮动端点的法线方向：点已在边框上，最近边框候选就是它自己，pin.side 即方位（geometry 单源，原 sideOf 已收编）
    { point: s, side: d.pins?.source?.side ?? closestBorderPin(sRect, s).pin.side },
    { point: t, side: d.pins?.target?.side ?? closestBorderPin(tRect, t).pin.side },
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
    // 会话在 pointerdown 就开（抢在 XYHandle 的 onConnectStart 前面）：kind=reconnect 让预览箭头指回固定端，
    // onDrop 带改接的 commit——画布的 onConnectStart 见到 reconnect 会话会跳过不顶
    const grab = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    beginSession({
      kind: "reconnect",
      fromNode: fixed.nodeId, // 补命中的自连 veto：不动那端
      start: grab,
      last: grab,
      fromHandleType: null,
      onDrop: (hit) => {
        const ns = end === "source" ? hit : source;
        const nt = end === "target" ? hit : target;
        if (ns === nt || (ns === source && nt === target)) return; // 自连 / 拖回原位不改接
        d.commitReconnect?.(id, ns, nt, end);
      },
    });
    XYHandle.onPointerDown(
      e.nativeEvent,
      xyDragArgs(store, {
        handleDomNode: e.currentTarget, // 只用于定位 document；连接点类型由 edgeUpdaterType 定
        isTarget: fixed.type === "target",
        nodeId: fixed.nodeId,
        edgeUpdaterType: fixed.type, // 语义是「不动那端的连接点类型」：决定预览 fromHandle.type，进而决定预览箭头朝向
        onConnect: (connection) => {
          console.log("[dbg] edge onConnect", JSON.stringify(connection));
          fireSession(); // 已落成：松手补命中的闸
          const { source: ns, target: nt } = connection;
          if (!ns || !nt || ns === nt) return; // 自连不改接
          if (ns === source && nt === target) return; // 拖回原位
          d.commitReconnect?.(id, ns, nt, end);
        },
        // 清尾统一走画布那道（dropSession 补命中 + endSession）：补命中的 commit 在会话的 onDrop 上
        onConnectEnd: (...args) => store.getState().onConnectEnd?.(...args),
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
