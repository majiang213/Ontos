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
  type ConnectionLineComponentProps,
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutObjects, type CanvasLink, type CanvasObject } from "./layout";
import FloatingEdge, { type Bend } from "./FloatingEdge";
import FloatingConnectionLine from "./FloatingConnectionLine";

function ObjectNode({ data }: { data: ObjNodeData }) {
  const cls = data.state === "new" ? "node-shell is-new" : data.state === "modified" ? "node-shell is-modified" : "node-shell";
  return (
    <div className={cls}>
      {/* 上下各一个连接点：平时透明，悬停节点浮现。两个点都只是抓手——方向恒为 拖出节点 → 落点节点，
          与从哪个点拖、节点摆在哪无关（顶点拖出在 onConnect 里换回方向）；预览线的箭头就是关系的方向 */}
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
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
  selectedLink?: string | null;
  onSelect: (name: string) => void;
  onSelectLink?: (name: string) => void;
  onConnectRequest?: (from: string, to: string) => void;
  onReconnectLink?: (name: string, from: string, to: string) => void; // 拖着已有边的一头改接到别的对象
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

function Flow({ objects, links, layout, edgeBends, selectedLink, onSelect, onSelectLink, onConnectRequest, onReconnectLink, onBendChange, onLayoutChange }: CanvasProps) {
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
  const reconnecting = useRef(false); // 正在改接已有线（预览箭头方向用：改接源端时箭头指回固定端）
  // 组件身份必须稳定（否则拖动中途换类型会重挂预览），方向标记走 ref
  const ConnectionLinePreview = useCallback(
    (p: ConnectionLineComponentProps) => (
      <FloatingConnectionLine {...p} reversed={reconnecting.current && p.fromHandle.type === "target"} />
    ),
    []
  );
  /** 一键理顺：重跑分层布局并取景、记住新摆位。导入一批新表、或拖乱了之后用。 */
  const tidy = useCallback(() => {
    const pos = layoutObjects(objects, links);
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    onLayoutChange?.(Object.fromEntries(pos));
    // 双帧后取景：等节点重新测量完
    requestAnimationFrame(() => requestAnimationFrame(() => rf.fitView({ padding: 0.2 })));
  }, [objects, links, setNodes, rf, onLayoutChange]);

  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null); // 悬停的边：露出弯折捏点与改接锚点
  const edges: Edge[] = useMemo(
    () =>
      links.map((l) => ({
        id: l.name,
        type: "floating",
        source: l.from,
        target: l.to,
        label: l.inverse ? `${l.name} / ${l.inverse}` : l.name,
        ...edgeTone(l, selectedLink), // 边色与箭头一处判定
        interactionWidth: 20, // 线的点击热区放宽，细线也好点
        data: { bend: edgeBends?.[l.name], showKnob: hoveredEdge === l.name || selectedLink === l.name, commitBend: onBendChange },
      })),
    [links, selectedLink, edgeBends, hoveredEdge, onBendChange]
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
      connectionRadius={150} // 半径要盖过节点半身位（节点最大 288×~220），落在节点正中也能吸附
      connectOnClick={false} // 点选连线会和节点点击（开编辑卡）打架，只保留拖拽一种手势
      connectionLineComponent={ConnectionLinePreview} // 预览与最终边同算法：选中的落点就是新建后的落点
      deleteKeyCode={null} // 删除只走编辑卡/详情卡：键盘删节点不过草稿，状态会乱
      onNodesChange={onNodesChange}
      onNodeClick={(_, node) => onSelect(node.id)}
      onEdgeClick={(_, edge) => onSelectLink?.(edge.id)}
      onEdgeMouseEnter={(_, edge) => setHoveredEdge(edge.id)}
      onEdgeMouseLeave={() => setHoveredEdge(null)}
      onConnectStart={(_, params) => {
        startHandleType.current = params.handleType ?? null;
      }}
      onConnect={(c) => {
        if (!c.source || !c.target || c.source === c.target) return; // 自连不在表单里做
        // 方向恒为 拖出节点 → 落点节点：从顶点（target 点）拖出时 xyflow 会给成反向，换回来
        const swapped = startHandleType.current === "target";
        onConnectRequest?.(swapped ? c.target : c.source, swapped ? c.source : c.target);
      }}
      onReconnect={(oldEdge, c) => {
        // 拖回原位或自连都不算改接；走 update_link 改 from/to，配对字段由服务端跟着新端点修
        if (!c.source || !c.target || c.source === c.target) return;
        if (c.source === oldEdge.source && c.target === oldEdge.target) return;
        onReconnectLink?.(oldEdge.id, c.source, c.target);
      }}
      reconnectRadius={12} // 改接锚点（钉在节点上/下中点）的可抓半径
      onReconnectStart={() => {
        reconnecting.current = true;
      }}
      onReconnectEnd={() => {
        reconnecting.current = false;
        startHandleType.current = null;
      }}
      onConnectEnd={() => {
        reconnecting.current = false; // 改接结束 onConnectEnd 也会先发一次，兜底清理
        startHandleType.current = null;
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
