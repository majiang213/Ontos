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
  const built: Node[] = objects.map((o, i) => {
    const props = o.properties.map((p) => p.label ?? p.name).slice(0, 4);
    const more = o.properties.length - props.length;
    return {
      id: o.name,
      position: { x: 80 + (i % 2) * 320, y: 60 + Math.floor(i / 2) * 200 },
      data: {
        label: (
          <div className={`ont-node ${selected === o.name ? "sel" : ""} ${o._ignored ? "ignored" : ""}`}>
            <div className="on-title">
              {o.label}
              <span className="on-name">{o.name}</span>
              {o.kind === "event" && <span className="tag gray" style={{ marginLeft: 6 }}>事件</span>}
            </div>
            {props.length > 0 && (
              <div className="on-props">
                {props.join(" · ")}{more > 0 ? ` · +${more}` : ""}
              </div>
            )}
            <div className="on-meta">
              {o.identity && (
                <span className="tag gray" style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                  <Key size={9} />{o.identity}
                </span>
              )}
              {o.sources.length === 0 && <span className="tag gray">手动</span>}
              {/* 节点是本体对象，不是表——来源只作轻量标注，完整路径在 title */}
              {[...new Set(o.sources.map((s) => s.connection))].map((conn) => (
                <span
                  key={conn}
                  className="tag gray"
                  style={{ fontSize: 10, padding: "0 6px", opacity: 0.75 }}
                  title={o.sources.filter((s) => s.connection === conn).map((s) => `${s.connection}.${s.table}`).join("、")}
                >
                  {conn}
                </span>
              ))}
            </div>
          </div>
        ),
      },
      style: {
        width: "auto",
        padding: 0,
        background: "transparent",
        border: "none",
        borderRadius: 0,
        boxShadow: "none",
        cursor: onSelect ? "pointer" : "default",
      },
    };
  });

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
    rf?.fitView({ padding: 0.22, duration: 220 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objCount]);

  const edges: Edge[] = ontology.link_types
    .filter((l) => ontology.object_types[l.from] && ontology.object_types[l.to])
    .map((l) => ({
      id: l.name,
      source: l.from,
      target: l.to,
      label: l.label || l.name,
      labelStyle: { fontSize: 11, fill: "#3a38b8", fontWeight: 600 },
      labelBgStyle: { fill: "#f4f4ef", fillOpacity: 0.92 },
      labelBgPadding: [4, 6] as [number, number],
      labelBgBorderRadius: 4,
      style: { stroke: "#9b99d4", strokeWidth: 1.6 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "#9b99d4", width: 16, height: 16 },
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
      <Background gap={18} size={1} color="rgba(24, 24, 28, 0.07)" />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
