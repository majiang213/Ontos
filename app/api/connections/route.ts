// 连接管理：GET 列表（剥掉密码）/ POST 保存（test:true 先测连通，通过才落库）/ DELETE 删除。
// 保存即注册进驱动注册表，即时生效；失败回滚注册。

import { NextResponse } from "next/server";
import { z } from "zod";
import { demoDriver, registerSaved } from "@/lib/engine/load";
import { metaStore } from "@/lib/meta/store";
import { BadRequest, bodyJson } from "@/app/api/_shared";

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
  options: z.record(z.string(), z.unknown()).optional(),
  test: z.boolean().optional(),
});

export async function GET() {
  // 密码不外发（存储明文是演示取舍，出网不是）
  const connections = metaStore()
    .listConnections()
    .map(({ ro_pass: _a, rw_pass: _b, ...rest }) => rest);
  return NextResponse.json({ connections });
}

export async function POST(req: Request) {
  try {
    const { test, ...rec } = connectionSchema.parse(await bodyJson(req));
    if (rec.type === "sqlite" && !rec.db_name) {
      return NextResponse.json({ error: "sqlite 连接必须给文件路径（db_name）" }, { status: 400 });
    }
    const registry = demoDriver();
    registerSaved(registry, rec); // 先注册，测试与内省都走注册表
    if (test) {
      try {
        const tables = await registry.introspect(rec.name);
        if (tables.length === 0) return NextResponse.json({ ok: true, warning: "连上了，但库里没有表", tables, saved: false });
      } catch (e) {
        registry.unregister(rec.name);
        return NextResponse.json({ error: `连不上：${e instanceof Error ? e.message : String(e)}` }, { status: 422 });
      }
    }
    metaStore().saveConnection(rec); // 测过才落库
    return NextResponse.json({ ok: true, saved: true });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "连接形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { name } = z.object({ name: z.string().min(1) }).parse(await bodyJson(req));
    metaStore().deleteConnection(name);
    demoDriver().unregister(name);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: "请求形状不合法" }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
