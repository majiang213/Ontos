// 问数与动作留痕（log_query / log_action）：存请求与成败，不存结果集。

import type { ActionLogRec, QueryLogRec } from "../types";
import { ConcernStore } from "./base";

export class LogsStore extends ConcernStore {
  async logQuery(workspace: string, l: QueryLogRec): Promise<void> {
    const id = await this.wsId(workspace);
    await this.backend.run(
      `INSERT INTO log_query (workspace_id, version, session_id, model, question, query_json, row_count, error, duration_ms, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, l.version ?? null, l.session_id ?? null, l.model ?? null, l.question ?? null, l.query_json ?? null, l.row_count ?? null, l.error ?? null, l.duration_ms ?? null, l.ok ? 1 : 0]
    );
  }

  async logAction(workspace: string, l: ActionLogRec): Promise<void> {
    const id = await this.wsId(workspace);
    await this.backend.run(
      `INSERT INTO log_action (workspace_id, version, action, object_type, subject, request_json, projections, error, duration_ms, ok)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, l.version ?? null, l.action, l.object_type, l.subject, l.request_json ?? null, l.projections ? JSON.stringify(l.projections) : null, l.error ?? null, l.duration_ms ?? null, l.ok ? 1 : 0]
    );
  }

  async listQueryLogs(workspace: string, limit = 50): Promise<Record<string, unknown>[]> {
    const id = await this.wsId(workspace);
    return this.backend.all(`SELECT * FROM log_query WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`, [id, limit]);
  }

  async listActionLogs(workspace: string, limit = 50): Promise<Record<string, unknown>[]> {
    const id = await this.wsId(workspace);
    return this.backend.all(`SELECT * FROM log_action WHERE workspace_id = ? ORDER BY id DESC LIMIT ?`, [id, limit]);
  }
}
