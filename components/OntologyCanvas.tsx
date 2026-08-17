// 本体画布 —— 节点是对象类型，边是关系。只读展示已发布配置（编辑走发布流程，M4 之后开放）。
// 节点卡用 Double-Bezel；位置由 dagre 分层布局给出（被引用的根在上）；「整理布局」随时重排。
"use client";

import { useCallback, useEffect, useMemo } from "react";
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

export interface CanvasObject {
  name: string;
  description?: string;
  kind: "thing" | "event";
  properties: { name: string; type: string; derived: boolean; values?: (string | number)[] }[];
  sources: string[]; // 源条目名（connection.table）
  actions: string[];
}

export interface CanvasLink {
  name: string;
  from: string;
  to: string;
  inverse?: string;
  kind: "match" | "transition";
}

function ObjectNode({ data }: { data: ObjNodeData }) {
  return (
    <div className="node-shell">
      <Handle type="target" position={Position.Top} style={{ visibility: "hidden" }} />
      <Handle type="source" position={Position.Bottom} style={{ visibility: "hidden" }} />
      <div className="node-core">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="node-title">{data.label}</span>
          <span className="node-kind">{data.kind === "thing" ? "事物" : "事件"}</span>
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
            <span key={s} className="tag">{s}</span>
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

export default function OntologyCanvas(props: { objects: CanvasObject[]; links: CanvasLink[]; onSelect: (name: string) => void }) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}

function Flow({ objects, links, onSelect }: { objects: CanvasObject[]; links: CanvasLink[]; onSelect: (name: string) => void }) {
  const initialNodes: Node<ObjNodeData>[] = useMemo(() => {
    const pos = layoutObjects(objects, links);
    return objects.map((o) => ({
      id: o.name,
      type: "obj",
      position: pos.get(o.name) ?? { x: 0, y: 0 },
      data: { ...o, label: o.name },
    }));
  }, [objects, links]);

  // 受控节点状态：没有 onNodesChange 把变化写回 state，拖动会被旧 props 弹回
  const [nodes, setNodes] = useNodesState(initialNodes);
  useEffect(() => setNodes(initialNodes), [initialNodes, setNodes]);
  const onNodesChange = useCallback(
    (changes: NodeChange<Node<ObjNodeData>>[]) => setNodes((ns) => applyNodeChanges(changes, ns)),
    [setNodes]
  );

  const rf = useReactFlow();
  /** 一键理顺：重跑分层布局并取景。导入一批新表、或拖乱了之后用。 */
  const tidy = useCallback(() => {
    const pos = layoutObjects(objects, links);
    setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
    requestAnimationFrame(() => rf.fitView({ padding: 0.2 }));
  }, [objects, links, setNodes, rf]);

  const edges: Edge[] = useMemo(
    () =>
      links.map((l) => ({
        id: l.name,
        source: l.from,
        target: l.to,
        label: l.inverse ? `${l.name} / ${l.inverse}` : l.name,
        style: l.kind === "transition" ? { strokeDasharray: "6 4", stroke: "var(--warn)" } : undefined,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [links]
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      nodesDraggable
      nodesConnectable={false}
      onNodesChange={onNodesChange}
      onNodeClick={(_, node) => onSelect(node.id)}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} color="rgba(32,29,24,0.06)" />
      <Controls showInteractive={false} />
      <Panel position="top-right">
        <button className="btn" onClick={tidy}>整理布局</button>
      </Panel>
    </ReactFlow>
  );
}
