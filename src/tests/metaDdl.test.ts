// 元库 DDL 静态检查（R8 卡 1）：MySQL 后端曾不可启动——三道死刑（多语句未开 / TEXT 进索引 1170 /
// TEXT 挂时间默认 1067，外加 TEXT 字面量默认 1101）且头注谎称「差异只三处」。没有活体 MySQL 可打，
// 按结构钉死这三类形状不再出现；sqlite 侧用内存库真跑一遍 DDL 当执行级证据。

import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { MYSQL_DDL } from "../server/meta/ddl/mysql";
import { SQLITE_DDL } from "../server/meta/ddl/sqlite";
import { SqliteBackend } from "../server/meta/backends";

describe("元库 DDL（两方言）", () => {
  it("sqlite DDL 在内存库真跑通过；adj_overlap 带按对唯一索引；onto_version 工作行唯一锚（draft_key）生效", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SQLITE_DDL); // 执行级：语法与约束都被 SQLite 真验过
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'adj_overlap'`).all() as { name: string }[];
    expect(idx.length).toBeGreaterThan(0); // UNIQUE(workspace_id, class_a, class_b) 的自动索引
    db.prepare(`INSERT INTO onto_workspace (id, name) VALUES (1, 'ddlcheck')`).run(); // 外键前置：工作行挂在空间上
    // 工作行唯一锚：绕过 saveDraftPack 裸插第二工作行被 UNIQUE(draft_key) 拦（无状态化后「每空间恰一行」的 DB 级保证）
    db.prepare(`INSERT INTO onto_version (workspace_id, version, yaml, canvas_json, rev) VALUES (1, NULL, '', '{}', 0)`).run();
    expect(() => db.prepare(`INSERT INTO onto_version (workspace_id, version, yaml, canvas_json, rev) VALUES (1, NULL, '', '{}', 0)`).run()).toThrow(/UNIQUE/i);
    // 编号行不参与唯一锚：两个同空间不同编号行正常共存
    db.prepare(`INSERT INTO onto_version (workspace_id, version, yaml, canvas_json, rev) VALUES (1, 1, 'y', NULL, 0)`).run();
    db.prepare(`INSERT INTO onto_version (workspace_id, version, yaml, canvas_json, rev) VALUES (1, 2, 'y', NULL, 0)`).run();
    db.close();
  });

  it("MYSQL_DDL 不含三类致命形状（R8 卡 1 回归）", () => {
    expect(MYSQL_DDL).not.toMatch(/TEXT[^\n]*UNIQUE/); // TEXT 列进 UNIQUE（错误 1170）
    expect(MYSQL_DDL).not.toMatch(/name TEXT NOT NULL,\s*\n\s*PRIMARY KEY/); // TEXT 列进主键（错误 1170）
    expect(MYSQL_DDL).not.toMatch(/TEXT[^\n]*DEFAULT CURRENT_TIMESTAMP/); // TEXT 挂时间默认值（错误 1067）
    expect(MYSQL_DDL).not.toMatch(/TEXT NOT NULL DEFAULT '[^'(]/); // TEXT 字面量默认值（错误 1101，只许表达式形态 DEFAULT ('...')）
    // 键列与时列的正面对照：VARCHAR(191) 与 DATETIME 必须出现
    expect(MYSQL_DDL).toContain("name VARCHAR(191) NOT NULL UNIQUE");
    expect(MYSQL_DDL).toContain("created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
    expect(MYSQL_DDL).toContain("UNIQUE (workspace_id, class_a, class_b)");
    // 工作行唯一锚两方言同构：draft_key 生成列 + UNIQUE；rev 列持久化草稿修订号
    expect(MYSQL_DDL).toContain("draft_key BIGINT GENERATED ALWAYS AS");
    expect(MYSQL_DDL).toContain("UNIQUE KEY uq_draft_key");
    expect(MYSQL_DDL).toContain("rev INT NOT NULL DEFAULT 0");
    expect(SQLITE_DDL).toContain("draft_key INTEGER GENERATED ALWAYS AS");
    expect(SQLITE_DDL).toContain("UNIQUE (draft_key)");
    expect(SQLITE_DDL).toContain("rev INTEGER NOT NULL DEFAULT 0");
    // 发号器改雪花：meta_seq 表两方言都不存在
    expect(MYSQL_DDL).not.toContain("meta_seq");
    expect(SQLITE_DDL).not.toContain("meta_seq");
  });

  it("MysqlBackend 建池开了 multipleStatements（八个 CREATE TABLE 一次下发的前提）", () => {
    const src = readFileSync("src/server/meta/backends.ts", "utf8");
    expect(src).toContain("multipleStatements: true");
  });

  it("两方言的表集合一致（八张表同名同约束面）", () => {
    const tables = (ddl: string) => [...ddl.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort();
    expect(tables(MYSQL_DDL)).toEqual(tables(SQLITE_DDL));
  });

  it("DDL 设计面：MySQL 每表 ENGINE/CHARSET + 表级 COMMENT；两方言外键与扫描索引齐备", () => {
    expect(MYSQL_DDL.match(/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4/g)?.length).toBe(8); // 八表各自声明（中文字段安全）
    expect(MYSQL_DDL.match(/\) ENGINE=[^\n]*COMMENT='/g)?.length).toBe(8); // 八表各一句表级 COMMENT（注释投影纪律）
    expect(MYSQL_DDL.match(/FOREIGN KEY \(workspace_id\)/g)?.length).toBe(7); // 除 onto_workspace 自身：onto_version + 六张业务表
    expect(SQLITE_DDL.match(/REFERENCES onto_workspace\(id\)/g)?.length).toBe(7);
    // 空间维扫描的索引落点（UNIQUE/PK 左前缀已覆盖的不重复建）
    for (const idx of ["idx_adj_decision_ws", "idx_ont_question_ws", "idx_log_query_ws_time", "idx_log_action_ws_time"]) {
      expect(MYSQL_DDL).toContain(idx);
      expect(SQLITE_DDL).toContain(idx);
    }
  });

  it("旧库迁移：无 rev / draft_key 的老 schema 打开后自动补列 + 工作行唯一索引，CAS 生效，meta_seq 老表丢弃", async () => {
    // 造一个无状态化前的旧库：onto_version 没有 rev / draft_key，还有发号器计数器表 meta_seq
    const file = join(tmpdir(), `ontos-old-${process.pid}-${Date.now()}.db`);
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE onto_workspace (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, seed_from TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE onto_version (id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES onto_workspace(id), version INTEGER,
        yaml TEXT NOT NULL DEFAULT '', canvas_json TEXT, origin TEXT NOT NULL DEFAULT 'publish', note TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (workspace_id, version));
      CREATE TABLE meta_seq (workspace_id INTEGER NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (workspace_id, name));
      INSERT INTO onto_workspace (id, name) VALUES (1, 'oldws');
      INSERT INTO onto_version (workspace_id, version, yaml, canvas_json) VALUES (1, NULL, '', '{}');`);
    old.close();

    const s = new SqliteBackend(file); // 打开即迁移
    try {
      // rev 列已补：CAS 命中 1 行，重放 0 行（冲突语义与新版一致）
      await expect(s.run(`UPDATE onto_version SET canvas_json = '{"m":1}', rev = rev + 1 WHERE workspace_id = 1 AND version IS NULL AND rev = 0`)).resolves.toBe(1);
      await expect(s.run(`UPDATE onto_version SET canvas_json = '{"m":1}', rev = rev + 1 WHERE workspace_id = 1 AND version IS NULL AND rev = 0`)).resolves.toBe(0);
      // 工作行唯一索引已建：第二工作行被 UNIQUE 拦（「每空间恰一行」升为 DB 级保证）
      await expect(s.run(`INSERT INTO onto_version (workspace_id, version, yaml, canvas_json, rev) VALUES (1, NULL, '', '{}', 0)`)).rejects.toThrow(/UNIQUE/i);
      // meta_seq 老表已随迁移丢弃
      const tables = await s.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta_seq'`);
      expect(tables).toHaveLength(0);
    } finally {
      await s.close();
      rmSync(file, { force: true });
    }
  });
});
