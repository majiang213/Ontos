// 本体画布 —— 节点是对象类型，边是关系。只读展示已发布配置（编辑走发布流程，M4 之后开放）。
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
    <div
      style={{
        background: "var(--panel)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius)",
        boxShadow: "var(--shadow-sm)",
        padding: "10px 12px",
        width: 280,
        fontSize: 13,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ visibility: "hidden" }} />
      <Handle type="source" position={Position.Right} style={{ visibility: "hidden" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <strong style={{ fontSize: 14 }}>{data.label}</strong>
        <span style={{ fontSize: 11, color: "var(--ink-3)" }}>{data.kind === "thing" ? "事物" : "事件"}</span>
      </div>
      {data.description && <div style={{ color: "var(--ink-2)", marginBottom: 6 }}>{data.description}</div>}
      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 6 }}>
        {data.properties.map((p) => (
          <div key={p.name} style={{ display: "flex", justifyContent: "space-between", gap: 8, lineHeight: 1.7 }}>
            <span style={{ fontFamily: "var(--mono)" }}>{p.name}</span>
            <span style={{ color: "var(--ink-3)", fontSize: 12 }}>
              {p.type}
              {p.derived ? " · 派生" : ""}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
        {data.sources.map((s) => (
          <span key={s} style={{ fontSize: 11, background: "var(--accent-soft)", color: "var(--accent)", borderRadius: 6, padding: "1px 7px" }}>
            {s}
          </span>
        ))}
        {data.actions.map((a) => (
          <span key={a} style={{ fontSize: 11, background: "var(--ok-soft)", color: "var(--ok)", borderRadius: 6, padding: "1px 7px" }}>
            {a}
          </span>
        ))}
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
      objects.map((o, i) => ({
        id: o.name,
        type: "obj",
        position: { x: (i % 3) * 330, y: Math.floor(i / 3) * 300 },
        data: { ...o, label: o.name },
      })),
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
        labelStyle: { fontSize: 11, fill: "var(--ink-2)" },
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
      nodesDraggable
      nodesConnectable={false}
      onNodeClick={(_, node) => onSelect(node.id)}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={18} color="var(--canvas-dot)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
