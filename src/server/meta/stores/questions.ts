// 验收问题集（ont_question）：增删、状态随版本更新、失败原因落 detail。

import { ConcernStore } from "./base";

export class QuestionsStore extends ConcernStore {
  async listQuestions(workspace: string): Promise<{ id: number; question: string; expected?: string; status: string; detail?: string; version?: number }[]> {
    const id = await this.wsId(workspace);
    return (await this.backend.all(`SELECT * FROM ont_question WHERE workspace_id = ? ORDER BY id`, [id])) as never[];
  }

  async addQuestion(workspace: string, question: string, expected?: string): Promise<void> {
    const id = await this.wsId(workspace);
    await this.backend.run(`INSERT INTO ont_question (workspace_id, question, expected) VALUES (?, ?, ?)`, [id, question, expected ?? null]);
  }

  async removeQuestion(workspace: string, qid: number): Promise<void> {
    const id = await this.wsId(workspace);
    await this.backend.run(`DELETE FROM ont_question WHERE workspace_id = ? AND id = ?`, [id, qid]);
  }

  async setQuestionStatus(workspace: string, qid: number, status: string, version?: number, detail?: string): Promise<void> {
    const id = await this.wsId(workspace);
    await this.backend.run(`UPDATE ont_question SET status = ?, detail = ?, version = COALESCE(?, version) WHERE workspace_id = ? AND id = ?`, [status, detail ?? null, version ?? null, id, qid]);
  }
}
