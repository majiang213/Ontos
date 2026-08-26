// 源驱动抽象 —— 引擎与源库之间的唯一接口。
// 引擎把对某个源的需求编成「列 + 条件」，驱动翻成方言 SQL 下推。
// 条件里的 column 已经是源列名（经 sources.fields 翻好），驱动不认属性名。
// 「空=至今」作用在哪些运算符上见 schema/config.treatsNullAsUntilNow（运算符语义单源，本层不再上指 query）。

import { treatsNullAsUntilNow } from "../schema/config";

export type CondOp =
  | "eq" | "ne" | "lt" | "lte" | "gt" | "gte"
  | "in" | "contains" | "null" | "notnull";

export interface Condition {
  column: string;
  op: CondOp;
  value?: unknown; // in 时是数组；null / notnull 不带值
  nullLoose?: boolean; // 「空=至今」：只对 date 类型属性为 true（gt/gte 时 NULL 也算满足）
  dateLike?: boolean; // 该条件作用在 date 属性上：值是 Unix 秒，下推活体库前按方言归一（toColumnValue）
}

export interface TableInfo {
  name: string;
  columns: { name: string; type: string; pk: boolean; comment?: string }[];
}

export interface SourceDriver {
  readonly dialect?: "sqlite" | "mysql" | "pg"; // 单驱动带方言；注册表是多方言混合，用 dialectOf 按连接查
  /** 注册表按连接名查方言；单驱动可不实现（直接读 dialect 属性）。 */
  dialectOf?(connection: string): "sqlite" | "mysql" | "pg" | undefined;
  // 下推只读查询：取哪些列、按什么条件筛，在库内完成。异步：真库走网络。limit 给时下推行数上限
  select(connection: string, table: string, columns: string[], conditions: Condition[], limit?: number): Promise<Record<string, unknown>[]>;
  // 聚合下推（M7 查询治理）：分组键与指标在库内 GROUP BY，不拉全量明细。只有判定「整个聚合都能在库内算」才调（assemble.aggregatePushdown）
  selectAggregate(connection: string, table: string, group: { column: string; as: string }[], metrics: AggMetric[], conditions: Condition[]): Promise<Record<string, unknown>[]>;
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

/** 按连接查方言，查不到回退单驱动方言（唯一出处）：注册表多方言与单驱动同一口径。
 *  undefined = 非 mysql/pg（toColumnValue 按不转换处理，与原内联写法同语义）。 */
export function dialectFor(driver: SourceDriver, connection: string): Dialect | undefined {
  return driver.dialectOf?.(connection) ?? driver.dialect;
}

/** 标识符引号：mysql 反引号，pg/sqlite 双引号。标识符内的引号字符双写转义。 */
function quoteFor(dialect: "sqlite" | "mysql" | "pg"): (id: string) => string {
  return dialect === "mysql"
    ? (id) => `\`${id.replace(/`/g, "``")}\``
    : (id) => `"${id.replace(/"/g, '""')}"`;
}

/** 占位符风格：sqlite/mysql 用 ?，pg 用 $1..$n。 */
function renderPlaceholders(sql: string, dialect: "sqlite" | "mysql" | "pg"): string {
  if (dialect !== "pg") return sql;
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/* ---------- 方言值归一 ---------- */

/** 写库/下推的日期值按方言归一：引擎内部是 Unix 秒，活体 mysql/pg 的 DATETIME/TIMESTAMP 列要 UTC 串；sqlite 演示库是 INTEGER 列，用秒。 */
export function toColumnValue(v: unknown, type: string | undefined, dialect: string | undefined): unknown {
  if (type === "date" && typeof v === "number" && (dialect === "mysql" || dialect === "pg")) {
    const d = new Date(v * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
  return v;
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
function conditionSql(cond: Condition, quote: (id: string) => string, dialect: "sqlite" | "mysql" | "pg"): { sql: string; params: unknown[] } {
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
      const nullOk = cond.nullLoose === true && treatsNullAsUntilNow(cond.op);
      const base = `${col} ${sym} ?`;
      return nullOk
        ? { sql: `(${base} OR ${col} IS NULL)`, params: [cond.value] }
        : { sql: base, params: [cond.value] };
    }
  }
}

/* ---------- SQL 构造（唯一出处） ----------
   全部内部渲染占位符（pg → $1..$n，其余 ?）：调用方拿到手就能执行，不用记得再渲染。 */

export type Dialect = "sqlite" | "mysql" | "pg";

/** 聚合指标：op 与产出列名（as）由引擎给，column 已是源列名（"*" 只配 count）。 */
export interface AggMetric {
  op: "count" | "avg" | "sum" | "min" | "max";
  column: string | "*";
  as: string;
}

export function buildSelect(
  table: string,
  columns: string[],
  conds: Condition[],
  dialect: Dialect,
  limit?: number
): { sql: string; params: unknown[] } {
  const quote = quoteFor(dialect);
  const parts = conds.map((c) => conditionSql(c, quote, dialect));
  const where = parts.length ? ` WHERE ${parts.map((p) => p.sql).join(" AND ")}` : "";
  const params = parts.flatMap((p) => p.params);
  const cols = columns.length ? columns.map(quote).join(", ") : "*";
  const sql = `SELECT ${cols} FROM ${quote(table)}${where}${limit ? " LIMIT ?" : ""}`;
  return { sql: renderPlaceholders(sql, dialect), params: limit ? [...params, limit] : params };
}

/** 聚合下推的构造（select 走 buildSelect）：GROUP BY 在库内算。
 *  语义对齐内存聚合：count 数非空值 / count(*) 数行、avg/min/max 跳过 NULL（下推前提是 number 列，见 aggregatePushdown）；
 *  sum 组内全是 NULL 时内存给 0 而 SQL 给 NULL，用 COALESCE 对齐。 */
export function buildAggregate(
  table: string,
  group: { column: string; as: string }[],
  metrics: AggMetric[],
  conds: Condition[],
  dialect: Dialect
): { sql: string; params: unknown[] } {
  const quote = quoteFor(dialect);
  const parts = conds.map((c) => conditionSql(c, quote, dialect));
  const where = parts.length ? ` WHERE ${parts.map((p) => p.sql).join(" AND ")}` : "";
  const params = parts.flatMap((p) => p.params);
  const gcols = group.map((g) => `${quote(g.column)} AS ${quote(g.as)}`);
  const mcols = metrics.map((m) => {
    const target = m.column === "*" ? "*" : quote(m.column);
    const expr = m.op === "sum" ? `COALESCE(SUM(${target}), 0)` : `${m.op.toUpperCase()}(${target})`;
    return `${expr} AS ${quote(m.as)}`;
  });
  const groupBy = group.length ? ` GROUP BY ${group.map((g) => quote(g.column)).join(", ")}` : "";
  const sql = `SELECT ${[...gcols, ...mcols].join(", ")} FROM ${quote(table)}${where}${groupBy}`;
  return { sql: renderPlaceholders(sql, dialect), params };
}

/** update/delete 的构造（select 走 buildSelect）。 */
export function buildStatement(
  dialect: Dialect,
  kind: "update" | "delete",
  table: string,
  opts: { set?: Record<string, unknown>; conditions?: Condition[] }
): { sql: string; params: unknown[] } {
  const quote = quoteFor(dialect);
  const conds = (opts.conditions ?? []).map((c) => conditionSql(c, quote, dialect));
  const where = conds.length ? ` WHERE ${conds.map((p) => p.sql).join(" AND ")}` : "";
  let sql: string;
  let params: unknown[];
  if (kind === "update") {
    const setCols = Object.keys(opts.set ?? {});
    sql = `UPDATE ${quote(table)} SET ${setCols.map((c) => `${quote(c)} = ?`).join(", ")}${where}`;
    params = [...setCols.map((c) => opts.set![c]), ...conds.flatMap((p) => p.params)];
  } else {
    sql = `DELETE FROM ${quote(table)}${where}`;
    params = conds.flatMap((p) => p.params);
  }
  return { sql: renderPlaceholders(sql, dialect), params };
}

export function buildInsert(dialect: Dialect, table: string, row: Record<string, unknown>): { sql: string; params: unknown[] } {
  const quote = quoteFor(dialect);
  const cols = Object.keys(row);
  const sql = `INSERT INTO ${quote(table)} (${cols.map(quote).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`;
  return { sql: renderPlaceholders(sql, dialect), params: cols.map((c) => row[c]) };
}
