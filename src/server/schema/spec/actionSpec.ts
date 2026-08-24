// 动作形状规约 —— 附录 B「动作」一节取值形状的单一事实源。
// 位置 → 该位置允许的取值形状：静态校验（validate）与表单白名单（actionView formCompatible）同查这份规约。
// 纯结构（是不是对象/数组/非空）仍由 schema/config.ts 的 Zod 管；本文件管语境规则与表单子集标记。

import { FROM_KEY_SET, isFromOnly, isPlainLiteral, propertyRef } from "./valueSpec";

/* ---------- 位置规则：静态校验（validate 消费） ---------- */

export interface ValuePosRule {
  /** 该位置有没有「当前个体」上下文（from: current / { property, from: current } 的闸门）。 */
  allowCurrent: boolean;
  /** from: generated：never = 一律不许；withGenerate = create 位且目标属性带 generate 列表才许。 */
  generated: "never" | "withGenerate";
}

/** 位置 → 规则。效应过滤里的操作数规则在 filterSpec（checkOperand），不在这张表。 */
export const VALUE_POSITIONS = {
  "effect.update.properties": { allowCurrent: true, generated: "never" },
  "effect.create.properties": { allowCurrent: false, generated: "withGenerate" },
  "effect.identity": { allowCurrent: false, generated: "never" },
  "inform.properties": { allowCurrent: false, generated: "never" },
} as const satisfies Record<string, ValuePosRule>;

export type ValuePosition = keyof typeof VALUE_POSITIONS;

/** 取值来源形状核对：字面量与 now 系表达式串放过（运行期 resolveValue 管）；数组拒收；
 *  { property } 组合的 from 只许 current/request；from 词表按位置规则放闸。 */
export function checkActionValue(pos: ValuePosition, v: unknown, where: string, opts?: { hasGenerate?: boolean }): void {
  if (v === null || typeof v !== "object") return; // 字面量与表达式串：运行期管，这里不管
  if (Array.isArray(v)) throw new Error(`配置不合法：${where} 的取值不接受数组`);
  const rule: ValuePosRule = VALUE_POSITIONS[pos];
  const ref = propertyRef(v);
  if (ref) {
    const from = ref.from === undefined ? "current" : ref.from; // { property } 缺省 from = current
    if (from !== "current" && from !== "request") throw new Error(`配置不合法：${where} 的取值 { property } 组合的 from 只许 current/request：${JSON.stringify(v)}`);
    if (from === "current" && !rule.allowCurrent) throw new Error(`配置不合法：${where} 没有当前个体，取值不能来自 current：${JSON.stringify(v)}`);
    return;
  }
  const rec = v as Record<string, unknown>;
  if (typeof rec.from === "string" && FROM_KEY_SET.has(rec.from)) {
    if (rec.from === "current" && !rule.allowCurrent) throw new Error(`配置不合法：${where} 没有当前个体，取值不能来自 current：${JSON.stringify(v)}`);
    if (rec.from === "generated" && !(rule.generated === "withGenerate" && opts?.hasGenerate)) {
      throw new Error(`配置不合法：${where} 的 from: generated 只许用在 create 效应且目标属性带 generate 列表：${JSON.stringify(v)}`);
    }
    return;
  }
  throw new Error(`配置不合法：${where} 的取值来源不认识：${JSON.stringify(v)}`);
}

/* ---------- 表单子集（actionView formCompatible 消费） ----------
   白名单（附录 B 子集）：无 inform；pre 只含本类非派生字段的等于/不等于字面量、或 $link 已发生/未发生；
   update/delete 只作用在宿主类、无 filter、必须 identity: { from: identity }；create 取值只许 request/identity/字面量；
   link 只许本类上的转化关系。结构条件（宿主类、无 filter、转化关系）留在 formCompatible，
   取值形状全在下表。 */

export type FormValueKind = "literal" | "from:request" | "from:identity";

/** 位置 → 表单认得的取值形状。pre 的字段条件与 $link 条目形状单列。 */
export const FORM_SUBSET = {
  "effect.update.properties": ["literal", "from:request"],
  "effect.create.properties": ["literal", "from:request", "from:identity"],
  "effect.identity": ["from:identity"],
} as const satisfies Record<string, readonly FormValueKind[]>;

export type FormValuePosition = keyof typeof FORM_SUBSET;

/** 取值归到表单三形状之一；归不进（表达式、from: generated、{ property } 组合等）返回 null。 */
export function formValueKind(v: unknown): FormValueKind | null {
  if (isPlainLiteral(v)) return "literal";
  if (isFromOnly(v, "request")) return "from:request";
  if (isFromOnly(v, "identity")) return "from:identity";
  return null;
}

/** 位置 + 取值 → 表单认不认。 */
export function inFormSubset(pos: FormValuePosition, v: unknown): boolean {
  const k = formValueKind(v);
  return k !== null && (FORM_SUBSET[pos] as readonly string[]).includes(k);
}

/** pre 的字段条件：等于字面量，或 { ne: 字面量 }。 */
export function formPreOk(v: unknown): boolean {
  if (isPlainLiteral(v)) return true;
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "ne" && isPlainLiteral((v as Record<string, unknown>).ne)) return true;
  }
  return false;
}
