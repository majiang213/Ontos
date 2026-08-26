// 数据源连接（conn_source）：按空间的连接增删查。

import type { ConnectionRec } from "../types";
import { ConcernStore, upsertSql } from "./base";

export class ConnectionsStore extends ConcernStore {
  async saveConnection(workspace: string, c: ConnectionRec): Promise<void> {
    const id = await this.wsId(workspace);
    const columns = ["workspace_id", "name", "type", "host", "port", "db_name", "ro_user", "ro_pass", "rw_user", "rw_pass"];
    const vals = [id, c.name, c.type, c.host ?? null, c.port ?? null, c.db_name ?? null, c.ro_user ?? null, c.ro_pass ?? null, c.rw_user ?? null, c.rw_pass ?? null];
    const sql = upsertSql(this.datasource.dialect, "conn_source", columns, ["workspace_id", "name"], columns.slice(2), true);
    await this.datasource.run(sql, vals);
  }

  async listConnections(workspace: string): Promise<ConnectionRec[]> {
    const id = await this.wsId(workspace);
    const rows = await this.datasource.all(`SELECT * FROM conn_source WHERE workspace_id = ? ORDER BY name`, [id]);
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
    }));
  }

  async deleteConnection(workspace: string, name: string): Promise<void> {
    const id = await this.wsId(workspace);
    await this.datasource.run(`DELETE FROM conn_source WHERE workspace_id = ? AND name = ?`, [id, name]);
  }
}
