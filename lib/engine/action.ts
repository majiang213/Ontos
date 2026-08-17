// M8 动作执行 —— 对应《ontos-article.md》§6 与图 8。
// 顺序：找动作 → 读个体 → 核前置 → 定效应 → 校公理 → 按写回逐条投影 → 留痕。
// 跨库没有分布式事务：已成功的投影不回滚，失败条目进结果；补偿是重发同一动作。

import type { ActionDef, EffectItem, OntologyConfig, ValueSource } from "../schema/config";
import type { ActionRequest } from "../schema/request";
import type { SourceDriver } from "./driver";
import {
  currentView,
  evalDerived,
  evalFilterOnIndividual,
  keyColumn,
  mustCls,
  propValue,
  sourcesOf,
  type Cls,
  type Env,
  type Individual,
} from "./individual";
import { generateValue, resolveValue, type EvalContext } from "./expr";
import { createEnv, selectIndividuals } from "./query";

export interface ProjectionRecord {
  source: string;
  table: string;
  op: "insert" | "update" | "delete";
  ok: boolean;
  error?: string;
  note?: string;
}

export interface ActionResult {
  ok: boolean;
  stage?: "pre" | "effect" | "axiom" | "project";
  error?: string;
  projections: ProjectionRecord[];
  notifications?: NotificationRecord[];
}

/** 告知（inform）本期预留：引擎生成变更事件但不外发，随结果返回，不静默丢弃。 */
export interface NotificationRecord {
  object: string;
  to: string[];
  properties: Record<string, unknown>;
  lines: { op: string; object: string; targets: string[] }[];
  delivered: false;
  note: string;
}

/* 每个进程一份的发号计数器（generate 的 sequence）。演示期驻内存，入元数据库是后续。 */
const sequenceCounters = new Map<string, number>();
function nextSequence(key: string, start = 1): number {
  const n = Math.max(sequenceCounters.get(key) ?? 0, start - 1) + 1;
  sequenceCounters.set(key, n);
  return n;
}

function emptyIndividual(cls: Cls): Individual {
  return { key: "", rows: Object.fromEntries(sourcesOf(cls).map(([s]) => [s, null])) };
}

const reject = (stage: ActionResult["stage"], error: string): ActionResult => ({ ok: false, stage, error, projections: [] });

export function runAction(config: OntologyConfig, driver: SourceDriver, req: ActionRequest): ActionResult {
  if (!config.object_types[req.object]) return reject("pre", `配置中没有类：${req.object}`);
  const cls = mustCls(config, req.object);
  const action: ActionDef | undefined = cls.def.actions?.[req.action];
  if (!action) return reject("pre", `${req.object} 上没有动作：${req.action}`);

  const env = createEnv(config, driver);
  const ctx: EvalContext = {
    identity: req.identity,
    action: req.action,
    object: req.object,
    request: req.request ?? {},
    nextSequence,
    allowPreKeys: true, // 前置才许用 $request / $exists
  };

  // 第 3 步：读出目标个体（各源有没有行都算合法状态）
  const found = selectIndividuals(env, cls.name, { identity: req.identity, allColumns: true, ctx });
  const subject = found[0] ?? emptyIndividual(cls);

  // 第 4、5 步：核前置（与过滤同一套写法，多 $request、$exists）
  if (action.pre) {
    let preOk = false;
    try {
      preOk = evalFilterOnIndividual(cls, subject, action.pre, env, ctx);
    } catch (e) {
      return reject("pre", e instanceof Error ? e.message : String(e));
    }
    if (!preOk) return reject("pre", "前置不满足");
  }

  // 第 6 步：按效应确定存在上的变化（先解析出计划，不急着投影）
  let plan: Planned[];
  try {
    plan = action.effect.map((item) => planEffect(env, cls, item, subject, ctx));
  } catch (e) {
    return reject("effect", e instanceof Error ? e.message : String(e));
  }

  // 第 7 步：公理校验。mutex：同一次动作里同一个体同一属性不得被赋两个不同的值（比的是求值后的结果）
  for (const [axiomName, axiom] of Object.entries(cls.def.axioms ?? {})) {
    if (axiom.type !== "mutex") continue;
    const seen = new Map<string, unknown>();
    for (const p of plan) {
      if (p.kind !== "update" || p.cls.name !== cls.name) continue;
      if (!(axiom.property in p.setSpec)) continue;
      for (const target of p.targets) {
        let v: unknown;
        try {
          v = resolveValue(p.setSpec[axiom.property], axiom.property, { ...ctx, current: currentView(p.cls, target) });
        } catch (e) {
          return reject("axiom", err(e));
        }
        if (seen.has(target.key) && seen.get(target.key) !== v) {
          return reject("axiom", `违反公理 ${axiomName}：${axiom.property} 被赋两个值`);
        }
        seen.set(target.key, v);
      }
    }
  }

  // 第 8 步：按写回逐条投影。部分失败不回滚，逐条记录。
  const projections: ProjectionRecord[] = [];
  for (const p of plan) {
    const op = p.kind === "update" ? "update" : p.kind === "delete" ? "delete" : "insert";
    try {
      const recs = project(env, p, req, ctx);
      if (recs.length === 0) {
        projections.push({ source: "-", table: "-", op, ok: false, error: "没有源承接这次变化（属性未映射或第 3 步无行）" });
      } else {
        projections.push(...recs);
      }
    } catch (e) {
      projections.push({ source: "-", table: "-", op, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const ok = projections.every((r) => r.ok);

  // 第 10 步：告知本期预留——生成变更事件随结果返回，不外发
  let notifications: NotificationRecord[] = [];
  try {
    notifications = buildNotifications(action, plan, req, ctx, projections);
  } catch (e) {
    notifications = [{ object: "-", to: [], properties: {}, lines: [], delivered: false, note: `变更事件生成失败：${err(e)}` }];
  }
  return { ok, stage: ok ? undefined : "project", projections, ...(notifications.length ? { notifications } : {}) };
}

/** 变更事件按效应列表逐项生成条目。create 的 target 取解析出的识别值（from: generated 的不重复发号）。 */
function buildNotifications(
  action: ActionDef,
  plan: Planned[],
  req: ActionRequest,
  ctx: EvalContext,
  projections: ProjectionRecord[]
): NotificationRecord[] {
  const anyFail = projections.some((r) => !r.ok);
  return (action.inform ?? []).map((inf) => {
    const properties = Object.fromEntries(Object.entries(inf.properties).map(([prop, spec]) => [prop, resolveValue(spec, prop, ctx)]));
    // change_id 由 action + subject + occurred_at 合成（§6.5）
    if (properties.action != null && properties.subject != null && properties.occurred_at != null) {
      properties.change_id = `${properties.action}|${properties.subject}|${properties.occurred_at}`;
    }
    return {
      object: inf.object,
      to: inf.to,
      properties,
    lines: plan.map((p) => {
      if (p.kind === "create") {
        const idProp = p.cls.def.identity;
        const spec = idProp ? p.propSpec[idProp] : undefined;
        const resolvable = spec !== undefined && !(typeof spec === "object" && spec !== null && (spec as Record<string, unknown>).from === "generated");
        const v = resolvable ? resolveValue(spec, idProp!, ctx) : null;
        return { op: p.kind, object: p.cls.name, targets: v == null ? [] : [String(v)] };
      }
      return {
        op: p.kind,
        object: p.kind === "link" ? req.object : p.cls.name,
        targets: p.kind === "link" ? [String(req.identity)] : p.targets.map((t) => t.key),
      };
    }),
    delivered: false,
    note: anyFail
      ? "告知本期预留，引擎不执行外发；有投影失败，事件按计划生成，与实际存在可能有差（§6.5）"
      : "告知本期预留，引擎不执行外发（机制见《ontos-article.md》§6.5）",
    };
  });
}

/* ---------- 效应计划 ---------- */

type Planned =
  | { kind: "update"; cls: Cls; targets: Individual[]; setSpec: Record<string, ValueSource> }
  | { kind: "create"; cls: Cls; propSpec: Record<string, ValueSource> }
  | { kind: "delete"; cls: Cls; targets: Individual[] }
  | { kind: "link"; linkName: string; subject: Individual };

function planEffect(env: Env, reqCls: Cls, item: EffectItem, subject: Individual, ctx: EvalContext): Planned {
  if ("link" in item) {
    const link = env.config.link_types[item.link];
    if (!link?.transition) throw new Error(`link 只用于转化关系：${item.link}`);
    if (link.from !== reqCls.name || link.to !== reqCls.name) throw new Error(`转化关系 ${item.link} 不在 ${reqCls.name} 上`);
    return { kind: "link", linkName: item.link, subject };
  }
  if ("create" in item) {
    const cls = mustCls(env.config, item.create.object);
    for (const prop of Object.keys(item.create.properties)) rejectIfDerived(cls, prop);
    return { kind: "create", cls, propSpec: item.create.properties };
  }
  const op = "update" in item ? item.update : item.delete;
  const cls = mustCls(env.config, op.object);
  // 效应里的过滤按普通过滤求值：$request / $exists 是前置专有的键，这里不继承
  const filterCtx: EvalContext = { ...ctx, allowPreKeys: false };
  let targets: Individual[];
  if (op.identity !== undefined) {
    const id = resolveValue(op.identity, cls.def.identity ?? "identity", ctx);
    if (op.object === reqCls.name && id === ctx.identity) targets = [subject];
    else targets = selectIndividuals(env, cls.name, { identity: id, allColumns: true, ctx: filterCtx });
  } else if (op.filter) {
    targets = selectIndividuals(env, cls.name, { filter: op.filter, allColumns: true, ctx: filterCtx });
  } else {
    throw new Error(`认人必须写明：${op.object} 缺 identity 或 filter`);
  }
  if (targets.length === 0) throw new Error(`效应找不到对象：${op.object}`);
  if ("update" in item) {
    for (const prop of Object.keys(item.update.properties)) rejectIfDerived(cls, prop);
    return { kind: "update", cls, targets, setSpec: item.update.properties };
  }
  return { kind: "delete", cls, targets };
}

function rejectIfDerived(cls: Cls, prop: string) {
  const def = cls.def.properties[prop];
  if (!def) throw new Error(`效应里的名字对不上配置：${cls.name}.${prop}`);
  if (def.derived) throw new Error(`派生属性不能写入：${cls.name}.${prop}`);
}

/* ---------- 写回：表在哪、插还是改，按效应和 sources 推出 ---------- */

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

function project(env: Env, p: Planned, req: ActionRequest, ctx: EvalContext): ProjectionRecord[] {
  const driver = env.driver;
  const out: ProjectionRecord[] = [];

  if (p.kind === "update") {
    const changed = Object.keys(p.setSpec);
    for (const target of p.targets) {
      let setVals: Record<string, unknown>;
      try {
        const evalCtx: EvalContext = {
          ...ctx,
          current: currentView(p.cls, target),
          currentDerived: (prop) => evalDerived(p.cls, target, prop, env, ctx),
        };
        setVals = Object.fromEntries(
          Object.entries(p.setSpec).map(([prop, spec]) => [prop, resolveValue(spec, prop, evalCtx)])
        );
      } catch (e) {
        out.push({ source: "-", table: "-", op: "update", ok: false, error: `个体 ${target.key} 取值失败：${err(e)}` });
        continue;
      }
      let handled = 0;
      for (const [srcName, entry] of sourcesOf(p.cls)) {
        const row = target.rows[srcName];
        if (!row) continue; // 第 3 步该源没行，不改
        if (!changed.every((prop) => entry.fields[prop])) continue; // 只改映射了全部所改属性的源
        handled++; // 有源承接才计数；尝试后失败按各源条目记
        try {
          const set: Record<string, unknown> = {};
          for (const prop of changed) set[entry.fields[prop]] = setVals[prop];
          // 条件更新：识别列 = 读到的键，且要改的列仍等于读到的值
          const keyCol = keyColumn(p.cls, entry);
          const conds = [
            { column: keyCol, op: "eq" as const, value: row[keyCol] },
            ...changed.map((prop) => ({ column: entry.fields[prop], op: "eq" as const, value: row[entry.fields[prop]] ?? null })),
          ];
          const n = driver.update(entry.connection, entry.table, set, conds);
          out.push(
            n > 0
              ? { source: srcName, table: entry.table, op: "update", ok: true }
              : { source: srcName, table: entry.table, op: "update", ok: false, error: "条件更新未命中（行可能已被并发改动）" }
          );
        } catch (e) {
          out.push({ source: srcName, table: entry.table, op: "update", ok: false, error: err(e) });
        }
      }
      if (handled === 0) {
        out.push({ source: "-", table: "-", op: "update", ok: false, error: `个体 ${target.key} 没有源承接这次变化（属性未映射或第 3 步无行）` });
      }
    }
    return out;
  }

  if (p.kind === "create") {
    const vals: Record<string, unknown> = {};
    for (const [prop, spec] of Object.entries(p.propSpec)) {
      vals[prop] = resolveValue(spec, prop, ctx, () => generateValue(p.cls.name, prop, p.cls.def.properties[prop], ctx));
    }
    const targets = sourcesOf(p.cls).filter(([, entry]) => Object.keys(p.propSpec).every((prop) => entry.fields[prop]));
    if (targets.length === 0) throw new Error(`没有源能承接 ${p.cls.name} 的全部所赋属性`);
    for (const [srcName, entry] of targets) {
      try {
        // 幂等：对齐属性（源条目的 key，省略则是类的 identity）的值已有行就跳过——补偿重发不会重复插（§6.3）
        const keyProp = entry.key ?? p.cls.def.identity;
        const idVal = keyProp ? vals[keyProp] : undefined;
        if (keyProp && idVal !== undefined && entry.fields[keyProp]) {
          const keyCol = keyColumn(p.cls, entry);
          const dup = driver.select(entry.connection, entry.table, [keyCol], [{ column: keyCol, op: "eq", value: idVal }]);
          if (dup.length > 0) {
            out.push({ source: srcName, table: entry.table, op: "insert", ok: true, note: "已有行，跳过（幂等）" });
            continue;
          }
        }
        const row: Record<string, unknown> = {};
        for (const [prop, col] of Object.entries(entry.fields)) if (vals[prop] !== undefined) row[col] = vals[prop];
        driver.insert(entry.connection, entry.table, row); // 未映射的 pk 由源库自生
        out.push({ source: srcName, table: entry.table, op: "insert", ok: true });
      } catch (e) {
        out.push({ source: srcName, table: entry.table, op: "insert", ok: false, error: err(e) });
      }
    }
    return out;
  }

  if (p.kind === "link") {
    // 转化：插入该类里第 3 步没有行、又映射了识别字段的源；值取读到的个体属性，写回不再查一遍
    const cls = mustCls(env.config, req.object);
    const subject = p.subject;
    for (const [srcName, entry] of sourcesOf(cls)) {
      if (subject.rows[srcName] != null) continue; // 已有行的源不动
      const idProp = cls.def.identity;
      if (!idProp || !entry.fields[idProp]) continue;
      try {
        const row: Record<string, unknown> = {};
        for (const [prop, col] of Object.entries(entry.fields)) {
          const v = prop === idProp ? req.identity : propValue(cls, subject, prop);
          if (v !== undefined && v !== null) row[col] = v;
        }
        driver.insert(entry.connection, entry.table, row);
        out.push({ source: srcName, table: entry.table, op: "insert", ok: true });
      } catch (e) {
        out.push({ source: srcName, table: entry.table, op: "insert", ok: false, error: err(e) });
      }
    }
    return out;
  }

  // delete：删掉第 3 步读到行的那些源上的行
  for (const target of p.targets) {
    for (const [srcName, entry] of sourcesOf(p.cls)) {
      if (!target.rows[srcName]) continue;
      try {
        const keyCol = keyColumn(p.cls, entry);
        driver.delete(entry.connection, entry.table, [{ column: keyCol, op: "eq", value: target.rows[srcName]![keyCol] }]);
        out.push({ source: srcName, table: entry.table, op: "delete", ok: true });
      } catch (e) {
        out.push({ source: srcName, table: entry.table, op: "delete", ok: false, error: err(e) });
      }
    }
  }
  return out;
}
