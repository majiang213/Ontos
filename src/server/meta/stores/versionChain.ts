// 版本链与工作行：YAML 全量快照入库；onto_version 里 version IS NULL 的一行是可变头（画布全部内容的唯一落点）。

import { ConcernStore } from "./base";
import { MSG } from "../../errors";

export class VersionChainStore extends ConcernStore {
  async latestVersion(workspace: string, seedYaml: string): Promise<{ version: number; yaml: string }> {
    const id = await this.wsId(workspace);
    const row = await this.backend.get(`SELECT version, yaml FROM onto_version WHERE workspace_id = ? AND version IS NOT NULL ORDER BY version DESC LIMIT 1`, [id]);
    if (row) return { version: row.version as number, yaml: row.yaml as string };
    // 被元数据写抢注的空间：种子补成 v1。并发首访各插一行撞 UNIQUE(workspace_id, version)——
    // insert-ignore 让败者无害（与 wsId/ensureWorkspace 同一条纪律，基座 runInsertIgnore）
    await this.runInsertIgnore(`onto_version (workspace_id, version, yaml, origin) VALUES (?, 1, ?, 'publish')`, [id, seedYaml]);
    return { version: 1, yaml: seedYaml };
  }

  async insertVersion(workspace: string, version: number, yaml: string, origin: "publish", canvas?: unknown): Promise<void> {
    const id = await this.wsId(workspace);
    await this.backend.run(
      `INSERT INTO onto_version (workspace_id, version, yaml, canvas_json, origin) VALUES (?, ?, ?, ?, ?)`,
      [id, version, yaml, canvas == null ? null : JSON.stringify(canvas), origin]
    );
  }

  async listVersions(workspace: string): Promise<{ version: number; createdAt: string; origin: string }[]> {
    const id = await this.wsId(workspace);
    const rows = await this.backend.all(`SELECT version, origin, created_at FROM onto_version WHERE workspace_id = ? AND version IS NOT NULL ORDER BY version`, [id]);
    return rows.map((r) => ({ version: r.version as number, origin: String(r.origin), createdAt: String(r.created_at) }));
  }

  async versionYaml(workspace: string, version: number): Promise<string | undefined> {
    const id = await this.wsId(workspace);
    const row = await this.backend.get(`SELECT yaml FROM onto_version WHERE workspace_id = ? AND version = ?`, [id, version]);
    return row?.yaml as string | undefined;
  }

  /** 该版发布时的画布快照（对象 + 线 + 摆位）。旧行可能没有。
   *  坏 JSON 按「没有画布包」降级（本体不丢、摆位走 dagre）——与 getWorkingPack 的硬炸不对称是刻意的：
   *  历史版本的界面状态丢了能活，当前工作副本读不回来不能活；降级留服务端诊断一行。 */
  async versionCanvas(workspace: string, version: number): Promise<unknown | undefined> {
    const id = await this.wsId(workspace);
    const row = await this.backend.get(`SELECT canvas_json FROM onto_version WHERE workspace_id = ? AND version = ?`, [id, version]);
    const raw = row?.canvas_json;
    if (typeof raw !== "string" || !raw.length) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      console.warn(`[ontos] v${version} 的 canvas_json 不是合法 JSON，按没有画布包处理（摆位将走自动布局）`);
      return undefined;
    }
  }

  /** 工作行的画布包（canvas_json，已 JSON.parse）；还没有工作行返回 undefined。 */
  async getWorkingPack(workspace: string): Promise<unknown | undefined> {
    const id = await this.wsId(workspace);
    const row = await this.backend.get(`SELECT canvas_json FROM onto_version WHERE workspace_id = ? AND version IS NULL`, [id]);
    const raw = row?.canvas_json;
    if (typeof raw !== "string" || !raw.length) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(MSG.workingPackBadJson);
    }
  }

  /** upsert 工作行：version IS NULL 不进 UNIQUE 约束——「每空间恰一行」的保证者不在本函数
   *  （SELECT 后 INSERT 拦不住并发双行），是上游的每空间写队列（runtime tails，editDraft/versions 都经它串行）。 */
  async setWorkingPack(workspace: string, pack: unknown): Promise<void> {
    const id = await this.wsId(workspace);
    const existing = await this.backend.get(`SELECT id FROM onto_version WHERE workspace_id = ? AND version IS NULL`, [id]);
    if (existing) await this.backend.run(`UPDATE onto_version SET canvas_json = ? WHERE id = ?`, [JSON.stringify(pack), existing.id]);
    else await this.backend.run(`INSERT INTO onto_version (workspace_id, version, yaml, canvas_json, origin) VALUES (?, NULL, '', ?, 'publish')`, [id, JSON.stringify(pack)]);
  }
}
