// 验收问题集跑批 —— 逐条经 LLM 槽位编译后交引擎执行，失败分阶段记：
//   编译失败（模型没产出结构化查询）/ 执行出错（本体或映射有误）/ 答案不符（查出来了但对不上期望）。
// 答错即本体或映射有误，回画布改对象或来源映射再跑；失败原因落 detail，界面点开能看。
// target=draft 时对当前草稿试跑：用工作副本的配置，结果不落验收记录（草稿没有版本可锚）。
// 路由只做解析与错误阶梯，跑批逻辑收在这里（薄路由）。

import { query } from "./query";
import { getSlot, type LlmSlot } from "../llmSlot";
import { getDriverRegistry } from "../infra/load";
import { getDraft, getPublished } from "../config/configStore";
import { metaStore } from "../../meta/store";

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
  status: string;
  detail: string;
}

/** 跑批：全量；onlyId 给了就只跑那一条。target=draft 对当前草稿试跑，状态不落库、版本返回 null。
 *  slot 可注入假实现（测试用），缺省按环境选（无 key 走离线回退）。 */
export async function runQuestions(ws: string, opts: { onlyId?: number; slot?: LlmSlot; target?: "published" | "draft" } = {}): Promise<{ results: QuestionRunResult[]; version: number | null }> {
  const draft = opts.target === "draft";
  const { config, version } = draft ? { config: (await getDraft(ws)).draft, version: null } : await getPublished(ws);
  const slot = opts.slot ?? getSlot();
  const registry = await getDriverRegistry(ws);
  const all = await metaStore().listQuestions(ws);
  const targets = opts.onlyId === undefined ? all : all.filter((q) => q.id === opts.onlyId);
  const results: QuestionRunResult[] = [];
  for (const q of targets) {
    let status = "通过";
    let detail = "";
    try {
      const parsed = await slot.nlToQuery(q.question, config, ws);
      try {
        const { rows } = await query(config, registry, parsed);
        const bad = checkExpected(q.expected, rows);
        if (bad) {
          status = "答案不符";
          detail = bad;
        }
      } catch (e) {
        status = "执行出错";
        detail = e instanceof Error ? e.message : String(e);
      }
    } catch (e) {
      status = "编译失败";
      detail = e instanceof Error ? e.message : String(e);
    }
    if (!draft) await metaStore().setQuestionStatus(ws, q.id, status, version ?? undefined, detail || undefined); // 试跑不碰验收记录
    results.push({ id: q.id, question: q.question, status, detail });
  }
  return { results, version };
}
