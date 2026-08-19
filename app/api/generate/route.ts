// 逆向建模：POST /api/generate
// 多选的表 → 内省 → LLM 槽位产草稿（离线回退为确定性规则）→ 导入工作副本。
// 对象立刻上画布（草稿态），没有预览卡、没有确认草稿卡。

import { NextResponse } from "next/server";
import { z } from "zod";
import { getDriverRegistry, resolveTableInfos } from "@/lib/engine/load";
import { getSlot } from "@/lib/engine/llmSlot";
import { applyOp, DraftReject } from "@/lib/engine/configStore";
import { EngineReject } from "@/lib/engine/individual";
import { BadRequest, bodyJson, internalError, requireWriteAuth, wsOf } from "@/app/api/_shared";

const bodySchema = z.object({
  tables: z.array(z.object({ connection: z.string(), table: z.string() })).nonempty(),
});

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  try {
    const ws = wsOf(req);
    const { tables } = bodySchema.parse(await bodyJson(req));
    const registry = getDriverRegistry(ws);
    // 按连接分组内省 + 逐表定位：引擎共享实现（mcp 同款）
    const infos = await resolveTableInfos(registry, tables, (m) => new DraftReject(m));
    const objects = await getSlot().draftObjects(infos);
    applyOp({ op: "import_objects", objects }, ws);
    return NextResponse.json({ ok: true, created: Object.keys(objects) });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "请求形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof DraftReject || e instanceof EngineReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return internalError(e);
  }
}
