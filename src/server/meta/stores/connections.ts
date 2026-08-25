// 数据源连接（conn_source）：按空间的连接增删查。

import type { ConnectionRec } from "../types";
import { ConcernStore } from "./base";

export class ConnectionsStore extends ConcernStore {
  async saveConnection(workspace: string, c: ConnectionRec): Promise<void> {
    const id = await this.wsId(workspace);
    const cols = `(workspace_id, name, type, host, port, db_name, ro_user, ro_pass, rw_user, rw_pass, options)`;
    const vals = [id, c.name, c.type, c.host ?? null, c.port ?? null, c.db_name ?? null, c.ro_user ?? null, c.ro_pass ?? null, c.rw_user ?? null, c.rw_pass ?? null, c.options ? JSON.stringify(c.options) : null];
    const upsert =
      this.backend.dialect === "mysql"
        ? `ON DUPLICATE KEY UPDATE type=VALUES(type), host=VALUES(host), port=VALUES(port), db_name=VALUES(db_name), ro_user=VALUES(ro_user), ro_pass=VALUES(ro_pass), rw_user=VALUES(rw_user), rw_pass=VALUES(rw_pass), options=VALUES(options), updated_at=CURRENT_TIMESTAMP`
        : `ON CONFLICT(workspace_id, name) DO UPDATE SET type=excluded.type, host=excluded.host, port=excluded.port, db_name=excluded.db_name, ro_user=excluded.ro_user, ro_pass=excluded.ro_pass, rw_user=excluded.rw_user, rw_pass=excluded.rw_pass, options=excluded.options, updated_at=datetime('now')`;
    await this.backend.run(`INSERT INTO conn_source ${cols} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ${upsert}`, vals);
  }

  async listConnections(workspace: string): Promise<ConnectionRec[]> {
    const id = await this.wsId(workspace);
    const rows = await this.backend.all(`SELECT * FROM conn_source WHERE workspace_id = ? ORDER BY name`, [id]);
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
      options: r.options ? JSON.parse(String(r.options)) : undefined,
    }));
  }

  async deleteConnection(workspace: string, name: string): Promise<void> {
    const id = await this.wsId(workspace);
    await this.backend.run(`DELETE FROM conn_source WHERE workspace_id = ? AND name = ?`, [id, name]);
  }
}
