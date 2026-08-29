// 逆向建模建议：POST /api/propose_objects
// 多选的表 → 内省 → LLM 接口产草稿（无 Key 时 test 空间为确定性规则）。不写工作副本（落地由画布再发 edit_draft import_objects）。
// 与 MCP propose_objects 同名同义。跨次生成撞名：prompt 带草稿已有类名（occupied），
// 接口返回后先跑 disambiguateClassNames 硬闸（撞名改 {connection}_{table}）再交还——import_objects 不再整批 422。

import { z } from "zod";
import { engineEnv } from "@/server/runtime";
import { getDriverRegistry } from "@/server/infra/connections";
import { disambiguateClassNames, proposeObjectsFor } from "@/server/infra/llm/llm";
import { getDraft } from "@/server/features/ontology/current";
import { EngineReject } from "@/server/errors";
import { bodyJson, rejectRes, respond, workspaceOf } from "@/app/api/_shared";

const bodySchema = z.object({
  tables: z.array(z.object({ connection: z.string(), table: z.string() })).nonempty(),
});

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => {
    const { tables } = bodySchema.parse(await bodyJson(req));
    const env = engineEnv();
    const workspace = await workspaceOf(params);
    const registry = await getDriverRegistry(workspace);
    const occupied = Object.keys((await getDraft(env, workspace)).draft.object_types); // 草稿已有类名：提示模型 + 硬闸都用这份
    const r = await proposeObjectsFor(env.llm(workspace), registry, tables, (m) => new EngineReject(m), occupied);
    if (r.code !== 200) return rejectRes(r);
    return { object_types: disambiguateClassNames(r.value, occupied) };
  });
}
