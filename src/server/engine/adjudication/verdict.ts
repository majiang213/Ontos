// 裁决结论枚举 —— 五种结论的机器键 + 展示文案（《AGENTS.md》术语表「五关系类型」）。
// 枚举成员是稳定键：decisions API、adj_decision 留痕、配置一律存键；汉字只做展示文案（VERDICT_LABELS）。

export enum Verdict {
  /** 完全等价：合并单对象挂多源 */
  Same = "same",
  /** 部分重叠：公共部分立上位对象 */
  Overlap = "overlap",
  /** 生命周期阶段：统一对象 + 状态 + 转化关系 */
  Stage = "stage",
  /** 仅名字像：各自独立 */
  NameSimilar = "name_similar",
  /** 跳过：按「各自独立」处理 */
  Skip = "skip",
}

/** 全部枚举值（UI 按钮顺序与枚举声明一致）。 */
export const VERDICTS = [Verdict.Same, Verdict.Overlap, Verdict.Stage, Verdict.NameSimilar, Verdict.Skip] as const;

/** LLM 建议的倾向：无「跳过」——机器不给「先放着」的建议。 */
export const TENDENCIES = [Verdict.Same, Verdict.Overlap, Verdict.Stage, Verdict.NameSimilar] as const;
export type Tendency = (typeof TENDENCIES)[number];

/** 键 → 展示文案（UI 按钮、AI 建议展示、提示词注解共用）。 */
export const VERDICT_LABELS: Record<Verdict, string> = {
  [Verdict.Same]: "同一",
  [Verdict.Overlap]: "部分重叠",
  [Verdict.Stage]: "阶段",
  [Verdict.NameSimilar]: "仅名称相似",
  [Verdict.Skip]: "跳过",
};

/** 候选对建议：跨源疑似同义的两个类 + 机器倾向 + 理由。裁决权在人，这只是建议（LLM 槽位产出，
 *  /api/list_candidates 的响应形状，画布裁决面板消费）。放这里不放 llmSlot：它是裁决词汇，
 *  且本模块是纯叶子，前端可安全引用。 */
export interface PairAdvice {
  class_a: string;
  class_b: string;
  tendency: Tendency;
  reason: string;
}
