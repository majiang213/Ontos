// 源驱动抽象 —— 引擎与源库之间的唯一接口。
// 引擎把对某个源的需求编成「列 + 条件」，驱动翻成方言 SQL 下推。
// 条件里的 column 已经是源列名（经 sources.fields 翻好），驱动不认属性名。

export type CondOp =
  | "eq" | "ne" | "lt" | "lte" | "gt" | "gte"
  | "in" | "contains" | "null" | "notnull";

export interface Condition {
  column: string;
  op: CondOp;
  value?: unknown; // in 时是数组；null / notnull 不带值
}

export interface SourceDriver {
  readonly dialect: "sqlite" | "mysql" | "pg";
  // 下推只读查询：取哪些列、按什么条件筛，在库内完成
  select(connection: string, table: string, columns: string[], conditions: Condition[]): Record<string, unknown>[];
  // 写回三种：插、条件更新（返回受影响行数）、条件删除
  insert(connection: string, table: string, row: Record<string, unknown>): void;
  update(connection: string, table: string, set: Record<string, unknown>, conditions: Condition[]): number;
  delete(connection: string, table: string, conditions: Condition[]): number;
}

/* 条件 → WHERE 片段。占位符统一用 ?；标识符引号按方言给。 */
export function conditionSql(cond: Condition, quote: (id: string) => string): { sql: string; params: unknown[] } {
  const col = quote(cond.column);
  switch (cond.op) {
    case "null":
      return { sql: `${col} IS NULL`, params: [] };
    case "notnull":
      return { sql: `${col} IS NOT NULL`, params: [] };
    case "in": {
      const vals = (cond.value as unknown[]) ?? [];
      if (vals.length === 0) return { sql: "1 = 0", params: [] };
      return { sql: `${col} IN (${vals.map(() => "?").join(", ")})`, params: vals };
    }
    case "contains":
      return { sql: `${col} LIKE ?`, params: [`%${String(cond.value)}%`] };
    case "eq":
      return cond.value === null
        ? { sql: `${col} IS NULL`, params: [] }
        : { sql: `${col} = ?`, params: [cond.value] };
    case "ne":
      return cond.value === null
        ? { sql: `${col} IS NOT NULL`, params: [] }
        : { sql: `(${col} <> ? OR ${col} IS NULL)`, params: [cond.value] };
    default: {
      const sym = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[cond.op];
      // 日期比较：空值按至今处理——gt/gte 时 NULL 也算满足（空=至今，至今晚于任何日期）
      const nullOk = cond.op === "gt" || cond.op === "gte";
      const base = `${col} ${sym} ?`;
      return nullOk
        ? { sql: `(${base} OR ${col} IS NULL)`, params: [cond.value] }
        : { sql: base, params: [cond.value] };
    }
  }
}

export function buildSelect(
  table: string,
  columns: string[],
  conds: Condition[],
  quote: (id: string) => string
): { sql: string; params: unknown[] } {
  const parts = conds.map((c) => conditionSql(c, quote));
  const where = parts.length ? ` WHERE ${parts.map((p) => p.sql).join(" AND ")}` : "";
  const params = parts.flatMap((p) => p.params);
  const cols = columns.length ? columns.map(quote).join(", ") : "*";
  return { sql: `SELECT ${cols} FROM ${quote(table)}${where}`, params };
}
