// 逆向建模建议：POST /api/propose_objects
// 多选的表 → 内省 → LLM 槽位产草稿（离线回退为确定性规则）。不写工作副本。
// 与 MCP propose_objects 同名同义；落地走 edit_draft 的 import_objects。

import { z } from "zod";
import { engineEnv } from "@/server/runtime";
import { getDriverRegistry } from "@/server/infra/connections";
import { proposeObjectsFor } from "@/server/infra/llm/slot";
import { EngineReject } from "@/server/errors";
import { bodyJson, rejectRes, respond, workspaceOf } from "@/app/api/_shared";

const bodySchema = z.object({
  tables: z.array(z.object({ connection: z.string(), table: z.string() })).nonempty(),
});

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => {
    const { tables } = bodySchema.parse(await bodyJson(req));
    const env = engineEnv();
    const registry = await getDriverRegistry(await workspaceOf(params));
    const r = await proposeObjectsFor(env.llm, registry, tables, (m) => new EngineReject(m));
    if (r.code !== 200) return rejectRes(r);
    return { object_types: r.value };
  });
}
