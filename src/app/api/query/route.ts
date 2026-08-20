// M7 查询服务：POST /api/query
// 薄适配：解析并校验查询 JSON → 引擎按已发布配置求值 → 答案行 + 取数路径 + 留痕（不存结果集）。
// 自然语言 → 查询 JSON 是 Agent 的活（LLM 槽位），不在这条路由里。

import { NextResponse } from "next/server";
import { queryRequestSchema } from "@/server/schema/request";
import { runQuery } from "@/server/engine/query";
import { EngineReject } from "@/server/engine/individual";
import { getDriverRegistry } from "@/server/engine/load";
import { getPublished } from "@/server/engine/configStore";
import { metaStore } from "@/server/meta/store";
import { ZodError } from "zod";
import { BadRequest, bodyJson, internalError, safeLog, wsOf } from "@/app/api/_shared";

export async function POST(req: Request) {
  const started = Date.now();
  let queryJson: string | undefined;
  let ws = "default"; // wsOf 抛 BadRequest 时，catch 里的留痕也要有去处
  try {
    ws = wsOf(req);
    const query = queryRequestSchema.parse(await bodyJson(req));
    queryJson = JSON.stringify(query);
    const { rows, path } = await runQuery((await getPublished(ws)).config, await getDriverRegistry(ws), query);
    safeLog(async () => metaStore().logQuery(ws, { version: (await getPublished(ws)).version, query_json: queryJson, row_count: rows.length, ok: true, duration_ms: Date.now() - started }));
    return NextResponse.json({ rows, path });
  } catch (e) {
    safeLog(async () => metaStore().logQuery(ws, { version: (await getPublished(ws)).version, query_json: queryJson, ok: false, error: e instanceof Error ? e.message : String(e), duration_ms: Date.now() - started }));
    if (e instanceof ZodError) return NextResponse.json({ error: "请求形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof EngineReject) return NextResponse.json({ error: e.message }, { status: 422 }); // 引擎拒绝，不猜
    return internalError(e);
  }
}
