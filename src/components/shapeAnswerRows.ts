// 答案卡表格塑形 —— 纯函数，渲染（ChatPage.AnswerCard）与测试共用。
// 列取所有行的并集：稀疏行不丢列；值全为空的列直接跳过——旧版本答案里可能留着这种键：
// 看不见内容却把表格顶宽。值是数组的列认展开列，排在标量列后。

export interface AnswerShape {
  cols: string[]; // 标量列
  expandCols: string[]; // 展开列（任一行的值是数组）
}

export function shapeAnswerRows(rows: Record<string, unknown>[]): AnswerShape {
  const allKeys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => rows.some((r) => r[c] !== undefined && r[c] !== null && r[c] !== ""));
  return {
    cols: allKeys.filter((c) => !rows.some((r) => Array.isArray(r[c]))),
    expandCols: allKeys.filter((c) => rows.some((r) => Array.isArray(r[c]))),
  };
}
