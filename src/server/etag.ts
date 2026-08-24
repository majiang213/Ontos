// 画布监视器的 ETag 格式：空间名 + rev。GET /api/ontology 与画布轮询共用这一处，不两端心算。
// 零依赖的共享叶子：路由与前端组件都从这里取（同 valueSpec 的共享方式）。

export function etagOf(ws: string, rev: number): string {
  return `"${ws}-${rev}"`;
}
