// 发布与放弃：POST /api/publish 发布（升版本、写版本文件）；DELETE /api/publish 放弃（回退到已发布快照）。
// 引擎只读已发布版本，发布后立即可查。配置不合法 422；写盘等自身故障 500。

import { discard, publish } from "@/server/engine/draft/versions";
import { MSG } from "@/server/errors";
import { requireWriteAuth, respond, wsOf } from "@/app/api/_shared";

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  // 配置结构不合法（zod）与语义不合法（DraftReject）同落 422：发布的拒绝都是配置问题
  return respond(async () => ({ ok: true, ...(await publish(wsOf(req))) }), { zod: { status: 422, error: MSG.zodConfigShape } });
}

export async function DELETE(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    await discard(wsOf(req));
    return { ok: true };
  });
}
