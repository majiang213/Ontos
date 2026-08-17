// 已发布本体：GET /api/ontology
// 画布按这份配置画图：节点是对象类型，字段是属性，边是关系。

import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/engine/load";

export async function GET() {
  const config = loadConfig();
  return NextResponse.json({
    version: 1, // M4 版本化之前，种子配置即 v1
    object_types: config.object_types,
    link_types: config.link_types,
    outlets: config.outlets ?? {},
  });
}
