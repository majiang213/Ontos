// 裁决留痕、交集计数与候选快照：adj_decision（含版本回填/放弃标记）、adj_overlap（按对更新，值集合不落库）
// 与 adj_candidates（按草稿内容哈希一份快照，同一内容只问一次模型）。

import type { CandidateSnapshotRec, DecisionRec, OverlapRec } from "../types";
import { ConcernStore, upsertSql } from "./base";

export class AdjudicationStore extends ConcernStore {
  async recordDecision(workspace: string, d: DecisionRec): Promise<void> {
    const id = await this.wsId(workspace);
    await this.datasource.run(
      `INSERT INTO adj_decision (workspace_id, version, class_a, class_b, source_a, source_b, llm_advice, rate, evidence, verdict, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, d.version ?? null, d.class_a, d.class_b, d.source_a, d.source_b, d.llm_advice ?? null, d.rate ?? null, d.evidence ? JSON.stringify(d.evidence) : null, d.verdict, d.decided_by]
    );
  }

  async listDecisions(workspace: string): Promise<(DecisionRec & { id: number; created_at: string })[]> {
    const id = await this.wsId(workspace);
    const rows = await this.datasource.all(`SELECT * FROM adj_decision WHERE workspace_id = ? ORDER BY id DESC`, [id]);
    return rows.map((r) => ({ ...r, evidence: r.evidence ? JSON.parse(String(r.evidence)) : undefined })) as never[];
  }

  /** 发布时回填：把还没绑版本的裁决挂上这个版本。 */
  async backfillDecisionVersions(workspace: string, version: number): Promise<void> {
    const id = await this.wsId(workspace);
    await this.datasource.run(`UPDATE adj_decision SET version = ? WHERE workspace_id = ? AND version IS NULL`, [version, id]);
  }

  /** 放弃草稿时：未绑版本的裁决标成 -1（已放弃），不再随下一次发布回填。 */
  async abandonPendingDecisions(workspace: string): Promise<void> {
    const id = await this.wsId(workspace);
    await this.datasource.run(`UPDATE adj_decision SET version = -1 WHERE workspace_id = ? AND version IS NULL`, [id]);
  }

  /** 交集按对更新（同一对重复计算只留最新计数——由 UNIQUE(workspace_id, class_a, class_b) 兜底，方言 upsert 原子写；
   *  旧形态 DELETE+INSERT 两条，并发重算同一对会双行并存）。 */
  async recordOverlap(workspace: string, o: OverlapRec): Promise<void> {
    const id = await this.wsId(workspace);
    const vals = [id, o.class_a, o.class_b, o.norm_rule ?? null, o.count_a, o.count_b, o.count_hit, o.rate];
    const sql = upsertSql(
      this.datasource.dialect,
      "adj_overlap",
      ["workspace_id", "class_a", "class_b", "norm_rule", "count_a", "count_b", "count_hit", "rate"],
      ["workspace_id", "class_a", "class_b"],
      ["norm_rule", "count_a", "count_b", "count_hit", "rate"]
    );
    await this.datasource.run(sql, vals);
  }

  async listOverlaps(workspace: string): Promise<(OverlapRec & { id: number; created_at: string })[]> {
    const id = await this.wsId(workspace);
    return (await this.datasource.all(`SELECT * FROM adj_overlap WHERE workspace_id = ? ORDER BY id DESC`, [id])) as never[];
  }

  /** 读候选快照：没有过快照返回 null。 */
  async readCandidateSnapshot(workspace: string): Promise<CandidateSnapshotRec | null> {
    const id = await this.wsId(workspace);
    const rows = await this.datasource.all(`SELECT shot_hash, proposals FROM adj_candidates WHERE workspace_id = ?`, [id]);
    if (rows.length === 0) return null;
    return { shot_hash: String(rows[0].shot_hash), proposals: JSON.parse(String(rows[0].proposals)) };
  }

  /** 写候选快照：每空间一行，方言 upsert（并发重算同一内容，败者覆盖同值，无害）。 */
  async writeCandidateSnapshot(workspace: string, snap: CandidateSnapshotRec): Promise<void> {
    const id = await this.wsId(workspace);
    const sql = upsertSql(
      this.datasource.dialect,
      "adj_candidates",
      ["workspace_id", "shot_hash", "proposals"],
      ["workspace_id"],
      ["shot_hash", "proposals"]
    );
    await this.datasource.run(sql, [id, snap.shot_hash, JSON.stringify(snap.proposals)]);
  }
}
