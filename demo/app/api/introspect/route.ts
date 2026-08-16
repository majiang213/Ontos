// M1 连接器：只读表结构。不返回任何业务行（采样也不给），避免界面泄密。
import { NextResponse } from "next/server";
import { SOURCES } from "@/lib/sources";

export async function GET() {
  const result = SOURCES.map((db) => ({
    connection: db.connection,
    kind: db.kind,
    tables: db.tables.map((t) => ({
      name: t.name,
      comment: t.comment,
      columns: t.columns,
    })),
  }));
  return NextResponse.json(result);
}
