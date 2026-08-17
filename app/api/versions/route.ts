// 版本历史与回滚：GET /api/versions 列表；POST /api/versions { version } 回滚到该版。
// 回滚是 Git revert 语义：旧内容作为新版本发布，历史链不断。

import { NextResponse } from "next/server";
import { z } from "zod";
import { listVersions, rollbackTo, DraftReject } from "@/lib/engine/configStore";

export async function GET() {
  return NextResponse.json({
    versions: listVersions().map((v) => ({ version: v.version, createdAt: v.createdAt })),
  });
}

export async function POST(req: Request) {
  try {
    const { version } = z.object({ version: z.number().int().positive() }).parse(await req.json());
    const result = rollbackTo(version);
    return NextResponse.json({ ok: true, version: result.version });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "请求形状不合法" }, { status: 400 });
    if (e instanceof DraftReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
