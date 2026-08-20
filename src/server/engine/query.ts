// M7 查询求值 —— 对应《ontos-article.md》§5.4 与图 7。
// 先定列再下推；各源取回后按同一性标准对齐；派生按形状翻译；全程只读。

import type { Filter, LinkType, OntologyConfig } from "../schema/config";
import { FILTER_OPS } from "../schema/config";
import { walkFilter } from "../schema/filterWalk";
import type { ExpandNode, QueryRequest } from "../schema/request";
import { dialectFor, toColumnValue, type Condition, type SourceDriver } from "./driver";
import type { EvalContext } from "./expr";
import {
  assertFilterShapes,
  currentOf,
  EngineReject,
  evalDerived,
  evalFilterOnIndividual,
  findLink,
  keyColumn,
  mustCls,
  propValue,
  resolveOperand,
  sourcesOf,
  whenRuleHits,
  type Cls,
  type Env,
  type Individual,
} from "./individual";

const DEFAULT_LIMIT = 200; // 查询治理：请求不写 limit 时的兜底上限

/* ---------- 环境：关系判定与个体存在性 ---------- */

interface ResolvedLink {
  link: LinkType;
  reversed: boolean; // true = 按 inverse 名从 to 走回 from
}

function resolveLink(config: OntologyConfig, clsName: string, name: string): ResolvedLink {
  const found = findLink(config, clsName, name);
  if (!found) throw new EngineReject(`关系名对不上配置：${clsName} 出发没有 ${name}`);
  return found;
}

/** 转化关系的两截判定（§6.4）：出发规则里值为 true 的源现在有没有行；到达规则现在是否整条命中。 */
async function transitionHolds(cls: Cls, ind: Individual, link: LinkType, env: Env, ctx: EvalContext): Promise<boolean> {
  const t = link.transition!;
  const clsOfLink = cls;
  const def = clsOfLink.def.properties[t.property];
  if (!def?.derived || !Array.isArray(def.derived)) throw new EngineReject(`transition.property 不是 when 派生：${t.property}`);
  const fromRule = def.derived.find((r) => r.value === t.from);
  const toRule = def.derived.find((r) => r.value === t.to);
  if (!fromRule || !toRule) throw new EngineReject(`派生规则里找不到阶段 ${String(t.from)} / ${String(t.to)}`);
  const fromSourcesHaveRows = Object.entries(fromRule.when)
    .filter(([, cond]) => cond === true)
    .every(([src]) => ind.rows[src] != null);
  return fromSourcesHaveRows && (await whenRuleHits(clsOfLink, ind, toRule, env, ctx));
}

/** 组装求值环境：配置 + 驱动 + 关系判定 + 存在性检查。查询与动作共用。 */
export function createEnv(config: OntologyConfig, driver: SourceDriver): Env {
  const env: Env = {
    config,
    driver,
    async existsIndividual(clsName, identityValue) {
      return (await selectIndividuals(env, clsName, { identity: identityValue })).length > 0;
    },
    async linkHolds(clsName, ind, linkName, targetFilter, ctx) {
      const cls = mustCls(config, clsName);
      const { link, reversed } = resolveLink(config, clsName, linkName);
      if (link.transition) {
        if (targetFilter !== undefined) throw new EngineReject(`转化关系不支持目标侧过滤：${linkName}`);
        return transitionHolds(cls, ind, link, env, ctx);
      }
      // match 关系：两端属性值相等则成立。空值不连关系。
      const merged = matchConds(cls, ind, link, reversed, targetFilter as Filter | undefined, (k) => `目标侧过滤 ${k} 与关系 ${linkName} 的配对字段冲突`);
      if (!merged) return false;
      const targetClsName = reversed ? link.from : link.to;
      return (await selectIndividuals(env, targetClsName, { filter: merged, ctx })).length > 0;
    },
  };
  return env;
}

/* ---------- 个体组装：先定列，再下推 ---------- */

/** match 配对 → 目标侧条件（唯一出处）：reversed 换向；配对值为空返回 null（关系不成立，没有目标）。
 *  目标侧过滤与配对字段冲突即拒绝（静默覆盖会让配对形同虚设），冲突文案由调用方定。 */
function matchConds(cls: Cls, ind: Individual, link: LinkType, reversed: boolean, targetFilter: Filter | undefined, conflictMsg: (k: string) => string): Filter | null {
  const conds: Filter = {};
  for (const pair of link.match ?? []) {
    const myProp = reversed ? pair.to : pair.from;
    const targetProp = reversed ? pair.from : pair.to;
    const v = propValue(cls, ind, myProp);
    if (v == null) return null; // 空值不连关系
    conds[targetProp] = v;
  }
  const merged: Filter = { ...conds };
  for (const [k, v] of Object.entries(targetFilter ?? {})) {
    if (k in conds) throw new EngineReject(conflictMsg(k));
    merged[k] = v;
  }
  return merged;
}

interface SelectOpts {
  identity?: unknown;
  filter?: Filter;
  requested?: string[];
  expands?: ExpandNode[];
  allColumns?: boolean; // 动作执行用：读全量映射列
  ctx?: EvalContext;
  path?: string[];
  limit?: number; // 单源且无过滤时下推行数上限；多源/带过滤必须取全量再对齐核对，不下推
}

/** 本次涉及的属性：要返回的 + 过滤点到的 + 派生的输入 + 展开与 $link 的配对属性。 */
function neededProps(cls: Cls, requested: string[] | undefined, filter: Filter | undefined, expands: ExpandNode[] | undefined, config: OntologyConfig): Set<string> {
  const need = new Set<string>();
  const addLink = (name: string) => {
    const { link, reversed } = resolveLink(config, cls.name, name);
    if (link.match) for (const pair of link.match) addProp(reversed ? pair.to : pair.from);
    if (link.transition) addProp(link.transition.property);
  };
  const addFilterKeys = (f: Filter) => {
    walkFilter(config, cls.name, f, {
      prop: (_c, k) => addProp(k),
      link: (_c, name) => {
        addLink(name);
        return false; // $link 子过滤落在目标类，不进本类的属性集
      },
    });
  };
  const addProp = (p: string) => {
    if (need.has(p)) return;
    need.add(p);
    const def = cls.def.properties[p];
    if (!def) throw new EngineReject(`名字对不上配置：${cls.name}.${p}`);
    if (def.derived) {
      if (Array.isArray(def.derived)) {
        for (const rule of def.derived) {
          for (const cond of Object.values(rule.when)) {
            if (typeof cond === "object") addFilterKeys(cond as Filter);
          }
        }
      } else {
        addFilterKeys(def.derived as Filter);
      }
    }
  };
  requested?.forEach(addProp);
  if (filter) addFilterKeys(filter);
  for (const ex of expands ?? []) addLink(ex.relation);
  return need;
}

/** 能下推的平推条件：非派生、只在一个源有映射、操作数不依赖 current。其余留在内存核对。 */
async function pushdownConditions(cls: Cls, filter: Filter | undefined, ctx: EvalContext): Promise<Map<string, Condition[]>> {
  const out = new Map<string, Condition[]>();
  if (!filter) return out;
  for (const [prop, cv] of Object.entries(filter)) {
    if (prop.startsWith("$")) continue;
    const def = cls.def.properties[prop];
    if (!def) throw new EngineReject(`过滤里的名字对不上配置：${cls.name}.${prop}`);
    if (def.derived) continue;
    const mapped = sourcesOf(cls).filter(([, e]) => e.fields[prop]);
    if (mapped.length !== 1) continue; // 多源都有时按声明顺序取值，推送会改变语义，留内存
    const conds = await toConditions(mapped[0][1].fields[prop], cv, ctx, def.type === "date");
    if (!conds) continue;
    out.set(mapped[0][0], [...(out.get(mapped[0][0]) ?? []), ...conds]);
  }
  return out;
}

async function toConditions(column: string, cv: unknown, ctx: EvalContext, dateLike = false): Promise<Condition[] | null> {
  try {
    if (cv !== null && typeof cv === "object" && !Array.isArray(cv)) {
      const rec = cv as Record<string, unknown>;
      const keys = Object.keys(rec);
      const isOpObject = keys.length > 0 && keys.every((k) => (FILTER_OPS as readonly string[]).includes(k));
      if (!isOpObject) {
        // 裸的 { property, from } 视为等值；取不到值就留内存核对
        const v = await resolveOperand(cv, ctx);
        return v === undefined ? null : [{ column, op: "eq", value: v, dateLike: dateLike || undefined }];
      }
      const conds: Condition[] = [];
      for (const [op, operand] of Object.entries(rec)) {
        const v = await resolveOperand(operand, ctx);
        if (v === undefined) return null; // 依赖 current 等，留内存核对
        if (v === null) {
          if (op === "eq") conds.push({ column, op: "null" });
          else if (op === "ne") conds.push({ column, op: "notnull" });
          else return null; // 与 null 比大小：下推会改变语义（空按至今），留内存核对
        } else {
          conds.push({ column, op: op as Condition["op"], value: v, nullLoose: dateLike || undefined, dateLike: dateLike || undefined });
        }
      }
      return conds;
    }
    if (cv === null) return [{ column, op: "null" }];
    const v = await resolveOperand(cv, ctx);
    return v === undefined ? null : [{ column, op: "eq", value: v, dateLike: dateLike || undefined }];
  } catch {
    return null; // 操作数取不到值（如依赖 current），留内存核对
  }
}

/** 组装个体：各源分别下推，按对齐键配成同一个体，再做内存过滤核对。 */
export async function selectIndividuals(env: Env, clsName: string, opts: SelectOpts = {}): Promise<Individual[]> {
  const cls = mustCls(env.config, clsName);
  const srcs = sourcesOf(cls);
  if (srcs.length === 0) return []; // 无源类（如 change）读不出个体
  const ctx: EvalContext = { identity: opts.identity as string | number | undefined, ...(opts.ctx ?? {}) };
  const need = neededProps(cls, opts.requested, opts.filter, opts.expands, env.config); // 始终计算：校验名字、供取列
  const readAll = opts.allColumns || opts.requested === undefined; // 没点 properties 就要返回全部，列得取全
  const pushed = await pushdownConditions(cls, opts.filter, ctx);
  const byKey = new Map<string, Individual>();

  // limit 只在「单源、无过滤、无展开」时下推：多源要先取全量对齐，内存过滤同理，推下去会切掉候选
  const pushLimit = opts.limit !== undefined && srcs.length === 1 && !opts.filter && !opts.expands?.length ? opts.limit : undefined;
  let nullKeys = 0;
  let dupKeys = 0;
  for (const [srcName, entry] of srcs) {
    const keyCol = keyColumn(cls, entry);
    const cols = new Set<string>([keyCol]);
    if (readAll) for (const c of Object.values(entry.fields)) cols.add(c);
    else for (const p of need) { const c = entry.fields[p]; if (c) cols.add(c); }
    const conds: Condition[] = [...(pushed.get(srcName) ?? [])];
    if (opts.identity !== undefined) conds.push({ column: keyCol, op: "eq", value: opts.identity });
    // date 条件的值是 Unix 秒：下推活体库前按连接方言归一（读侧与写回同一规则）
    const dialect = dialectFor(env.driver, entry.connection);
    const bound = conds.map((c) => {
      if (!c.dateLike || c.value === undefined) return c;
      const v = Array.isArray(c.value) ? c.value.map((x) => toColumnValue(x, "date", dialect)) : toColumnValue(c.value, "date", dialect);
      return { ...c, value: v };
    });
    const rows = await env.driver.select(entry.connection, entry.table, [...cols], bound, pushLimit);
    opts.path?.push(
      `下推 ${entry.connection}.${entry.table}：取 ${[...cols].join("、")}${conds.length ? `，带条件 ${conds.length} 条` : ""}${pushLimit ? `，limit ${pushLimit} 下推` : ""}，命中 ${rows.length} 行（只读）`
    );
    for (const row of rows) {
      const kv = row[keyCol];
      if (kv == null || String(kv).trim() === "") {
        nullKeys++; // 缺识别值的行没法对齐，排除并记账
        continue;
      }
      const k = String(kv);
      const ind = byKey.get(k) ?? { key: k, rows: Object.fromEntries(srcs.map(([s]) => [s, null])) };
      if (ind.rows[srcName] != null) dupKeys++; // 同源同键重复：保留首行，记账
      else ind.rows[srcName] = row;
      byKey.set(k, ind);
    }
  }
  if (nullKeys > 0) opts.path?.push(`${nullKeys} 行缺识别值，已排除（不对齐成个体）`);
  if (dupKeys > 0) opts.path?.push(`${dupKeys} 行与同源已有行识别值重复，保留首行`);

  let list = [...byKey.values()];
  if (opts.filter) {
    const kept: Individual[] = [];
    for (const ind of list) {
      if (await evalFilterOnIndividual(cls, ind, opts.filter!, env, ctx)) kept.push(ind);
    }
    list = kept;
    opts.path?.push(`内存核对过滤与派生：${list.length} 个体留下`);
  }
  return list;
}

/* ---------- 查询树求值 ---------- */

export interface QueryResult {
  rows: Record<string, unknown>[];
  path: string[];
}

export async function runQuery(config: OntologyConfig, driver: SourceDriver, req: QueryRequest): Promise<QueryResult> {
  const env = createEnv(config, driver);
  const path: string[] = [];
  const cls = mustCls(config, req.object);
  const ctx: EvalContext = { identity: req.identity };
  // 过滤形状入口校验：in 必须数组、其余运算符与等值位禁数组——下推与内存共用一把尺
  if (req.filter) assertFilterShapes(req.filter);
  const checkExpand = (exs?: ExpandNode[]) => exs?.forEach((e) => { if (e.filter) assertFilterShapes(e.filter, `展开 ${e.relation}`); checkExpand(e.expand); });
  checkExpand(req.expand);

  if (req.aggregate && req.expand?.length) throw new EngineReject("聚合与展开不能同给：分组统计不携带逐个体明细");
  // 展开深度上限：每层都是一轮下推，无上限会被深层请求打爆
  const depthOf = (exs: ExpandNode[] | undefined, d: number): number => (exs?.length ? Math.max(...exs.map((e) => depthOf(e.expand, d + 1))) : d);
  if (depthOf(req.expand, 0) > 3) throw new EngineReject("展开最多三层");

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
    if (!legal.has(prop)) throw new EngineReject(`order 里的名字对不上配置：${prop}`);
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
  const { link, reversed } = resolveLink(env.config, cls.name, item.relation);
  if (link.transition) {
    if (item.expand?.length) throw new EngineReject(`转化关系不支持嵌套展开：${item.relation}`);
    if (item.filter !== undefined) throw new EngineReject(`转化关系不支持目标侧过滤：${item.relation}`); // 与 linkHolds 同口径，不静默吞
    return [item.relation, (await transitionHolds(cls, ind, link, env, ctx)) ? [await project(cls, ind, item.properties, env, ctx)] : []];
  }
  const targetClsName = reversed ? link.from : link.to;
  const merged = matchConds(cls, ind, link, reversed, item.filter, (k) => `展开 ${item.relation} 的目标侧过滤 ${k} 与配对字段冲突`);
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
    if (!def) throw new EngineReject(`properties 里的名字对不上配置：${cls.name}.${p}`);
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
      else throw new EngineReject(`未知聚合：${op}`);
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
