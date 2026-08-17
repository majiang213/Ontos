// 连接管理：GET 列表 / POST 保存 / DELETE 删除；POST body 带 test:true 时先测连通。
// 保存即注册进驱动注册表，即时生效。mysql/pg 无活库时测试会失败并如实返回原因。

import { NextResponse } from "next/server";
import { z } from "zod";
import { demoDriver, registerSaved } from "@/lib/engine/load";
import { metaStore } from "@/lib/meta/store";

const connectionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "连接名必须是小写字母/数字/下划线"),
  type: z.enum(["mysql", "pg", "sqlite"]),
  host: z.string().optional(),
  port: z.number().int().optional(),
  db_name: z.string().optional(),
  ro_user: z.string().optional(),
  ro_pass: z.string().optional(),
  rw_user: z.string().optional(),
  rw_pass: z.string().optional(),
  test: z.boolean().optional(), // 保存前先测连通
});

export async function GET() {
  return NextResponse.json({ connections: metaStore().listConnections() });
}

export async function POST(req: Request) {
  try {
    const { test, ...rec } = connectionSchema.parse(await req.json());
    const registry = demoDriver();
    registerSaved(registry, rec); // 先注册，测试与内省都走注册表
    if (test) {
      try {
        const tables = await registry.introspect(rec.name);
        if (tables.length === 0) return NextResponse.json({ ok: true, warning: "连上了，但库里没有表", tables });
        return NextResponse.json({ ok: true, tables });
      } catch (e) {
        registry.unregister(rec.name);
        return NextResponse.json({ error: `连不上：${e instanceof Error ? e.message : String(e)}` }, { status: 422 });
      }
    }
    metaStore().saveConnection(rec);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "连接形状不合法", issues: e.issues }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const { name } = (await req.json()) as { name: string };
  metaStore().deleteConnection(name);
  demoDriver().unregister(name);
  return NextResponse.json({ ok: true });
}
