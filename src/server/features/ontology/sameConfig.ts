// 结构比较 —— 「两份规定结构上一不一样」：键序无关（zod parse 会按 schema 重排键，直接 JSON.stringify 会误判）。
// 消费方：commit 重算 dirty、水合算初始 dirty、views 算类状态。纯函数，不碰库。

/** 键序无关的结构比较。 */
export function sameConfig(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}
