// 关切 store 的基座：共享后端与「空间名 → workspace_id」的注册纪律（未注册的先注册）。
// 版本行由 latestVersion 播种——元数据写（留痕/连接/问题集）可能先于配置访问碰到新空间。

import type { MetaBackend } from "../backends";

export abstract class ConcernStore {
  constructor(protected backend: MetaBackend) {}

  /** 空间 id；未注册的先注册。 */
  protected async wsId(ws: string): Promise<number> {
    const row = await this.backend.get(`SELECT id FROM onto_workspace WHERE name = ?`, [ws]);
    if (row) return row.id as number;
    await this.backend.run(`INSERT INTO onto_workspace (name, seed_from) VALUES (?, ?)`, [ws, "lazy"]);
    return (await this.backend.get(`SELECT id FROM onto_workspace WHERE name = ?`, [ws]))!.id as number;
  }
}
