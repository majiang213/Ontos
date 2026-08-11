// M5 正向生成器：本体 → 迁移 DDL + CRUD API 清单 + 页面清单（确定性模板）。
import { NextResponse } from "next/server";
import { generate } from "@/lib/codegen";

export async function POST(req: Request) {
  const { ontology } = await req.json();
  return NextResponse.json(generate(ontology));
}
