// 表达式求值 —— 日期一套、数字一套，表面都跟 Elasticsearch。
// 语义见《ontos-article.md》§6.2 与附录 B「保留字」。

import type { PropertyDef, ValueSource } from "../schema/config";

/* 求值上下文：一次过滤核对或一条效应赋值能看到的全部来源。 */
export interface EvalContext {
  identity?: string | number; // 请求顶上的识别值
  action?: string; // 请求顶上的动作名
  object?: string; // 请求顶上的类名
  request?: Record<string, unknown>; // 请求参数
  current?: Record<string, unknown>; // 本条过滤或 update 正在谈的个体的源列属性值
  currentDerived?: (prop: string) => unknown | Promise<unknown>; // 点名的属性是派生属性时，按需现算（异步：可能要查源）
  nextSequence?: (key: string, start?: number) => number; // generate 的计数器
  allowPreKeys?: boolean; // true 才许用 $request / $exists（它们只属于前置，见 §5.2）
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

function evalDateExpr(expr: string, now = Math.floor(Date.now() / 1000)): number {
  if (!DATE_RE.test(expr)) throw new Error(`非法日期表达式：${expr}`);
  let t = now;
  const steps = expr.match(/[+-]\d+[yMwdhms]/g) ?? [];
  for (const s of steps) {
    const n = parseInt(s.slice(1, -1), 10) * UNIT_S[s[s.length - 1]];
    t = s[0] === "+" ? t + n : t - n;
  }
  const floor = /\/([yMwdhms])$/.exec(expr)?.[1];
  if (floor) {
    if (floor === "y" || floor === "M") throw new Error(`日期取整只支持 /w /d /h /m /s：${expr}`);
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
  if (typeof v !== "number") throw new Error(`数字表达式取不到数：${tok}`);
  return v;
}

function evalNumberExpr(expr: string, ctx: EvalContext): number {
  const m = NUM_RE.exec(expr);
  if (!m) throw new Error(`非法数字表达式：${expr}`);
  const a = numOperand(m[1], ctx);
  const b = numOperand(m[3], ctx);
  return m[2] === "+" ? a + b : a - b;
}

/** 字符串字面量里的日期：ISO 串转 UTC Unix 秒；now 系按表达式求值；形似表达式但不合语法的拒绝。
 *  「形似」收紧为 now 后紧跟运算符/数字/斜杠，或 current./request. 前缀—— nowadays 这类文本不算。 */
const EXPR_LIKE = /^(now([+\-/\d]|$)|(current|request)\.)/;

export function resolveLiteral(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const s: string = v;
  // isDateExpr 的类型谓词（v is string）会把 string 变量的假分支收成 never——Boolean() 包一层丢掉谓词
  if (Boolean(isDateExpr(s))) return evalDateExpr(s);
  if (EXPR_LIKE.test(s)) throw new Error(`非法表达式：${s}`);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    // 日期契约是 UTC：空格型（MySQL dateStrings）补 T…Z；T 型没写时区后缀的也按 UTC；自带时区的不动
    const hasZone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(s);
    const iso = s.includes("T") ? (hasZone ? s : `${s}Z`) : s.includes(" ") ? (hasZone ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`) : s;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) throw new Error(`非法日期字面量：${s}`);
    return Math.floor(ms / 1000);
  }
  return s;
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
      if (hit === undefined) throw new Error(`取不到值：${String(rec.property)}`);
      return hit;
    }
    if (from === "request") {
      const hit = ctx.request?.[propName];
      if (hit === undefined) throw new Error(`请求缺参数：${propName}`);
      return hit;
    }
    if (from === "identity") {
      if (ctx.identity === undefined) throw new Error("请求缺识别值 identity");
      return ctx.identity;
    }
    if (from === "action") return ctx.action;
    if (from === "object") return ctx.object;
    if (from === "current") {
      const hit = ctx.current?.[propName];
      if (hit === undefined) throw new Error(`取不到值：${propName}`); // 与 { property } 同口径，不静默少写列
      return hit;
    }
    if (from === "generated") {
      if (!gen) throw new Error(`该路径不支持 from: generated（属性 ${propName}：发号只在 create 投影里可用）`);
      return gen();
    }
    throw new Error(`无法识别的取值来源：${JSON.stringify(v)}`);
  }
  if (typeof v === "string") {
    if (isDateExpr(v)) return evalDateExpr(v);
    if (isNumberExpr(v)) return evalNumberExpr(v, ctx);
    if (EXPR_LIKE.test(v)) throw new Error(`非法表达式：${v}`); // 形似表达式但不合语法，拒绝而不是当字面量写库
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return resolveLiteral(v);
  }
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

function uuidV7(): string {
  const ms = Date.now(); // 48 位毫秒时间戳
  const rnd = crypto.getRandomValues(new Uint8Array(10));
  const b = [
    (ms / 2 ** 40) & 0xff, (ms / 2 ** 32) & 0xff, (ms / 2 ** 24) & 0xff,
    (ms / 2 ** 16) & 0xff, (ms / 2 ** 8) & 0xff, ms & 0xff,
    0x70 | (rnd[0] & 0x0f), rnd[1], // version 7
    0x80 | (rnd[2] & 0x3f), rnd[3], // variant 10
    rnd[4], rnd[5], rnd[6], rnd[7], rnd[8], rnd[9],
  ];
  const h = [...b].map((x) => Math.floor(x).toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

export function generateValue(cls: string, prop: string, def: PropertyDef, ctx: EvalContext): string {
  if (!def.generate) throw new Error(`${cls}.${prop} 没有 generate`);
  const parts = def.generate.map((item) => {
    if (typeof item === "string") return item;
    const rec = item as Record<string, unknown>;
    if (rec.from || rec.property) return String(resolveValue(item as ValueSource, prop, ctx)); // 整项交给 resolveValue，不拆键
    if (rec.date) return formatUtc(evalDateExpr(String(rec.date)), String(rec.format ?? "yyyyMMdd"));
    if (rec.sequence) {
      if (!ctx.nextSequence) throw new Error("没有计数器，不能发号");
      const seq = rec.sequence as { start?: number; width?: number };
      return pad(ctx.nextSequence(`${cls}.${prop}`, seq.start ?? 1), seq.width ?? 4);
    }
    if (rec.uuid === "v7") return uuidV7();
    throw new Error(`无法识别的 generate 项：${JSON.stringify(item)}`);
  });
  return parts.join("");
}
