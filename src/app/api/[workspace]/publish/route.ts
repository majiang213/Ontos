// 发布与放弃：POST /api/publish 发布（升版本、写版本文件）；DELETE /api/publish 放弃（回退到已发布快照）。
// 引擎只读已发布版本，发布后立即可查。配置不合法 422；写盘等自身故障 500。

import { discard, publish } from "@/server/features/ontology/versions";
import { engineEnv } from "@/server/runtime";
import { MSG } from "@/server/errors";
import { rejectRes, requireWriteAuth, respond, workspaceOf } from "@/app/api/_shared";

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  // 配置结构不合法（zod）与语义不合法（Result 422）同落 422：发布的拒绝都是配置问题
  return respond(async () => {
    const r = await publish(engineEnv(), await workspaceOf(params));
    if (r.code !== 200) return rejectRes(r);
    return { ok: true, version: r.value.version };
  }, { zod: { status: 422, error: MSG.zodConfigShape } });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const r = await discard(engineEnv(), await workspaceOf(params));
    if (r.code !== 200) return rejectRes(r);
    return { ok: true };
  });
}
