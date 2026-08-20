// 版本历史与回滚：GET /api/versions 列表；POST /api/versions { version } 回滚到该版。
// 回滚是 Git revert 语义：旧内容作为新版本发布，历史链不断。

import { NextResponse } from "next/server";
import { z } from "zod";
import { listVersions, rollbackTo, DraftReject } from "@/server/engine/configStore";
import { BadRequest, bodyJson, internalError, requireWriteAuth, wsOf } from "@/app/api/_shared";

export async function GET(req: Request) {
  try {
    return NextResponse.json({
      versions: (await listVersions(wsOf(req))).map((v) => ({ version: v.version, createdAt: v.createdAt })),
    });
  } catch (e) {
    return internalError(e);
  }
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  try {
    const { version } = z.object({ version: z.number().int().positive() }).parse(await bodyJson(req));
    const result = await rollbackTo(version, wsOf(req));
    return NextResponse.json({ ok: true, version: result.version });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "请求形状不合法" }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof DraftReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return internalError(e);
  }
}
