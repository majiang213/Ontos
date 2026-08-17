// 问数 API 台账：GET 列表 / POST 命名保存 / DELETE 删除。
// 每问一个新问题，编译出的结构化查询可命名保存为可复用 API。

import { NextResponse } from "next/server";
import { z } from "zod";
import { queryRequestSchema } from "@/lib/schema/request";
import { metaStore } from "@/lib/meta/store";

export async function GET() {
  return NextResponse.json({ apis: metaStore().listQueryApis() });
}

export async function POST(req: Request) {
  try {
    const body = z.object({ name: z.string().min(1), question: z.string().min(1), query: z.unknown() }).parse(await req.json());
    const query = queryRequestSchema.parse(body.query); // 只存能过校验的结构化查询
    metaStore().saveQueryApi(body.name, body.question, JSON.stringify(query));
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "查询形状不合法", issues: e.issues }, { status: 422 });
    throw e;
  }
}

export async function DELETE(req: Request) {
  const { id } = z.object({ id: z.number() }).parse(await req.json());
  metaStore().deleteQueryApi(id);
  return NextResponse.json({ ok: true });
}
