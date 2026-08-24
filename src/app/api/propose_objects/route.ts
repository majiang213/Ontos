// 逆向建模建议：POST /api/propose_objects
// 多选的表 → 内省 → LLM 槽位产草稿（离线回退为确定性规则）。不写工作副本。
// 与 MCP propose_objects 同名同义；落地走 edit_draft 的 import_objects。

import { z } from "zod";
import { getDriverRegistry } from "@/server/engine/infra/load";
import { proposeObjectsFor } from "@/server/engine/llmSlot";
import { EngineReject } from "@/server/errors";
import { bodyJson, respond, wsOf } from "@/app/api/_shared";

const bodySchema = z.object({
  tables: z.array(z.object({ connection: z.string(), table: z.string() })).nonempty(),
});

export async function POST(req: Request) {
  return respond(async () => {
    const { tables } = bodySchema.parse(await bodyJson(req));
    const registry = await getDriverRegistry(wsOf(req));
    const object_types = await proposeObjectsFor(registry, tables, (m) => new EngineReject(m));
    return { object_types };
  });
}
