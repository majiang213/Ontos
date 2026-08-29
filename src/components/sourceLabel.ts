// 来源标签：源条目名 → 「连接.表」的白话（画布节点与对象卡共用，唯一出处）。
export function sourceLabel(sources: Record<string, { connection: string; table: string }> | undefined, key: string): string {
  const s = sources?.[key];
  return s ? `${s.connection}.${s.table}` : key;
}
