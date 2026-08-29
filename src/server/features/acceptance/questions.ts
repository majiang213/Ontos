// 验收问题集跑批 —— 逐条经 LLM 接口编译后交引擎执行，失败分阶段记：
//   编译失败（模型没产出结构化查询）/ 执行出错（本体或映射有误）/ 答案不符（查出来了但对不上期望）。
// 答错即本体或映射有误，回画布改对象或来源映射再跑；失败原因落 detail，界面点开能看。
// target=draft 时对当前草稿试跑：用工作副本的配置，结果不落验收记录（草稿没有版本可锚）。
// 路由只做解析与错误阶梯，跑批逻辑收在这里（薄路由）。

import { query } from "../query/query";
import { metricColumn } from "../query/assemble";
import type { QueryRequest } from "../../schema/request";
import type { Llm } from "../../infra/llm/llm";
import type { EngineEnv } from "../env";
import { getDraft, getPublished } from "../ontology/current";
import { MSG, toResult, type Result } from "../../errors";
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

/** 对期望：符合返回 null；不符返回白话原因（落 detail）。比较只在内存里做，结果集不落库。
 *  纯数字期望比对口径（要能当对错板）：聚合查询比合计——加总引擎产出列（count:* → count、count:status → count_status，
 *  列名规则单源在 assemble.metricColumn，不拿运算符名去 rows 里取）；列表查询比行数；
 *  显式 limit 比期望小 = 截断了，不能算对。queryReq 是编出来的结构化查询本体，比对口径按它分路。 */
export function checkExpected(raw: string | undefined, rows: Record<string, unknown>[], queryReq: QueryRequest): string | null {
  const e = parseExpected(raw);
  if (e === null) return EXPECTED_HINT;
  if (e.kind === "any") return null;
  if (e.kind === "rows") {
    if (queryReq.aggregate) {
      const metrics = queryReq.aggregate.metrics; // schema 已保证非空、指标名不重复；多条指标没法对单个期望数字
      if (metrics.length !== 1) return MSG.expectMultiMetric(metrics.length);
      const [op, field] = Object.entries(metrics[0])[0];
      const key = metricColumn(op, field);
      const total = rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);
      return total === e.n ? null : MSG.expectTotalMismatch(e.n, total);
    }
    if (queryReq.limit != null && queryReq.limit < e.n) return MSG.expectTruncated(queryReq.limit, e.n);
    return rows.length === e.n ? null : MSG.expectRowsMismatch(e.n, rows.length);
  }
  return rows.some((r) => String(r[e.field] ?? "").trim() === e.value) ? null : MSG.expectFieldMiss(e.field, e.value, rows.length);
}

export interface QuestionRunResult {
  id: number;
  question: string;
  status: QuestionStatus;
  detail: string;
}

/** 跑批：全量；onlyId 给了就只跑那一条。target=draft 对当前草稿试跑，状态不落库、版本返回 null。
 *  llm 可注入假实现（测试用），缺省用 env 的实现（无 Key 时 test 走演示实现，其他空间报错）。 */
export async function runQuestions(env: EngineEnv, workspace: string, opts: { onlyId?: number; llm?: Llm; target?: "published" | "draft" } = {}): Promise<Result<{ results: QuestionRunResult[]; version: number | null }>> {
  return toResult(async () => {
    const draft = opts.target === "draft";
    const { config, version } = draft ? { config: (await getDraft(env, workspace)).draft, version: null } : await getPublished(env, workspace);
    const llm = opts.llm ?? env.llm(workspace);
    const registry = await env.getRegistry(workspace);
    const all = await env.meta.listQuestions(workspace);
    const targets = opts.onlyId === undefined ? all : all.filter((q) => q.id === opts.onlyId);
    const results: QuestionRunResult[] = [];
    for (const q of targets) {
      let status: QuestionStatus = Q_STATUS.pass;
      let detail = "";
      try {
        const parsed = await llm.nlToQuery(q.question, config, workspace);
        const r = await query(env, config, registry, parsed);
        if (r.code !== 200) {
          status = Q_STATUS.error;
          detail = r.message;
        } else {
          const bad = checkExpected(q.expected, r.value.rows, parsed); // 比对带上查询：聚合比合计、过小 limit 不算对
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
    return { results, version };
  }, (v) => MSG.resultRunDone(v.results.length));
}
