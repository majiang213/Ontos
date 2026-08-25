// M7 查询求值 —— 对应《ontos-article.md》§5.4 与图 7。
// 个体由 individual 组装；本文件只投影结果树（展开、聚合、排序）。全程只读。

import type { OntologyConfig } from "../../schema/config";
import type { ExpandNode, QueryRequest } from "../../schema/request";
import type { SourceDriver } from "../infra/driver";
import type { EvalContext } from "./expr";
import { EngineReject, MSG } from "../../errors";
import { assertFilterShapes } from "./compare";
import { createEnv, matchConds, selectIndividuals } from "./assemble";
import { currentOf, evalDerived, transitionHolds } from "./evaluate";
import { mustCls, mustLink, propValue, type Cls, type Env, type Individual } from "./individual";

const DEFAULT_LIMIT = 200; // 查询治理：请求不写 limit 时的兜底上限

/* ---------- 查询树求值 ---------- */

export interface QueryResult {
  rows: Record<string, unknown>[];
  path: string[];
}

export async function query(config: OntologyConfig, driver: SourceDriver, req: QueryRequest): Promise<QueryResult> {
  const env = createEnv(config, driver);
  const path: string[] = [];
  const cls = mustCls(config, req.object);
  const ctx: EvalContext = { identity: req.identity };
  // 过滤形状入口校验：in 必须数组、其余运算符与等值位禁数组——下推与内存共用一把尺
  if (req.filter) assertFilterShapes(req.filter);
  const checkExpand = (exs?: ExpandNode[]) => exs?.forEach((e) => { if (e.filter) assertFilterShapes(e.filter, `展开 ${e.relation}`); checkExpand(e.expand); });
  checkExpand(req.expand);

  if (req.aggregate && req.expand?.length) throw new EngineReject(MSG.aggregateWithExpand);
  // 展开深度上限：每层都是一轮下推，无上限会被深层请求打爆
  const depthOf = (exs: ExpandNode[] | undefined, d: number): number => (exs?.length ? Math.max(...exs.map((e) => depthOf(e.expand, d + 1))) : d);
  if (depthOf(req.expand, 0) > 3) throw new EngineReject(MSG.expandTooDeep);

  // 聚合的分组键与指标字段也要下推进去
  const requested = req.aggregate
    ? [...req.aggregate.group_by, ...req.aggregate.metrics.flatMap((m) => Object.values(m)).filter((f) => f !== "*")]
    : req.properties;

  const individuals = await selectIndividuals(env, req.object, {
    identity: req.identity,
    filter: req.filter,
    requested,
    expands: req.expand,
    ctx,
    path,
    limit: req.aggregate || req.order ? undefined : (req.limit ?? DEFAULT_LIMIT), // 聚合要全量分组、order 要全量排序，都不能先截断
  });

  // 展开：按已声明关系进入目标类
  const expanded = new Map<string, Record<string, Record<string, unknown>[]>>();
  for (const item of req.expand ?? []) {
    for (const ind of individuals) {
      const bag = expanded.get(ind.key) ?? {};
      const [name, rows] = await expandItem(env, cls, ind, item, ctx, path);
      bag[name] = rows;
      expanded.set(ind.key, bag);
    }
    path.push(`展开 ${item.relation}`);
  }

  let rows: Record<string, unknown>[];
  if (req.aggregate) {
    rows = await aggregate(cls, individuals, req.aggregate, env, ctx, path);
    path.push(`聚合：${req.aggregate.group_by.join("、")} 分组，${rows.length} 组`);
  } else {
    rows = [];
    for (const ind of individuals) {
      const row = await project(cls, ind, req.properties, env, ctx);
      const bag = expanded.get(ind.key);
      if (bag) Object.assign(row, bag);
      rows.push(row);
    }
  }

  if (req.order) {
    const [[prop, dir]] = Object.entries(req.order);
    const legal = req.aggregate
      ? new Set([
          ...req.aggregate.group_by,
          ...req.aggregate.metrics.map((m) => {
            const [op, f] = Object.entries(m)[0];
            return f === "*" ? op : `${op}_${f}`;
          }),
        ])
      : new Set(req.properties ?? Object.keys(cls.def.properties)); // 按未返回的属性排序等于按 undefined 排，拒绝
    if (!legal.has(prop)) throw new EngineReject(MSG.orderPropUnknown(prop));
    rows.sort((a, b) => compareRows(a[prop], b[prop]) * (dir === "desc" ? -1 : 1));
  }
  const limit = req.limit ?? DEFAULT_LIMIT;
  if (rows.length > limit) {
    rows = rows.slice(0, limit);
    path.push(`结果超过上限，截断到 ${limit} 行`);
  }
  return { rows, path };
}

/** 一个个体上的一项展开：返回 [关系名, 目标行数组]。转化关系成立则带回自身行，match 关系按配对值查目标类。 */
async function expandItem(
  env: Env,
  cls: Cls,
  ind: Individual,
  item: ExpandNode,
  ctx: EvalContext,
  path: string[]
): Promise<[string, Record<string, unknown>[]]> {
  const { link, reversed } = mustLink(env.config, cls.name, item.relation);
  if (link.transition) {
    if (item.expand?.length) throw new EngineReject(MSG.transitionNoNestedExpand(item.relation));
    if (item.filter !== undefined) throw new EngineReject(MSG.transitionNoTargetFilter(item.relation)); // 与 linkHolds 同口径，不静默吞
    return [item.relation, (await transitionHolds(cls, ind, link, env, ctx)) ? [await project(cls, ind, item.properties, env, ctx)] : []];
  }
  const targetClsName = reversed ? link.from : link.to;
  const merged = matchConds(cls, ind, link, reversed, item.filter, (k) => MSG.expandFilterConflict(item.relation, k));
  if (!merged) return [item.relation, []]; // 配对值为空：关系不成立，没有目标——与 linkHolds 同语义
  const targetCls = mustCls(env.config, targetClsName);
  const sub = await selectIndividuals(env, targetClsName, {
    filter: merged,
    requested: item.properties,
    expands: item.expand,
    ctx,
    path,
  });
  const rows: Record<string, unknown>[] = [];
  for (const t of sub) {
    const row = await project(targetCls, t, item.properties, env, ctx);
    for (const nested of item.expand ?? []) {
      const [name, nestedRows] = await expandItem(env, targetCls, t, nested, ctx, path);
      row[name] = nestedRows;
    }
    rows.push(row);
  }
  return [item.relation, rows];
}

/** 返回形态：点了哪些属性给哪些；没点给全部（源列属性 + 派生都算出来）。 */
async function project(cls: Cls, ind: Individual, requested: string[] | undefined, env: Env, ctx: EvalContext): Promise<Record<string, unknown>> {
  const props = requested ?? Object.keys(cls.def.properties);
  const row: Record<string, unknown> = {};
  for (const p of props) {
    const def = cls.def.properties[p];
    if (!def) throw new EngineReject(MSG.propertiesPropUnknown(cls.name, p));
    row[p] = def.derived ? await evalDerived(cls, ind, p, env, ctx) : propValue(cls, ind, p);
  }
  return row;
}

async function aggregate(cls: Cls, individuals: Individual[], agg: NonNullable<QueryRequest["aggregate"]>, env: Env, ctx: EvalContext, path: string[]) {
  const views = new Map<string, Record<string, unknown>>(); // 每个个体只算一遍（派生含 $link 查询）
  // 只算分组键与指标字段用得到的派生：没引用的派生不算（省 N+1，也免被无关坏派生拖累）
  const only = new Set([...agg.group_by, ...agg.metrics.flatMap((m) => Object.values(m)).filter((f) => f !== "*")]);
  const viewOf = async (ind: Individual) => {
    let v = views.get(ind.key);
    if (!v) { v = await currentOf(cls, ind, env, ctx, only); views.set(ind.key, v); }
    return v;
  };
  const groups = new Map<string, { key: Record<string, unknown>; members: Individual[] }>();
  for (const ind of individuals) {
    const cur = await viewOf(ind);
    const keyObj = Object.fromEntries(agg.group_by.map((g) => [g, cur[g] ?? null])); // undefined 丢键会坍组，归一成 null
    const k = JSON.stringify(keyObj);
    const g = groups.get(k) ?? { key: keyObj, members: [] };
    g.members.push(ind);
    groups.set(k, g);
  }
  let dropped = 0;
  const rows: Record<string, unknown>[] = [];
  for (const { key, members } of groups.values()) {
    const row: Record<string, unknown> = { ...key };
    for (const metric of agg.metrics) {
      const [op, field] = Object.entries(metric)[0];
      const all: unknown[] = [];
      for (const m of members) all.push((await viewOf(m))[field]);
      const vals = all.filter((v): v is number => typeof v === "number");
      if (op !== "count") dropped += all.length - vals.length;
      const name = field === "*" ? op : `${op}_${field}`;
      if (op === "count") row[name] = field === "*" ? members.length : all.filter((v) => v != null).length; // count:"*" 数行，count:"字段" 数非空值（同 SQL）
      else if (op === "avg") row[name] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      else if (op === "sum") row[name] = vals.reduce((a, b) => a + b, 0);
      else if (op === "min") row[name] = vals.length ? Math.min(...vals) : null;
      else if (op === "max") row[name] = vals.length ? Math.max(...vals) : null;
      else throw new EngineReject(MSG.aggregateUnknown(op));
    }
    rows.push(row);
  }
  if (dropped > 0) path.push(`聚合剔除非数值 ${dropped} 个`);
  return rows;
}

function compareRows(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
