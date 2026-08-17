// M3 裁决确认 + M4 本体管理：按人工裁决产出合并本体（单一事实源）。
// 同时生成 merge_decisions 留痕（关系类型 + 证据快照 + 裁决人）。
import { NextResponse } from "next/server";
import { buildMergedOntology, toYaml } from "@/lib/ontology";

export async function POST(req: Request) {
  const { decisions, evidence, drafts } = await req.json();
  const merged = buildMergedOntology(decisions, drafts);
  const mergeDecisions = Object.entries(decisions).map(([key, type]) => ({
    pair: key,
    relation_type: type,
    evidence_snapshot: (evidence ?? []).find((e: { pair: string }) => e.pair.includes(key === "person" ? "candidate" : key === "department" ? "department ↔ hr" : "job_posting")) ?? null,
    decided_by: "demo_user",
    decided_at: new Date().toISOString(),
  }));
  return NextResponse.json({ ontology: merged, yaml: toYaml(merged), merge_decisions: mergeDecisions });
}
