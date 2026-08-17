// ============================================================
// 本体模型 —— 元模型类型 + M2 草稿（罐头）+ M3 裁决后的合并产出
// LLM 插槽：draftFor() 在 MVP 里是 generateObject(schema → YAML 草稿)，
// 只产草稿不落库；这里用罐头草稿演示，结构即真实结构。
// ============================================================

export interface PropDef {
  name: string;
  type: string;
  label?: string;
  pk?: boolean;
  values?: string[];
  derived?: string; // 派生规则（无源字段可映射时）
}
export interface SourceMapping {
  connection: string;
  table: string;
  pk: string;
  fields: Record<string, string>; // 本体属性 → 源列
}
export interface FnDef {
  name: string;
  label: string;
  rule: string; // 白话：怎么算
}
export interface AxiomDef {
  name: string;
  rule: string; // 白话：必须遵守什么
}
export interface ActionDef {
  name: string;
  label: string;
  does: string; // 白话：做什么
  record?: string; // 系统的记录，如 hr.employee
  mode?: string; // insert-or-update 等
  from_fields?: string; // 从对象带过去的字段名，逗号分隔
}
export interface PermDef {
  field: string; // 空 = 整个对象
  who: string; // 白话：谁能看
}
export interface ObjectDef {
  name: string;
  label: string;
  identity?: string; // 匹配键：实例怎么认
  kind?: "thing" | "event"; // 事物 / 事件
  parent?: string; // 子类型：属于哪个上位对象
  equivalent?: string; // 同义：和哪个对象是一回事
  properties: PropDef[];
  sources: SourceMapping[];
  functions?: FnDef[];
  axioms?: AxiomDef[];
  actions?: ActionDef[];
  permissions?: PermDef[];
  _ignored?: boolean;
}
export interface LinkDef {
  name: string;
  label?: string;
  from: string;
  to: string;
  inverse?: string; // 逆关系名，如 属于 ↔ 下辖
  card?: "1:1" | "1:n" | "n:1" | "n:n";
  via: unknown;
}
export interface Ontology {
  object_types: Record<string, ObjectDef>;
  link_types: LinkDef[];
  questions?: string[]; // 能力测试题：用来验收模型
}

// ---- M2 罐头草稿：对两个源库各自逆向 --------------------------
export function draftFor(connection: string): Ontology {
  if (connection === "recruiting") {
    return {
      object_types: {
        candidate: {
          name: "candidate",
          label: "候选人",
          identity: "id_card",
          properties: [
            { name: "id", type: "int", pk: true, label: "ID" },
            { name: "name", type: "string", label: "姓名" },
            { name: "id_card", type: "string", label: "身份证" },
            { name: "mobile", type: "string", label: "手机号" },
            { name: "applied_position", type: "string", label: "应聘职位" },
            { name: "interview_score", type: "int", label: "面试评分" },
          ],
          sources: [
            {
              connection: "recruiting",
              table: "candidate",
              pk: "cand_id",
              fields: { id: "cand_id", name: "candidate_name", id_card: "idcard_no", mobile: "mobile", applied_position: "applied_position", interview_score: "interview_score" },
            },
          ],
        },
        job_posting: {
          name: "job_posting",
          label: "招聘职位",
          properties: [
            { name: "id", type: "int", pk: true, label: "ID" },
            { name: "title", type: "string", label: "职位名" },
            { name: "jd_text", type: "string", label: "JD描述" },
          ],
          sources: [{ connection: "recruiting", table: "job_posting", pk: "job_id", fields: { id: "job_id", title: "title", jd_text: "jd_text" } }],
        },
        department: {
          name: "department",
          label: "部门",
          identity: "name",
          properties: [
            { name: "code", type: "string", pk: true, label: "部门编号" },
            { name: "name", type: "string", label: "部门名" },
          ],
          sources: [{ connection: "recruiting", table: "department", pk: "dept_code", fields: { code: "dept_code", name: "dept_name" } }],
        },
      },
      link_types: [{ name: "applied_to", from: "candidate", to: "job_posting", via: { column: "applied_position ↔ title" } }],
    };
  }
  return {
    object_types: {
      employee: {
        name: "employee",
        label: "员工",
        identity: "id_card",
        properties: [
          { name: "id", type: "string", pk: true },
          { name: "name", type: "string", label: "姓名" },
          { name: "id_card", type: "string", label: "身份证" },
          { name: "phone", type: "string", label: "手机号" },
          { name: "status", type: "enum", values: ["在职", "离职"], label: "在职状态" },
          { name: "hired_at", type: "date", label: "入职日期" },
        ],
        sources: [
          {
            connection: "hr",
            table: "employee",
            pk: "emp_no",
            fields: { id: "emp_no", name: "emp_name", id_card: "id_card", phone: "phone", status: "status", hired_at: "hired_at" },
          },
        ],
      },
      department: {
        name: "department",
        label: "部门",
        identity: "name",
        properties: [
          { name: "code", type: "string", pk: true, label: "部门编号" },
          { name: "name", type: "string", label: "部门名" },
        ],
        sources: [{ connection: "hr", table: "department", pk: "dept_id", fields: { code: "dept_id", name: "dept_name" } }],
      },
      headcount_position: {
        name: "headcount_position",
        label: "岗位编制",
        properties: [
          { name: "id", type: "int", pk: true, label: "ID" },
          { name: "title", type: "string", label: "岗位名" },
          { name: "headcount", type: "int", label: "编制数" },
        ],
        sources: [{ connection: "hr", table: "headcount_position", pk: "pos_id", fields: { id: "pos_id", title: "title", headcount: "headcount" } }],
      },
    },
    link_types: [
      { name: "belongs_to", from: "employee", to: "department", via: { fk: "employee.dept_id → department.dept_id" } },
      { name: "staffed_by", from: "headcount_position", to: "department", via: { fk: "headcount_position.dept_id → department.dept_id" } },
    ],
  };
}

// ---- M3 候选对（罐头，MVP 里由 LLM 语义建议产出）--------------
export interface PairCandidate {
  key: string;
  a: { connection: string; table: string; object: string };
  b: { connection: string; table: string; object: string };
  semanticHint: string;
}
export const PAIR_CANDIDATES: PairCandidate[] = [
  {
    key: "person",
    a: { connection: "recruiting", table: "candidate", object: "candidate" },
    b: { connection: "hr", table: "employee", object: "employee" },
    semanticHint: "两边都是'人'，字段高度相似（姓名/身份证/手机）",
  },
  {
    key: "department",
    a: { connection: "recruiting", table: "department", object: "department" },
    b: { connection: "hr", table: "department", object: "department" },
    semanticHint: "同名表，部门名一致",
  },
  {
    key: "position",
    a: { connection: "recruiting", table: "job_posting", object: "job_posting" },
    b: { connection: "hr", table: "headcount_position", object: "headcount_position" },
    semanticHint: "都叫'职位/岗位'，名字相近",
  },
];

// ---- M3 裁决后的合并：decisions = { person: "③", department: "①", position: "⑤" }
// 五种裁决（含 ⤼ 跳过=暂不合并、各自独立）都必须落到本体——裁决权在人，系统得执行。
// drafts 传入时尊重人工修订与忽略标记；不传则用内置草稿
export function buildMergedOntology(
  decisions: Record<string, string>,
  drafts?: { connection: string; ontology: Ontology }[],
): Ontology {
  const merged: Ontology = { object_types: {}, link_types: [] };
  const covered = new Set<string>();
  const rDraft = drafts?.find((d) => d.connection === "recruiting")?.ontology ?? draftFor("recruiting");
  const hDraft = drafts?.find((d) => d.connection === "hr")?.ontology ?? draftFor("hr");

  // —— 人员对（candidate ↔ employee）——
  // ③ 生命周期：统一对象 + status 派生 + converted 转化关系
  if (decisions.person === "③") {
    merged.object_types.person = {
      name: "person",
      label: "人员",
      kind: "thing",
      identity: "id_card",
      properties: [
        { name: "id", type: "uuid", pk: true },
        { name: "name", type: "string", label: "姓名" },
        { name: "id_card", type: "string", label: "身份证" },
        { name: "status", type: "enum", values: ["候选人", "在职", "离职"], label: "状态", derived: "仅招聘源→候选人；命中 HR 源→在职（HR status=离职→离职）" },
        { name: "hired_at", type: "date", label: "入职日期" },
      ],
      sources: [
        { connection: "recruiting", table: "candidate", pk: "cand_id", fields: { name: "candidate_name", id_card: "idcard_no" } },
        { connection: "hr", table: "employee", pk: "emp_no", fields: { name: "emp_name", id_card: "id_card", hired_at: "hired_at" } },
      ],
      functions: [{ name: "is_converted", label: "是否已转正", rule: "状态从候选人变成在职" }],
      axioms: [{ name: "status_one", rule: "同一个人同一时刻只能有一个状态" }],
      actions: [{
        name: "hire",
        label: "录用",
        does: "候选人转为在职",
        record: "hr.employee",
        mode: "insert-or-update",
        from_fields: "name,id_card",
      }],
      permissions: [{ field: "id_card", who: "人事可看，其他人不可见" }],
    };
    merged.link_types.push({ name: "converted", label: "转正", from: "person", to: "person", inverse: "converted_from", card: "1:1", via: { transition: { status: ["候选人", "在职"] } } });
    merged.questions = [
      "查所有从候选人转正的员工及其部门",
      "现在还有多少候选人",
    ];
    covered.add("candidate").add("employee");
  } else if (decisions.person === "①") {
    // ① 完全等价：合并为单对象挂多源（公共属性并集，无状态派生）
    merged.object_types.person = personHub();
    covered.add("candidate").add("employee");
  } else if (decisions.person === "②") {
    // ② 部分重叠：上位对象承载公共属性，各自保留特有属性
    merged.object_types.person = personHub();
    merged.object_types.candidate = {
      name: "candidate",
      label: "候选人",
      properties: [
        { name: "id", type: "int", pk: true, label: "ID" },
        { name: "applied_position", type: "string", label: "应聘职位" },
        { name: "interview_score", type: "int", label: "面试评分" },
      ],
      sources: [{ connection: "recruiting", table: "candidate", pk: "cand_id", fields: { id: "cand_id", applied_position: "applied_position", interview_score: "interview_score" } }],
    };
    merged.object_types.employee = {
      name: "employee",
      label: "员工",
      properties: [
        { name: "id", type: "string", pk: true },
        { name: "status", type: "enum", values: ["在职", "离职"], label: "在职状态" },
        { name: "hired_at", type: "date", label: "入职日期" },
      ],
      sources: [{ connection: "hr", table: "employee", pk: "emp_no", fields: { id: "emp_no", status: "status", hired_at: "hired_at" } }],
    };
    covered.add("candidate").add("employee");
  }
  // ⑤ / ⤼：不覆盖 → 草稿直通，各自独立进本体

  // —— 部门对（department ↔ department，4/4 名称重合）——
  if (decisions.department && decisions.department !== "⑤" && decisions.department !== "⤼") {
    // ①（及对部门无语义区别的②③）：等价合并挂双源
    merged.object_types.department = {
      name: "department",
      label: "部门",
      identity: "name",
      properties: [
        { name: "code", type: "string", pk: true, label: "部门编号" },
        { name: "name", type: "string", label: "部门名" },
      ],
      sources: [
        { connection: "recruiting", table: "department", pk: "dept_code", fields: { code: "dept_code", name: "dept_name" } },
        { connection: "hr", table: "department", pk: "dept_id", fields: { code: "dept_id", name: "dept_name" } },
      ],
    };
    covered.add("department");
  } else if (decisions.department) {
    // ⑤/⤼：各自独立——两个草稿对象同名，加源后缀区分
    const rd = rDraft.object_types.department;
    const hd = hDraft.object_types.department;
    if (rd && !rd._ignored) merged.object_types.department_recruiting = { ...structuredClone(rd), name: "department_recruiting", label: "部门·招聘" };
    if (hd && !hd._ignored) merged.object_types.department_hr = { ...structuredClone(hd), name: "department_hr", label: "部门·HR" };
    covered.add("department");
  }

  // —— 职位对（job_posting ↔ headcount_position）——
  if (decisions.position === "①" || decisions.position === "③") {
    // 等价合并：统一「职位」挂双源（职位名为公共属性）
    merged.object_types.position = positionHub();
    covered.add("job_posting").add("headcount_position");
  } else if (decisions.position === "②") {
    // 部分重叠：上位「职位」+ 各自特有属性
    merged.object_types.position = positionHub();
    merged.object_types.job_posting = {
      name: "job_posting",
      label: "招聘职位",
      properties: [
        { name: "id", type: "int", pk: true, label: "ID" },
        { name: "jd_text", type: "text", label: "JD描述" },
      ],
      sources: [{ connection: "recruiting", table: "job_posting", pk: "job_id", fields: { id: "job_id", jd_text: "jd_text" } }],
    };
    merged.object_types.headcount_position = {
      name: "headcount_position",
      label: "岗位编制",
      properties: [
        { name: "id", type: "int", pk: true, label: "ID" },
        { name: "headcount", type: "int", label: "编制数" },
      ],
      sources: [{ connection: "hr", table: "headcount_position", pk: "pos_id", fields: { id: "pos_id", headcount: "headcount" } }],
    };
    covered.add("job_posting").add("headcount_position");
  }
  // ⑤ / ⤼：不覆盖 → 草稿直通

  // 未被任何候选对覆盖的草稿对象直接进本体（单源发布、各自独立、或跳过裁决的对象）
  if (drafts) {
    for (const d of drafts) {
      for (const [name, o] of Object.entries(d.ontology.object_types)) {
        if (o._ignored || covered.has(name)) continue;
        if (!merged.object_types[name]) merged.object_types[name] = o;
      }
    }
    // 草稿关系：两端对象都在本体里才带入（去重）
    for (const d of drafts) {
      for (const l of d.ontology.link_types ?? []) {
        if (merged.object_types[l.from] && merged.object_types[l.to] && !merged.link_types.some((x) => x.name === l.name)) {
          merged.link_types.push(l);
        }
      }
    }
  }
  // 人员↔部门任职关系：两对象都在本体时建立
  if (merged.object_types.person && merged.object_types.department && !merged.link_types.some((l) => l.name === "works_in")) {
    merged.link_types.push({ name: "works_in", label: "任职于", from: "person", to: "department", inverse: "staffed_by", card: "n:1", via: { fk: "hr.employee.dept_id → hr.department.dept_id" } });
  }
  if (!merged.questions?.length) {
    merged.questions = ["查所有从候选人转正的员工及其部门", "现在还有多少候选人"];
  }
  return merged;
}

// 人员上位对象（①/② 共用）：公共属性 + 双源映射，身份证为匹配键
function personHub(): ObjectDef {
  return {
    name: "person",
    label: "人员",
    identity: "id_card",
    properties: [
      { name: "id", type: "uuid", pk: true },
      { name: "name", type: "string", label: "姓名" },
      { name: "id_card", type: "string", label: "身份证" },
      { name: "phone", type: "string", label: "手机号" },
    ],
    sources: [
      { connection: "recruiting", table: "candidate", pk: "cand_id", fields: { name: "candidate_name", id_card: "idcard_no", phone: "mobile" } },
      { connection: "hr", table: "employee", pk: "emp_no", fields: { name: "emp_name", id_card: "id_card", phone: "phone" } },
    ],
  };
}

// 职位上位对象（①/②/③ 共用）：职位名为公共属性，挂双源
function positionHub(): ObjectDef {
  return {
    name: "position",
    label: "职位",
    properties: [
      { name: "id", type: "uuid", pk: true },
      { name: "title", type: "string", label: "职位名" },
    ],
    sources: [
      { connection: "recruiting", table: "job_posting", pk: "job_id", fields: { title: "title" } },
      { connection: "hr", table: "headcount_position", pk: "pos_id", fields: { title: "title" } },
    ],
  };
}

// ---- 极简 YAML 渲染（够 demo 用即可）--------------------------
function yamlList(key: string, items: Record<string, string>[] | undefined, indent = "    ") {
  if (!items?.length) return [];
  const lines = [`${indent}${key}:`];
  for (const it of items) {
    const body = Object.entries(it).filter(([, v]) => v).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
    lines.push(`${indent}  - { ${body} }`);
  }
  return lines;
}

export function toYaml(ont: Ontology): string {
  const lines: string[] = ["object_types:"];
  for (const o of Object.values(ont.object_types)) {
    if (o._ignored) continue;
    lines.push(`  ${o.name}:`);
    lines.push(`    label: ${o.label}`);
    lines.push(`    kind: ${o.kind ?? "thing"}`);
    if (o.identity) lines.push(`    identity: ${o.identity}`);
    if (o.parent) lines.push(`    parent: ${o.parent}`);
    if (o.equivalent) lines.push(`    equivalent: ${o.equivalent}`);
    lines.push(`    properties:`);
    for (const p of o.properties) {
      const extras = [p.pk ? "pk: true" : "", p.label ? `label: ${p.label}` : "", p.values ? `values: [${p.values.join(", ")}]` : "", p.derived ? `derived: "${p.derived}"` : ""].filter(Boolean).join(", ");
      lines.push(`      - { name: ${p.name}, type: ${p.type}${extras ? ", " + extras : ""} }`);
    }
    lines.push(`    sources:`);
    for (const s of o.sources) {
      lines.push(`      - { connection: ${s.connection}, table: ${s.table}, pk: ${s.pk},`);
      const fields = Object.entries(s.fields).map(([k, v]) => `${k}: ${v}`).join(", ");
      lines.push(`          fields: { ${fields} } }`);
    }
    lines.push(...yamlList("functions", o.functions as Record<string, string>[] | undefined));
    lines.push(...yamlList("axioms", o.axioms as Record<string, string>[] | undefined));
    lines.push(...yamlList("actions", o.actions as Record<string, string>[] | undefined));
    lines.push(...yamlList("permissions", o.permissions as Record<string, string>[] | undefined));
  }
  lines.push("link_types:");
  for (const l of ont.link_types) {
    const extra = [
      l.label ? `label: ${l.label}` : "",
      l.inverse ? `inverse: ${l.inverse}` : "",
      l.card ? `card: ${l.card}` : "",
    ].filter(Boolean).join(", ");
    lines.push(`  - { name: ${l.name}, from: ${l.from}, to: ${l.to}${extra ? ", " + extra : ""}, via: ${JSON.stringify(l.via)} }`);
  }
  if (ont.questions?.length) {
    lines.push("questions:");
    for (const q of ont.questions) lines.push(`  - ${JSON.stringify(q)}`);
  }
  return lines.join("\n");
}
