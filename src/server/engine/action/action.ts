// M8 动作执行 —— 对应《ontos-article.md》§6 与图 8。
// 顺序：找动作 → 读个体 → 核前置 → 定效应 → 校公理 → 按写回逐条投影 → 留痕。
// 跨库没有分布式事务：已成功的投影不回滚，失败条目进结果；补偿是重发同一动作。

import type { ActionDef, EffectItem, OntologyConfig, ValueSource } from "../../schema/config";
import { sourceKeyProp } from "../../schema/config";
import type { ActionRequest } from "../../schema/request";
import { dialectFor, toColumnValue, type SourceDriver } from "../infra/driver";
import { assertFilterShapes } from "../query/compare";
import { createEnv, selectIndividuals } from "../query/assemble";
import { evalDerived, evalFilterOnIndividual } from "../query/evaluate";
import { currentView, keyColumn, mustCls, propValue, sourcesOf, type Cls, type Env, type Individual } from "../query/individual";
import { generateValue, resolveLiteral, resolveValue, type EvalContext } from "../query/expr";
import { enqueueKeyed, runtime } from "../../runtime";
import { buildNotifications, type NotificationRecord } from "./notify";

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

/* 发号计数器的默认实现驻内存（测试/纯引擎用）；路由层经 runAction 的 opts 注入元数据库版，重启不复位。 */
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

export async function runAction(
  config: OntologyConfig,
  driver: SourceDriver,
  req: ActionRequest,
  opts?: { nextSequence?: (key: string, start?: number) => number | Promise<number>; ws?: string } // 路由层注入元数据库发号器（异步）；缺省用内存版。ws = 串行键（哪份本体世界的动作互斥；缺省 default）
): Promise<ActionResult> {
  // 每空间一条动作串行队列（runtime.actionTails）：发号与 create 幂等都是 check-then-act，
  // 并发裸奔会发出重号、补偿重发会插重复行——串行化后这两条在队列内天然互斥
  return enqueueKeyed(runtime().actionTails ??= new Map(), opts?.ws ?? "default", () => runActionInner(config, driver, req, opts));
}

async function runActionInner(
  config: OntologyConfig,
  driver: SourceDriver,
  req: ActionRequest,
  opts?: { nextSequence?: (key: string, start?: number) => number | Promise<number> }
): Promise<ActionResult> {
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
    nextSequence: opts?.nextSequence ?? nextSequence,
    allowPreKeys: true, // 前置才许用 $request / $exists
  };

  // 第 3 步：读出目标个体（各源有没有行都算合法状态）
  const found = await selectIndividuals(env, cls.name, { identity: req.identity, allColumns: true, ctx });
  const subject = found[0] ?? emptyIndividual(cls);

  // 第 4、5 步：核前置（与过滤同一套写法，多 $request、$exists）
  if (action.pre) {
    let preOk = false;
    try {
      assertFilterShapes(action.pre, "前置");
      preOk = await evalFilterOnIndividual(cls, subject, action.pre, env, ctx);
    } catch (e) {
      return reject("pre", e instanceof Error ? e.message : String(e));
    }
    if (!preOk) return reject("pre", "前置不满足");
  }

  // 第 6 步：按效应确定存在上的变化（先解析出计划，不急着投影）
  let plan: Planned[];
  try {
    plan = [];
    for (const item of action.effect) plan.push(await planEffect(env, cls, item, subject, ctx));
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
      const recs = await project(env, p, req, ctx);
      if (recs.length === 0) {
        projections.push({ source: "-", table: "-", op, ok: false, error: "没有来源能承接这次变化（字段没映射，或源库里没这行）" });
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
    notifications = buildNotifications(config, action, plan, req, ctx, projections);
  } catch (e) {
    notifications = [{ object: "-", to: [], properties: {}, lines: [], delivered: false, note: `变更事件生成失败：${err(e)}` }];
  }
  return { ok, stage: ok ? undefined : "project", projections, ...(notifications.length ? { notifications } : {}) };
}

/* ---------- 效应计划 ---------- */

/** 效应计划：先解析出计划再投影（notify.ts 的变更事件生成也消费它）。 */
export type Planned =
  | { kind: "update"; cls: Cls; targets: Individual[]; setSpec: Record<string, ValueSource> }
  | { kind: "create"; cls: Cls; propSpec: Record<string, ValueSource> }
  | { kind: "delete"; cls: Cls; targets: Individual[] }
  | { kind: "link"; linkName: string; subject: Individual };

async function planEffect(env: Env, reqCls: Cls, item: EffectItem, subject: Individual, ctx: EvalContext): Promise<Planned> {
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
    else targets = await selectIndividuals(env, cls.name, { identity: id, allColumns: true, ctx: filterCtx });
  } else if (op.filter) {
    assertFilterShapes(op.filter, "效应过滤");
    targets = await selectIndividuals(env, cls.name, { filter: op.filter, allColumns: true, ctx: filterCtx });
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

/* ---------- 写回：表在哪、插还是改，按效应和 sources 推出 ----------
   project 只做分派；四种写回各一个函数。两层分清：「哪些源能承接这次变化」（承接规则）
   与「这一行怎么插/改、方言怎么归一」（单源写入细节）——后者收在各函数内部的小函数里。 */

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

type SourceEntry = NonNullable<OntologyConfig["object_types"][string]["sources"]>[string];

async function project(env: Env, p: Planned, req: ActionRequest, ctx: EvalContext): Promise<ProjectionRecord[]> {
  if (p.kind === "update") return projectUpdate(env, p, ctx);
  if (p.kind === "create") return projectCreate(env, p, ctx);
  if (p.kind === "link") return projectLink(env, p, req);
  return projectDelete(env, p);
}

/** 源能不能承接这次 update：第 3 步在该源读到了行，且所改属性全部映射了列。 */
function carriesUpdate(row: Record<string, unknown> | null, entry: SourceEntry, changed: string[]): boolean {
  return row != null && changed.every((prop) => entry.fields[prop]);
}

async function projectUpdate(env: Env, p: Extract<Planned, { kind: "update" }>, ctx: EvalContext): Promise<ProjectionRecord[]> {
  const out: ProjectionRecord[] = [];
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
      if (!carriesUpdate(row, entry, changed)) continue; // 没行 / 没映射全：这源不承接
      handled++; // 有源承接才计数；尝试后失败按各源条目记
      out.push(await updateOneSource(env, p, srcName, entry, row!, setVals, changed));
    }
    if (handled === 0) {
      out.push({ source: "-", table: "-", op: "update", ok: false, error: `个体 ${target.key} 没有来源能承接这次变化（字段没映射，或源库里没这行）` });
    }
  }
  return out;
}

/** 条件更新一个源：识别列 = 读到的键，且要改的列仍等于读到的值。0 行不等于失败——见 rereadMatchesTarget。 */
async function updateOneSource(
  env: Env,
  p: Extract<Planned, { kind: "update" }>,
  srcName: string,
  entry: SourceEntry,
  row: Record<string, unknown>,
  setVals: Record<string, unknown>,
  changed: string[]
): Promise<ProjectionRecord> {
  const driver = env.driver;
  try {
    const dialect = dialectFor(driver, entry.connection);
    const set: Record<string, unknown> = {};
    for (const prop of changed) set[entry.fields[prop]] = toColumnValue(setVals[prop], p.cls.def.properties[prop]?.type, dialect);
    const keyCol = keyColumn(p.cls, entry);
    const conds = [
      { column: keyCol, op: "eq" as const, value: row[keyCol] },
      ...changed.map((prop) => ({ column: entry.fields[prop], op: "eq" as const, value: row[entry.fields[prop]] ?? null })),
    ];
    const n = await driver.update(entry.connection, entry.table, set, conds);
    if (n > 0) return { source: srcName, table: entry.table, op: "update", ok: true };
    const already = await rereadMatchesTarget(env, entry, keyCol, row[keyCol], changed, set);
    return already
      ? { source: srcName, table: entry.table, op: "update", ok: true, note: "已是目标值，没重复写" }
      : { source: srcName, table: entry.table, op: "update", ok: false, error: "条件更新未命中（行可能已被并发改动）" };
  } catch (e) {
    return { source: srcName, table: entry.table, op: "update", ok: false, error: err(e) };
  }
}

/** MySQL 同值不改记 0 行：按键重读核对，与写入的列值比对，已是目标值算幂等命中。
 *  读回与写入的形态可能不同（如 MySQL DATE 列读出日期串、写入带时分秒）：过同一道字面量归一再比。 */
async function rereadMatchesTarget(
  env: Env,
  entry: SourceEntry,
  keyCol: string,
  keyVal: unknown,
  changed: string[],
  set: Record<string, unknown>
): Promise<boolean> {
  const reread = await env.driver.select(entry.connection, entry.table, [keyCol, ...changed.map((prop) => entry.fields[prop])], [{ column: keyCol, op: "eq", value: keyVal }]);
  const cur = reread[0];
  if (cur == null) return false;
  const norm = (x: unknown) => {
    try {
      return resolveLiteral(x);
    } catch {
      return x;
    }
  };
  return changed.every((prop) => {
    const col = entry.fields[prop];
    return norm(cur[col]) === norm(set[col]) || (cur[col] ?? null) === (set[col] ?? null);
  });
}

async function projectCreate(env: Env, p: Extract<Planned, { kind: "create" }>, ctx: EvalContext): Promise<ProjectionRecord[]> {
  const driver = env.driver;
  const out: ProjectionRecord[] = [];
  const vals: Record<string, unknown> = {};
  for (const [prop, spec] of Object.entries(p.propSpec)) {
    // generateValue 现在异步（发号器落库）：Promise.resolve 统一解包，非 generated 的取值不受影响
    vals[prop] = await Promise.resolve(resolveValue(spec, prop, ctx, () => generateValue(p.cls.name, prop, p.cls.def.properties[prop], ctx)));
  }
  // 承接规则：源映射了全部所赋属性
  const targets = sourcesOf(p.cls).filter(([, entry]) => Object.keys(p.propSpec).every((prop) => entry.fields[prop]));
  if (targets.length === 0) throw new Error(`没有源能承接 ${p.cls.name} 的全部所赋属性`);
  for (const [srcName, entry] of targets) {
    try {
      if (await alreadyInserted(env, p, entry, vals)) {
        out.push({ source: srcName, table: entry.table, op: "insert", ok: true, note: "已有这行，没重复插" });
        continue;
      }
      const row: Record<string, unknown> = {};
      const dialect = dialectFor(driver, entry.connection);
      for (const [prop, col] of Object.entries(entry.fields)) {
        if (vals[prop] !== undefined) row[col] = toColumnValue(vals[prop], p.cls.def.properties[prop]?.type, dialect);
      }
      await driver.insert(entry.connection, entry.table, row); // 未映射的 pk 由源库自生
      out.push({ source: srcName, table: entry.table, op: "insert", ok: true });
    } catch (e) {
      out.push({ source: srcName, table: entry.table, op: "insert", ok: false, error: err(e) });
    }
  }
  return out;
}

/** create 幂等：对齐属性（sourceKeyProp，schema/config 单源）的值已有行就跳过——补偿重发不会重复插（§6.3）。 */
async function alreadyInserted(env: Env, p: Extract<Planned, { kind: "create" }>, entry: SourceEntry, vals: Record<string, unknown>): Promise<boolean> {
  const keyProp = sourceKeyProp(p.cls.def, entry);
  const idVal = keyProp ? vals[keyProp] : undefined;
  if (!keyProp || idVal === undefined || !entry.fields[keyProp]) return false;
  const keyCol = keyColumn(p.cls, entry);
  const dup = await env.driver.select(entry.connection, entry.table, [keyCol], [{ column: keyCol, op: "eq", value: idVal }]);
  return dup.length > 0;
}

async function projectLink(env: Env, p: Extract<Planned, { kind: "link" }>, req: ActionRequest): Promise<ProjectionRecord[]> {
  const driver = env.driver;
  const out: ProjectionRecord[] = [];
  // 转化：插入该类里第 3 步没有行、又映射了识别字段的源；值取读到的个体属性，写回不再查一遍
  const cls = mustCls(env.config, req.object);
  const subject = p.subject;
  for (const [srcName, entry] of sourcesOf(cls)) {
    if (subject.rows[srcName] != null) continue; // 已有行的源不动
    const idProp = cls.def.identity;
    if (!idProp || !entry.fields[idProp]) continue;
    try {
      const row: Record<string, unknown> = {};
      const dialect = dialectFor(driver, entry.connection);
      for (const [prop, col] of Object.entries(entry.fields)) {
        const v = prop === idProp ? req.identity : propValue(cls, subject, prop);
        if (v !== undefined && v !== null) row[col] = toColumnValue(v, cls.def.properties[prop]?.type, dialect);
      }
      await driver.insert(entry.connection, entry.table, row);
      out.push({ source: srcName, table: entry.table, op: "insert", ok: true });
    } catch (e) {
      out.push({ source: srcName, table: entry.table, op: "insert", ok: false, error: err(e) });
    }
  }
  return out;
}

/** delete：删掉第 3 步读到行的那些源上的行。 */
async function projectDelete(env: Env, p: Extract<Planned, { kind: "delete" }>): Promise<ProjectionRecord[]> {
  const driver = env.driver;
  const out: ProjectionRecord[] = [];
  for (const target of p.targets) {
    for (const [srcName, entry] of sourcesOf(p.cls)) {
      if (!target.rows[srcName]) continue;
      try {
        const keyCol = keyColumn(p.cls, entry);
        await driver.delete(entry.connection, entry.table, [{ column: keyCol, op: "eq", value: target.rows[srcName]![keyCol] }]);
        out.push({ source: srcName, table: entry.table, op: "delete", ok: true });
      } catch (e) {
        out.push({ source: srcName, table: entry.table, op: "delete", ok: false, error: err(e) });
      }
    }
  }
  return out;
}
