// 发布与放弃：POST /api/publish 发布（升版本、写版本文件）；DELETE /api/publish 放弃（回退到已发布快照）。
// 引擎只读已发布版本，发布后立即可查。配置不合法 422；写盘等自身故障 500。

import { NextResponse } from "next/server";
import { discardDraft, DraftReject, publishDraft } from "@/lib/engine/configStore";
import { ZodError } from "zod";
import { internalError, requireWriteAuth } from "@/app/api/_shared";

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  try {
    const { version } = publishDraft();
    return NextResponse.json({ ok: true, version });
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "配置结构不合法", issues: e.issues }, { status: 422 });
    if (e instanceof DraftReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return internalError(e);
  }
}

export async function DELETE(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  try {
    discardDraft();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return internalError(e);
  }
}
