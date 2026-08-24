// 逆向建模：POST /api/generate
// 多选的表 → 内省 → LLM 槽位产草稿（离线回退为确定性规则）→ 导入工作副本。
// 对象立刻上画布（草稿态），没有预览卡、没有确认草稿卡。

import { z } from "zod";
import { getDriverRegistry, resolveTableInfos } from "@/server/engine/load";
import { getSlot } from "@/server/engine/llmSlot";
import { applyOp, DraftReject } from "@/server/engine/configStore";
import { bodyJson, requireWriteAuth, respond, wsOf } from "@/app/api/_shared";

const bodySchema = z.object({
  tables: z.array(z.object({ connection: z.string(), table: z.string() })).nonempty(),
});

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const ws = wsOf(req);
    const { tables } = bodySchema.parse(await bodyJson(req));
    const registry = await getDriverRegistry(ws);
    // 按连接分组内省 + 逐表定位：引擎共享实现（mcp 同款）
    const infos = await resolveTableInfos(registry, tables, (m) => new DraftReject(m));
    const objects = await getSlot().draftObjects(infos);
    await applyOp({ op: "import_objects", objects }, ws);
    return { ok: true, created: Object.keys(objects) };
  });
}
