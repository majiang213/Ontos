// M2 AI 逆向建模：schema → 本体草稿（YAML），只产草稿不落库。
// LLM 插槽：MVP 里这里调 generateObject；demo 返回罐头草稿 + 假延迟。
import { NextResponse } from "next/server";
import { draftFor, toYaml } from "@/lib/ontology";

export async function GET() {
  await new Promise((r) => setTimeout(r, 800)); // 假装 LLM 在思考
  const drafts = ["recruiting", "hr"].map((conn) => {
    const ont = draftFor(conn);
    return { connection: conn, ontology: ont, yaml: toYaml(ont) };
  });
  return NextResponse.json(drafts);
}
