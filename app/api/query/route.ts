// M7 查询服务：POST /api/query
// 薄适配：解析并校验查询 JSON → 引擎按已发布配置求值 → 答案行 + 取数路径 + 留痕（不存结果集）。
// 自然语言 → 查询 JSON 是 Agent 的活（LLM 槽位），不在这条路由里。

import { NextResponse } from "next/server";
import { queryRequestSchema } from "@/lib/schema/request";
import { runQuery } from "@/lib/engine/query";
import { EngineReject } from "@/lib/engine/individual";
import { demoDriver, loadConfig } from "@/lib/engine/load";
import { getPublished } from "@/lib/engine/configStore";
import { metaStore } from "@/lib/meta/store";
import { ZodError } from "zod";
import { BadRequest, bodyJson, safeLog } from "@/app/api/_shared";

export async function POST(req: Request) {
  const started = Date.now();
  let queryJson: string | undefined;
  try {
    const query = queryRequestSchema.parse(await bodyJson(req));
    queryJson = JSON.stringify(query);
    const { rows, path } = await runQuery(loadConfig(), demoDriver(), query);
    safeLog(() => metaStore().logQuery({ version: getPublished().version, query_json: queryJson, row_count: rows.length, ok: true, duration_ms: Date.now() - started }));
    return NextResponse.json({ rows, path });
  } catch (e) {
    safeLog(() => metaStore().logQuery({ version: getPublished().version, query_json: queryJson, ok: false, error: e instanceof Error ? e.message : String(e), duration_ms: Date.now() - started }));
    if (e instanceof ZodError) return NextResponse.json({ error: "请求形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof EngineReject) return NextResponse.json({ error: e.message }, { status: 422 }); // 引擎拒绝，不猜
    return NextResponse.json({ error: "引擎内部错误", detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
