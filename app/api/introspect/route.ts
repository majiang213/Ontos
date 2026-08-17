// M1 连接器（雏形）：GET /api/introspect
// 读当前驱动下各连接的表结构。源表是只读原料，不取业务行。

import { NextResponse } from "next/server";
import { demoDriver } from "@/lib/engine/load";
import { SqliteFixtureDriver } from "@/lib/engine/fixture";

export async function GET() {
  const driver = demoDriver();
  if (!(driver instanceof SqliteFixtureDriver)) {
    return NextResponse.json({ error: "当前驱动不是 fixture" }, { status: 501 });
  }
  const sources = driver.connections().map((connection) => ({
    connection,
    tables: driver.introspect(connection),
  }));
  return NextResponse.json({ sources });
}
