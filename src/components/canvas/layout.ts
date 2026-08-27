// 自动布局 —— 一个算法按层铺排：层由 dagre 算（有向边 目标→来源 反向进图，被引用方在上），
// 每层按 dagre 的 order 从左到右等距，一层超过列数就折行。无边的图只有一层，折行即均匀网格——
// 不需要为「没线」另开一套布局。自环（转化关系）不参与分层；没线的对象自成一尾层排在最下，
// 不混进根层。三种形态（全孤立 / 部分有线 / 全有线）走同一段铺排循环。
// 「整理布局」与未存摆位的新节点共用同一份计算。
// 画布的两个输入类型也住这里（layout 是它们的唯一下游定义点，组件不反向依赖组件）。

import dagre from "@dagrejs/dagre";

export interface CanvasObject {
  name: string;
  description?: string;
  kind: "thing" | "event";
  identity?: string; // 唯一键字段名：节点在对应字段旁画钥匙记号
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

/** 铺排参数：列数（单层折行时等于网格列数）、列距、行距。 */
const GAP_X = 80;
const GAP_Y = 90;

export function layoutObjects(objects: CanvasObject[], links: CanvasLink[]): Map<string, { x: number; y: number }> {
  // 自环不参与分层（只画线）；「有线」只认两端不同的边
  const realLinks = links.filter((l) => l.from !== l.to);
  const connected = new Set(realLinks.flatMap((l) => [l.from, l.to]));

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const o of objects) g.setNode(o.name, { width: NODE_W, height: estimateHeight(o) });
  // 边按 目标→来源 反向进图：被引用多的对象（设备、部门、人员）排在最上层
  for (const l of realLinks) g.setEdge(l.to, l.from);
  dagre.layout(g);

  // 层分配：有线的用 dagre 的 rank；没线的自成一尾层（dagre 会把孤立节点并进最上行，混进根层）
  const connectedRanks = new Map<string, number>();
  for (const o of objects) {
    if (connected.has(o.name)) connectedRanks.set(o.name, g.node(o.name)?.rank ?? 0);
  }
  const isolateRank = (connectedRanks.size ? Math.max(...connectedRanks.values()) : -1) + 1;

  // 统一铺排：按层从上到下，层内按 order 从左到右等距；一层超过列数折行（无边的单层图折成网格）
  const cols = Math.max(1, Math.ceil(Math.sqrt(objects.length)));
  const byRank = new Map<number, { name: string; order: number; height: number }[]>();
  for (const o of objects) {
    const rank = connected.has(o.name) ? connectedRanks.get(o.name)! : isolateRank;
    const entry = { name: o.name, order: g.node(o.name)?.order ?? 0, height: estimateHeight(o) };
    byRank.set(rank, [...(byRank.get(rank) ?? []), entry]);
  }

  const out = new Map<string, { x: number; y: number }>();
  let y = 0;
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const nodes = byRank.get(rank)!.sort((a, b) => a.order - b.order);
    const rows = Math.ceil(nodes.length / cols);
    for (let r = 0; r < rows; r++) {
      const slice = nodes.slice(r * cols, (r + 1) * cols);
      const rowH = Math.max(...slice.map((s) => s.height));
      slice.forEach((s, i) => out.set(s.name, { x: i * (NODE_W + GAP_X), y }));
      y += rowH + GAP_Y;
    }
  }
  return out;
}
