// 验收问题集跑批 —— 逐条经 LLM 槽位编译后交引擎执行，失败分阶段记：
//   编译失败（模型没产出结构化查询）/ 执行出错（本体或映射有误）/ 答案不符（查出来了但对不上期望）。
// 答错即本体或映射有误，回画布改对象或来源映射再跑；失败原因落 detail，界面点开能看。
// target=draft 时对当前草稿试跑：用工作副本的配置，结果不落验收记录（草稿没有版本可锚）。
// 路由只做解析与错误阶梯，跑批逻辑收在这里（薄路由）。

import { query } from "../query/query";
import type { LlmSlot } from "../../infra/llm/slot";
import type { EngineEnv } from "../env";
import { getDraft, getPublished } from "../ontology/current";
import { MSG, codeOf, type Result } from "../../errors";
import { Q_STATUS, type QuestionStatus } from "./questionStatus";

/** 期望结果的合法写法：留空（能查出就算过）/ 纯数字（比对行数）/ 字段=值（至少一行对上）。 */
export type Expected = { kind: "any" } | { kind: "rows"; n: number } | { kind: "cell"; field: string; value: string };

export const EXPECTED_HINT = "期望结果只认两种写法：纯数字（比对行数，如 3）或 字段=值（如 阶段=在途）";

/** 解析期望写法；不认识返回 null（新增时 400，跑批时按答案不符记并带上提示）。 */
export function parseExpected(raw?: string | null): Expected | null {
  const s = (raw ?? "").trim();
  if (!s) return { kind: "any" };
  if (/^\d+$/.test(s)) return { kind: "rows", n: Number(s) };
  const eq = s.indexOf("=");
  if (eq > 0) {
    const field = s.slice(0, eq).trim();
    const value = s.slice(eq + 1).trim();
    if (field && value) return { kind: "cell", field, value };
  }
  return null;
}

/** 对期望：符合返回 null；不符返回白话原因（落 detail）。比较只在内存里做，结果集不落库。 */
export function checkExpected(raw: string | undefined, rows: Record<string, unknown>[]): string | null {
  const e = parseExpected(raw);
  if (e === null) return EXPECTED_HINT;
  if (e.kind === "any") return null;
  if (e.kind === "rows") return rows.length === e.n ? null : `期望 ${e.n} 行，实得 ${rows.length} 行`;
  return rows.some((r) => String(r[e.field] ?? "").trim() === e.value) ? null : `没有一行的「${e.field}」等于「${e.value}」（实查 ${rows.length} 行）`;
}

export interface QuestionRunResult {
  id: number;
  question: string;
  status: QuestionStatus;
  detail: string;
}

/** 跑批：全量；onlyId 给了就只跑那一条。target=draft 对当前草稿试跑，状态不落库、版本返回 null。
 *  slot 可注入假实现（测试用），缺省用 env 的槽位（无 key 走离线回退）。 */
export async function runQuestions(env: EngineEnv, workspace: string, opts: { onlyId?: number; slot?: LlmSlot; target?: "published" | "draft" } = {}): Promise<Result<{ results: QuestionRunResult[]; version: number | null }>> {
  try {
    const draft = opts.target === "draft";
    const { config, version } = draft ? { config: (await getDraft(env, workspace)).draft, version: null } : await getPublished(env, workspace);
    const slot = opts.slot ?? env.llm;
    const registry = await env.getRegistry(workspace);
    const all = await env.meta.listQuestions(workspace);
    const targets = opts.onlyId === undefined ? all : all.filter((q) => q.id === opts.onlyId);
    const results: QuestionRunResult[] = [];
    for (const q of targets) {
      let status: QuestionStatus = Q_STATUS.pass;
      let detail = "";
      try {
        const parsed = await slot.nlToQuery(q.question, config, workspace);
        const r = await query(env, config, registry, parsed);
        if (r.code !== 200) {
          status = Q_STATUS.error;
          detail = r.message;
        } else {
          const bad = checkExpected(q.expected, r.value.rows);
          if (bad) {
            status = Q_STATUS.wrong;
            detail = bad;
          }
        }
      } catch (e) {
        status = Q_STATUS.compileFail;
        detail = e instanceof Error ? e.message : String(e);
      }
      if (!draft) await env.meta.setQuestionStatus(workspace, q.id, status, version ?? undefined, detail || undefined); // 试跑不碰验收记录
      results.push({ id: q.id, question: q.question, status, detail });
    }
    return { code: 200, message: MSG.resultRunDone(results.length), value: { results, version } };
  } catch (e) {
    const code = codeOf(e);
    if (code !== null) return { code, message: e instanceof Error ? e.message : String(e) };
    throw e;
  }
}
