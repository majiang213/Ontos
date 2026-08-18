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
  nullLoose?: boolean; // 「空=至今」：只对 date 类型属性为 true（gt/gte 时 NULL 也算满足）
}

export interface TableInfo {
  name: string;
  columns: { name: string; type: string; pk: boolean }[];
}

export interface SourceDriver {
  readonly dialect?: "sqlite" | "mysql" | "pg"; // 单驱动带方言；注册表是多方言混合，用 dialectOf 按连接查
  /** 注册表按连接名查方言；单驱动可不实现（直接读 dialect 属性）。 */
  dialectOf?(connection: string): "sqlite" | "mysql" | "pg" | undefined;
  // 下推只读查询：取哪些列、按什么条件筛，在库内完成。异步：真库走网络。limit 给时下推行数上限
  select(connection: string, table: string, columns: string[], conditions: Condition[], limit?: number): Promise<Record<string, unknown>[]>;
  // 写回三种：插、条件更新（返回受影响行数）、条件删除
  insert(connection: string, table: string, row: Record<string, unknown>): Promise<void>;
  update(connection: string, table: string, set: Record<string, unknown>, conditions: Condition[]): Promise<number>;
  delete(connection: string, table: string, conditions: Condition[]): Promise<number>;
  // M1：内省表结构（不取业务行）与脱敏采样（3 行）
  introspect?(connection: string): Promise<TableInfo[]>;
  sample?(connection: string, table: string, limit?: number): Promise<Record<string, unknown>[]>;
  // 资源释放：连接删除/重注册时调用
  close?(): Promise<void>;
}

/* ---------- 方言 ---------- */

/** 标识符引号：mysql 反引号，pg/sqlite 双引号。标识符内的引号字符双写转义。 */
export function quoteFor(dialect: "sqlite" | "mysql" | "pg"): (id: string) => string {
  return dialect === "mysql"
    ? (id) => `\`${id.replace(/`/g, "``")}\``
    : (id) => `"${id.replace(/"/g, '""')}"`;
}

/** 占位符风格：sqlite/mysql 用 ?，pg 用 $1..$n。 */
export function renderPlaceholders(sql: string, dialect: "sqlite" | "mysql" | "pg"): string {
  if (dialect !== "pg") return sql;
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/* ---------- 脱敏采样 ---------- */

const SENSITIVE = /id_?card|idcard|phone|mobile|身份证|手机|邮箱|email/i;

/** 敏感列只留头尾：身份证/手机号这类标识字段，采样时脱敏。 */
export function maskValue(column: string, value: unknown): unknown {
  if (value == null) return value;
  if (!SENSITIVE.test(column)) return value;
  const s = String(value);
  return s.length <= 6 ? "******" : `${s.slice(0, 4)}******${s.slice(-2)}`;
}

/* 条件 → WHERE 片段。占位符统一用 ?；标识符引号按方言给。 */
export function conditionSql(cond: Condition, quote: (id: string) => string, dialect: "sqlite" | "mysql" | "pg" = "sqlite"): { sql: string; params: unknown[] } {
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
    case "contains": {
      const v = String(cond.value).replace(/[\\%_]/g, (c) => `\\${c}`); // 转义通配符，防 % 变全表匹配
      // MySQL 的 SQL 文本里反斜杠是转义符：想表达「一个反斜杠」字面量本身得写两个
      const esc = dialect === "mysql" ? "ESCAPE '\\\\'" : "ESCAPE '\\'";
      return { sql: `${col} LIKE ? ${esc}`, params: [`%${v}%`] };
    }
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
      // 「空=至今」只对 date 属性生效：gt/gte 时 NULL 也算满足（至今晚于任何日期）
      const nullOk = cond.nullLoose === true && (cond.op === "gt" || cond.op === "gte");
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
  dialect: "sqlite" | "mysql" | "pg",
  limit?: number
): { sql: string; params: unknown[] } {
  const quote = quoteFor(dialect);
  const parts = conds.map((c) => conditionSql(c, quote, dialect));
  const where = parts.length ? ` WHERE ${parts.map((p) => p.sql).join(" AND ")}` : "";
  const params = parts.flatMap((p) => p.params);
  const cols = columns.length ? columns.map(quote).join(", ") : "*";
  return { sql: `SELECT ${cols} FROM ${quote(table)}${where}${limit ? " LIMIT ?" : ""}`, params: limit ? [...params, limit] : params };
}
