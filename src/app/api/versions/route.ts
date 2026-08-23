// 版本历史：GET /api/versions 列表；POST /api/versions { version } 把该版覆盖到当前工作副本。
// 不插入新版本；问数仍读已发布。要让问数也变成这版，人再点发布。

import { z } from "zod";
import { listVersions, rollbackTo } from "@/server/engine/configStore";
import { bodyJson, requireWriteAuth, respond, wsOf } from "@/app/api/_shared";

export async function GET(req: Request) {
  return respond(async () => ({
    versions: (await listVersions(wsOf(req))).map((v) => ({ version: v.version, createdAt: v.createdAt })),
  }));
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const { version } = z.object({ version: z.number().int().positive() }).parse(await bodyJson(req));
    const result = await rollbackTo(version, wsOf(req));
    return { ok: true, version: result.version };
  });
}
