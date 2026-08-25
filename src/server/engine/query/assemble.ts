// 个体组装 —— 先定列，再下推，按识别字段对齐：各源分别下推，按对齐键配成同一个体，再做内存过滤核对。
// 组装求值环境（createEnv）也在这：linkHolds 要查源，经 selectIndividuals 落地；
// 求值（evaluate.ts）只面向 Env 接口，不反向依赖本模块——拆开后运行时递归还在，模块环没有了。

import type { Filter, LinkType, OntologyConfig } from "../../schema/config";
import { walkFilter } from "../../schema/spec/filterSpec";
import type { ExpandNode } from "../../schema/request";
import { EngineReject, MSG } from "../../errors";
import { dialectFor, toColumnValue, type Condition, type SourceDriver } from "../infra/driver";
import type { EvalContext } from "./expr";
import { pushCondition } from "./filterOp";
import { isOpObject } from "../../schema/spec/filterSpec";
import { resolveOperand } from "./compare";
import { evalFilterOnIndividual, transitionHolds } from "./evaluate";
import { keyColumn, mustCls, mustLink, propValue, sourcesOf, type Cls, type Env, type Individual } from "./individual";

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
        if (targetFilter !== undefined) throw new EngineReject(MSG.transitionNoTargetFilter(linkName));
        return transitionHolds(cls, ind, link, env, ctx);
      }
      const merged = matchConds(cls, ind, link, reversed, targetFilter as Filter | undefined, (k) => MSG.filterConflictsPair(linkName, k));
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
    if (!def) throw new EngineReject(MSG.propUnknown(cls.name, p));
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
    if (!def) throw new EngineReject(MSG.filterPropUnknown(cls.name, prop));
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
