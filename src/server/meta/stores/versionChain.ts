// 版本链与工作行：YAML 全量快照入库；onto_version 里 version IS NULL 的一行是可变头（画布全部内容的唯一落点）。

import { ConcernStore } from "./base";
import { MSG } from "../../errors";

export class VersionChainStore extends ConcernStore {
  async latestVersion(ws: string, seedYaml: string): Promise<{ version: number; yaml: string }> {
    const id = await this.wsId(ws);
    const row = await this.backend.get(`SELECT version, yaml FROM onto_version WHERE workspace_id = ? AND version IS NOT NULL ORDER BY version DESC LIMIT 1`, [id]);
    if (row) return { version: row.version as number, yaml: row.yaml as string };
    // 被元数据写抢注的空间：种子补成 v1。并发首访各插一行撞 UNIQUE(workspace_id, version)——
    // insert-ignore 让败者无害（与 wsId/ensureWorkspace 同一条纪律，基座 runInsertIgnore）
    await this.runInsertIgnore(`onto_version (workspace_id, version, yaml, origin) VALUES (?, 1, ?, 'publish')`, [id, seedYaml]);
    return { version: 1, yaml: seedYaml };
  }

  async insertVersion(ws: string, version: number, yaml: string, origin: "publish", canvas?: unknown): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(
      `INSERT INTO onto_version (workspace_id, version, yaml, canvas_json, origin) VALUES (?, ?, ?, ?, ?)`,
      [id, version, yaml, canvas == null ? null : JSON.stringify(canvas), origin]
    );
  }

  async listVersions(ws: string): Promise<{ version: number; createdAt: string; origin: string }[]> {
    const id = await this.wsId(ws);
    const rows = await this.backend.all(`SELECT version, origin, created_at FROM onto_version WHERE workspace_id = ? AND version IS NOT NULL ORDER BY version`, [id]);
    return rows.map((r) => ({ version: r.version as number, origin: String(r.origin), createdAt: String(r.created_at) }));
  }

  async versionYaml(ws: string, version: number): Promise<string | undefined> {
    const id = await this.wsId(ws);
    const row = await this.backend.get(`SELECT yaml FROM onto_version WHERE workspace_id = ? AND version = ?`, [id, version]);
    return row?.yaml as string | undefined;
  }

  /** 该版发布时的画布快照（对象 + 线 + 摆位）。旧行可能没有。 */
  async versionCanvas(ws: string, version: number): Promise<unknown | undefined> {
    const id = await this.wsId(ws);
    const row = await this.backend.get(`SELECT canvas_json FROM onto_version WHERE workspace_id = ? AND version = ?`, [id, version]);
    const raw = row?.canvas_json;
    if (typeof raw !== "string" || !raw.length) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  /** 工作行的画布包（canvas_json，已 JSON.parse）；还没有工作行返回 undefined。 */
  async getWorkingPack(ws: string): Promise<unknown | undefined> {
    const id = await this.wsId(ws);
    const row = await this.backend.get(`SELECT canvas_json FROM onto_version WHERE workspace_id = ? AND version IS NULL`, [id]);
    const raw = row?.canvas_json;
    if (typeof raw !== "string" || !raw.length) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(MSG.workingPackBadJson);
    }
  }

  /** upsert 工作行：version IS NULL 不进 UNIQUE 约束，「每空间恰一行」的纪律收在这一处。 */
  async setWorkingPack(ws: string, pack: unknown): Promise<void> {
    const id = await this.wsId(ws);
    const existing = await this.backend.get(`SELECT id FROM onto_version WHERE workspace_id = ? AND version IS NULL`, [id]);
    if (existing) await this.backend.run(`UPDATE onto_version SET canvas_json = ? WHERE id = ?`, [JSON.stringify(pack), existing.id]);
    else await this.backend.run(`INSERT INTO onto_version (workspace_id, version, yaml, canvas_json, origin) VALUES (?, NULL, '', ?, 'publish')`, [id, JSON.stringify(pack)]);
  }
}
