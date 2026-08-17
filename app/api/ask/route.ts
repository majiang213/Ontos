// 问数：POST /api/ask
// 自然语言 → 查询 JSON 是 LLM 槽位（generateObject + Zod，读配置视图，不写死名字）。
// 槽位没接模型之前，这里是罐头映射，只认演示剧本的几个问题——形状与槽位产物一致。

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { queryRequestSchema, type QueryRequest } from "@/lib/schema/request";
import { runQuery } from "@/lib/engine/query";
import { EngineReject } from "@/lib/engine/individual";
import { demoDriver, loadConfig } from "@/lib/engine/load";

function compile(question: string): QueryRequest {
  if (/每个部门|各部门|多少台|多少设备/.test(question)) {
    return {
      object: "equipment",
      filter: { status: "in_service" },
      aggregate: { group_by: ["dept"], metrics: [{ count: "*" }] },
    };
  }
  if (/过保/.test(question)) {
    return { object: "equipment", properties: ["name", "serial_no"], filter: { in_warranty: false } };
  }
  if (/在途/.test(question)) {
    return { object: "equipment", properties: ["name", "serial_no"], filter: { status: "in_transit" } };
  }
  if (/报废/.test(question)) {
    return { object: "equipment", properties: ["name", "serial_no"], filter: { status: "scrapped" } };
  }
  if (/在役|部门/.test(question)) {
    return {
      object: "equipment",
      properties: ["name"],
      filter: { status: "in_service" },
      expand: [{ relation: "belongs_to", properties: ["name"] }],
    };
  }
  return { object: "equipment", properties: ["name", "status"] };
}

export async function POST(req: Request) {
  try {
    const { question } = (await req.json()) as { question: string };
    if (!question?.trim()) return NextResponse.json({ error: "问题为空" }, { status: 400 });
    const query = queryRequestSchema.parse(compile(question));
    const { rows, path } = runQuery(loadConfig(), demoDriver(), query);
    return NextResponse.json({ question, query, rows, path });
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "请求形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof EngineReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return NextResponse.json({ error: "引擎内部错误", detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
