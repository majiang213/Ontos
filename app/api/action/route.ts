// M8 动作执行器：POST /api/action
// 薄适配：解析并校验写入请求 → 引擎按已发布动作执行 → 每条投影的成败 + 留痕。
// 前置不满足、公理拦截：不动任何源；投影阶段部分失败不回滚——补偿是重发同一动作或人工修库。

import { NextResponse } from "next/server";
import { actionRequestSchema, type ActionRequest } from "@/lib/schema/request";
import { runAction } from "@/lib/engine/action";
import { EngineReject } from "@/lib/engine/individual";
import { getDriverRegistry } from "@/lib/engine/load";
import { getPublished } from "@/lib/engine/configStore";
import { metaStore } from "@/lib/meta/store";
import { ZodError } from "zod";
import { BadRequest, bodyJson, internalError, requireWriteAuth, safeLog, wsOf } from "@/app/api/_shared";

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  const started = Date.now();
  let action: ActionRequest | undefined;
  let ws = "default";
  /** 留痕的公共部分：成功/失败两支只补差异字段。 */
  const log = (outcome: { ok: boolean; error?: string; projections?: unknown }) =>
    safeLog(async () => action && metaStore().logAction(ws, {
      version: (await getPublished(ws)).version,
      action: action.action,
      object_type: action.object,
      subject: String(action.identity),
      request_json: action.request ? JSON.stringify(action.request) : undefined,
      ...outcome,
      duration_ms: Date.now() - started,
    }));
  try {
    ws = wsOf(req);
    const parsed = actionRequestSchema.parse(await bodyJson(req));
    action = parsed;
    // 发号器落元数据库：重启不复位，补偿重发撞上幂等查重才成立
    const result = await runAction((await getPublished(ws)).config, await getDriverRegistry(ws), parsed, { nextSequence: (k, s) => metaStore().nextSeq(ws, k, s) });
    log({ ok: result.ok, error: result.error, projections: result.projections });
    // 领域内的失败（前置、公理、投影失败）装在结果里返回 422；抛出来的才是引擎故障
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (e) {
    // 引擎故障（未经 result 包装的抛出）也留痕——不留就查不到这次动作
    log({ ok: false, error: e instanceof Error ? e.message : String(e) });
    if (e instanceof ZodError) return NextResponse.json({ error: "请求形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof EngineReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return internalError(e);
  }
}
