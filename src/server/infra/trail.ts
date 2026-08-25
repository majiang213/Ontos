// 留痕编排 —— 问数与动作的留痕形状（字段、duration、版本号）唯一出处。路由与 MCP 共用。
// 住 infra 不住 features：跨域应用服务，问数与动作两域都消费；版本号由调用方传入
// （取数在调用方，本文件不反向依赖任何领域包）。

import type { ActionRequest } from "../schema/request";
import type { MetaStore } from "../meta/store";
import type { Result } from "../errors";

/** 留痕依赖：元库 + 时钟。EngineEnv 的结构子集——调用方直接把 env 传进来即可。 */
export interface TrailDeps {
  meta: MetaStore;
  clock: () => number;
}

/** 留痕尽力而为（可同步可异步）：响应失败的根因若正是元库故障，catch 里再抛就成非 JSON 响应。 */
export function safeLog(fn: () => void | Promise<void>): void {
  try {
    void Promise.resolve(fn()).catch(() => {});
  } catch {
    // 留痕失败不挡响应
  }
}

/** 问数留痕：fn 返回 Result（成功带 rows，失败带 message），成败各留一条；返回原 Result 不吞错误。
 *  base 是调用方知道的字段（question/model/query_json）；version 由调用方传入（问数发起时的已发布版本）。 */
export async function withQueryLog<T extends { rows: unknown[] }>(
  deps: TrailDeps,
  workspace: string,
  version: number,
  base: { question?: string; model?: string; query_json?: string },
  fn: () => Promise<Result<T>>
): Promise<Result<T>> {
  const started = deps.clock();
  try {
    const r = await fn();
    if (r.code === 200) {
      safeLog(async () => deps.meta.logQuery(workspace, { version, ...base, row_count: r.value.rows.length, ok: true, duration_ms: deps.clock() - started }));
    } else {
      safeLog(async () => deps.meta.logQuery(workspace, { version, ...base, ok: false, error: r.message, duration_ms: deps.clock() - started }));
    }
    return r;
  } catch (e) {
    // 意外异常（引擎故障）也留一条失败，再原样上抛（respond 兜 500）
    safeLog(async () => deps.meta.logQuery(workspace, { version, ...base, ok: false, error: e instanceof Error ? e.message : String(e), duration_ms: deps.clock() - started }));
    throw e;
  }
}

/** 动作留痕：结果装 ok/error/projections；异常记失败并重抛。解析失败（动作没成形）不留——本来就没这次动作。
 *  version 由调用方传入（动作发起时的已发布版本）。 */
export async function withActionLog<T extends { ok: boolean; error?: string; projections?: unknown }>(
  deps: TrailDeps,
  workspace: string,
  version: number,
  action: ActionRequest,
  fn: () => Promise<T>
): Promise<T> {
  const started = deps.clock();
  const log = (outcome: { ok: boolean; error?: string; projections?: unknown }) =>
    safeLog(async () =>
      deps.meta.logAction(workspace, {
        version,
        action: action.action,
        object_type: action.object,
        subject: String(action.identity),
        request_json: action.request ? JSON.stringify(action.request) : undefined,
        ...outcome,
        duration_ms: deps.clock() - started,
      })
    );
  try {
    const result = await fn();
    log({ ok: result.ok, error: result.error, projections: result.projections });
    return result;
  } catch (e) {
    log({ ok: false, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}
