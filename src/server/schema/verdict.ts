// 对齐判定的共享词汇 —— 机器键 + 展示文案 + 建议形状（《AGENTS.md》术语表「对齐判定」）。
// 住 schema 不住任何领域包：配置键、decisions API、adj_decision 留痕、AI 接口建议、前端按钮全用它，
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
 *  人只点关系类型；留下谁、谁早谁晚、时期名由建议给出（LLM 接口产出，/api/list_candidates 的响应形状，画布裁决面板消费）。 */
export interface PairAdvice {
  class_a: string;
  class_b: string;
  tendency: Tendency;
  reason: string;
  /** 类等价：合并后留下的类名（必须是两个类名之一）。 */
  keep?: string;
  /** 生命周期：较早的类 + 时期名（英文小写）。 */
  stage?: { earlier: string; from: string; to: string };
  /** 串改写来的待问：还没有针对这两个类的新建议，界面不标「建议」。 */
  pending?: boolean;
}

/** 点名必须是这一对之一才认 —— keep 与 stage.earlier 的共同纪律；链改写丢掉不再成对的点名。 */
export function onPair(name: string | undefined, a: string, b: string): name is string {
  return name === a || name === b;
}

/** 建议形状的纪律（出槽后统一清一遍）：stage 只在倾向是生命周期时有意义；from/to 空或不齐就整个去掉。
 *  模型会写 stage 空壳（非生命周期倾向也带 stage、词留空）——快照里不留脏形状，占位词兜底由 executionPlan 负责。 */
export function cleanAdvice(p: PairAdvice): PairAdvice {
  if (p.tendency !== Verdict.Stage) return p.stage ? { ...p, stage: undefined } : p;
  if (!p.stage) return p;
  return p.stage.from?.trim() && p.stage.to?.trim() ? p : { ...p, stage: undefined };
}

/** 兜底时期标识是领域中性的占位（建议没给时期名时才落到这里；人可改标识换领域词）。
 *  单源住本文件：executionPlan 缺词兜底与 applyVerdict 落地取值都经它，不许第二个家。 */
export const FALLBACK_STAGE = { from: "early", to: "late" } as const;

/** 兜底词的中文名（只给占位词配；建议词的中文名由改标识补）。 */
export const FALLBACK_STAGE_LABELS: Record<string, string | undefined> = { early: "早期", late: "晚期" };

/** 生命周期落地时 status 值域的取词形状：占位词带中文名（早期/晚期），其余词只带 value（中文名由改标识补）。applyVerdict 用它，不住第二个家。 */
export function stageValues(from: string, to: string): { value: string; label?: string }[] {
  const withLabel = (v: string) => {
    const label = FALLBACK_STAGE_LABELS[v];
    return label ? { value: v, label } : { value: v };
  };
  return [withLabel(from), withLabel(to)];
}

/** 人点的关系类型 → 定案顺序与生命周期时期名。建议里缺项或点名不在这一对上，留下 class_a、时期名取兜底。 */
export function executionPlan(
  class_a: string,
  class_b: string,
  verdict: Verdict,
  advice: Pick<PairAdvice, "keep" | "stage">
): { order: [string, string]; stage?: { from: string; to: string } } {
  if (verdict === Verdict.Same) {
    const keep = onPair(advice.keep, class_a, class_b) ? advice.keep : class_a;
    return { order: keep === class_a ? [class_a, class_b] : [class_b, class_a] };
  }
  if (verdict === Verdict.Stage) {
    const earlier = onPair(advice.stage?.earlier, class_a, class_b) ? advice.stage.earlier : class_a;
    const from = advice.stage?.from?.trim() || FALLBACK_STAGE.from;
    const to = advice.stage?.to?.trim() || FALLBACK_STAGE.to;
    return {
      order: earlier === class_a ? [class_a, class_b] : [class_b, class_a],
      stage: { from, to },
    };
  }
  return { order: [class_a, class_b] };
}
