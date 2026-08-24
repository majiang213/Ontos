// 个体 —— 同一性标准对齐之后，一个体 = 各源各一行（或缺行）。
// 组装（下推、按识别字段对齐）、属性取值、派生求值、过滤核对都在这里。
// 问数只投影结果树；动作经本模块读个体。

import type { Filter, LinkType, ObjectType, OntologyConfig, WhenRule } from "../../schema/config";
import { resolveLink, walkFilter } from "../../schema/spec/filterSpec";
import type { ExpandNode } from "../../schema/request";
import { dialectFor, toColumnValue, type Condition, type SourceDriver } from "../infra/driver";
import { resolveLiteral, type EvalContext } from "./expr";
import { compare, isOpObject, pushCondition } from "./filterOp";

/** 类名 + 类定义，成对传。 */
export interface Cls {
  name: string;
  def: ObjectType;
}

export interface Individual {
  key: string; // 对齐键的值（identity 或源条目 key 的原值，转字符串做键）
  rows: Record<string, Record<string, unknown> | null>; // 源条目名 → 行（列→值）；null = 该源无行
}

export interface Env {
  config: OntologyConfig;
  driver: SourceDriver;
  // 关系是否成立、某类有没有这个体——createEnv 提供（本文件后段）。异步：要查源
  linkHolds(clsName: string, ind: Individual, linkName: string, target: unknown, ctx: EvalContext): Promise<boolean>;
  existsIndividual(clsName: string, identityValue: unknown): Promise<boolean>;
}

import { EngineReject } from "../../errors";

/** 关系名对不上配置即拒绝（问数展开、个体组装、Env.linkHolds 共用）。 */
export function mustLink(config: OntologyConfig, clsName: string, name: string): { link: LinkType; reversed: boolean } {
  const found = resolveLink(config, clsName, name);
  if (!found) throw new EngineReject(`关系名对不上配置：${clsName} 出发没有 ${name}`);
  return found;
}

export function mustCls(config: OntologyConfig, name: string): Cls {
  const def = config.object_types[name];
  if (!def) throw new EngineReject(`配置中没有类：${name}`);
  return { name, def };
}

export function sourcesOf(cls: Cls): [string, NonNullable<ObjectType["sources"]>[string]][] {
  return Object.entries(cls.def.sources ?? {});
}

/** 该源用来对齐、认行的列：源条目的 key，省略则用类的 identity。 */
export function keyColumn(cls: Cls, entry: { fields: Record<string, string>; key?: string }): string {
  const keyProp = entry.key ?? cls.def.identity;
  if (!keyProp) throw new EngineReject("类没有 identity，源条目也没有 key");
  const col = entry.fields[keyProp];
  if (!col) throw new EngineReject(`源条目的 fields 里没有对齐属性 ${keyProp}`);
  return col;
}

/** 源列属性的值：按 sources 声明顺序，排在前面的源优先；该源无行则看下一个。 */
export function propValue(cls: Cls, ind: Individual, prop: string): unknown {
  const def = cls.def.properties[prop];
  if (!def) throw new EngineReject(`类上没有属性：${prop}`); // 点错名是配置/请求问题（422），不是系统故障
  for (const [src, entry] of sourcesOf(cls)) {
    const col = entry.fields[prop];
    const row = ind.rows[src];
    if (col && row) return row[col] ?? null;
  }
  return undefined;
}

/** 指定源条目上某属性的值（when 过滤、写回认值用）。 */
export function propValueFrom(cls: Cls, ind: Individual, src: string, prop: string): unknown {
  const entry = cls.def.sources?.[src];
  const row = ind.rows[src];
  if (!entry || !row) return undefined;
  const col = entry.fields[prop];
  return col ? (row[col] ?? null) : undefined;
}

/* ---------- when 规则 ---------- */

/** when 里一个键是否成立：true=有行；false=无行；过滤=有行且已映射属性满足。 */
async function whenKeyHolds(cls: Cls, ind: Individual, src: string, cond: boolean | Filter, env: Env, ctx: EvalContext): Promise<boolean> {
  if (!(src in ind.rows)) throw new EngineReject(`when 规则指向不存在的源条目：${cls.name} 没有 ${src}`); // 拼错源名不能静默吞
  const row = ind.rows[src];
  if (cond === true) return row != null;
  if (cond === false) return row == null;
  if (row == null) return false;
  return evalFilterOnIndividual(cls, ind, cond, env, ctx, src);
}

/** 某个源条目上的属性视图（when 过滤里的 { property, from: current } 用它）。 */
function sourceView(cls: Cls, ind: Individual, src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entry = cls.def.sources?.[src];
  if (!entry) return out;
  for (const prop of Object.keys(entry.fields)) out[prop] = propValueFrom(cls, ind, src, prop);
  return out;
}

export async function whenRuleHits(cls: Cls, ind: Individual, rule: WhenRule, env: Env, ctx: EvalContext): Promise<boolean> {
  for (const [src, cond] of Object.entries(rule.when)) {
    if (!(await whenKeyHolds(cls, ind, src, cond as boolean | Filter, env, ctx))) return false;
  }
  return true;
}

/** 派生属性求值。when 列表取第一条命中；一条过滤取布尔。 */
export async function evalDerived(cls: Cls, ind: Individual, prop: string, env: Env, ctx: EvalContext): Promise<unknown> {
  const def = cls.def.properties[prop];
  const derived = def?.derived;
  if (!derived) throw new EngineReject(`属性不是派生的：${prop}`);
  if (Array.isArray(derived)) {
    for (const r of derived) {
      if (await whenRuleHits(cls, ind, r, env, ctx)) return r.value;
    }
    return undefined;
  }
  return evalFilterOnIndividual(cls, ind, derived as Filter, env, ctx);
}

/* ---------- 行级比较 ---------- */

/** 操作数求值（异步：派生属性可能要查源）：字面量、ISO 日期串、日期表达式、{ property, from }、{ from: identity }。 */
export async function resolveOperand(v: unknown, ctx: EvalContext): Promise<unknown> {
  if (Array.isArray(v)) {
    try {
      return v.map((x) => resolveLiteral(x)); // in 的值是数组，元素级解析（ISO 串落成秒）
    } catch (e) {
      throw new EngineReject(e instanceof Error ? e.message : String(e)); // 与标量分支同口径：非法表达式 422 不是 500
    }
  }
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if (typeof rec.property === "string") {
      if (rec.from === "request") {
        try {
          return resolveLiteral(ctx.request?.[rec.property]); // 请求参数：严格，非法拒绝
        } catch (e) {
          throw new EngineReject(e instanceof Error ? e.message : String(e));
        }
      }
      const hit = ctx.current?.[rec.property];
      if (hit === undefined) {
        // 派生按需现算。错误分类在源头就是对的：点错名（evalDerived/propValue）抛 EngineReject，
        // 源库故障（$link 派生真查库）是原生异常——都不需要在这里归一，原样透传即可
        if (ctx.currentDerived) return await ctx.currentDerived(rec.property);
        throw new EngineReject(`操作数取不到值：${rec.property}`); // 下推层接到这个错就退回内存核对
      }
      return dataLiteral(hit); // 源库数据：只转换，不抛错
    }
    if (rec.from === "identity") return ctx.identity;
    throw new EngineReject(`无法识别的操作数：${JSON.stringify(v)}`);
  }
  try {
    return resolveLiteral(v); // 请求侧表达式非法 → 422
  } catch (e) {
    throw new EngineReject(e instanceof Error ? e.message : String(e));
  }
}

/** 数据侧的值只做转换、不抛错：源列里写什么不归引擎管，形似而非法就按原字符串比。 */
function dataLiteral(v: unknown): unknown {
  try {
    return resolveLiteral(v);
  } catch {
    return v;
  }
}

/** 单个条件是否成立。actual 为 undefined（个体或该值不存在）时一律不成立。
 *  dateLike=true（仅 date 类型属性）时 null 按「空=至今」处理：actual 为空时 gt/gte 成立；expected 为空时 lt/lte 成立。 */
export async function conditionHolds(actual: unknown, condVal: unknown, ctx: EvalContext, dateLike = false): Promise<boolean> {
  const a = dataLiteral(actual); // ISO 日期串落成秒；脏数据不抛错
  if (isOpObject(condVal)) {
    for (const op of Object.keys(condVal)) {
      if (!compare(a, op, await resolveOperand(condVal[op], ctx), dateLike)) return false;
    }
    return true;
  }
  // 裸的 { property, from } 或等值位字面量：日期表达式、ISO 串落成秒，非法表达式拒绝
  return compare(a, "eq", await resolveOperand(condVal, ctx), dateLike);
}

/** 过滤值形状校验：in 的值必须数组；其余运算符与等值位不许数组；$link 嵌套限三层（防深层扇出）。
 *  查询与动作入口各跑一次，下推与内存共用同一把尺。遍历走 schema 层 walkFilter（结构遍历，不解析关系）。 */
export function assertFilterShapes(filter: Filter, trail = "过滤"): void {
  walkFilter(null, "", filter, {
    link: (_cls, _ln, _target, _sub, depth) => {
      if (depth + 1 > 3) throw new EngineReject(`${trail}：$link 嵌套最多三层`);
      // 存在性写法（true/false）没有子过滤：walker 对非对象本就不递归
    },
    prop: (_cls, key, v) => {
      if (Array.isArray(v)) throw new EngineReject(`${trail}的 ${key}：等值位不接受数组（数组只能出现在 in 里）`);
      if (isOpObject(v)) {
        for (const [op, operand] of Object.entries(v)) {
          if (op === "in") {
            if (!Array.isArray(operand)) throw new EngineReject(`${trail}的 ${key}.in：值必须是数组`);
          } else if (Array.isArray(operand)) {
            throw new EngineReject(`${trail}的 ${key}.${op}：不接受数组`);
          }
        }
      }
      // 裸的 { property, from } 是操作数不是运算符块，跳过
    },
  });
}

/* ---------- 整条过滤在个体上的核对（前置、布尔派生、残余过滤共用） ---------- */

export async function evalFilterOnIndividual(cls: Cls, ind: Individual, filter: Filter, env: Env, ctx: EvalContext, fromSource?: string): Promise<boolean> {
  const current = fromSource ? sourceView(cls, ind, fromSource) : currentView(cls, ind);
  const evalCtx: EvalContext = {
    ...ctx,
    current,
    currentDerived: fromSource ? undefined : (p) => evalDerived(cls, ind, p, env, ctx),
  };
  for (const [key, v] of Object.entries(filter)) {
    if (key === "$link") {
      for (const [linkName, target] of Object.entries(v as Record<string, unknown>)) {
        if (!(await linkCondHolds(cls, ind, linkName, target, env, ctx))) return false;
      }
      continue;
    }
    if (fromSource) {
      if (key.startsWith("$")) throw new EngineReject(`when 下的过滤不支持 ${key}`);
      if (!(await conditionHolds(propValueFrom(cls, ind, fromSource, key), v, evalCtx, cls.def.properties[key]?.type === "date"))) return false;
      continue;
    }
    if ((key === "$request" || key === "$exists") && !ctx.allowPreKeys) {
      throw new EngineReject(`${key} 只属于前置，查询过滤不支持`);
    }
    if (key === "$request") {
      for (const [param, cv] of Object.entries(v as Record<string, unknown>)) {
        const val = ctx.request?.[param];
        if (cv !== null && typeof cv === "object" && "object" in (cv as Record<string, unknown>)) {
          // { object: 类名 }：参数必须能按该类 identity 认到已有个体
          if (val == null || !(await env.existsIndividual(String((cv as Record<string, unknown>).object), val))) return false;
          continue;
        }
        if (!(await conditionHolds(val, cv, { ...ctx, current: ctx.request }))) return false;
      }
      continue;
    }
    if (key === "$exists") {
      const exists = Object.values(ind.rows).some((r) => r != null);
      if (exists !== Boolean(v)) return false;
      continue;
    }
    // 属性条件：派生属性先算，源列属性按映射取值
    const def = cls.def.properties[key];
    if (!def) throw new EngineReject(`过滤里的名字对不上配置：${cls.name}.${key}`);
    const actual = def.derived ? await evalDerived(cls, ind, key, env, ctx) : propValue(cls, ind, key);
    if (!(await conditionHolds(actual, v, evalCtx, def.type === "date"))) return false;
  }
  return true;
}

async function linkCondHolds(cls: Cls, ind: Individual, linkName: string, target: unknown, env: Env, ctx: EvalContext): Promise<boolean> {
  if (target === true) return env.linkHolds(cls.name, ind, linkName, undefined, ctx);
  if (target === false) return !(await env.linkHolds(cls.name, ind, linkName, undefined, ctx));
  return env.linkHolds(cls.name, ind, linkName, target, ctx); // 对象：存在满足该过滤的关联个体
}

/** 个体的源列属性视图（{ property, from: current } 的默认来源；不碰派生，避免递归）。 */
export function currentView(cls: Cls, ind: Individual): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [prop, def] of Object.entries(cls.def.properties)) {
    if (!def.derived) out[prop] = propValue(cls, ind, prop);
  }
  return out;
}

/** 个体的合并属性视图（含派生；聚合、动作效应取值用）。only 给了就只算用到的派生——$link 派生逐个体查源，全算是 N+1。 */
export async function currentOf(cls: Cls, ind: Individual, env: Env, ctx: EvalContext, only?: Set<string>): Promise<Record<string, unknown>> {
  const out = currentView(cls, ind);
  for (const [prop, def] of Object.entries(cls.def.properties)) {
    if (!def.derived) continue;
    if (only && !only.has(prop)) continue;
    out[prop] = await evalDerived(cls, ind, prop, env, ctx);
  }
  return out;
}

/* ---------- 组装：先定列，再下推，按识别字段对齐 ---------- */

export interface SelectOpts {
  identity?: unknown;
  filter?: Filter;
  requested?: string[];
  expands?: ExpandNode[];
  allColumns?: boolean; // 动作执行用：读全量映射列
  ctx?: EvalContext;
  path?: string[];
  limit?: number; // 单源且无过滤时下推行数上限；多源/带过滤必须取全量再对齐核对，不下推
}

/** 转化关系的两截判定（§6.4）：出发规则里值为 true 的源现在有没有行；到达规则现在是否整条命中。 */
export async function transitionHolds(cls: Cls, ind: Individual, link: LinkType, env: Env, ctx: EvalContext): Promise<boolean> {
  const t = link.transition!;
  const def = cls.def.properties[t.property];
  if (!def?.derived || !Array.isArray(def.derived)) throw new EngineReject(`transition.property 不是 when 派生：${t.property}`);
  const fromRule = def.derived.find((r) => r.value === t.from);
  const toRule = def.derived.find((r) => r.value === t.to);
  if (!fromRule || !toRule) throw new EngineReject(`派生规则里找不到阶段 ${String(t.from)} / ${String(t.to)}`);
  const fromSourcesHaveRows = Object.entries(fromRule.when)
    .filter(([, cond]) => cond === true)
    .every(([src]) => ind.rows[src] != null);
  return fromSourcesHaveRows && (await whenRuleHits(cls, ind, toRule, env, ctx));
}

/** match 配对 → 目标侧条件（唯一出处）：reversed 换向；配对值为空返回 null（关系不成立，没有目标）。
 *  目标侧过滤与配对字段冲突即拒绝（静默覆盖会让配对形同虚设），冲突文案由调用方定。 */
export function matchConds(cls: Cls, ind: Individual, link: LinkType, reversed: boolean, targetFilter: Filter | undefined, conflictMsg: (k: string) => string): Filter | null {
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

/** 组装求值环境：配置 + 驱动 + 关系判定 + 存在性检查。问数与动作共用。 */
export function createEnv(config: OntologyConfig, driver: SourceDriver): Env {
  const env: Env = {
    config,
    driver,
    async existsIndividual(clsName, identityValue) {
      return (await selectIndividuals(env, clsName, { identity: identityValue })).length > 0;
    },
    async linkHolds(clsName, ind, linkName, targetFilter, ctx) {
      const cls = mustCls(config, clsName);
      const { link, reversed } = mustLink(config, clsName, linkName);
      if (link.transition) {
        if (targetFilter !== undefined) throw new EngineReject(`转化关系不支持目标侧过滤：${linkName}`);
        return transitionHolds(cls, ind, link, env, ctx);
      }
      const merged = matchConds(cls, ind, link, reversed, targetFilter as Filter | undefined, (k) => `目标侧过滤 ${k} 与关系 ${linkName} 的配对字段冲突`);
      if (!merged) return false;
      const targetClsName = reversed ? link.from : link.to;
      return (await selectIndividuals(env, targetClsName, { filter: merged, ctx })).length > 0;
    },
  };
  return env;
}

/** 本次涉及的属性：要返回的 + 过滤点到的 + 派生的输入 + 展开与 $link 的配对属性。 */
function neededProps(cls: Cls, requested: string[] | undefined, filter: Filter | undefined, expands: ExpandNode[] | undefined, config: OntologyConfig): Set<string> {
  const need = new Set<string>();
  const addLink = (name: string) => {
    const { link, reversed } = mustLink(config, cls.name, name);
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
    if (isOpObject(cv)) {
      const conds: Condition[] = [];
      for (const [op, operand] of Object.entries(cv)) {
        const v = await resolveOperand(operand, ctx);
        const c = pushCondition(column, op, v, dateLike);
        if (!c) return null;
        conds.push(c);
      }
      return conds;
    }
    if (cv === null) return [pushCondition(column, "eq", null, dateLike)!];
    const v = await resolveOperand(cv, ctx);
    const c = pushCondition(column, "eq", v, dateLike);
    return c ? [c] : null;
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
      if (await evalFilterOnIndividual(cls, ind, opts.filter, env, ctx)) kept.push(ind);
    }
    list = kept;
    opts.path?.push(`内存核对过滤与派生：${list.length} 个体留下`);
  }
  return list;
}
