// M7 查询服务：POST /api/query
// 薄适配：解析并校验查询 JSON → 引擎按已发布配置求值 → 答案行 + 取数路径 + 留痕（不存结果集）。
// 自然语言 → 查询 JSON 是 Agent 的活（LLM 槽位），不在这条路由里。

import { queryRequestSchema } from "@/server/schema/request";
import { engineEnv } from "@/server/runtime";
import { query } from "@/server/features/query/query";
import { getDriverRegistry } from "@/server/infra/connections";
import { getPublished } from "@/server/features/ontology/current";
import { withQueryLog } from "@/server/infra/trail";
import { bodyJson, rejectRes, respond, workspaceOf } from "@/app/api/_shared";

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => {
    const workspace = await workspaceOf(params);
    const parsed = queryRequestSchema.parse(await bodyJson(req));
    const env = engineEnv();
    const { config, version } = await getPublished(env, workspace); // 版本号随留痕由调用方传入（问数发起时的已发布版本）
    const r = await withQueryLog({ meta: env.meta, clock: env.clock }, workspace, version, { query_json: JSON.stringify(parsed) }, async () =>
      query(env, config, await getDriverRegistry(workspace), parsed)
    );
    if (r.code !== 200) return rejectRes(r);
    return r.value;
  });
}
