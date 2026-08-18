// 归一化 —— 比对前把识别字段洗成统一格式（《ontos-article.md》§3.2 第二步）。
// 只在内存，不改源值、不落库。规则按格式自动匹配，不涉模型。

export interface NormRule {
  name: string;
  match: (sample: string[]) => boolean; // 按格式自动匹配
  normalize: (v: string) => string;
}

export const RULES: NormRule[] = [
  {
    name: "serial", // 出厂序列号：去横杠/空格，统一大写
    match: (s) => s.filter((v) => /^[A-Za-z]{1,4}[-\s]?\d{3,}/.test(v)).length >= s.length * 0.6,
    normalize: (v) => v.replace(/[-\s]/g, "").toUpperCase(),
  },
  {
    name: "phone", // 手机号：去 +86、空格、连字符
    match: (s) => s.filter((v) => /^(\+?86)?1[3-9]\d{9}$/.test(v.replace(/[-\s]/g, ""))).length >= s.length * 0.6,
    normalize: (v) => v.replace(/^\+?86/, "").replace(/[-\s]/g, ""),
  },
  {
    name: "id_card", // 身份证：去空格，X 大写
    match: (s) => s.filter((v) => /^\d{17}[\dXx]$/.test(v.replace(/\s/g, ""))).length >= s.length * 0.6,
    normalize: (v) => v.replace(/\s/g, "").toUpperCase(),
  },
  {
    name: "email",
    match: (s) => s.filter((v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)).length >= s.length * 0.6,
    normalize: (v) => v.trim().toLowerCase(),
  },
  {
    name: "plain", // 兜底：去首尾空格
    match: () => true,
    normalize: (v) => v.trim(),
  },
];

export function pickRule(sample: string[]): NormRule {
  return RULES.find((r) => r.match(sample)) ?? RULES[RULES.length - 1];
}

export function normalizeWith(rule: NormRule, v: unknown): string {
  return rule.normalize(String(v ?? ""));
}
