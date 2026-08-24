// 个体求值 —— when 规则、派生属性、整条过滤在个体上的核对（前置、布尔派生、残余过滤共用）。
// 派生求值与过滤核对互相递归（派生的 when 是过滤，过滤会点到派生属性），语义上是一体，收在同一模块；
// 递归经 Env 接口的 linkHolds 缝走，不反向依赖组装。

import type { Filter, LinkType, WhenRule } from "../../schema/config";
import { EngineReject } from "../../errors";
import type { EvalContext } from "./expr";
import { conditionHolds } from "./compare";
import { currentView, propValue, propValueFrom, type Cls, type Env, type Individual } from "./individual";

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

/* ---------- 整条过滤在个体上的核对 ---------- */

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
