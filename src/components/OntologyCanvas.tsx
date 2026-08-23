// 本体画布 —— 节点是对象类型，边是关系。
// 位置：已存摆位（草稿里的 layout）优先，其余走 dagre 分层；「整理布局」一键重排并记住。
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  ConnectionMode,
  Controls,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useNodesState,
  useReactFlow,
  useStoreApi,
  type ConnectionLineComponentProps,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import { XYHandle } from "@xyflow/system";
import "@xyflow/react/dist/style.css";
import { layoutObjects, NODE_H, NODE_W, type CanvasLink, type CanvasObject } from "./layout";
import FloatingEdge, { closestBorderPin, rectOf, type Bend, type BorderPin } from "./FloatingEdge";
import FloatingConnectionLine from "./FloatingConnectionLine";
import { connectTrack, xyDragArgs } from "./connectTrack";

/** 四边连接条拖出的线，落成时走这个桥（ObjectNode 够不到 Flow 的 finishConnect）；Flow 每次渲染挂上最新版。 */
const ringConnect: { current: ((c: { source: string | null; target: string | null }) => void) | null } = { current: null };

function ObjectNode({ data }: { data: ObjNodeData }) {
  const store = useStoreApi();
  const cls = data.state === "new" ? "node-shell is-new" : data.state === "modified" ? "node-shell is-modified" : "node-shell";
  /** 四边连接条：从任一边的任意点拖出即连线（与把手同走 XYHandle 一套拖拽机；透传参数在 connectTrack.xyDragArgs 一处）。
      不 stopPropagation/preventDefault：吞掉 pointerdown 的默认行为会连带吞掉 click，边框一带的单击开不出编辑卡；
      节点拖动/画布平移由 nodrag/nopan 类拦（与把手同机制），单击则冒泡成节点点击 */
  const onStripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    XYHandle.onPointerDown(
      e.nativeEvent,
      xyDragArgs(store, {
        handleDomNode: e.currentTarget, // 条上带 source 类：连接点类型由此判定（方向 = 本节点 → 落点）
        isTarget: false,
        nodeId: data.name,
        onConnect: (c) => ringConnect.current?.(c),
        onConnectEnd: (...args) => store.getState().onConnectEnd?.(...args),
      })
    );
  };
  return (
    <div className={cls}>
      {/* 上下各一个连接把手：不显示、不当抓手（起线走下面的四边连接条），但连接机器与边定位要读它，必须在 */}
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
      {/* 四条边的任意点都是抓手：跨在边框上的隐形条，方向恒为 拖出节点 → 落点节点，端点钉在抓取/落点的边框位置 */}
      {(["top", "bottom", "left", "right"] as const).map((side) => (
        <div key={side} className={`connect-strip ${side} source nodrag nopan`} onPointerDown={onStripDown} />
      ))}
      <div className="node-core">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="node-title">{data.label}</span>
          <span className="node-kind">{data.kind === "thing" ? "事物" : "事件"}</span>
          {data.state === "new" && <span className="tag tag-warn">草稿</span>}
          {data.state === "modified" && <span className="tag tag-warn">待发布</span>}
        </div>
        {data.description && <div className="node-desc">{data.description}</div>}
        <div className="node-props">
          {data.properties.map((p) => (
            <div key={p.name} className="node-prop">
              <code>{p.name}</code>
              <span className="t" style={{ maxWidth: 170, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p.type}
                {p.derived ? " · 派生" : ""}
                {p.description ? ` · ${p.description}` : ""}
              </span>
            </div>
          ))}
        </div>
        <div className="node-tags">
          {data.sources.map((s) => (
            <span key={s.key} className="tag">{s.label}</span>
          ))}
          {data.actions.map((a) => (
            <span key={a} className="tag tag-ok">{a}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

type ObjNodeData = Record<string, unknown> & CanvasObject & { label: string };
const nodeTypes = { obj: ObjectNode };
const edgeTypes = { floating: FloatingEdge };

/** 画布 props（唯一一份）：外层 Provider 包装与内部 Flow 共用。 */
export interface CanvasProps {
  objects: CanvasObject[];
  links: CanvasLink[];
  layout?: Record<string, { x: number; y: number }>;
  edgeBends?: Record<string, Bend>; // 线的弯折点（界面状态，随摆位存）
  edgePins?: Record<string, { source?: BorderPin; target?: BorderPin }>; // 端点钉点（手选位置；无则浮动附着）
  selectedLink?: string | null;
  onSelect: (name: string) => void;
  onSelectLink?: (name: string) => void;
  onConnectRequest?: (from: string, to: string, pins?: { source?: BorderPin; target?: BorderPin }) => void;
  onReconnectLink?: (name: string, from: string, to: string, moved?: { end: "source" | "target"; pin?: BorderPin }) => void; // 拖着已有边的一头改接到别的对象
  onBendChange?: (name: string, bend: Bend | null) => void; // 拖线身捏点拉弯/拉直
  onLayoutChange?: (positions: Record<string, { x: number; y: number }>) => void;
}

export default function OntologyCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}

/** 边色一处判：点中 > 转化 > 默认；style 与 markerEnd 同产（hex 与 globals.css 的 --accent/--warn 同值——SVG marker 不吃 CSS var，故常量单源）。
 *  默认边也必须显式给 marker 颜色：color 缺省时不渲染箭头（marker 不继承边的描边色）。 */
const EDGE_ACCENT = "#3b36b0"; // = var(--accent)
const EDGE_WARN = "#8a5f0b"; // = var(--warn)
const EDGE_DEFAULT = "#b1b1b7"; // = xyflow 默认边色（.react-flow__edge-path 的默认 stroke）
function edgeTone(l: CanvasLink, selectedLink?: string | null): { style: Edge["style"]; markerEnd: Edge["markerEnd"] } {
  const selected = l.name === selectedLink;
  const transition = l.kind === "transition";
  return {
    style: selected ? { stroke: "var(--accent)", strokeWidth: 2.5 } : transition ? { strokeDasharray: "6 4", stroke: "var(--warn)" } : undefined,
    markerEnd: { type: MarkerType.ArrowClosed, color: selected ? EDGE_ACCENT : transition ? EDGE_WARN : EDGE_DEFAULT },
  };
}

function Flow({ objects, links, layout, edgeBends, edgePins, selectedLink, onSelect, onSelectLink, onConnectRequest, onReconnectLink, onBendChange, onLayoutChange }: CanvasProps) {
  const initialNodes: Node<ObjNodeData>[] = useMemo(() => {
    const pos = layoutObjects(objects, links);
    return objects.map((o) => ({
      id: o.name,
      type: "obj",
      position: layout?.[o.name] ?? pos.get(o.name) ?? { x: 0, y: 0 }, // 已存摆位优先
      data: { ...o, label: o.name },
    }));
  }, [objects, links, layout]);

  // 受控节点状态：没有 onNodesChange 把变化写回 state，拖动会被旧 props 弹回
  const [nodes, setNodes] = useNodesState(initialNodes);
  // 配置/摆位刷新时保留当前摆位：正在拖的节点不被回包弹回原位
  useEffect(() => {
    setNodes((ns) =>
      initialNodes.map((n) => {
        const cur = ns.find((x) => x.id === n.id);
        return cur ? { ...n, position: cur.position } : n;
      })
    );
  }, [initialNodes, setNodes]);
  const onNodesChange = useCallback(
    (changes: NodeChange<Node<ObjNodeData>>[]) => {
      setNodes((ns) => applyNodeChanges(changes, ns));
      // 拖动结束（position 且 dragging=false）时记住摆位
      const done = changes.filter(
        (c): c is Extract<NodeChange<Node<ObjNodeData>>, { type: "position" }> =>
          c.type === "position" && c.dragging === false && Boolean(c.position)
      );
      if (done.length && onLayoutChange) {
        onLayoutChange(Object.fromEntries(done.map((c) => [c.id, c.position!])));
      }
    },
    [setNodes, onLayoutChange]
  );

  const rf = useReactFlow();
  const startHandleType = useRef<"source" | "target" | null>(null); // 本次拖拽从哪种点拉出（onConnect 换方向用）
  const connectFired = useRef(false); // onConnect 是否已落成（松手补命中的闸：toHandle 在无效命中时也非空，不能拿它当判据）
  const reconnecting = useRef(false); // 正在改接已有线（预览箭头方向用：改接源端时箭头指回固定端；由边 data.setReconnecting 驱动）
  // 组件身份必须稳定（否则拖动中途换类型会重挂预览），方向标记走 ref
  const ConnectionLinePreview = useCallback(
    (p: ConnectionLineComponentProps) => (
      <FloatingConnectionLine {...p} reversed={reconnecting.current && p.fromHandle.type === "target"} />
    ),
    []
  );
  // 连线拖拽全程跟指针（flow 坐标）：松手时按它钉落点端
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (connectTrack.active) connectTrack.last = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    };
    document.addEventListener("mousemove", move); // active 闸：只在连线拖拽中取数
    return () => document.removeEventListener("mousemove", move);
  }, [rf]);
  /** 指针位置 → 该节点边框上最近的钉点。 */
  const pinAt = (nodeId: string, p: { x: number; y: number } | null): BorderPin | undefined => {
    if (!p) return undefined;
    const n = rf.getInternalNode(nodeId);
    return n ? closestBorderPin(rectOf(n), p).pin : undefined;
  };
  /** 连线落成：方向恒为 拖出节点 → 落点节点（顶点拖出换回来）；两端钉点按抓取/落点位置钉在边框上。 */
  const finishConnect = (c: { source: string | null; target: string | null }, swapped: boolean) => {
    if (!c.source || !c.target || c.source === c.target) return;
    const from = swapped ? c.target : c.source;
    const to = swapped ? c.source : c.target;
    onConnectRequest?.(from, to, { source: pinAt(from, connectTrack.start), target: pinAt(to, connectTrack.last) });
  };
  useEffect(() => {
    ringConnect.current = (c) => finishConnect(c, false); // 四边连接条恒从源点拖出，不用换向
  });
  /** 一键理顺：重跑分层布局并取景、记住新摆位。导入一批新表、或拖乱了之后用。 */
  const tidy = useCallback(() => {
    const pos = layoutObjects(objects, links);
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    onLayoutChange?.(Object.fromEntries(pos));
    // 双帧后取景：等节点重新测量完
    requestAnimationFrame(() => requestAnimationFrame(() => rf.fitView({ padding: 0.2 })));
  }, [objects, links, setNodes, rf, onLayoutChange]);

  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null); // 悬停的边：露出弯折捏点与改接锚点
  // 全部节点矩形：边的绕障路由吃这份（节点拖动时每帧重算，边跟着重绕）
  const obstacles = useMemo(
    () => nodes.map((n) => ({ x: n.position.x, y: n.position.y, w: n.measured?.width ?? NODE_W, h: n.measured?.height ?? NODE_H })), // 未测量回退与 rectOf 同常量（layout.ts）
    [nodes]
  );
  const edges: Edge[] = useMemo(
    () =>
      links.map((l) => ({
        id: l.name,
        type: "floating",
        source: l.from,
        target: l.to,
        // 线上标注两行：主行关系描述（没有退英文名），副行「源对象 → 目标对象」中文名——谓语的论元与方向都在线上
        label: (
          <>
            <span>{l.description ?? (l.inverse ? `${l.name} / ${l.inverse}` : l.name)}</span>
            <span className="edge-label-sub">
              {l.fromLabel} → {l.toLabel}
            </span>
          </>
        ),
        ...edgeTone(l, selectedLink), // 边色与箭头一处判定
        interactionWidth: 20, // 线的点击热区放宽，细线也好点
        data: {
          bend: edgeBends?.[l.name],
          pins: edgePins?.[l.name],
          obstacles,
          showKnob: hoveredEdge === l.name || selectedLink === l.name,
          commitBend: onBendChange,
          // 改接走 update_link 改 from/to（配对字段由服务端跟着新端点修）；被拖的那头按落点钉新钉点
          commitReconnect: (name: string, from: string, to: string, movedEnd: "source" | "target") => {
            onReconnectLink?.(name, from, to, { end: movedEnd, pin: pinAt(movedEnd === "source" ? from : to, connectTrack.last) });
          },
          setReconnecting: (v: boolean) => {
            reconnecting.current = v;
          },
        },
      })),
    [links, selectedLink, edgeBends, edgePins, hoveredEdge, onBendChange, onReconnectLink, obstacles]
  );

  // 首批对象到达后才取景（挂载时 nodes 恒为空，fitView 等于白做）
  const fittedOnce = useRef(false);
  useEffect(() => {
    if (!fittedOnce.current && objects.length > 0) {
      fittedOnce.current = true;
      requestAnimationFrame(() => rf.fitView({ padding: 0.2 }));
    }
  }, [objects.length, rf]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      nodesDraggable
      nodesConnectable
      // 手动连线宽松判定：落在目标对象身上任意位置都算连它（取最近的连接点）；
      // 严格模式必须命中对方 10px 的顶点，用户拖上去多半落空，表现为「连不上」
      connectionMode={ConnectionMode.Loose}
      connectionRadius={300} // 半径要盖过最大节点的半对角线（~185）：落在大卡片侧边正中也能连上
      connectOnClick={false} // 点选连线会和节点点击（开编辑卡）打架，只保留拖拽一种手势
      connectionDragThreshold={6} // 起拖要拖出 6px：单击的抖动永远起不了线，单击就是单击
      connectionLineComponent={ConnectionLinePreview} // 预览与最终边同算法：选中的落点就是新建后的落点
      deleteKeyCode={null} // 删除只走编辑卡/详情卡：键盘删节点不过草稿，状态会乱
      onNodesChange={onNodesChange}
      onNodeClick={(_, node) => onSelect(node.id)}
      onEdgeClick={(_, edge) => onSelectLink?.(edge.id)}
      onEdgeMouseEnter={(_, edge) => setHoveredEdge(edge.id)}
      onEdgeMouseLeave={() => setHoveredEdge(null)}
      onConnectStart={(e, params) => {
        startHandleType.current = params.handleType ?? null;
        const pt = "clientX" in e ? { x: e.clientX, y: e.clientY } : { x: e.touches[0]?.clientX ?? 0, y: e.touches[0]?.clientY ?? 0 };
        connectTrack.active = true;
        connectTrack.start = rf.screenToFlowPosition(pt); // 抓取点：决定源端钉点
        connectTrack.last = connectTrack.start;
      }}
      onConnect={(c) => {
        connectFired.current = true;
        finishConnect(c, startHandleType.current === "target"); // 顶点拖出时 xyflow 会给成反向，换回来
      }}
      onConnectEnd={(event, connectionState) => {
        // 补命中：XYHandle 松手时只吃最后一次 mousemove 的采样——快速甩过去时采样还在半空，松手点已在节点上却判落空。
        // 这里按松手的实际位置补一次（改接拖拽不补：它的落空语义是「不改」）
        if (!reconnecting.current && !connectFired.current && connectionState.fromNode && "clientX" in event) {
          const nodeEl = document.elementFromPoint(event.clientX, event.clientY)?.closest(".react-flow__node");
          const toId = nodeEl?.getAttribute("data-id");
          if (toId && toId !== connectionState.fromNode.id) {
            connectTrack.last = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }); // 落点端钉点按松手处算
            finishConnect({ source: connectionState.fromNode.id, target: toId }, startHandleType.current === "target");
          }
        }
        reconnecting.current = false;
        startHandleType.current = null;
        connectFired.current = false;
        connectTrack.active = false;
        connectTrack.start = null;
      }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} color="rgba(32,29,24,0.06)" />
      <Controls showInteractive={false} />
      <Panel position="top-right" style={{ display: "flex", gap: 8 }}>
        <button className="btn" onClick={tidy}>整理布局</button>
      </Panel>
    </ReactFlow>
  );
}
