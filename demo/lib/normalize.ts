// ============================================================
// 归一化规则库 —— 真实实现（文档第 2 节"先归一化再比对"）
// MVP 里规则库内置，LLM 只在识别失败时兜底建议，且只看格式模式。
// ============================================================

export interface NormalizeRule {
  name: string;
  label: string;
  pattern: RegExp; // 识别"这列值是什么标识"
  normalize: (v: string) => string;
}

export const RULES: NormalizeRule[] = [
  {
    name: "id_card",
    label: "身份证",
    pattern: /^\d{17}[\dXx]$/,
    normalize: (v) => v.trim().toUpperCase(),
  },
  {
    name: "phone",
    label: "手机号",
    pattern: /^(\+?86[\s-]?)?1\d{2}[\s-]?\d{4}[\s-]?\d{4}$/,
    normalize: (v) => {
      const digits = v.replace(/\D/g, "");
      return digits.length === 13 && digits.startsWith("86") ? digits.slice(2) : digits;
    },
  },
];

// 按列名 + 采样值猜这列适用哪条规则（列名先过滤一遍 PII 语义，值只取格式）
export function pickRule(columnName: string, samples: unknown[]): NormalizeRule | null {
  const nameHint = /idcard|id_card|身份证/i.test(columnName)
    ? "id_card"
    : /mobile|phone|手机/i.test(columnName)
      ? "phone"
      : null;
  const values = samples.filter((v) => typeof v === "string") as string[];
  for (const rule of RULES) {
    if (nameHint && rule.name !== nameHint) continue;
    const hit = values.filter((v) => rule.pattern.test(v.trim())).length;
    if (values.length > 0 && hit / values.length >= 0.6) return rule;
  }
  return null;
}

export function normalizeWith(rule: NormalizeRule, v: unknown): string | null {
  if (typeof v !== "string" || !rule.pattern.test(v.trim())) return null;
  return rule.normalize(v);
}
