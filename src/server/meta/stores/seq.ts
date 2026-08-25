// 发号器（meta_seq）：进程重启不复位（动作 generate 的 sequence 走这里）。原子自增并返回新值。
// 原子性分两层：sqlite 单语句 INSERT ... ON CONFLICT DO UPDATE ... RETURNING（默认部署形态，SQL 级原子）；
// mysql 没有 RETURNING（池上 LAST_INSERT_ID 跨连接不安全）留两句——进程内互斥由 runAction 的串行队列
// （runtime.actionTails）兜底，跨进程 MySQL 在文档化的单进程假设之外（runtime.ts 头注）。

import { ConcernStore } from "./base";

export class SeqStore extends ConcernStore {
  async nextSeq(workspace: string, name: string, start = 1): Promise<number> {
    const id = await this.wsId(workspace);
    if (this.backend.dialect === "sqlite") {
      const row = await this.backend.get(
        `INSERT INTO meta_seq (workspace_id, name, value) VALUES (?, ?, ?)
         ON CONFLICT(workspace_id, name) DO UPDATE SET value = MAX(value + 1, excluded.value)
         RETURNING value`,
        [id, name, start]
      );
      return row!.value as number;
    }
    const upsert = `ON DUPLICATE KEY UPDATE value = GREATEST(value + 1, VALUES(value))`;
    await this.backend.run(`INSERT INTO meta_seq (workspace_id, name, value) VALUES (?, ?, ?) ${upsert}`, [id, name, start]);
    const row = await this.backend.get(`SELECT value FROM meta_seq WHERE workspace_id = ? AND name = ?`, [id, name]);
    return row!.value as number;
  }
}
