// 逆向建模：POST /api/generate
// 多选的表 → 内省 → LLM 槽位产草稿（离线回退为确定性规则）→ 导入工作副本。
// 对象立刻上画布（草稿态），没有预览卡、没有确认草稿卡。

import { NextResponse } from "next/server";
import { z } from "zod";
import { demoDriver } from "@/lib/engine/load";
import { getSlot } from "@/lib/engine/llmSlot";
import { applyOp, DraftReject } from "@/lib/engine/configStore";
import { EngineReject } from "@/lib/engine/individual";
import { BadRequest, bodyJson, internalError, requireWriteAuth } from "@/app/api/_shared";

const bodySchema = z.object({
  tables: z.array(z.object({ connection: z.string(), table: z.string() })).nonempty(),
});

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  try {
    const { tables } = bodySchema.parse(await bodyJson(req));
    const registry = demoDriver();
    // 按连接分组：每个连接内省一次，N 张表不再做 N 次全库内省
    const byConn = new Map<string, Awaited<ReturnType<typeof registry.introspect>>>();
    for (const { connection } of tables) {
      if (!byConn.has(connection)) byConn.set(connection, await registry.introspect(connection));
    }
    const infos = tables.map(({ connection, table }) => {
      const info = byConn.get(connection)!.find((t) => t.name === table);
      if (!info) throw new DraftReject(`表不存在：${connection}.${table}`);
      return { connection, table: info };
    });
    const objects = await getSlot().draftObjects(infos);
    applyOp({ op: "import_objects", objects });
    return NextResponse.json({ ok: true, created: Object.keys(objects) });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "请求形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof DraftReject || e instanceof EngineReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return internalError(e);
  }
}
