// 问数 API 台账：GET 列表 / POST 命名保存 / DELETE 删除。
// 每问一个新问题，编译出的结构化查询可命名保存为可复用 API。只存能过校验的查询。

import { NextResponse } from "next/server";
import { z } from "zod";
import { queryRequestSchema } from "@/server/schema/request";
import { metaStore } from "@/server/meta/store";
import { bodyJson, requireWriteAuth, respond, wsOf } from "@/app/api/_shared";

export async function GET(req: Request) {
  return respond(async () => ({ apis: await metaStore().listQueryApis(wsOf(req)) }));
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    let body: { name: string; question: string; query: unknown };
    try {
      body = z.object({ name: z.string().min(1), question: z.string().min(1), query: z.unknown() }).parse(await bodyJson(req));
    } catch {
      // 外层形状（name/question/query 齐不齐）单独报，不进错误阶梯
      return NextResponse.json({ error: "请求形状不合法（需要 name、question、query）" }, { status: 400 });
    }
    const query = queryRequestSchema.parse(body.query); // 形状问题一律 400，与其它路由同层
    await metaStore().saveQueryApi(wsOf(req), body.name, body.question, JSON.stringify(query));
    return { ok: true };
  }, { zod: { status: 400, error: "查询形状不合法" } });
}

export async function DELETE(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const { id } = z.object({ id: z.number() }).parse(await bodyJson(req));
    await metaStore().deleteQueryApi(wsOf(req), id);
    return { ok: true };
  });
}
