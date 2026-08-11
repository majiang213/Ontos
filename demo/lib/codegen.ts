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
      return parts.join(" ");
    });
    ddl.push(cols.join(",\n"));
    ddl.push(`);\n`);

    apis.push(`GET    /api/${table}        列表（分页/过滤）`);
    apis.push(`POST   /api/${table}        新建`);
    apis.push(`GET    /api/${table}/:id    详情`);
    apis.push(`PATCH  /api/${table}/:id    更新`);
    apis.push(`DELETE /api/${table}/:id    删除`);

    pages.push(`/${table}          列表页（AG Grid 列来自属性）`);
    pages.push(`/${table}/:id      详情/编辑页（rjsf 按属性类型生表单）`);

    for (const p of o.properties) {
      const from = o.sources
        .filter((s) => s.fields[p.name])
        .map((s) => `${s.connection}.${s.table}.${s.fields[p.name]}`)
        .join("  +  ");
      lineage.push(`${table}.${p.name}  ←  ${from || `派生：${p.derived ?? "—"}`}`);
    }
  }

  return { ddl: ddl.join("\n"), apis, pages, lineage };
}
