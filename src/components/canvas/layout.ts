// 自动布局（ADR 0011 边感知）—— 无连线的整图：按列折行的均匀网格；有连线的图：dagre 分层（有向边 目标→来源
// 反向进图，被引用方在上），一层一行不折行（折行把跨层长边拦腰掰断，是「线穿节点、线绕行」的元凶），
// 层内按 dagre 的 order 从左到右等距；排完用路由当验收器（directCurve）逐边验证，验不过的边加宽走廊再排，
// 迭代有上限，到上限接受当前结果——路由本身永远兜底（A* 保证不穿节点），迭代只为让边尽量直接出曲线（取直率）。
// 没连线的对象自成一尾层排在最下，尾层按列折行成网格（与无连线整图同口径）。
// 「整理布局」与未存摆位的新节点共用同一份计算。
// 画布的两个输入类型也住这里（layout 是它们的唯一下游定义点，组件不反向依赖组件）。

import dagre from "@dagrejs/dagre";
import { directCurve, type RouteRect } from "./router";
import { floatingEndsOf } from "./geometry";

export interface CanvasObject {
  name: string;
  description?: string;
  kind: "thing" | "event";
  identity?: string; // 唯一键字段名：节点在对应字段旁画钥匙记号
  properties: { name: string; type: string; derived: boolean; description?: string }[];
  sources: { key: string; label: string }[]; // key=源条目名，label=connection.table
  actions: string[];
  state?: "new" | "modified" | "same"; // 草稿态：new=未发布的新对象，modified=有未发布改动
  homonyms?: string[]; // 同形异义的对方类名（配置投影，不是关系）
  verdicts?: string[]; // 头上的裁决结论徽章（部分重叠/公共对象/生命周期/同形异义），见 sharedOrigin.verdictBadgesOf
  /** 有转化时：派生枚举的全部时期。来源已写进 hint 的不再进普通标签。 */
  stages?: {
    property: string;
    items: { value: string; hint: string }[];
    sourceKeys: string[];
  };
}

export interface CanvasLink {
  name: string;
  from: string;
  to: string;
  inverse?: string;
  description?: string; // 线身主标注：关系的白话描述（没有才退英文名）
  fromLabel?: string; // 线身副标注：源对象的中文名（没有退对象名）
  toLabel?: string; // 线身副标注：目标对象的中文名
  kind: "match" | "transition" | "shared"; // match/transition = 配置关系；shared = 公共对象由来，只活在画布
}

/** 节点尺寸的未测量回退（唯一出处）：dagre 分层、FloatingEdge.rectOf、OntologyCanvas 的 obstacles 构造共用。 */
export const NODE_W = 300;
export const NODE_H = 160;

/** 节点高度按内容估算，与渲染的 CSS 逐段对齐（shell 12 + core 内边距 24 + 题头行 30 + 描述 18 + 属性 7+20/行
 *  + 阶段 17+18/行 + 标签 8+20/行 + 行距 4）：估算只差在换行细节，验收外扩 VERIFY_PAD 吸收残余漂移。 */
export function estimateHeight(o: CanvasObject): number {
  const stageKeys = o.stages ? new Set(o.stages.sourceKeys) : null;
  const extraSources = o.sources.filter((s) => !stageKeys?.has(s.key)).length;
  const props = o.properties.filter((p) => p.name !== o.stages?.property).length;
  const tags = extraSources + o.actions.length;
  const tagRows = Math.ceil(tags / 3); // 内容宽 ~260px，每行约 3 个标签
  const stage = o.stages ? o.stages.items.length * 18 + 17 : 0;
  return 73 + (o.description ? 18 : 0) + props * 20 + stage + (tags > 0 ? 8 + tagRows * 20 + (tagRows - 1) * 4 : 0);
}

/** 铺排参数：列距、行距（有连线时是迭代起点，无连线时是网格间距）。 */
const GAP_X = 80;
const GAP_Y = 90;
/** 走廊迭代：每轮加宽量与轮数上限。到上限接受当前结果——路由仍保证不穿节点。 */
const WIDEN_X = 24;
const WIDEN_Y = 40;
const MAX_PASSES = 12;
/** 验收外扩：布局时只有估算高度，渲染是实测高度——外扩吸收两者的漂移（换行、标签行数）。 */
const VERIFY_PAD = 32;

/** 无连线整图：按列折行的均匀网格（也用于全自环——自环不参与分层，只画线）。 */
function gridLayout(objects: CanvasObject[]): Map<string, { x: number; y: number }> {
  const cols = Math.max(1, Math.ceil(Math.sqrt(objects.length)));
  const out = new Map<string, { x: number; y: number }>();
  let y = 0;
  for (let r = 0; r * cols < objects.length; r++) {
    const slice = objects.slice(r * cols, (r + 1) * cols);
    const rowH = Math.max(...slice.map((o) => estimateHeight(o)));
    slice.forEach((o, i) => out.set(o.name, { x: i * (NODE_W + GAP_X), y }));
    y += rowH + GAP_Y;
  }
  return out;
}

interface RankInfo {
  rankOf: Map<string, number>; // 对象 → 层号（孤立 = isolateRank）
  orderOf: Map<string, number>; // 对象 → 层内顺序
  isolateRank: number;
}

/** dagre 分层：层号与层内顺序（边按 目标→来源 反向进图，被引用方在上；层内 order 已做交叉最小化）。 */
function ranksOf(objects: CanvasObject[], realLinks: CanvasLink[], connected: Set<string>): RankInfo {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 90 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const o of objects) g.setNode(o.name, { width: NODE_W, height: estimateHeight(o) });
  for (const l of realLinks) g.setEdge(l.to, l.from);
  dagre.layout(g);
  const rankOf = new Map<string, number>();
  for (const o of objects) if (connected.has(o.name)) rankOf.set(o.name, g.node(o.name)?.rank ?? 0);
  const isolateRank = (rankOf.size ? Math.max(...rankOf.values()) : -1) + 1;
  const orderOf = new Map<string, number>();
  for (const o of objects) orderOf.set(o.name, g.node(o.name)?.order ?? 0);
  return { rankOf, orderOf, isolateRank };
}

/** 统一铺排：有连线的层一层一行（不折行）；孤立尾层按列折行成网格（与无连线整图同口径）。 */
function placeByRanks(objects: CanvasObject[], info: RankInfo, heightOf: Map<string, number>, gapX: number, gapY: number): Map<string, { x: number; y: number }> {
  const byRank = new Map<number, string[]>();
  for (const o of objects) {
    const rank = info.rankOf.get(o.name) ?? info.isolateRank;
    byRank.set(rank, [...(byRank.get(rank) ?? []), o.name]);
  }
  const out = new Map<string, { x: number; y: number }>();
  let y = 0;
  for (const rank of [...byRank.keys()].sort((a, b) => a - b)) {
    const names = byRank.get(rank)!.sort((a, b) => (info.orderOf.get(a) ?? 0) - (info.orderOf.get(b) ?? 0));
    if (rank === info.isolateRank) {
      const cols = Math.max(1, Math.ceil(Math.sqrt(names.length)));
      const rows = Math.ceil(names.length / cols);
      for (let r = 0; r < rows; r++) {
        const slice = names.slice(r * cols, (r + 1) * cols);
        const rowH = Math.max(...slice.map((n) => heightOf.get(n) ?? NODE_H));
        slice.forEach((n, i) => out.set(n, { x: i * (NODE_W + gapX), y }));
        y += rowH + gapY;
      }
    } else {
      const rowH = Math.max(...names.map((n) => heightOf.get(n) ?? NODE_H));
      names.forEach((n, i) => out.set(n, { x: i * (NODE_W + gapX), y }));
      y += rowH + gapY;
    }
  }
  return out;
}

/** 一条边在当前摆位下能否直接出曲线：端点浮动附着（无钉点，floatingEndsOf 与 FloatingEdge 同口径）；
 *  两端自己的矩形不进障碍（曲线从自家边框探出，外扩区本就该免检——与 router 的 nearEnd 免检同理由）。
 *  缺节点当畅通（画布会跳过渲染）。验收口径供 canvasLayout.test 复用。 */
export function edgeBlocked(l: CanvasLink, pos: Map<string, { x: number; y: number }>, heightOf: Map<string, number>): boolean {
  const rect = (name: string, pad: number): RouteRect | null => {
    const p = pos.get(name);
    if (!p) return null;
    return { x: p.x - pad, y: p.y - pad, w: NODE_W + pad * 2, h: (heightOf.get(name) ?? NODE_H) + pad * 2 };
  };
  const sR = rect(l.from, 0);
  const tR = rect(l.to, 0);
  if (!sR || !tR) return false;
  const [s, t] = floatingEndsOf(sR, tR);
  const others = [...pos].filter(([name]) => name !== l.from && name !== l.to).map(([name, p]) => rect(name, VERIFY_PAD)!);
  return !directCurve(s, t, others);
}

export function layoutObjects(objects: CanvasObject[], links: CanvasLink[]): Map<string, { x: number; y: number }> {
  // 自环不参与分层（只画线）；「有线」只认两端不同的边
  const realLinks = links.filter((l) => l.from !== l.to);
  const connected = new Set(realLinks.flatMap((l) => [l.from, l.to]));
  if (connected.size === 0) return gridLayout(objects);

  const info = ranksOf(objects, realLinks, connected);
  const heightOf = new Map(objects.map((o) => [o.name, estimateHeight(o)] as const));

  // 迭代：路由当验收器——验不过的边加宽走廊再排；上限后接受（路由仍兜底不穿节点）
  let gapX = GAP_X;
  let gapY = GAP_Y;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const pos = placeByRanks(objects, info, heightOf, gapX, gapY);
    if (!realLinks.some((l) => edgeBlocked(l, pos, heightOf))) return pos;
    gapX += WIDEN_X;
    gapY += WIDEN_Y;
  }
  return placeByRanks(objects, info, heightOf, gapX, gapY);
}
