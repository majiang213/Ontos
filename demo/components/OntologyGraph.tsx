"use client";

// 本体图画布：React Flow 渲染对象类型与关系（M4 的可视化位）
// 节点可拖拽：位置在本地 state 里维护，本体内容变化时重建节点但保留已拖位置；
// 拖拽后的 mouseup 不触发"点节点编辑"。
// 从节点底部手柄拖到另一节点 = 建关系（onConnect）；点边 = 编辑/删除关系（onEdgeSelect）。
import { useEffect, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MarkerType, useNodesState, applyNodeChanges, type Node, type Edge, type NodeChange, type Connection } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Key } from "@phosphor-icons/react";
import type { Ontology } from "@/lib/ontology";

export default function OntologyGraph({ ontology, onSelect, selected, onConnect, onEdgeSelect }: {
  ontology: Ontology;
  onSelect?: (name: string) => void;
  selected?: string | null;
  onConnect?: (from: string, to: string) => void;
  onEdgeSelect?: (name: string) => void;
}) {
  const objects = Object.values(ontology.object_types);
  const built: Node[] = objects.map((o, i) => ({
    id: o.name,
    position: { x: 80 + (i % 2) * 320, y: 60 + Math.floor(i / 2) * 190 },
    data: {
      label: (
        <div style={{ textAlign: "left", fontSize: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>
            {o.label} <span style={{ color: "#9ca3af", fontFamily: "monospace", fontSize: 11 }}>{o.name}</span>
          </div>
          <div style={{ color: "#4b5563", marginTop: 4 }}>
            {o.properties.map((p) => p.label ?? p.name).slice(0, 4).join(" · ")}
          </div>
          <div style={{ marginTop: 6, display: "flex", gap: 4, flexWrap: "wrap" }}>
            {o.identity && (
              <span className="tag gray" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <Key size={9} />{o.identity}
              </span>
            )}
            {o.sources.map((s) => (
              <span key={s.connection} className="tag gray" style={{ fontSize: 10, padding: "0 6px", opacity: 0.75 }} title="来源表（只读映射，schema 在「表结构」抽屉里看）">
                {s.connection}.{s.table}
              </span>
            ))}
          </div>
        </div>
      ),
    },
    style: {
      width: 280,
      background: "#fff",
      border: selected === o.name ? "1.5px solid #4341c9" : "1px solid #e8e6e1",
      borderRadius: 12,
      padding: "12px 14px",
      fontSize: 12,
      boxShadow: selected === o.name ? "0 4px 16px rgba(67,65,201,0.18)" : "0 2px 8px rgba(24,24,28,0.06)",
      cursor: onSelect ? "pointer" : "default",
      opacity: o._ignored ? 0.45 : 1,
    },
  }));

  const [nodes, setNodes] = useNodesState(built);
  // 内容签名：本体被编辑（改名/加属性等）时重建节点内容，但保留拖拽位置
  const sig = objects
    .map((o) => `${o.name}:${o.label}:${o.identity ?? ""}:${o.properties.map((p) => `${p.name}=${p.label ?? ""}:${p.type}`).join(",")}:${o.sources.length}:${selected ?? ""}`)
    .join("|");
  useEffect(() => {
    setNodes((prev) => {
      const pos = new Map(prev.map((n) => [n.id, n.position]));
      return built.map((n) => (pos.has(n.id) ? { ...n, position: pos.get(n.id)! } : n));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // 拖拽后的 click 抑制：拖完不打开编辑面板
  const dragged = useRef(false);

  // fitView 只在初始化时生效——对象增删时手动重新取景（编辑内容/拖动不打断视角）
  const [rf, setRf] = useState<{ fitView: (o?: any) => void } | null>(null);
  const objCount = objects.length;
  useEffect(() => {
    rf?.fitView({ padding: 0.2, duration: 200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objCount]);

  const edges: Edge[] = ontology.link_types
    .filter((l) => ontology.object_types[l.from] && ontology.object_types[l.to])
    .map((l) => ({
      id: l.name,
      source: l.from,
      target: l.to,
      label: l.name,
      labelStyle: { fontSize: 11, fill: "#4f46e5" },
      style: { stroke: "#a5b4fc" },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#a5b4fc" },
      animated: l.name === "converted",
    }));
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      onInit={(instance) => setRf(instance)}
      proOptions={{ hideAttribution: true }}
      nodesDraggable
      nodesConnectable={!!onConnect}
      deleteKeyCode={null}
      onNodesChange={(chs: NodeChange[]) => setNodes((ns) => applyNodeChanges(chs, ns))}
      onNodeDragStart={() => { dragged.current = true; }}
      onNodeDragStop={() => { setTimeout(() => { dragged.current = false; }, 0); }}
      onNodeClick={(_, n) => {
        if (dragged.current) { dragged.current = false; return; }
        onSelect?.(n.id);
      }}
      onConnect={(c: Connection) => {
        if (c.source && c.target) onConnect?.(c.source, c.target);
      }}
      onEdgeClick={(_, e) => onEdgeSelect?.(e.id)}
    >
      <Background gap={18} color="#f0f1f3" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
