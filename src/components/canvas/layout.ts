// 自动分层布局 —— dagre 按有向边分层：被引用的根对象在上，引用它们的在下，边顺一个方向。
// 自环（转化关系）不参与分层，只画线。
// 画布的两个输入类型也住这里（layout 是它们的唯一下游定义点，组件不反向依赖组件）。

import dagre from "@dagrejs/dagre";

export interface CanvasObject {
  name: string;
  description?: string;
  kind: "thing" | "event";
  properties: { name: string; type: string; derived: boolean; values?: (string | number)[]; description?: string }[];
  sources: { key: string; label: string }[]; // key=源条目名，label=connection.table
  actions: string[];
  state?: "new" | "modified" | "same"; // 草稿态：new=未发布的新对象，modified=有未发布改动
}

export interface CanvasLink {
  name: string;
  from: string;
  to: string;
  inverse?: string;
  description?: string; // 线身主标注：关系的白话描述（没有才退英文名）
  fromLabel?: string; // 线身副标注：源对象的中文名（没有退对象名）
  toLabel?: string; // 线身副标注：目标对象的中文名
  kind: "match" | "transition";
}

/** 节点尺寸的未测量回退（唯一出处）：dagre 分层、FloatingEdge.rectOf、OntologyCanvas 的 obstacles 构造共用。 */
export const NODE_W = 300;
export const NODE_H = 160;

/** 节点高度按内容估算：题头 + 属性行 + 标签行。 */
function estimateHeight(o: CanvasObject): number {
  const tags = o.sources.length + o.actions.length > 0 ? 30 : 0;
  return 92 + o.properties.length * 21 + tags;
}

export function layoutObjects(objects: CanvasObject[], links: CanvasLink[]): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 90, marginx: 40, marginy: 40 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const o of objects) g.setNode(o.name, { width: NODE_W, height: estimateHeight(o) });
  // 边按 目标→来源 反向进图：被引用多的对象（设备、部门、人员）排在最上层
  for (const l of links) {
    if (l.from === l.to) continue; // 自环不参与分层
    g.setEdge(l.to, l.from);
  }

  dagre.layout(g);

  const out = new Map<string, { x: number; y: number }>();
  for (const o of objects) {
    const n = g.node(o.name);
    out.set(o.name, { x: n.x - NODE_W / 2, y: n.y - estimateHeight(o) / 2 }); // dagre 给的是中心点
  }
  return out;
}
