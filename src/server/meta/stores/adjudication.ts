// 裁决留痕与交集计数：adj_decision（含版本回填/放弃标记）与 adj_overlap（按对更新，值集合不落库）。

import type { DecisionRec, OverlapRec } from "../types";
import { ConcernStore } from "./base";

export class AdjudicationStore extends ConcernStore {
  async recordDecision(ws: string, d: DecisionRec): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(
      `INSERT INTO adj_decision (workspace_id, version, class_a, class_b, source_a, source_b, llm_advice, rate, evidence, verdict, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, d.version ?? null, d.class_a, d.class_b, d.source_a, d.source_b, d.llm_advice ?? null, d.rate ?? null, d.evidence ? JSON.stringify(d.evidence) : null, d.verdict, d.decided_by]
    );
  }

  async listDecisions(ws: string): Promise<(DecisionRec & { id: number; created_at: string })[]> {
    const id = await this.wsId(ws);
    const rows = await this.backend.all(`SELECT * FROM adj_decision WHERE workspace_id = ? ORDER BY id DESC`, [id]);
    return rows.map((r) => ({ ...r, evidence: r.evidence ? JSON.parse(String(r.evidence)) : undefined })) as never[];
  }

  /** 发布时回填：把还没绑版本的裁决挂上这个版本。 */
  async backfillDecisionVersions(ws: string, version: number): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(`UPDATE adj_decision SET version = ? WHERE workspace_id = ? AND version IS NULL`, [version, id]);
  }

  /** 放弃草稿时：未绑版本的裁决标成 -1（已放弃），不再随下一次发布回填。 */
  async abandonPendingDecisions(ws: string): Promise<void> {
    const id = await this.wsId(ws);
    await this.backend.run(`UPDATE adj_decision SET version = -1 WHERE workspace_id = ? AND version IS NULL`, [id]);
  }

  /** 交集按对更新（同一对重复计算只留最新计数——由 UNIQUE(workspace_id, class_a, class_b) 兜底，方言 upsert 原子写；
   *  旧形态 DELETE+INSERT 两条，并发重算同一对会双行并存）。 */
  async recordOverlap(ws: string, o: OverlapRec): Promise<void> {
    const id = await this.wsId(ws);
    const vals = [id, o.class_a, o.class_b, o.norm_rule ?? null, o.count_a, o.count_b, o.count_hit, o.rate];
    await this.backend.run(
      this.backend.dialect === "mysql"
        ? `INSERT INTO adj_overlap (workspace_id, class_a, class_b, norm_rule, count_a, count_b, count_hit, rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE norm_rule = VALUES(norm_rule), count_a = VALUES(count_a), count_b = VALUES(count_b), count_hit = VALUES(count_hit), rate = VALUES(rate)`
        : `INSERT INTO adj_overlap (workspace_id, class_a, class_b, norm_rule, count_a, count_b, count_hit, rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, class_a, class_b) DO UPDATE SET norm_rule = excluded.norm_rule, count_a = excluded.count_a, count_b = excluded.count_b, count_hit = excluded.count_hit, rate = excluded.rate`,
      vals
    );
  }

  async listOverlaps(ws: string): Promise<(OverlapRec & { id: number; created_at: string })[]> {
    const id = await this.wsId(ws);
    return (await this.backend.all(`SELECT * FROM adj_overlap WHERE workspace_id = ? ORDER BY id DESC`, [id])) as never[];
  }
}
