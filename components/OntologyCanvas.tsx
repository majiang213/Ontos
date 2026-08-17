// 本体画布 —— 节点是对象类型，边是关系。只读展示已发布配置（编辑走发布流程，M4 之后开放）。
// 节点卡用 Double-Bezel（外壳托盘 + 内核），ReactFlow 只换肤不改行为。
"use client";

import { useMemo } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

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
      <Handle type="target" position={Position.Left} style={{ visibility: "hidden" }} />
      <Handle type="source" position={Position.Right} style={{ visibility: "hidden" }} />
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

export default function OntologyCanvas({
  objects,
  links,
  onSelect,
}: {
  objects: CanvasObject[];
  links: CanvasLink[];
  onSelect: (name: string) => void;
}) {
  const nodes: Node<ObjNodeData>[] = useMemo(
    () =>
      objects.map((o, i) => {
        const row = Math.floor(i / 3);
        return {
          id: o.name,
          type: "obj",
          position: { x: (i % 3) * 340 + (row % 2) * 120, y: row * 320 }, // 奇数行右移，破刚性网格
          data: { ...o, label: o.name },
        };
      }),
    [objects]
  );
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
      onNodeClick={(_, node) => onSelect(node.id)}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={20} color="rgba(32,29,24,0.06)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
