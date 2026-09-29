// 自动布局（ADR 0011 边感知）—— 有连线的图用 dagre 从左到右分层（边 目标→来源 反向进图，被引用方在左）。
// 纵轴用 dagre 的坐标：一条边的两端尽量水平对齐，同一列里连向不同对象的卡片上下错开。
// 不按「一层一行、行高=该行最高卡片」往下推。没连线的对象用天际线排到连线部分右侧，不垫在高卡片下面。
// 排完用路由当验收器：还有边穿节点就只加宽列距，加宽不再减少穿节点就停。路由仍兜底不穿节点。
// 相邻两列的间距还要容得下这条边上的说明：说明放在线的中点。间距不够时渲染会把说明推离线身。
// 「整理布局」与未存摆位的新节点共用这一份计算。
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
  tagLabels?: string[]; // 底部标签文案（来源、动作、判定芯片）。整理布局按它折行算高度；缺省用来源和动作名
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
  fromLabel?: string; // 线身副标注：源对象的短名（edgeEndLabel）
  toLabel?: string; // 线身副标注：目标对象的短名
  kind: "match" | "transition" | "shared"; // match/transition = 配置关系；shared = 公共对象由来，只活在画布
}

/** 线端副标注的短名：描述里第一个停顿之前的那段。整段描述会把线标签铺进相邻卡片。没有这段时用对象名。 */
export function edgeEndLabel(description: string | undefined, name: string): string {
  const head = (description ?? "").trim().split(/[（(，,。；;]/)[0]?.trim() ?? "";
  return head || name;
}

/** 节点尺寸的未测量回退（唯一出处）：dagre 分层、FloatingEdge.rectOf、OntologyCanvas 的 obstacles 构造共用。 */
export const NODE_W = 300;
export const NODE_H = 160;
/** 卡片壳的实际宽度（.node-shell）。线的端点落在壳边上，比布局槽窄一截。 */
export const CARD_W = 288;

/** 卡片内容宽：壳宽 288，减去壳内边距 12 和核内边距 28。标签折行与描述换行都用这道宽。 */
const CONTENT_W = 248;

function unitWidth(text: string, cjk: number, ascii: number): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 255 ? cjk : ascii;
  return w;
}

/** 描述按 12px 字宽换行。芯片按 11px 字宽加内边距，在内容宽里折行。 */
function wrappedLines(text: string): number {
  if (!text) return 0;
  let lines = 1;
  let used = 0;
  for (const ch of text) {
    const w = ch.charCodeAt(0) > 255 ? 12 : 7;
    if (used > 0 && used + w > CONTENT_W) {
      lines++;
      used = w;
    } else used += w;
  }
  return lines;
}

function tagRowCount(labels: string[]): number {
  if (labels.length === 0) return 0;
  let rows = 1;
  let used = 0;
  for (const label of labels) {
    const w = 9 + unitWidth(label, 11, 5.5);
    if (used > 0 && used + 4 + w > CONTENT_W) {
      rows++;
      used = w;
    } else used += (used > 0 ? 4 : 0) + w;
  }
  return rows;
}

/** 底部标签的文案，与节点渲染同一套：阶段已写进 hint 的来源不再进标签，判定芯片算在内。 */
export function layoutTagLabels(o: CanvasObject, chips: { text: string }[] = []): string[] {
  const stageKeys = new Set(o.stages?.sourceKeys ?? []);
  return [...o.sources.filter((s) => !stageKeys.has(s.key)).map((s) => s.label), ...o.actions, ...chips.map((c) => c.text)];
}

/** 节点高度按内容估算，与渲染的 CSS 对齐：题头、描述换行、属性行、阶段行、标签折行。
 *  估算偏矮时整理布局会把下一行排进这张卡片。宁可比实测略高。 */
export function estimateHeight(o: CanvasObject): number {
  const descLines = wrappedLines(o.description ?? "");
  const props = o.properties.filter((p) => p.name !== o.stages?.property).length;
  const stages = o.stages?.items.length ?? 0;
  const rows = tagRowCount(o.tagLabels ?? layoutTagLabels(o));
  return 60
    + (descLines ? 8 + 17 * descLines : 0)
    + (props ? 6 + 21 * props : 0)
    + (stages ? 14 + 18 * stages : 0)
    + (rows ? 8 + 20 * rows + 4 * (rows - 1) : 0);
}

/** 线标签盒子，与 .edge-label 同一口径：最大宽 220（border-box），主行 11px、副行 10px、行高 1.5。
 *  整理布局用它决定相邻两列拉开多少，说明才能落在线的中点上。 */
const LABEL_MAX_W = 220;
const LABEL_CHROME_X = 8 * 2 + 1 * 2; // padding 左右 8，border 左右 1
const LABEL_INNER_W = LABEL_MAX_W - LABEL_CHROME_X;
const LABEL_AIR = 8; // 说明与两侧卡片各留的空隙。再窄，说明会压进卡片，渲染就把它推离线

function wrapBlock(text: string, cjk: number, ascii: number): { w: number; lines: number } {
  if (!text) return { w: 0, lines: 0 };
  let lines = 1;
  let used = 0;
  let widest = 0;
  for (const ch of text) {
    const w = ch.charCodeAt(0) > 255 ? cjk : ascii;
    if (used > 0 && used + w > LABEL_INNER_W) {
      widest = Math.max(widest, used);
      lines++;
      used = w;
    } else used += w;
  }
  return { w: Math.max(widest, used), lines };
}

export function edgeLabelBox(l: CanvasLink): { w: number; h: number } {
  const main = (l.description ?? (l.inverse ? `${l.name} / ${l.inverse}` : l.name)).trim();
  const sub = l.fromLabel != null || l.toLabel != null ? `${l.fromLabel ?? ""} → ${l.toLabel ?? ""}` : "";
  const mainB = wrapBlock(main, 11, 6.5);
  const subB = wrapBlock(sub, 10, 6);
  const lines = mainB.lines + subB.lines;
  // 一行放得下就按字收缩；放不下就顶满 max-width（换行后的盒子是 220，不是最长那一行的字宽）。
  const wraps = mainB.lines > 1 || subB.lines > 1;
  const w = lines ? (wraps ? LABEL_MAX_W : Math.min(LABEL_MAX_W, Math.max(mainB.w, subB.w) + LABEL_CHROME_X)) : 0;
  const h = mainB.lines * 16.5 + subB.lines * 15 + (lines ? 4 : 0); // padding 上下 1，border 上下 1
  return { w: Math.ceil(w), h: Math.ceil(h) };
}

/** 列距，以及同一列里两张卡片之间的气口。气口只隔开这一列，不把右边整列推下去。 */
const GAP_X = 80;
const GAP_Y = 32;
/** 列距加宽。只有加宽真的减少了穿节点的边才留下，避免空加宽把图撑大。 */
const WIDEN_X = 24;
const MAX_PASSES = 6;
/** 验收外扩：布局时只有估算高度，渲染是实测高度——外扩吸收两者的漂移（换行、标签行数）。 */
const VERIFY_PAD = 32;

/** 天际线：下一块放进当前最矮的列。卡片一样高时从左到右排，就是均匀网格。 */
function masonry(names: string[], originX: number, heightOf: Map<string, number>, gapX: number): Map<string, { x: number; y: number }> {
  const cols = Math.max(1, Math.ceil(Math.sqrt(names.length)));
  const bottom = Array.from({ length: cols }, () => 0);
  const out = new Map<string, { x: number; y: number }>();
  for (const n of names) {
    let c = 0;
    for (let i = 1; i < cols; i++) if (bottom[i] < bottom[c]) c = i;
    const y = bottom[c];
    out.set(n, { x: originX + c * (NODE_W + gapX), y });
    bottom[c] = y + (heightOf.get(n) ?? NODE_H) + GAP_Y;
  }
  return out;
}

interface RankInfo {
  rankOf: Map<string, number>; // 有连线的对象 → 从左到右的层号
  centerY: Map<string, number>; // dagre 给出的中心纵坐标：相连的两端靠它水平对齐
}

/** dagre 分层（Sugiyama）：层号是列，纵坐标把一条边的两端尽量拉平，同一列里不同的边上下错开。 */
function ranksOf(objects: CanvasObject[], realLinks: CanvasLink[], connected: Set<string>): RankInfo {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: GAP_Y, ranksep: GAP_X });
  g.setDefaultEdgeLabel(() => ({}));
  for (const o of objects) if (connected.has(o.name)) g.setNode(o.name, { width: NODE_W, height: estimateHeight(o) });
  for (const l of realLinks) g.setEdge(l.to, l.from);
  dagre.layout(g);
  const rankOf = new Map<string, number>();
  const centerY = new Map<string, number>();
  for (const name of connected) {
    const n = g.node(name);
    rankOf.set(name, n?.rank ?? 0);
    centerY.set(name, n?.y ?? 0);
  }
  return { rankOf, centerY };
}

/** 相邻两列的列距：说明放在线中点时，壳与壳之间要容下标签宽再各留 LABEL_AIR。
 *  短说明用基本列距。跨过中间列的边不在这里加宽——中点不在这一道缝里。 */
function labelGaps(links: CanvasLink[], rankOf: Map<string, number>, columns: number): number[] {
  const gaps = Array.from({ length: Math.max(0, columns - 1) }, () => GAP_X);
  const compact = compactRank(rankOf);
  for (const l of links) {
    if (l.from === l.to) continue;
    const a = compact.get(l.from);
    const b = compact.get(l.to);
    if (a === undefined || b === undefined || Math.abs(a - b) !== 1) continue;
    const lo = Math.min(a, b);
    // 可见缝 = 列距 - 壳宽。列距 = NODE_W + gap，所以 gap = 可见缝 - (NODE_W - CARD_W)。
    const gap = edgeLabelBox(l).w + LABEL_AIR * 2 - (NODE_W - CARD_W);
    if (gap > gaps[lo]) gaps[lo] = gap;
  }
  return gaps;
}

function compactRank(rankOf: Map<string, number>): Map<string, number> {
  const ranks = [...new Set(rankOf.values())].sort((a, b) => a - b);
  const index = new Map(ranks.map((r, i) => [r, i]));
  return new Map([...rankOf].map(([name, r]) => [name, index.get(r)!]));
}

/** 列号压成连续的 0、1、2…。相邻列的间距由 gapAfter 给出（说明要多宽，这一道缝就多宽）。
 *  纵坐标沿用 dagre，再整体抬到从 0 开始。没连线的对象用基本列距排到这些列的右侧。 */
function placeByRanks(objects: CanvasObject[], info: RankInfo, heightOf: Map<string, number>, gapAfter: number[]): Map<string, { x: number; y: number }> {
  const ranks = [...new Set(info.rankOf.values())].sort((a, b) => a - b);
  const compact = new Map(ranks.map((r, i) => [r, i]));
  const xOf = (col: number) => {
    let x = 0;
    for (let i = 0; i < col; i++) x += NODE_W + (gapAfter[i] ?? GAP_X);
    return x;
  };
  const out = new Map<string, { x: number; y: number }>();
  let minY = 0;
  const placed: { name: string; x: number; y: number }[] = [];
  for (const o of objects) {
    const rank = info.rankOf.get(o.name);
    if (rank === undefined) continue;
    const h = heightOf.get(o.name) ?? NODE_H;
    const y = (info.centerY.get(o.name) ?? 0) - h / 2;
    placed.push({ name: o.name, x: xOf(compact.get(rank) ?? 0), y });
    if (y < minY) minY = y;
  }
  for (const p of placed) out.set(p.name, { x: p.x, y: p.y - minY });
  const isolates = objects.filter((o) => !info.rankOf.has(o.name)).map((o) => o.name);
  for (const [n, p] of masonry(isolates, xOf(ranks.length), heightOf, GAP_X)) out.set(n, p);
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
  if (connected.size === 0) return masonry(objects.map((o) => o.name), 0, new Map(objects.map((o) => [o.name, estimateHeight(o)])), GAP_X);

  const info = ranksOf(objects, realLinks, connected);
  const heightOf = new Map(objects.map((o) => [o.name, estimateHeight(o)] as const));
  const columns = new Set(info.rankOf.values()).size;
  const baseGaps = labelGaps(realLinks, info.rankOf, columns);
  const blockedCount = (pos: Map<string, { x: number; y: number }>) => realLinks.filter((l) => edgeBlocked(l, pos, heightOf)).length;
  const withExtra = (extra: number) => baseGaps.map((g) => g + extra);

  // 缝宽先够放下说明。还有边穿节点就在这个宽度上再加；加宽不再减少穿节点就停。
  let extra = 0;
  let best = placeByRanks(objects, info, heightOf, withExtra(extra));
  let bestBlocked = blockedCount(best);
  for (let pass = 0; pass < MAX_PASSES && bestBlocked > 0; pass++) {
    extra += WIDEN_X;
    const pos = placeByRanks(objects, info, heightOf, withExtra(extra));
    const blocked = blockedCount(pos);
    if (blocked >= bestBlocked) break;
    best = pos;
    bestBlocked = blocked;
  }
  return best;
}
