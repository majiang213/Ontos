// 留痕编排 —— 问数与动作的留痕形状（字段、duration、版本号）唯一出处。路由与 MCP 共用。
// 版本号在成功/失败一刻取一次；留痕尽力而为，不挡响应（safeLog）。

import type { ActionRequest } from "../schema/request";
import { getPublished } from "./configStore";
import { metaStore } from "../meta/store";

/** 留痕尽力而为（可同步可异步）：响应失败的根因若正是元库故障，catch 里再抛就成非 JSON 响应。 */
export function safeLog(fn: () => void | Promise<void>): void {
  try {
    void Promise.resolve(fn()).catch(() => {});
  } catch {
    // 留痕失败不挡响应
  }
}

/** 问数留痕：fn 返回 { rows } 取行数；成功/失败各留一条。base 是调用方知道的字段（question/model/query_json）。 */
export async function withQueryLog<T extends { rows: unknown[] }>(
  ws: string,
  base: { question?: string; model?: string; query_json?: string },
  fn: () => Promise<T>
): Promise<T> {
  const started = Date.now();
  try {
    const out = await fn();
    safeLog(async () => metaStore().logQuery(ws, { version: (await getPublished(ws)).version, ...base, row_count: out.rows.length, ok: true, duration_ms: Date.now() - started }));
    return out;
  } catch (e) {
    safeLog(async () => metaStore().logQuery(ws, { version: (await getPublished(ws)).version, ...base, ok: false, error: e instanceof Error ? e.message : String(e), duration_ms: Date.now() - started }));
    throw e;
  }
}

/** 动作留痕：结果装 ok/error/projections；异常记失败并重抛。解析失败（动作没成形）不留——本来就没这次动作。 */
export async function withActionLog<T extends { ok: boolean; error?: string; projections?: unknown }>(ws: string, action: ActionRequest, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const log = (outcome: { ok: boolean; error?: string; projections?: unknown }) =>
    safeLog(async () =>
      metaStore().logAction(ws, {
        version: (await getPublished(ws)).version,
        action: action.action,
        object_type: action.object,
        subject: String(action.identity),
        request_json: action.request ? JSON.stringify(action.request) : undefined,
        ...outcome,
        duration_ms: Date.now() - started,
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
