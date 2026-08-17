// M1 连接器（雏形）：GET /api/introspect
// 读当前驱动下各连接的表结构。源表是只读原料，不取业务行。

import { NextResponse } from "next/server";
import { demoDriver } from "@/lib/engine/load";
import type { SqliteFixtureDriver } from "@/lib/engine/fixture";

export async function GET() {
  const driver = demoDriver();
  // 鸭子判断，不用 instanceof：Next dev 下路由包与本模块可能各有类实例
  const fixture = driver as Partial<SqliteFixtureDriver>;
  if (typeof fixture.connections !== "function" || typeof fixture.introspect !== "function") {
    return NextResponse.json({ error: "当前驱动不支持内省" }, { status: 501 });
  }
  const sources = fixture.connections().map((connection) => ({
    connection,
    tables: fixture.introspect!(connection),
  }));
  return NextResponse.json({ sources });
}
