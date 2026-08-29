// 对齐判定的共享词汇 —— 机器键 + 展示文案 + 建议形状（《AGENTS.md》术语表「对齐判定」）。
// 住 schema 不住任何领域包：配置键、decisions API、adj_decision 留痕、AI 槽位建议、前端按钮全用它，
// 是跨域共享内核（纯叶子，前端可安全引用）。枚举成员是稳定键：汉字只做展示文案（VERDICT_LABELS）。

export enum Verdict {
  /** 类等价：两个类描述同一种现实事物——合并单对象挂多源 */
  Same = "same",
  /** 部分重叠：个体有交集又不是同一批——公共部分立上位对象 */
  Overlap = "overlap",
  /** 生命周期：同一个体的不同时期——统一对象 + 状态 + 转化关系 */
  Stage = "stage",
  /** 同形异义：不是在描述同一种东西——两类都留下并写入 class_conclusions */
  NameSimilar = "name_similar",
  /** 跳过：这次不对齐判定，不是类与类关系 */
  Skip = "skip",
}

/** 全部枚举值（UI 按钮顺序与枚举声明一致）。 */
export const VERDICTS = [Verdict.Same, Verdict.Overlap, Verdict.Stage, Verdict.NameSimilar, Verdict.Skip] as const;

/** LLM 建议的倾向：无「跳过」——机器不给「先放着」的建议。 */
export const TENDENCIES = [Verdict.Same, Verdict.Overlap, Verdict.Stage, Verdict.NameSimilar] as const;
export type Tendency = (typeof TENDENCIES)[number];

/** 键 → 展示文案（UI 按钮、AI 建议展示、提示词注解共用）。 */
export const VERDICT_LABELS: Record<Verdict, string> = {
  [Verdict.Same]: "类等价",
  [Verdict.Overlap]: "部分重叠",
  [Verdict.Stage]: "生命周期",
  [Verdict.NameSimilar]: "同形异义",
  [Verdict.Skip]: "跳过",
};

/** 候选对建议：疑似同义的两个类 + 机器倾向 + 理由。可以是不同库，也可以是同一库的两张表。
 *  裁决权在人，这只是建议（LLM 槽位产出，/api/list_candidates 的响应形状，画布裁决面板消费）。 */
export interface PairAdvice {
  class_a: string;
  class_b: string;
  tendency: Tendency;
  reason: string;
  /** 串改写来的待问：还没有针对这两个类的新建议，界面不标「建议」。 */
  pending?: boolean;
}
