// 发号器（meta_seq）：进程重启不复位（动作 generate 的 sequence 走这里）。原子自增并返回新值。

import { ConcernStore } from "./base";

export class SeqStore extends ConcernStore {
  async nextSeq(ws: string, name: string, start = 1): Promise<number> {
    const id = await this.wsId(ws);
    const upsert =
      this.backend.dialect === "mysql"
        ? `ON DUPLICATE KEY UPDATE value = GREATEST(value + 1, VALUES(value))`
        : `ON CONFLICT(workspace_id, name) DO UPDATE SET value = MAX(value + 1, excluded.value)`;
    await this.backend.run(`INSERT INTO meta_seq (workspace_id, name, value) VALUES (?, ?, ?) ${upsert}`, [id, name, start]);
    const row = await this.backend.get(`SELECT value FROM meta_seq WHERE workspace_id = ? AND name = ?`, [id, name]);
    return row!.value as number;
  }
}
