// M3 整合工作台 · 证据计算：对候选对算交集率（真实逻辑，内存完成）。
// 只返回比率/规则/统计摘要 —— 标识集合不落地（数据边界）。
import { NextResponse } from "next/server";
import { PAIR_CANDIDATES } from "@/lib/ontology";
import { analyzePair } from "@/lib/overlap";

export async function GET() {
  const evidence = PAIR_CANDIDATES.map((p) =>
    analyzePair(p.a.connection, p.a.table, p.b.connection, p.b.table, p.semanticHint),
  );
  return NextResponse.json(evidence);
}
