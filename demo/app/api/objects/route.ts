// 新系统（本体即应用）的对象列表：实时联邦查源库，不落库。
// person 走查询服务的统一逻辑（identity 合并 + status 派生 + works_in expand）；
// 其他对象按 sources 做 union，有识别字段则归一化去重。
import { NextResponse } from "next/server";
import { getTable } from "@/lib/sources";
import { RULES, normalizeWith } from "@/lib/normalize";
import { execute } from "@/lib/queryService";
import type { Ontology } from "@/lib/ontology";

export async function POST(req: Request) {
  const { ontology, object } = (await req.json()) as { ontology: Ontology; object: string };
  const obj = ontology?.object_types?.[object];
  if (!obj) return NextResponse.json({ error: `本体中没有对象 ${object}` }, { status: 404 });

  const sources = obj.sources.map((s) => `${s.connection}.${s.table}`);

  // person：identity 合并 + 派生 status + 沿关系取部门（复用查询服务，同一套机制）
  if (obj.identity === "id_card") {
    const { rows } = execute(ontology, { object, expand: ["department"] });
    return NextResponse.json({ rows, sources });
  }

  // 通用：各源 union；有识别字段且命中规则则归一化去重，否则按原值去重
  const idRule = obj.identity ? (RULES.find((r) => r.name === obj.identity) ?? null) : null;
  const seen = new Map<string, Record<string, unknown>>();
  for (const src of obj.sources) {
    const t = getTable(src.connection, src.table);
    for (const row of t.rows) {
      const rec: Record<string, unknown> = { _src: `${src.connection}.${src.table}` };
      for (const p of obj.properties) rec[p.name] = src.fields[p.name] ? row[src.fields[p.name]] : undefined;
      const rawId = obj.identity ? String(rec[obj.identity] ?? "") : "";
      const key = obj.identity ? (idRule ? normalizeWith(idRule, rawId) : rawId.trim()) : JSON.stringify(rec);
      if (!key) continue;
      if (!seen.has(key)) seen.set(key, rec);
    }
  }
  return NextResponse.json({ rows: [...seen.values()], sources });
}
