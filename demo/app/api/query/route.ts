// M7 查询 Agent：问题 → 结构化查询（LLM 插槽）→ 确定性编译执行 → 答案+取数路径。
import { NextResponse } from "next/server";
import { compileQuestion, execute, queryLogSummary } from "@/lib/queryService";

export async function POST(req: Request) {
  const { question, ontology } = await req.json();
  const structured = compileQuestion(question); // LLM 插槽：MVP 为 generateObject，Zod 校验
  const { rows, path } = execute(ontology, structured);
  return NextResponse.json({
    structured_query: structured,
    rows,
    path,
    query_log: queryLogSummary(question, structured, rows.length),
  });
}
