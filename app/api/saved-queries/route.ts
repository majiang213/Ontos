// 问数 API 台账：GET 列表 / POST 命名保存 / DELETE 删除。
// 每问一个新问题，编译出的结构化查询可命名保存为可复用 API。只存能过校验的查询。

import { NextResponse } from "next/server";
import { z } from "zod";
import { queryRequestSchema } from "@/lib/schema/request";
import { metaStore } from "@/lib/meta/store";
import { BadRequest, bodyJson } from "@/app/api/_shared";

export async function GET() {
  return NextResponse.json({ apis: metaStore().listQueryApis() });
}

export async function POST(req: Request) {
  let body: { name: string; question: string; query: unknown };
  try {
    body = z.object({ name: z.string().min(1), question: z.string().min(1), query: z.unknown() }).parse(await req.json());
  } catch {
    return NextResponse.json({ error: "请求形状不合法（需要 name、question、query）" }, { status: 400 });
  }
  try {
    const query = queryRequestSchema.parse(body.query);
    metaStore().saveQueryApi(body.name, body.question, JSON.stringify(query));
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "查询形状不合法", issues: e.issues }, { status: 422 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { id } = z.object({ id: z.number() }).parse(await bodyJson(req));
    metaStore().deleteQueryApi(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "请求形状不合法" }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
