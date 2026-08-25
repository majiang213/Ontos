// 验收状态词表（唯一出处）：写库、读库判分支、UI 展示都用这里的键——中文词是值不是键，
// 比照裁决的 Verdict 枚举 + VERDICT_LABELS 键值分离（verdict.ts 同例）。
// 纯叶子（零依赖）：引擎（questions.ts）、元库 DDL 注释按名互指、前端卡（QuestionsCard）三方共用。

export const Q_STATUS = { pass: "通过", wrong: "答案不符", error: "执行出错", compileFail: "编译失败", pending: "未跑" } as const;
export type QuestionStatus = (typeof Q_STATUS)[keyof typeof Q_STATUS];
