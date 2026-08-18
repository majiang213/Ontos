// 本体画布 —— 节点是对象类型，边是关系。
// 位置：已存摆位（草稿里的 layout）优先，其余走 dagre 分层；「整理布局」一键重排并记住。
"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
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
  type Edge,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { layoutObjects } from "../lib/layout";
import FloatingEdge from "./FloatingEdge";

export interface CanvasObject {
  name: string;
  description?: string;
  kind: "thing" | "event";
  properties: { name: string; type: string; derived: boolean; values?: (string | number)[] }[];
  sources: { key: string; label: string }[]; // key=源条目名，label=connection.table
  actions: string[];
  state?: "new" | "modified" | "same"; // 草稿态：new=未发布的新对象，modified=有未发布改动
}

export interface CanvasLink {
  name: string;
  from: string;
  to: string;
  inverse?: string;
  kind: "match" | "transition";
}

function ObjectNode({ data }: { data: ObjNodeData }) {
  const cls = data.state === "new" ? "node-shell is-new" : data.state === "modified" ? "node-shell is-modified" : "node-shell";
  return (
    <div className={cls}>
      {/* 上下各一对连接点：平时透明，悬停节点时浮现；从底部拖出、落到别家顶部即连线 */}
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
              <span className="t">
                {p.type}
                {p.derived ? " · 派生" : ""}
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

export default function OntologyCanvas(props: {
  objects: CanvasObject[];
  links: CanvasLink[];
  layout?: Record<string, { x: number; y: number }>;
  selectedLink?: string | null;
  onSelect: (name: string) => void;
  onSelectLink?: (name: string) => void;
  onConnectRequest?: (from: string, to: string) => void;
  onLayoutChange?: (positions: Record<string, { x: number; y: number }>) => void;
  onToggleMaximize?: () => void;
}) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}

function Flow({
  objects,
  links,
  layout,
  selectedLink,
  onSelect,
  onSelectLink,
  onConnectRequest,
  onLayoutChange,
  onToggleMaximize,
}: {
  objects: CanvasObject[];
  links: CanvasLink[];
  layout?: Record<string, { x: number; y: number }>;
  selectedLink?: string | null;
  onSelect: (name: string) => void;
  onSelectLink?: (name: string) => void;
  onConnectRequest?: (from: string, to: string) => void;
  onLayoutChange?: (positions: Record<string, { x: number; y: number }>) => void;
  onToggleMaximize?: () => void;
}) {
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
  /** 一键理顺：重跑分层布局并取景、记住新摆位。导入一批新表、或拖乱了之后用。 */
  const tidy = useCallback(() => {
    const pos = layoutObjects(objects, links);
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    onLayoutChange?.(Object.fromEntries(pos));
    // 双帧后取景：等节点重新测量完
    requestAnimationFrame(() => requestAnimationFrame(() => rf.fitView({ padding: 0.2 })));
  }, [objects, links, setNodes, rf, onLayoutChange]);

  const edges: Edge[] = useMemo(
    () =>
      links.map((l) => ({
        id: l.name,
        type: "floating",
        source: l.from,
        target: l.to,
        label: l.inverse ? `${l.name} / ${l.inverse}` : l.name,
        style: l.name === selectedLink
          ? { stroke: "var(--accent)", strokeWidth: 2.5 } // 点中的边高亮
          : l.kind === "transition"
            ? { strokeDasharray: "6 4", stroke: "var(--warn)" }
            : undefined,
        // 箭头跟着边色走，高亮时不拖灰箭头
        markerEnd: { type: MarkerType.ArrowClosed, color: l.name === selectedLink ? "#3b36b0" : l.kind === "transition" ? "#8a5f0b" : undefined },
        interactionWidth: 20, // 线的点击热区放宽，细线也好点
      })),
    [links, selectedLink]
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
      deleteKeyCode={null} // 删除只走编辑卡/详情卡：键盘删节点不过草稿，状态会乱
      onNodesChange={onNodesChange}
      onNodeClick={(_, node) => onSelect(node.id)}
      onEdgeClick={(_, edge) => onSelectLink?.(edge.id)}
      onConnect={(c) => {
        if (c.source && c.target && c.source !== c.target) onConnectRequest?.(c.source, c.target); // 自连不在表单里做
      }}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} color="rgba(32,29,24,0.06)" />
      <Controls showInteractive={false} />
      <Panel position="top-right" style={{ display: "flex", gap: 8 }}>
        {onToggleMaximize && <button className="btn" onClick={onToggleMaximize}>最大化</button>}
        <button className="btn" onClick={tidy}>整理布局</button>
      </Panel>
    </ReactFlow>
  );
}
