// 取值来源的形状原语 —— 附录 B「{ from: X }」词表的唯一事实源。
// 三档宽严不同的消费方共用这里的原语：运行期求值（expr.ts resolveValue）、
// 草稿静态校验（validate 经 actionSpec.checkActionValue）、画布表单白名单（actionView.ts formCompatible）。

/** from 的合法取值全集。 */
export const FROM_KEYS = ["identity", "action", "object", "current", "request", "generated"] as const;
export type FromKey = (typeof FROM_KEYS)[number];
export const FROM_KEY_SET: ReadonlySet<string> = new Set(FROM_KEYS);

/** 形似表达式：now 后紧跟运算符/数字/斜杠，或 current./request. 前缀——nowadays 这类文本不算。 */
export const EXPR_LIKE = /^(now([+\-/\d]|$)|(current|request)\.)/;

/** 恰为 { from: <key> } 的单键对象。 */
export function isFromOnly(v: unknown, key: FromKey): boolean {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  return keys.length === 1 && (v as Record<string, unknown>).from === key;
}

/** { property: 名, from? } 组合：是则返回拆解，不是返回 null。 */
export function propertyRef(v: unknown): { property: string; from?: unknown } | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  return typeof rec.property === "string" ? { property: rec.property, from: rec.from } : null;
}

/** 普通字面量：非对象；字符串不得形似表达式（now 系与 current./request. 前缀都不是字面量）。 */
export function isPlainLiteral(v: unknown): boolean {
  if (v === null || typeof v === "number" || typeof v === "boolean") return true;
  return typeof v === "string" && !EXPR_LIKE.test(v);
}
