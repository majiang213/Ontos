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

  /** 工作行的画布包（已 JSON.parse）+ 草稿修订号；还没有工作行返回 undefined。
   *  坏 JSON 硬炸（当前工作副本读不回来不能活）——与 versionCanvas 的历史行降级不对称是刻意的。 */
  async getDraftPack(workspace: string): Promise<{ pack: unknown; rev: number } | undefined> {
    const id = await this.wsId(workspace);
    const row = await this.backend.get(`SELECT canvas_json, rev FROM onto_version WHERE workspace_id = ? AND version IS NULL`, [id]);
    if (!row) return undefined;
    const raw = row.canvas_json;
    if (typeof raw !== "string" || !raw.length) throw new Error(MSG.workingPackBadJson);
    try {
      return { pack: JSON.parse(raw), rev: (row.rev as number) ?? 0 };
    } catch {
      throw new Error(MSG.workingPackBadJson);
    }
  }

  /** 工作行保存（显式 save 语义，不用 upsert）：
   *  有工作行 → CAS UPDATE（bump=1 自增 rev——界面状态 op 也 bump：内容写与界面写互相 CAS 检测；WHERE rev=expectedRev，0 行 = 冲突）；
   *  无工作行（首存）→ 显式 INSERT（并发首存撞 UNIQUE(draft_key) → 重读：rev 未前进则补 UPDATE（也带 rev 条件，重读到补写之间对方再写就判冲突），前进则判冲突）。
   *  成功返回保存后的 rev；冲突返回 null。 */
  async saveDraftPack(workspace: string, pack: unknown, expectedRev: number, bump: boolean): Promise<number | null> {
    const id = await this.wsId(workspace);
    const json = JSON.stringify(pack);
    const step = bump ? 1 : 0;
    const updated = await this.backend.run(
      `UPDATE onto_version SET canvas_json = ?, rev = rev + ? WHERE workspace_id = ? AND version IS NULL AND rev = ?`,
      [json, step, id, expectedRev]
    );
    if (updated > 0) return expectedRev + step;
    const row = await this.backend.get(`SELECT id, rev FROM onto_version WHERE workspace_id = ? AND version IS NULL`, [id]);
    if (!row) {
      try {
        await this.backend.run(`INSERT INTO onto_version (workspace_id, version, yaml, canvas_json, rev, origin) VALUES (?, NULL, '', ?, ?, 'publish')`, [id, json, expectedRev]);
        return expectedRev;
      } catch (e) {
        const rival = await this.backend.get(`SELECT rev FROM onto_version WHERE workspace_id = ? AND version IS NULL`, [id]);
        if (!rival) throw e; // 不是并发首存撞唯一：真实写错误，原样上抛（不套用草稿冲突文案）
        if ((rival.rev as number) !== expectedRev) return null; // 对方首存后又写入：冲突
        // 对方首存成功且 rev 未动：补写我们的包。补写也是 CAS（带 rev 条件）——重读到补写之间对方再写，宁可判冲突也不覆盖
        const patched = await this.backend.run(
          `UPDATE onto_version SET canvas_json = ?, rev = rev + ? WHERE workspace_id = ? AND version IS NULL AND rev = ?`,
          [json, step, id, expectedRev]
        );
        return patched > 0 ? expectedRev + step : null;
      }
    }
    return null; // 有工作行但 rev 对不上：CAS 冲突
  }
}
