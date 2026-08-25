// 版本历史：GET /api/versions 列表；POST /api/versions { version } 把该版覆盖到当前工作副本。
// 不插入新版本；问数仍读已发布。要让问数也变成这版，人再点发布。

import { z } from "zod";
import { engineEnv } from "@/server/runtime";
import { listVersions, rollbackTo } from "@/server/features/ontology/versions";
import { rejectRes, bodyJson, requireWriteAuth, respond, workspaceOf } from "@/app/api/_shared";

export async function GET(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => ({
    versions: (await listVersions(engineEnv(), await workspaceOf(params))).map((v) => ({ version: v.version, createdAt: v.createdAt })),
  }));
}

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const { version } = z.object({ version: z.number().int().positive() }).parse(await bodyJson(req));
    const r = await rollbackTo(engineEnv(), version, await workspaceOf(params));
    if (r.code !== 200) return rejectRes(r);
    return { ok: true, version: r.value.version };
  });
}
