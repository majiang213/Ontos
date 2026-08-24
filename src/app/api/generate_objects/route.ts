// 逆向建模：POST /api/generate_objects
// 多选的表 → 内省 → LLM 槽位产草稿（离线回退为确定性规则）→ 导入工作副本。
// 对象立刻上画布（草稿态），没有预览卡、没有确认草稿卡。

import { z } from "zod";
import { getDriverRegistry } from "@/server/engine/infra/load";
import { proposeObjectsFor } from "@/server/engine/llmSlot";
import { applyDraft } from "@/server/engine/config/configStore";
import { DraftReject } from "@/server/errors";
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
    // 按连接分组内省 + 逐表定位 + 槽位产草稿：组合原语（llmSlot.proposeObjectsFor，MCP 同款）
    const objects = await proposeObjectsFor(registry, tables, (m) => new DraftReject(m));
    await applyDraft({ op: "import_objects", objects }, ws);
    return { ok: true, created: Object.keys(objects) };
  });
}
