// 个体 —— 同一性标准对齐之后，一个体 = 各源各一行（或缺行）。
// 组装、属性取值、派生求值都在这里；过滤的行级核对也在这里。

import type { Filter, Literal, ObjectType, OntologyConfig, WhenRule } from "../schema/config";
import type { SourceDriver } from "./driver";
import { evalDateExpr, isDateExpr, type EvalContext } from "./expr";

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
  // 关系是否成立、某类有没有这个体——由查询引擎提供（本模块不反向依赖）
  linkHolds(clsName: string, ind: Individual, linkName: string, target: unknown, ctx: EvalContext): boolean;
  existsIndividual(clsName: string, identityValue: unknown): boolean;
}

export function mustCls(config: OntologyConfig, name: string): Cls {
  const def = config.object_types[name];
  if (!def) throw new Error(`配置中没有类：${name}`);
  return { name, def };
}

export function sourcesOf(cls: Cls): [string, NonNullable<ObjectType["sources"]>[string]][] {
  return Object.entries(cls.def.sources ?? {});
}

/** 该源用来对齐、认行的列：源条目的 key，省略则用类的 identity。 */
export function keyColumn(cls: Cls, entry: { fields: Record<string, string>; key?: string }): string {
  const keyProp = entry.key ?? cls.def.identity;
  if (!keyProp) throw new Error("类没有 identity，源条目也没有 key");
  const col = entry.fields[keyProp];
  if (!col) throw new Error(`源条目的 fields 里没有对齐属性 ${keyProp}`);
  return col;
}

/** 源列属性的值：按 sources 声明顺序，排在前面的源优先；该源无行则看下一个。 */
export function propValue(cls: Cls, ind: Individual, prop: string): unknown {
  const def = cls.def.properties[prop];
  if (!def) throw new Error(`类上没有属性：${prop}`);
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
function whenKeyHolds(cls: Cls, ind: Individual, src: string, cond: boolean | Filter): boolean {
  const row = ind.rows[src];
  if (cond === true) return row != null;
  if (cond === false) return row == null;
  if (row == null) return false;
  // 过滤落在该源的已映射属性上；键写属性名，不写列名
  return Object.entries(cond).every(([prop, cv]) => {
    if (prop.startsWith("$")) throw new Error(`when 下的过滤不支持 ${prop}`);
    return conditionHolds(propValueFrom(cls, ind, src, prop), cv, { current: sourceView(cls, ind, src) });
  });
}

/** 某个源条目上的属性视图（when 过滤里的 { property, from: current } 用它）。 */
function sourceView(cls: Cls, ind: Individual, src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entry = cls.def.sources?.[src];
  if (!entry) return out;
  for (const prop of Object.keys(entry.fields)) out[prop] = propValueFrom(cls, ind, src, prop);
  return out;
}

export function whenRuleHits(cls: Cls, ind: Individual, rule: WhenRule): boolean {
  return Object.entries(rule.when).every(([src, cond]) => whenKeyHolds(cls, ind, src, cond as boolean | Filter));
}

/** 派生属性求值。when 列表取第一条命中；一条过滤取布尔。 */
export function evalDerived(cls: Cls, ind: Individual, prop: string, env: Env, ctx: EvalContext): unknown {
  const def = cls.def.properties[prop];
  const derived = def?.derived;
  if (!derived) throw new Error(`属性不是派生的：${prop}`);
  if (Array.isArray(derived)) {
    const hit = derived.find((r) => whenRuleHits(cls, ind, r));
    return hit?.value;
  }
  return evalFilterOnIndividual(cls, ind, derived as Filter, env, ctx);
}

/* ---------- 行级比较 ---------- */

/** 操作数求值：字面量、日期表达式、{ property, from }、{ from: identity }。 */
export function resolveOperand(v: unknown, ctx: EvalContext): unknown {
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    if (typeof rec.property === "string") {
      const bag = rec.from === "request" ? ctx.request : ctx.current;
      const hit = bag?.[rec.property];
      if (hit === undefined && rec.from !== "request" && ctx.currentDerived) return ctx.currentDerived(rec.property);
      return hit;
    }
    if (rec.from === "identity") return ctx.identity;
    throw new Error(`无法识别的操作数：${JSON.stringify(v)}`);
  }
  if (isDateExpr(v)) return evalDateExpr(v);
  return v;
}

/** 单个条件是否成立。actual 为 undefined（个体或该值不存在）时一律不成立；
 *  null（列在、值为空）按「空=至今」处理：gt/gte 成立，lt/lte 不成立。 */
export function conditionHolds(actual: unknown, condVal: unknown, ctx: EvalContext): boolean {
  if (condVal !== null && typeof condVal === "object" && !Array.isArray(condVal)) {
    const rec = condVal as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length > 0 && keys.every((k) => ["eq", "ne", "lt", "lte", "gt", "gte", "in", "contains"].includes(k))) {
      return keys.every((op) => compareOp(actual, op, resolveOperand(rec[op], ctx)));
    }
    // 裸的 { property, from } 视为等值
    return compareOp(actual, "eq", resolveOperand(condVal, ctx));
  }
  return compareOp(actual, "eq", condVal as Literal);
}

function compareOp(actual: unknown, op: string, expected: unknown): boolean {
  if (actual === undefined) return false; // 没有这个体或这个值：任何字段条件都不成立
  if (actual === null) {
    if (op === "eq") return expected === null;
    if (op === "ne") return expected !== null;
    if (op === "gt" || op === "gte") return true; // 空=至今，至今晚于任何日期
    return false;
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

/* ---------- 整条过滤在个体上的核对（前置、布尔派生、残余过滤共用） ---------- */

export function evalFilterOnIndividual(cls: Cls, ind: Individual, filter: Filter, env: Env, ctx: EvalContext): boolean {
  return Object.entries(filter).every(([key, v]) => {
    if (key === "$link") {
      return Object.entries(v as Record<string, unknown>).every(([linkName, target]) =>
        linkCondHolds(cls, ind, linkName, target, env, ctx)
      );
    }
    if (key === "$request") {
      return Object.entries(v as Record<string, unknown>).every(([param, cv]) => {
        const val = ctx.request?.[param];
        if (cv !== null && typeof cv === "object" && "object" in (cv as Record<string, unknown>)) {
          // { object: 类名 }：参数必须能按该类 identity 认到已有个体
          return val != null && env.existsIndividual(String((cv as Record<string, unknown>).object), val);
        }
        return conditionHolds(val, cv, { ...ctx, current: ctx.request });
      });
    }
    if (key === "$exists") {
      const exists = Object.values(ind.rows).some((r) => r != null);
      return exists === Boolean(v);
    }
    // 属性条件：派生属性先算，源列属性按映射取值
    const def = cls.def.properties[key];
    if (!def) throw new Error(`过滤里的名字对不上配置：${cls.name}.${key}`);
    const actual = def.derived ? evalDerived(cls, ind, key, env, ctx) : propValue(cls, ind, key);
    return conditionHolds(actual, v, { ...ctx, current: currentView(cls, ind), currentDerived: (p) => evalDerived(cls, ind, p, env, ctx) });
  });
}

function linkCondHolds(cls: Cls, ind: Individual, linkName: string, target: unknown, env: Env, ctx: EvalContext): boolean {
  if (target === true) return env.linkHolds(cls.name, ind, linkName, undefined, ctx);
  if (target === false) return !env.linkHolds(cls.name, ind, linkName, undefined, ctx);
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

/** 个体的合并属性视图（含派生；聚合、动作效应取值用）。 */
export function currentOf(cls: Cls, ind: Individual, env: Env, ctx: EvalContext): Record<string, unknown> {
  const out = currentView(cls, ind);
  for (const [prop, def] of Object.entries(cls.def.properties)) {
    if (def.derived) out[prop] = evalDerived(cls, ind, prop, env, ctx);
  }
  return out;
}
