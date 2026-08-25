// 元库 DDL 静态检查（R8 卡 1）：MySQL 后端曾不可启动——三道死刑（多语句未开 / TEXT 进索引 1170 /
// TEXT 挂时间默认 1067，外加 TEXT 字面量默认 1101）且头注谎称「差异只三处」。没有活体 MySQL 可打，
// 按结构钉死这三类形状不再出现；sqlite 侧用内存库真跑一遍 DDL 当执行级证据。

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MYSQL_DDL } from "../server/meta/ddl/mysql";
import { SQLITE_DDL } from "../server/meta/ddl/sqlite";

describe("元库 DDL（两方言）", () => {
  it("sqlite DDL 在内存库真跑通过；adj_overlap 带按对唯一索引", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(SQLITE_DDL); // 执行级：语法与约束都被 SQLite 真验过
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'adj_overlap'`).all() as { name: string }[];
    expect(idx.length).toBeGreaterThan(0); // UNIQUE(workspace_id, class_a, class_b) 的自动索引
    db.close();
  });

  it("MYSQL_DDL 不含三类致命形状（R8 卡 1 回归）", () => {
    expect(MYSQL_DDL).not.toMatch(/TEXT[^\n]*UNIQUE/); // TEXT 列进 UNIQUE（错误 1170）
    expect(MYSQL_DDL).not.toMatch(/name TEXT NOT NULL,\s*\n\s*PRIMARY KEY/); // TEXT 列进主键（同 1170，meta_seq）
    expect(MYSQL_DDL).not.toMatch(/TEXT[^\n]*DEFAULT CURRENT_TIMESTAMP/); // TEXT 挂时间默认值（错误 1067）
    expect(MYSQL_DDL).not.toMatch(/TEXT NOT NULL DEFAULT '[^'(]/); // TEXT 字面量默认值（错误 1101，只许表达式形态 DEFAULT ('...')）
    // 键列与时列的正面对照：VARCHAR(191) 与 DATETIME 必须出现
    expect(MYSQL_DDL).toContain("name VARCHAR(191) NOT NULL UNIQUE");
    expect(MYSQL_DDL).toContain("created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
    expect(MYSQL_DDL).toContain("UNIQUE (workspace_id, class_a, class_b)");
  });

  it("MysqlBackend 建池开了 multipleStatements（九个 CREATE TABLE 一次下发的前提）", () => {
    const src = readFileSync("src/server/meta/backends.ts", "utf8");
    expect(src).toContain("multipleStatements: true");
  });

  it("两方言的表集合一致（九张表同名同约束面）", () => {
    const tables = (ddl: string) => [...ddl.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]).sort();
    expect(tables(MYSQL_DDL)).toEqual(tables(SQLITE_DDL));
  });

  it("DDL 设计面：MySQL 每表 ENGINE/CHARSET + 表级 COMMENT；两方言外键与扫描索引齐备", () => {
    expect(MYSQL_DDL.match(/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4/g)?.length).toBe(9); // 九表各自声明（中文字段安全）
    expect(MYSQL_DDL.match(/\) ENGINE=[^\n]*COMMENT='/g)?.length).toBe(9); // 九表各一句表级 COMMENT（注释投影纪律）
    expect(MYSQL_DDL.match(/FOREIGN KEY \(workspace_id\)/g)?.length).toBe(8); // 除 onto_workspace 自身，八张带 workspace_id 的表
    expect(SQLITE_DDL.match(/REFERENCES onto_workspace\(id\)/g)?.length).toBe(8);
    // 空间维扫描的索引落点（UNIQUE/PK 左前缀已覆盖的不重复建）
    for (const idx of ["idx_adj_decision_ws", "idx_ont_question_ws", "idx_log_query_ws_time", "idx_log_action_ws_time"]) {
      expect(MYSQL_DDL).toContain(idx);
      expect(SQLITE_DDL).toContain(idx);
    }
  });
});
