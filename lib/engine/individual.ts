// 个体 —— 同一性标准对齐之后，一个体 = 各源各一行（或缺行）。
// 组装、属性取值、派生求值都在这里；过滤的行级核对也在这里。

import type { Filter, ObjectType, OntologyConfig, WhenRule } from "../schema/config";
import type { SourceDriver } from "./driver";
import { resolveLiteral, type EvalContext } from "./expr";
import { FILTER_OPS } from "../schema/config";

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
  // 关系是否成立、某类有没有这个体——由查询引擎提供（本模块不反向依赖）。异步：要查源
  linkHolds(clsName: string, ind: Individual, linkName: string, target: unknown, ctx: EvalContext): Promise<boolean>;
  existsIndividual(clsName: string, identityValue: unknown): Promise<boolean>;
}

/** 引擎拒绝：请求或配置里的名字对不上已发布配置。路由按 422 处理；其它异常是引擎故障，按 500。 */
export class EngineReject extends Error {}

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
  // 过滤落在该源的已映射属性上；键写属性名，不写列名。$link 按附录 B 放行，其余 $ 键拒绝
  for (const [prop, cv] of Object.entries(cond)) {
    if (prop === "$link") {
      for (const [linkName, target] of Object.entries(cv as Record<string, unknown>)) {
        if (!(await linkCondHolds(cls, ind, linkName, target, env, ctx))) return false;
      }
      continue;
    }
    if (prop.startsWith("$")) throw new EngineReject(`when 下的过滤不支持 ${prop}`);
    if (!(await conditionHolds(propValueFrom(cls, ind, src, prop), cv, { ...ctx, current: sourceView(cls, ind, src) }, cls.def.properties[prop]?.type === "date"))) return false;
  }
  return true;
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

/** 字符串字面量里的日期与表达式在 expr.ts 的 resolveLiteral 里统一处理。 */
export { resolveLiteral };

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
  if (condVal !== null && typeof condVal === "object" && !Array.isArray(condVal)) {
    const rec = condVal as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length > 0 && keys.every((k) => (FILTER_OPS as readonly string[]).includes(k))) {
      for (const op of keys) {
        if (!compareOp(a, op, await resolveOperand(rec[op], ctx), dateLike)) return false;
      }
      return true;
    }
    // 裸的 { property, from } 视为等值
    return compareOp(a, "eq", await resolveOperand(condVal, ctx), dateLike);
  }
  // 等值位的字面量同样过解析：日期表达式、ISO 串落成秒，非法表达式拒绝
  return compareOp(a, "eq", await resolveOperand(condVal, ctx), dateLike);
}

function compareOp(actual: unknown, op: string, expected: unknown, dateLike: boolean): boolean {
  if (actual === undefined) return false; // 没有这个体或这个值：任何字段条件都不成立
  if (actual === null) {
    if (op === "eq") return expected === null;
    if (op === "ne") return expected !== null;
    if (dateLike && (op === "gt" || op === "gte")) return true; // 空=至今，至今晚于任何日期
    return false;
  }
  if (expected === null) {
    if (dateLike && (op === "lt" || op === "lte")) return true; // 与至今比：任何日期值都不晚于至今
    if (op === "gt" || op === "gte") return false;
    if (op === "ne") return true;
    return false; // eq / in / contains
  }
  switch (op) {
    case "eq": return actual === expected;
    case "ne": return actual !== expected;
    case "lt": return num(actual) && num(expected) && (actual as number) < (expected as number);
    case "lte": return num(actual) && num(expected) && (actual as number) <= (expected as number);
    case "gt": return num(actual) && num(expected) && (actual as number) > (expected as number);
    case "gte": return num(actual) && num(expected) && (actual as number) >= (expected as number);
    case "in": return Array.isArray(expected) && expected.includes(actual);
    case "contains": return String(actual).includes(String(expected));
    default: throw new Error(`未知运算符：${op}`);
  }
}

const num = (v: unknown) => typeof v === "number";

/** 过滤值形状校验：in 的值必须数组；其余运算符与等值位不许数组；$link 嵌套限三层（防深层扇出）。
 *  查询与动作入口各跑一次，下推与内存共用同一把尺。 */
export function assertFilterShapes(filter: Filter, trail = "过滤", depth = 0): void {
  if (depth > 3) throw new EngineReject(`${trail}：$link 嵌套最多三层`);
  for (const [key, v] of Object.entries(filter)) {
    if (key === "$link") {
      for (const [ln, sub] of Object.entries(v as Record<string, unknown>)) {
        if (sub !== true && sub !== false) assertFilterShapes(sub as Filter, `${trail} 的 $link.${ln}`, depth + 1);
      }
      continue;
    }
    if (key.startsWith("$")) continue; // $request/$exists 的形状另行约束
    if (Array.isArray(v)) throw new EngineReject(`${trail}的 ${key}：等值位不接受数组（数组只能出现在 in 里）`);
    if (v !== null && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      const keys = Object.keys(rec);
      if (keys.length > 0 && keys.every((k) => (FILTER_OPS as readonly string[]).includes(k))) {
        for (const [op, operand] of Object.entries(rec)) {
          if (op === "in") {
            if (!Array.isArray(operand)) throw new EngineReject(`${trail}的 ${key}.in：值必须是数组`);
          } else if (Array.isArray(operand)) {
            throw new EngineReject(`${trail}的 ${key}.${op}：不接受数组`);
          }
        }
      }
      // 裸的 { property, from } 是操作数不是运算符块，跳过
    }
  }
}

/* ---------- 整条过滤在个体上的核对（前置、布尔派生、残余过滤共用） ---------- */

export async function evalFilterOnIndividual(cls: Cls, ind: Individual, filter: Filter, env: Env, ctx: EvalContext): Promise<boolean> {
  const current = currentView(cls, ind); // 进循环前算一份
  const evalCtx: EvalContext = { ...ctx, current, currentDerived: (p) => evalDerived(cls, ind, p, env, ctx) };
  for (const [key, v] of Object.entries(filter)) {
    if ((key === "$request" || key === "$exists") && !ctx.allowPreKeys) {
      throw new EngineReject(`${key} 只属于前置，查询过滤不支持`);
    }
    if (key === "$link") {
      for (const [linkName, target] of Object.entries(v as Record<string, unknown>)) {
        if (!(await linkCondHolds(cls, ind, linkName, target, env, ctx))) return false;
      }
      continue;
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
