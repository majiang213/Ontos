// 逆向建模：POST /api/generate
// 多选的表 → 内省 → LLM 槽位产草稿（离线回退为确定性规则）→ 导入工作副本。
// 对象立刻上画布（草稿态），没有预览卡、没有确认草稿卡。

import { NextResponse } from "next/server";
import { z } from "zod";
import { demoDriver } from "@/lib/engine/load";
import { getSlot } from "@/lib/engine/llmSlot";
import { applyOp, DraftReject } from "@/lib/engine/configStore";

const bodySchema = z.object({
  tables: z.array(z.object({ connection: z.string(), table: z.string() })).nonempty(),
});

export async function POST(req: Request) {
  try {
    const { tables } = bodySchema.parse(await req.json());
    const registry = demoDriver();
    // 逐张内省（不取业务行），交槽位产草稿
    const infos = await Promise.all(
      tables.map(async ({ connection, table }) => {
        const all = await registry.introspect(connection);
        const info = all.find((t) => t.name === table);
        if (!info) throw new DraftReject(`表不存在：${connection}.${table}`);
        return { connection, table: info };
      })
    );
    const objects = await getSlot().draftObjects(infos);
    applyOp({ op: "import_objects", objects });
    return NextResponse.json({ ok: true, created: Object.keys(objects) });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "请求形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof DraftReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
