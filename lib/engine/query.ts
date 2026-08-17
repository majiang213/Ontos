// M7 查询求值 —— 对应《ontos-article.md》§5.4 与图 7。
// 先定列再下推；各源取回后按同一性标准对齐；派生按形状翻译；全程只读。

import type { Filter, LinkType, OntologyConfig } from "../schema/config";
import type { ExpandNode, QueryRequest } from "../schema/request";
import type { Condition, SourceDriver } from "./driver";
import type { EvalContext } from "./expr";
import {
  currentOf,
  evalDerived,
  evalFilterOnIndividual,
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
  const direct = config.link_types[name];
  if (direct && direct.from === clsName) return { link: direct, reversed: false };
  for (const link of Object.values(config.link_types)) {
    if (link.inverse === name && link.to === clsName) return { link, reversed: true };
  }
  throw new Error(`关系名对不上配置：${clsName} 出发没有 ${name}`);
}

/** 转化关系的两截判定（§6.4）：出发规则里值为 true 的源现在有没有行；到达规则现在是否整条命中。 */
function transitionHolds(cls: Cls, ind: Individual, link: LinkType): boolean {
  const t = link.transition!;
  const clsOfLink = cls;
  const def = clsOfLink.def.properties[t.property];
  if (!def?.derived || !Array.isArray(def.derived)) throw new Error(`transition.property 不是 when 派生：${t.property}`);
  const fromRule = def.derived.find((r) => r.value === t.from);
  const toRule = def.derived.find((r) => r.value === t.to);
  if (!fromRule || !toRule) throw new Error(`派生规则里找不到阶段 ${String(t.from)} / ${String(t.to)}`);
  const fromSourcesHaveRows = Object.entries(fromRule.when)
    .filter(([, cond]) => cond === true)
    .every(([src]) => ind.rows[src] != null);
  return fromSourcesHaveRows && whenRuleHits(clsOfLink, ind, toRule);
}

/** 组装求值环境：配置 + 驱动 + 关系判定 + 存在性检查。查询与动作共用。 */
export function createEnv(config: OntologyConfig, driver: SourceDriver): Env {
  const env: Env = {
    config,
    driver,
    existsIndividual(clsName, identityValue) {
      return selectIndividuals(env, clsName, { identity: identityValue }).length > 0;
    },
    linkHolds(clsName, ind, linkName, targetFilter, ctx) {
      const cls = mustCls(config, clsName);
      const { link, reversed } = resolveLink(config, clsName, linkName);
      if (link.transition) {
        if (targetFilter !== undefined) throw new Error(`转化关系不支持目标侧过滤：${linkName}`);
        return transitionHolds(cls, ind, link);
      }
      // match 关系：两端属性值相等则成立。空值不连关系。
      const targetClsName = reversed ? link.from : link.to;
      const conds: Filter = {};
      for (const pair of link.match ?? []) {
        const myProp = reversed ? pair.to : pair.from;
        const targetProp = reversed ? pair.from : pair.to;
        const v = propValue(cls, ind, myProp);
        if (v == null) return false;
        conds[targetProp] = v;
      }
      const merged: Filter = { ...conds, ...((targetFilter as Filter | undefined) ?? {}) };
      return selectIndividuals(env, targetClsName, { filter: merged, ctx }).length > 0;
    },
  };
  return env;
}

/* ---------- 个体组装：先定列，再下推 ---------- */

interface SelectOpts {
  identity?: unknown;
  filter?: Filter;
  requested?: string[];
  expands?: ExpandNode[];
  allColumns?: boolean; // 动作执行用：读全量映射列
  ctx?: EvalContext;
  path?: string[];
}

/** 本次涉及的属性：要返回的 + 过滤点到的 + 派生的输入 + 展开 match 的本侧。 */
function neededProps(cls: Cls, requested: string[] | undefined, filter: Filter | undefined, expands: ExpandNode[] | undefined, config: OntologyConfig): Set<string> {
  const need = new Set<string>();
  const addProp = (p: string) => {
    if (need.has(p)) return;
    need.add(p);
    const def = cls.def.properties[p];
    if (!def) throw new Error(`名字对不上配置：${cls.name}.${p}`);
    if (def.derived) {
      if (Array.isArray(def.derived)) {
        for (const rule of def.derived) {
          for (const cond of Object.values(rule.when)) {
            if (typeof cond === "object") Object.keys(cond as Filter).forEach(addProp);
          }
        }
      } else {
        Object.keys(def.derived as Filter).filter((k) => !k.startsWith("$")).forEach(addProp);
      }
    }
  };
  requested?.forEach(addProp);
  if (filter) Object.keys(filter).filter((k) => !k.startsWith("$")).forEach(addProp);
  for (const ex of expands ?? []) {
    const { link, reversed } = resolveLink(config, cls.name, ex.relation);
    if (link.match) for (const pair of link.match) addProp(reversed ? pair.to : pair.from);
    if (link.transition) addProp(link.transition.property);
  }
  // $link 里的转化关系也要读 transition.property
  const linkBlock = filter?.$link as Record<string, unknown> | undefined;
  for (const name of Object.keys(linkBlock ?? {})) {
    const { link } = resolveLink(config, cls.name, name);
    if (link.transition) addProp(link.transition.property);
  }
  return need;
}

/** 能下推的平推条件：非派生、只在一个源有映射、操作数不依赖 current。其余留在内存核对。 */
function pushdownConditions(cls: Cls, filter: Filter | undefined, ctx: EvalContext): Map<string, Condition[]> {
  const out = new Map<string, Condition[]>();
  if (!filter) return out;
  for (const [prop, cv] of Object.entries(filter)) {
    if (prop.startsWith("$")) continue;
    const def = cls.def.properties[prop];
    if (!def) throw new Error(`过滤里的名字对不上配置：${cls.name}.${prop}`);
    if (def.derived) continue;
    const mapped = sourcesOf(cls).filter(([, e]) => e.fields[prop]);
    if (mapped.length !== 1) continue; // 多源都有时按声明顺序取值，推送会改变语义，留内存
    const conds = toConditions(mapped[0][1].fields[prop], cv, ctx);
    if (!conds) continue;
    out.set(mapped[0][0], [...(out.get(mapped[0][0]) ?? []), ...conds]);
  }
  return out;
}

function toConditions(column: string, cv: unknown, ctx: EvalContext): Condition[] | null {
  try {
    if (cv !== null && typeof cv === "object" && !Array.isArray(cv)) {
      const rec = cv as Record<string, unknown>;
      return Object.entries(rec).map(([op, operand]) => {
        const v = resolveOperand(operand, ctx);
        if (op === "eq" && v === null) return { column, op: "null" } as Condition;
        if (op === "ne" && v === null) return { column, op: "notnull" } as Condition;
        return { column, op: op as Condition["op"], value: v };
      });
    }
    if (cv === null) return [{ column, op: "null" }];
    const v = resolveOperand(cv, ctx);
    return [{ column, op: "eq", value: v }];
  } catch {
    return null; // 操作数依赖 current 等，留内存核对
  }
}

/** 组装个体：各源分别下推，按对齐键配成同一个体，再做内存过滤核对。 */
export function selectIndividuals(env: Env, clsName: string, opts: SelectOpts = {}): Individual[] {
  const cls = mustCls(env.config, clsName);
  const srcs = sourcesOf(cls);
  if (srcs.length === 0) return []; // 无源类（如 change）读不出个体
  const ctx: EvalContext = { identity: opts.identity as string | number | undefined, ...(opts.ctx ?? {}) };
  const need = opts.allColumns ? null : neededProps(cls, opts.requested, opts.filter, opts.expands, env.config);
  const pushed = pushdownConditions(cls, opts.filter, ctx);
  const byKey = new Map<string, Individual>();

  for (const [srcName, entry] of srcs) {
    const keyCol = keyColumn(cls, entry);
    const cols = new Set<string>([keyCol]);
    if (need) for (const p of need) { const c = entry.fields[p]; if (c) cols.add(c); }
    else for (const c of Object.values(entry.fields)) cols.add(c);
    const conds: Condition[] = [...(pushed.get(srcName) ?? [])];
    if (opts.identity !== undefined) conds.push({ column: keyCol, op: "eq", value: opts.identity });
    const rows = env.driver.select(entry.connection, entry.table, [...cols], conds);
    opts.path?.push(
      `下推 ${entry.connection}.${entry.table}：取 ${[...cols].join("、")}${conds.length ? `，带条件 ${conds.length} 条` : ""}，命中 ${rows.length} 行（只读）`
    );
    for (const row of rows) {
      const k = String(row[keyCol]);
      const ind = byKey.get(k) ?? { key: k, rows: Object.fromEntries(srcs.map(([s]) => [s, null])) };
      ind.rows[srcName] = row;
      byKey.set(k, ind);
    }
  }

  let list = [...byKey.values()];
  if (opts.filter) {
    list = list.filter((ind) => evalFilterOnIndividual(cls, ind, opts.filter!, env, ctx));
    opts.path?.push(`内存核对过滤与派生：${list.length} 个体留下`);
  }
  return list;
}

/* ---------- 查询树求值 ---------- */

export interface QueryResult {
  rows: Record<string, unknown>[];
  path: string[];
}

export function runQuery(config: OntologyConfig, driver: SourceDriver, req: QueryRequest): QueryResult {
  const env = createEnv(config, driver);
  const path: string[] = [];
  const cls = mustCls(config, req.object);
  const ctx: EvalContext = { identity: req.identity };

  // 聚合的分组键与指标字段也要下推进去
  const requested = req.aggregate
    ? [...req.aggregate.group_by, ...req.aggregate.metrics.flatMap((m) => Object.values(m)).filter((f) => f !== "*")]
    : req.properties;

  const individuals = selectIndividuals(env, req.object, {
    identity: req.identity,
    filter: req.filter,
    requested,
    expands: req.expand,
    ctx,
    path,
  });

  if (req.aggregate) {
    const rows = aggregate(cls, individuals, req.aggregate, env, ctx);
    path.push(`聚合：${req.aggregate.group_by.join("、")} 分组，${rows.length} 组`);
    return { rows, path };
  }

  // 展开：按已声明关系进入目标类
  const expanded = new Map<string, Record<string, Record<string, unknown>[]>>();
  for (const item of req.expand ?? []) {
    for (const ind of individuals) {
      const bag = expanded.get(ind.key) ?? {};
      const [name, rows] = expandItem(env, cls, ind, item, ctx, path);
      bag[name] = rows;
      expanded.set(ind.key, bag);
    }
    path.push(`展开 ${item.relation}`);
  }

  let rows = individuals.map((ind) => {
    const row = project(cls, ind, req.properties, env, ctx);
    const bag = expanded.get(ind.key);
    if (bag) Object.assign(row, bag);
    return row;
  });

  if (req.order) {
    const [[prop, dir]] = Object.entries(req.order);
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
function expandItem(
  env: Env,
  cls: Cls,
  ind: Individual,
  item: ExpandNode,
  ctx: EvalContext,
  path: string[]
): [string, Record<string, unknown>[]] {
  const { link, reversed } = resolveLink(env.config, cls.name, item.relation);
  if (link.transition) {
    return [item.relation, transitionHolds(cls, ind, link) ? [project(cls, ind, item.properties, env, ctx)] : []];
  }
  const targetClsName = reversed ? link.from : link.to;
  const conds: Filter = {};
  for (const pair of link.match ?? []) {
    const myProp = reversed ? pair.to : pair.from;
    const targetProp = reversed ? pair.from : pair.to;
    const v = propValue(cls, ind, myProp);
    if (v != null) conds[targetProp] = v;
  }
  const merged: Filter = { ...conds, ...(item.filter ?? {}) };
  const targetCls = mustCls(env.config, targetClsName);
  const sub = selectIndividuals(env, targetClsName, {
    filter: merged,
    requested: item.properties,
    expands: item.expand,
    ctx,
    path,
  });
  const rows = sub.map((t) => {
    const row = project(targetCls, t, item.properties, env, ctx);
    for (const nested of item.expand ?? []) {
      const [name, nestedRows] = expandItem(env, targetCls, t, nested, ctx, path);
      row[name] = nestedRows;
    }
    return row;
  });
  return [item.relation, rows];
}

/** 返回形态：点了哪些属性给哪些；没点给全部（源列属性 + 派生都算出来）。 */
function project(cls: Cls, ind: Individual, requested: string[] | undefined, env: Env, ctx: EvalContext): Record<string, unknown> {
  const props = requested ?? Object.keys(cls.def.properties);
  const row: Record<string, unknown> = {};
  for (const p of props) {
    const def = cls.def.properties[p];
    if (!def) throw new Error(`properties 里的名字对不上配置：${cls.name}.${p}`);
    row[p] = def.derived ? evalDerived(cls, ind, p, env, ctx) : propValue(cls, ind, p);
  }
  return row;
}

function aggregate(cls: Cls, individuals: Individual[], agg: NonNullable<QueryRequest["aggregate"]>, env: Env, ctx: EvalContext) {
  const groups = new Map<string, { key: Record<string, unknown>; members: Individual[] }>();
  for (const ind of individuals) {
    const cur = currentOf(cls, ind, env, ctx);
    const keyObj = Object.fromEntries(agg.group_by.map((g) => [g, cur[g]]));
    const k = JSON.stringify(keyObj);
    const g = groups.get(k) ?? { key: keyObj, members: [] };
    g.members.push(ind);
    groups.set(k, g);
  }
  return [...groups.values()].map(({ key, members }) => {
    const row: Record<string, unknown> = { ...key };
    for (const metric of agg.metrics) {
      const [op, field] = Object.entries(metric)[0];
      const vals = members.map((m) => currentOf(cls, m, env, ctx)[field]).filter((v): v is number => typeof v === "number");
      const name = field === "*" ? op : `${op}_${field}`;
      if (op === "count") row[name] = members.length;
      else if (op === "avg") row[name] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      else if (op === "sum") row[name] = vals.reduce((a, b) => a + b, 0);
      else if (op === "min") row[name] = vals.length ? Math.min(...vals) : null;
      else if (op === "max") row[name] = vals.length ? Math.max(...vals) : null;
      else throw new Error(`未知聚合：${op}`);
    }
    return row;
  });
}

function compareRows(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
