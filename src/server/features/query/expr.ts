// 表达式求值 —— 日期一套、数字一套，表面都跟 Elasticsearch。
// 语义见《ontos-article.md》§6.2 与附录 B「保留字」。

import type { PropertyDef, ValueSource } from "../../schema/config";
import { EXPR_LIKE } from "../../schema/spec/valueSpec";
import { MSG } from "../../errors";

/* 求值上下文：一次过滤核对或一条效应赋值能看到的全部来源。 */
export interface EvalContext {
  identity?: string | number; // 请求顶上的识别值
  action?: string; // 请求顶上的动作名
  object?: string; // 请求顶上的类名
  request?: Record<string, unknown>; // 请求参数
  current?: Record<string, unknown>; // 本条过滤或 update 正在谈的个体的源列属性值
  currentDerived?: (prop: string) => unknown | Promise<unknown>; // 点名的属性是派生属性时，按需现算（异步：可能要查源）
  allowPreKeys?: boolean; // true 才许用 $request / $exists（它们只属于前置，见 §5.2）
  clock?: () => number; // 此刻（UTC Unix 秒）：日期表达式的唯一时间源，由边界注入（引擎不读系统时钟）
  uuid?: () => string; // uuid v7：generate 的 { uuid: v7 } 唯一随机源，由边界注入（引擎不碰 crypto）
  snowflake?: () => string; // 雪花号：generate 的 { snowflake: true } 唯一发号源，由边界注入（无共享计数器）
}

/* ---------- 日期表达式 ----------
   锚点只有 now（此刻，UTC Unix 秒）；+1d/-1d 是步进；/d /h 是向下取整。
   单位：y M w d h m s。没有单独的 today。 */
const UNIT_S: Record<string, number> = {
  y: 365 * 86400, M: 30 * 86400, w: 7 * 86400, d: 86400, h: 3600, m: 60, s: 1,
};
const DATE_RE = /^now(?:[+-]\d+[yMwdhms])*(?:\/[yMwdhms])?$/;

function isDateExpr(v: unknown): v is string {
  return typeof v === "string" && DATE_RE.test(v);
}

function evalDateExpr(expr: string, now: number): number {
  if (!DATE_RE.test(expr)) throw new Error(MSG.dateExprBad(expr));
  let t = now;
  const steps = expr.match(/[+-]\d+[yMwdhms]/g) ?? [];
  for (const s of steps) {
    const n = parseInt(s.slice(1, -1), 10) * UNIT_S[s[s.length - 1]];
    t = s[0] === "+" ? t + n : t - n;
  }
  const floor = /\/([yMwdhms])$/.exec(expr)?.[1];
  if (floor) {
    if (floor === "y" || floor === "M") throw new Error(MSG.dateFloorBad(expr));
    t = Math.floor(t / UNIT_S[floor]) * UNIT_S[floor];
  }
  return t;
}

/* ---------- 数字表达式 ----------
   同样写 + -，但没有单位、不能取整。锚点是 current.属性名、request.参数名或数字字面量。 */
const NUM_RE = /^((?:current|request)\.[A-Za-z_]\w*|\d+(?:\.\d+)?)([+-])((?:current|request)\.[A-Za-z_]\w*|\d+(?:\.\d+)?)$/;

function isNumberExpr(v: unknown): v is string {
  return typeof v === "string" && NUM_RE.test(v);
}

function numOperand(tok: string, ctx: EvalContext): number {
  if (/^\d/.test(tok)) return parseFloat(tok);
  const dot = tok.indexOf(".");
  const scope = tok.slice(0, dot);
  const prop = tok.slice(dot + 1);
  const bag = scope === "current" ? ctx.current : ctx.request;
  const v = bag?.[prop];
  if (typeof v !== "number") throw new Error(MSG.numExprNoValue(tok));
  return v;
}

function evalNumberExpr(expr: string, ctx: EvalContext): number {
  const m = NUM_RE.exec(expr);
  if (!m) throw new Error(MSG.numExprBad(expr));
  const a = numOperand(m[1], ctx);
  const b = numOperand(m[3], ctx);
  return m[2] === "+" ? a + b : a - b;
}

/** ISO 日期串 → UTC Unix 秒：空格型（MySQL dateStrings）补 T…Z；T 型没写时区后缀的也按 UTC；自带时区的不动。 */
function isoToSeconds(s: string): number {
  const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s);
  const iso = s.includes("T") ? (hasZone ? s : `${s}Z`) : s.includes(" ") ? (hasZone ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`) : s;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(MSG.dateLiteralBad(s));
  return Math.floor(ms / 1000);
}

/** 日期表达式求值需要时钟：没有注入就拒绝（缺时钟是运行环境问题，不当字面量写库）。 */
function requireClock(ctx: EvalContext | undefined): number {
  const clock = ctx?.clock;
  if (!clock) throw new Error(MSG.noClock);
  return clock();
}

/** 一个字符串字面量是什么意思（单源）：日期表达式按 now 求值；数字表达式（仅 allowNumber 侧）按 ctx 求值；
 *  形似表达式但不合语法的拒绝（不当字面量写库）；ISO 日期串落 UTC 秒；其余原样。
 *  「形似」正则 EXPR_LIKE 收在 schema/spec/valueSpec（取值来源词表的唯一事实源）。
 *  过滤侧（resolveLiteral）与效应侧（resolveValue 字符串支路）同调这一份——差别只在数字表达式开不开。 */
function resolveStringLiteral(s: string, ctx: EvalContext | undefined, allowNumber: boolean): unknown {
  if (isDateExpr(s)) return evalDateExpr(s, requireClock(ctx));
  if (allowNumber && isNumberExpr(s)) return evalNumberExpr(s, ctx!);
  if (EXPR_LIKE.test(s)) throw new Error(MSG.exprBad(s));
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return isoToSeconds(s);
  return s;
}

/** 过滤侧的字面量解析：不开数字表达式（"1+2" 在过滤里就是字符串 "1+2"，在效应里才会求成 3）。
 *  ctx 带上时钟：过滤值里的日期表达式（now-30d 等）按注入时钟求值。 */
export function resolveLiteral(v: unknown, ctx?: EvalContext): unknown {
  if (typeof v !== "string") return v;
  return resolveStringLiteral(v, ctx, false);
}

/* ---------- 属性值来源 ----------
   { from: request } 同名参数；{ property: 名, from: current|request } 点名的属性；
   { from: identity|action|object } 请求顶上的值；{ from: generated } 按 generate 发号；
   字符串按日期/数字表达式求值；其余字面量原样。 */
export function resolveValue(v: ValueSource, propName: string, ctx: EvalContext, gen?: () => unknown): unknown {
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    const from = rec.from;
    if (typeof rec.property === "string") {
      const bag = from === "request" ? ctx.request : ctx.current;
      const hit = bag?.[rec.property as string];
      if (hit === undefined) throw new Error(MSG.valueMissing(String(rec.property)));
      return hit;
    }
    if (from === "request") {
      const hit = ctx.request?.[propName];
      if (hit === undefined) throw new Error(MSG.requestParamMissing(propName));
      return hit;
    }
    if (from === "identity") {
      if (ctx.identity === undefined) throw new Error(MSG.identityMissing);
      return ctx.identity;
    }
    if (from === "action") return ctx.action;
    if (from === "object") return ctx.object;
    if (from === "current") {
      const hit = ctx.current?.[propName];
      if (hit === undefined) throw new Error(MSG.valueMissing(propName)); // 与 { property } 同口径，不静默少写列
      return hit;
    }
    if (from === "generated") {
      if (!gen) throw new Error(MSG.generatedUnsupported(propName));
      return gen();
    }
    throw new Error(MSG.valueSourceUnknown(JSON.stringify(v)));
  }
  if (typeof v === "string") return resolveStringLiteral(v, ctx, true); // 效应侧：开数字表达式
  return v;
}

/* ---------- generate：按列表拼编号 ---------- */
const pad = (n: number, w: number) => String(n).padStart(w, "0");

function formatUtc(seconds: number, format: string): string {
  const d = new Date(seconds * 1000);
  return format
    .replace("yyyy", String(d.getUTCFullYear()))
    .replace("MM", pad(d.getUTCMonth() + 1, 2))
    .replace("dd", pad(d.getUTCDate(), 2))
    .replace("HH", pad(d.getUTCHours(), 2))
    .replace("mm", pad(d.getUTCMinutes(), 2))
    .replace("ss", pad(d.getUTCSeconds(), 2));
}

export async function generateValue(cls: string, prop: string, def: PropertyDef, ctx: EvalContext): Promise<string> {
  if (!def.generate) throw new Error(MSG.noGenerate(cls, prop));
  const parts: string[] = [];
  for (const item of def.generate) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (rec.from || rec.property) {
      parts.push(String(resolveValue(item as ValueSource, prop, ctx))); // 整项交给 resolveValue，不拆键
      continue;
    }
    if (rec.date) {
      parts.push(formatUtc(evalDateExpr(String(rec.date), requireClock(ctx)), String(rec.format ?? "yyyyMMdd")));
      continue;
    }
    if (rec.snowflake === true) {
      if (!ctx.snowflake) throw new Error(MSG.noSnowflake);
      parts.push(ctx.snowflake());
      continue;
    }
    if (rec.uuid === "v7") {
      if (!ctx.uuid) throw new Error(MSG.noUuid);
      parts.push(ctx.uuid());
      continue;
    }
    throw new Error(MSG.generateItemUnknown(JSON.stringify(item)));
  }
  return parts.join("");
}
