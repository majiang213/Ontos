// ============================================================
// 正向生成器 —— 真实模板，假输出位置（M5）
// MVP 里这是 Nunjucks 确定性模板落盘成文件 + drizzle-kit migration；
// demo 只把生成物渲染出来看（DDL / API 清单 / 页面清单 / 血缘标注）。
// 禁止 LLM 直接写代码 —— 这里全部是字符串模板。
// ============================================================

import type { Ontology } from "./ontology";

export interface Artifacts {
  ddl: string;
  apis: string[];
  pages: string[];
  lineage: string[];
}

const TYPE_MAP: Record<string, string> = {
  uuid: "uuid",
  string: "varchar(255)",
  int: "integer",
  enum: "varchar(32)",
  date: "date",
};

export function generate(ont: Ontology): Artifacts {
  const ddl: string[] = [];
  const apis: string[] = [];
  const pages: string[] = [];
  const lineage: string[] = [];

  for (const o of Object.values(ont.object_types)) {
    const table = o.name;
    ddl.push(`-- ${o.label}`);
    ddl.push(`create table ${table} (`);
    const cols = o.properties.map((p) => {
      const t = TYPE_MAP[p.type] ?? "text";
      const parts = [`  ${p.name} ${t}`];
      if (p.pk) parts.push(p.type === "uuid" ? "primary key default gen_random_uuid()" : "primary key");
      if (p.values?.length) parts.push(`check (${p.name} in (${p.values.map((v) => `'${v}'`).join(", ")}))`);
      if (p.derived) parts.push(`-- 派生：${p.derived}`);
      return parts.join(" ");
    });
    // 关系 → 外键：from 表挂 to_id（一对多）；阶段转化（自关联）不落表，由状态字段派生
    const rels = ont.link_types.filter((l) => l.from === table && l.to !== table);
    for (const l of rels) cols.push(`  ${l.to}_id uuid references ${l.to}(id)  -- 关系 ${l.name}`);
    ddl.push(cols.join(",\n"));
    ddl.push(`);\n`);

    apis.push(`GET    /api/${table}        列表（分页/过滤）`);
    apis.push(`POST   /api/${table}        新建`);
    apis.push(`GET    /api/${table}/:id    详情`);
    apis.push(`PATCH  /api/${table}/:id    更新`);
    apis.push(`DELETE /api/${table}/:id    删除`);
    for (const l of rels) apis.push(`GET    /api/${table}/:id/${l.to}  沿关系取数（${l.name}）`);

    pages.push(`/${table}          列表页（AG Grid 列来自属性）`);
    pages.push(`/${table}/:id      详情/编辑页（rjsf 按属性类型生表单${rels.length ? `，含 ${rels.map((l) => l.name).join("/")} 关联区块` : ""}）`);

    for (const p of o.properties) {
      const from = o.sources
        .filter((s) => s.fields[p.name])
        .map((s) => `${s.connection}.${s.table}.${s.fields[p.name]}`)
        .join("  +  ");
      lineage.push(`${table}.${p.name}  ←  ${from || `派生：${p.derived ?? "—"}`}`);
    }
    for (const l of rels) lineage.push(`${table}.${l.to}_id  ←  关系 ${l.name}（${JSON.stringify(l.via)}）`);
  }

  // 主键锚：新库 uuid ↔ 源表主键的对照表——血缘与增量承接以此为据
  if (Object.values(ont.object_types).some((o) => o.sources.length > 0)) {
    ddl.push(`-- 源映射锚：新库主键 ↔ 源表主键（血缘/增量承接的对照）`);
    ddl.push(`create table object_mappings (`);
    ddl.push(`  id uuid primary key default gen_random_uuid(),`);
    ddl.push(`  object_type text not null,   -- 本体对象`);
    ddl.push(`  object_id uuid not null,     -- 新库主键`);
    ddl.push(`  connection text not null,    -- 来源连接`);
    ddl.push(`  source_table text not null,`);
    ddl.push(`  source_pk text not null      -- 源表主键值`);
    ddl.push(`);`);
  }

  return { ddl: ddl.join("\n"), apis, pages, lineage };
}
