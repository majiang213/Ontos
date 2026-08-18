// 元数据库 —— 平台元数据的唯一持久化（SQLite，文件库，重启不丢）。
// 表结构对应《Ontology平台MVP设计文档.md》§6 的 DDL（MySQL 方言）的 SQLite 适配：
// TEXT 代 VARCHAR/MEDIUMTEXT，datetime('now') 代 TIMESTAMP DEFAULT，JSON 列存 TEXT。
// 业务行永远不进这里；交集只存计数，标识值集合不落盘；日志不存结果集。

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const DDL = `
CREATE TABLE IF NOT EXISTS conn_source (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,                 -- mysql | pg | sqlite（fixture）
  host TEXT, port INTEGER, db_name TEXT,
  ro_user TEXT, ro_pass TEXT,         -- 演示期明文；生产须加密（KMS）
  rw_user TEXT, rw_pass TEXT,
  options TEXT,                       -- JSON：ssl、超时等方言项
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS adj_decision (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER,                    -- 结论生效的已发布版本，发布时回填
  class_a TEXT NOT NULL, class_b TEXT NOT NULL,
  source_a TEXT NOT NULL, source_b TEXT NOT NULL,
  llm_advice TEXT,                    -- 模型建议与依据
  rate REAL,                          -- 裁决时看到的交集率
  evidence TEXT,                      -- JSON 证据快照：归一化规则、样本量、交集数
  verdict TEXT NOT NULL,              -- 同一 | 部分重叠 | 阶段 | 仅名称相似 | 跳过
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS adj_overlap (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_a TEXT NOT NULL, class_b TEXT NOT NULL,
  norm_rule TEXT,                     -- 归一化规则
  count_a INTEGER NOT NULL, count_b INTEGER NOT NULL, count_hit INTEGER NOT NULL,
  rate REAL NOT NULL,
  computed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS ont_question (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER,
  question TEXT NOT NULL,
  expected TEXT,
  status TEXT NOT NULL DEFAULT '未跑'  -- 通过 | 失败 | 未跑
);
CREATE TABLE IF NOT EXISTS ont_query_api (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,          -- 问数 API 名（台账）
  question TEXT NOT NULL,             -- 原始自然语言
  query_json TEXT NOT NULL,           -- 编译出的结构化查询
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS log_query (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER,
  session_id TEXT,
  model TEXT,
  question TEXT,
  query_json TEXT,
  row_count INTEGER,                  -- 当时返回的行数；不是结果集
  error TEXT,
  duration_ms INTEGER,
  ok INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS log_action (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  request_json TEXT,
  projections TEXT,                   -- JSON：各条投影的成败
  error TEXT,
  duration_ms INTEGER,
  ok INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS meta_seq (
  name TEXT PRIMARY KEY,              -- 发号器名（如 appointment.appt_no）
  value INTEGER NOT NULL              -- 已发出的最大序号
);
`;

/* ---------- 记录类型 ---------- */

export interface ConnectionRec {
  name: string;
  type: "mysql" | "pg" | "sqlite";
  host?: string;
  port?: number;
  db_name?: string;
  ro_user?: string;
  ro_pass?: string;
  rw_user?: string;
  rw_pass?: string;
  options?: Record<string, unknown>;
}

export interface DecisionRec {
  version?: number;
  class_a: string;
  class_b: string;
  source_a: string;
  source_b: string;
  llm_advice?: string;
  rate?: number;
  evidence?: Record<string, unknown>;
  verdict: string;
  decided_by: string;
}

export interface OverlapRec {
  class_a: string;
  class_b: string;
  norm_rule?: string;
  count_a: number;
  count_b: number;
  count_hit: number;
  rate: number;
}

export interface QuestionRec {
  id: number;
  version?: number;
  question: string;
  expected?: string;
  status: string;
}

export interface QueryApiRec {
  id: number;
  name: string;
  question: string;
  query_json: string;
}

export interface QueryLogRec {
  version?: number;
  session_id?: string;
  model?: string;
  question?: string;
  query_json?: string;
  row_count?: number;
  error?: string;
  duration_ms?: number;
  ok: boolean;
}

export interface ActionLogRec {
  version?: number;
  action: string;
  object_type: string;
  subject: string;
  request_json?: string;
  projections?: unknown;
  error?: string;
  duration_ms?: number;
  ok: boolean;
}

/* ---------- 存储 ---------- */

export class MetaStore {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(DDL);
  }

  close() {
    this.db.close();
  }

  /* 连接 */
  saveConnection(c: ConnectionRec): void {
    this.db
      .prepare(
        `INSERT INTO conn_source (name, type, host, port, db_name, ro_user, ro_pass, rw_user, rw_pass, options)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET type=excluded.type, host=excluded.host, port=excluded.port, db_name=excluded.db_name,
           ro_user=excluded.ro_user, ro_pass=excluded.ro_pass, rw_user=excluded.rw_user, rw_pass=excluded.rw_pass,
           options=excluded.options, updated_at=datetime('now')`
      )
      .run(c.name, c.type, c.host ?? null, c.port ?? null, c.db_name ?? null, c.ro_user ?? null, c.ro_pass ?? null, c.rw_user ?? null, c.rw_pass ?? null, c.options ? JSON.stringify(c.options) : null);
  }

  listConnections(): ConnectionRec[] {
    const rows = this.db.prepare(`SELECT * FROM conn_source ORDER BY name`).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      name: r.name as string,
      type: r.type as ConnectionRec["type"],
      host: (r.host ?? undefined) as string | undefined,
      port: (r.port ?? undefined) as number | undefined,
      db_name: (r.db_name ?? undefined) as string | undefined,
      ro_user: (r.ro_user ?? undefined) as string | undefined,
      ro_pass: (r.ro_pass ?? undefined) as string | undefined,
      rw_user: (r.rw_user ?? undefined) as string | undefined,
      rw_pass: (r.rw_pass ?? undefined) as string | undefined,
      options: r.options ? JSON.parse(r.options as string) : undefined,
    }));
  }

  deleteConnection(name: string): void {
    this.db.prepare(`DELETE FROM conn_source WHERE name = ?`).run(name);
  }

  /* 裁决与交集 */
  recordDecision(d: DecisionRec): void {
    this.db
      .prepare(
        `INSERT INTO adj_decision (version, class_a, class_b, source_a, source_b, llm_advice, rate, evidence, verdict, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(d.version ?? null, d.class_a, d.class_b, d.source_a, d.source_b, d.llm_advice ?? null, d.rate ?? null, d.evidence ? JSON.stringify(d.evidence) : null, d.verdict, d.decided_by);
  }

  listDecisions(): (DecisionRec & { id: number; created_at: string })[] {
    const rows = this.db.prepare(`SELECT * FROM adj_decision ORDER BY id DESC`).all() as Record<string, unknown>[];
    return rows.map((r) => ({ ...r, evidence: r.evidence ? JSON.parse(r.evidence as string) : undefined })) as never[];
  }

  /** 发布时回填：把还没绑版本的裁决挂上这个版本。 */
  backfillDecisionVersions(version: number): void {
    this.db.prepare(`UPDATE adj_decision SET version = ? WHERE version IS NULL`).run(version);
  }

  /** 放弃草稿时：未绑版本的裁决标成 -1（已放弃），不再随下一次发布回填。 */
  abandonPendingDecisions(): void {
    this.db.prepare(`UPDATE adj_decision SET version = -1 WHERE version IS NULL`).run();
  }

  /** 发号器：进程重启不复位（动作 generate 的 sequence 走这里）。原子自增并返回新值。 */
  nextSeq(name: string, start = 1): number {
    const row = this.db
      .prepare(
        `INSERT INTO meta_seq (name, value) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET value = MAX(value + 1, excluded.value)
         RETURNING value`
      )
      .get(name, start) as { value: number };
    return row.value;
  }

  /** 交集按对更新（同一对重复计算只留最新计数）。 */
  recordOverlap(o: OverlapRec): void {
    this.db.prepare(`DELETE FROM adj_overlap WHERE class_a = ? AND class_b = ?`).run(o.class_a, o.class_b);
    this.db
      .prepare(`INSERT INTO adj_overlap (class_a, class_b, norm_rule, count_a, count_b, count_hit, rate) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(o.class_a, o.class_b, o.norm_rule ?? null, o.count_a, o.count_b, o.count_hit, o.rate);
  }

  listOverlaps(): (OverlapRec & { id: number; created_at: string })[] {
    return this.db.prepare(`SELECT * FROM adj_overlap ORDER BY id DESC`).all() as never[];
  }

  /* 验收问题集 */
  listQuestions(): QuestionRec[] {
    return this.db.prepare(`SELECT * FROM ont_question ORDER BY id`).all() as never[];
  }
  addQuestion(question: string, expected?: string): void {
    this.db.prepare(`INSERT INTO ont_question (question, expected) VALUES (?, ?)`).run(question, expected ?? null);
  }
  removeQuestion(id: number): void {
    this.db.prepare(`DELETE FROM ont_question WHERE id = ?`).run(id);
  }
  setQuestionStatus(id: number, status: string, version?: number): void {
    this.db.prepare(`UPDATE ont_question SET status = ?, version = COALESCE(?, version) WHERE id = ?`).run(status, version ?? null, id);
  }

  /* 问数 API 台账 */
  saveQueryApi(name: string, question: string, queryJson: string): void {
    this.db
      .prepare(`INSERT INTO ont_query_api (name, question, query_json) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET question=excluded.question, query_json=excluded.query_json`)
      .run(name, question, queryJson);
  }
  listQueryApis(): QueryApiRec[] {
    return this.db.prepare(`SELECT * FROM ont_query_api ORDER BY id`).all() as never[];
  }
  deleteQueryApi(id: number): void {
    this.db.prepare(`DELETE FROM ont_query_api WHERE id = ?`).run(id);
  }

  /* 日志（不存结果集） */
  logQuery(l: QueryLogRec): void {
    this.db
      .prepare(`INSERT INTO log_query (version, session_id, model, question, query_json, row_count, error, duration_ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(l.version ?? null, l.session_id ?? null, l.model ?? null, l.question ?? null, l.query_json ?? null, l.row_count ?? null, l.error ?? null, l.duration_ms ?? null, l.ok ? 1 : 0);
  }
  logAction(l: ActionLogRec): void {
    this.db
      .prepare(`INSERT INTO log_action (version, action, object_type, subject, request_json, projections, error, duration_ms, ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(l.version ?? null, l.action, l.object_type, l.subject, l.request_json ?? null, l.projections ? JSON.stringify(l.projections) : null, l.error ?? null, l.duration_ms ?? null, l.ok ? 1 : 0);
  }
  listQueryLogs(limit = 50): Record<string, unknown>[] {
    return this.db.prepare(`SELECT * FROM log_query ORDER BY id DESC LIMIT ?`).all(limit) as never[];
  }
  listActionLogs(limit = 50): Record<string, unknown>[] {
    return this.db.prepare(`SELECT * FROM log_action ORDER BY id DESC LIMIT ?`).all(limit) as never[];
  }
}

/* ---------- 单例（globalThis，Next dev 多路由包共享） ---------- */

const g = globalThis as unknown as { __ontosMeta?: MetaStore };

export function metaStore(): MetaStore {
  if (!g.__ontosMeta) {
    const file = join(process.cwd(), "lib/config/ontos-meta.db");
    g.__ontosMeta = new MetaStore(file);
  }
  return g.__ontosMeta;
}

/** 测试用：独立临时库。 */
export function freshMetaStore(path: string): MetaStore {
  return new MetaStore(path);
}

/** 测试用：关掉并清掉单例。单例的文件句柄绑死创建时的 cwd，换目录前必须清。 */
export function resetMetaStore(): void {
  g.__ontosMeta?.close();
  g.__ontosMeta = undefined;
}
