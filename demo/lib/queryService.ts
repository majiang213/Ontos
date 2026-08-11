// ============================================================
// 本体查询服务 —— 真实实现（M7 的服务端，文档 V1.3/V1.4）
// 输入：结构化查询（LLM 只准产出这个，Zod 可校验）
// 执行：确定性编译 → 各源下推 → 内存拼装（union + identity 匹配）
// 输出：答案行 + 取数路径（查询级血缘）+ query_log 摘要
// ============================================================

import { getTable } from "./sources";
import { RULES, normalizeWith } from "./normalize";
import type { Ontology, ObjectDef } from "./ontology";

export interface StructuredQuery {
  object: string;
  filter?: { converted?: boolean; status?: string };
  expand?: string[]; // 如 ["department"]
}

// LLM 插槽：MVP 里这是 generateObject(问题 + 本体上下文 → StructuredQuery)。
// 这里罐头映射 demo 问题。
export function compileQuestion(question: string): StructuredQuery {
  if (/转正/.test(question)) {
    return { object: "person", filter: { converted: true }, expand: ["department"] };
  }
  if (/候选人/.test(question) && !/转正/.test(question)) {
    return { object: "person", filter: { status: "候选人" } };
  }
  if (/在职/.test(question)) {
    return { object: "person", filter: { status: "在职" } };
  }
  return { object: "person" };
}

interface PersonRow {
  name: string;
  id_card: string;
  status: string;
  hired_at?: string;
  dept?: string;
  _sources: string[];
}

const idCardRule = RULES.find((r) => r.name === "id_card")!;
const mask = (v: string) => v.slice(0, 4) + "**********" + v.slice(-4);

export function execute(ont: Ontology, q: StructuredQuery): { rows: Omit<PersonRow, "_sources">[]; path: string[] } {
  const person: ObjectDef | undefined = ont.object_types[q.object];
  if (!person) throw new Error(`本体中没有对象 ${q.object}`);
  const identity = person.identity!;
  const path: string[] = [];

  // 1) 各源分别下推：按 sources 映射取回 identity 等字段（内存模拟 SQL 下推）
  const byIdentity = new Map<string, PersonRow>();
  for (const src of person.sources) {
    const t = getTable(src.connection, src.table);
    let hit = 0;
    for (const row of t.rows) {
      const rawId = row[src.fields[identity]];
      const id = normalizeWith(idCardRule, rawId);
      if (!id) continue;
      hit++;
      const existing = byIdentity.get(id);
      const rec: PersonRow = existing ?? {
        name: String(row[src.fields["name"]]),
        id_card: id,
        status: "候选人",
        _sources: [],
      };
      rec._sources.push(src.connection);
      if (src.connection === "hr") {
        rec.status = String(row["status"]) === "离职" ? "离职" : "在职";
        rec.hired_at = src.fields["hired_at"] ? String(row[src.fields["hired_at"]]) : undefined;
        rec.dept = String(row["dept_id"]);
      }
      byIdentity.set(id, rec);
    }
    path.push(`下推 ${src.connection}.${src.table}：取 ${src.fields[identity]} 等映射列，命中 ${hit} 行（只读）`);
  }

  // 2) 派生 status：记录出现在哪些源 + HR 源 status 字段（对象定义里的派生规则）
  path.push(`派生 status：仅招聘源→候选人；命中 HR 源→在职/离职（按 hr.employee.status）`);

  // 3) 过滤："已转正" = identity 归一化后在两个源都命中（与交集验证同一套机制）
  let persons = [...byIdentity.values()];
  if (q.filter?.converted) {
    persons = persons.filter((p) => p._sources.includes("recruiting") && p._sources.includes("hr"));
    path.push(`过滤 converted：identity=${identity} 归一化匹配 recruiting × hr 双源均命中 → ${persons.length} 人`);
  }
  if (q.filter?.status) {
    persons = persons.filter((p) => p.status === q.filter!.status);
    path.push(`过滤 status=${q.filter.status} → ${persons.length} 人`);
  }

  // 4) expand：沿 link 走到部门对象（FK 下推 HR 源）
  if (q.expand?.includes("department")) {
    const deptTable = getTable("hr", "department");
    const deptById = new Map(deptTable.rows.map((r) => [String(r["dept_id"]), String(r["dept_name"])]));
    for (const p of persons) p.dept = p.dept ? (deptById.get(p.dept) ?? p.dept) : undefined;
    path.push(`expand works_in：hr.employee.dept_id → hr.department.dept_name（FK 下推）`);
  }

  const rows = persons.map(({ name, id_card, status, hired_at, dept }) => ({
    name,
    id_card: mask(id_card), // 答案展示脱敏
    status,
    hired_at,
    dept,
  }));
  return { rows, path };
}

// query_logs 摘要：不存答案结果集，只存行数/路径（数据边界）
export function queryLogSummary(question: string, sq: StructuredQuery, rowCount: number) {
  return { question, structured_query: sq, row_count: rowCount, answer_stored: false, at: new Date().toISOString() };
}
