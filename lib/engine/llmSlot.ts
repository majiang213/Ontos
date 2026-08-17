// LLM 槽位 —— 模型只在这几个槽位里出现（《ontos-article.md》§4、§5.3）。
// 接口 + 离线确定性回退：没有模型 key 时由罐头实现产出；key 就位后换 AiSdkSlot。
// 模型当顾问不当计算器：产出一律过 Zod 校验，不合法即拒绝。

import type { QueryRequest } from "../schema/request";
import { queryRequestSchema } from "../schema/request";
import type { ObjectType, OntologyConfig } from "../schema/config";
import type { TableInfo } from "./driver";

export interface LlmSlot {
  /** NL → 查询 JSON（问数槽位） */
  nlToQuery(question: string, config: OntologyConfig): Promise<QueryRequest>;
  /** 表结构 → 本体草稿（逆向建模槽位） */
  draftObjects(tables: { connection: string; table: TableInfo }[]): Promise<Record<string, ObjectType>>;
  /** 跨源类两两比对 → 候选对与倾向（整合槽位） */
  suggestPairs(classes: { name: string; source: string; fields: string[] }[]): Promise<PairAdvice[]>;
}

export interface PairAdvice {
  class_a: string;
  class_b: string;
  tendency: "同一" | "阶段" | "仅名称相似";
  reason: string;
}

/* ---------- 离线确定性回退 ---------- */

export class CannedSlot implements LlmSlot {
  async nlToQuery(question: string, _config: OntologyConfig): Promise<QueryRequest> {
    // 演示剧本四问 + 默认。形状与 generateObject 产物一致，过同一道 Zod
    if (/每个部门|各部门|多少台|多少设备/.test(question)) {
      return queryRequestSchema.parse({
        object: "equipment",
        filter: { status: "in_service" },
        aggregate: { group_by: ["dept"], metrics: [{ count: "*" }] },
      });
    }
    if (/过保/.test(question)) {
      return queryRequestSchema.parse({ object: "equipment", properties: ["name", "serial_no"], filter: { in_warranty: false } });
    }
    if (/在途/.test(question)) {
      return queryRequestSchema.parse({ object: "equipment", properties: ["name", "serial_no"], filter: { status: "in_transit" } });
    }
    if (/报废/.test(question)) {
      return queryRequestSchema.parse({ object: "equipment", properties: ["name", "serial_no"], filter: { status: "scrapped" } });
    }
    if (/在役|部门/.test(question)) {
      return queryRequestSchema.parse({
        object: "equipment",
        properties: ["name"],
        filter: { status: "in_service" },
        expand: [{ relation: "belongs_to", properties: ["name"] }],
      });
    }
    return queryRequestSchema.parse({ object: "equipment", properties: ["name", "status"] });
  }

  async draftObjects(tables: { connection: string; table: TableInfo }[]): Promise<Record<string, ObjectType>> {
    const out: Record<string, ObjectType> = {};
    for (const { connection, table } of tables) {
      const properties: Record<string, ObjectType["properties"][string]> = {};
      const fields: Record<string, string> = {};
      let identity: string | undefined;
      for (const col of table.columns) {
        if (col.pk) continue; // 表主键只定位行，不进属性
        const type = col.type.includes("INT") ? "number" : col.type.includes("DATE") || col.type.includes("TIME") ? "date" : "string";
        properties[col.name] = { type };
        fields[col.name] = col.name;
        if (!identity && /_no$|_id$/.test(col.name)) identity = col.name; // 识别字段猜编号列；答不出就留白问人
      }
      const pkCol = table.columns.find((c) => c.pk);
      out[table.name] = {
        kind: "thing",
        identity,
        properties,
        sources: { [connection]: { connection, table: table.name, pk: pkCol?.name ?? "id", fields } },
      };
    }
    return out;
  }

  async suggestPairs(classes: { name: string; source: string; fields: string[] }[]): Promise<PairAdvice[]> {
    const pairs: PairAdvice[] = [];
    for (let i = 0; i < classes.length; i++) {
      for (let j = i + 1; j < classes.length; j++) {
        const a = classes[i];
        const b = classes[j];
        if (a.source === b.source) continue; // 同源不成对
        const shared = a.fields.filter((f) => b.fields.includes(f));
        const ratio = shared.length / Math.max(a.fields.length, b.fields.length, 1);
        if (ratio < 0.4) continue; // 字段对不上，不进候选
        const hasStage = [...a.fields, ...b.fields].some((f) => /status|state|阶段|状态/.test(f));
        pairs.push({
          class_a: a.name,
          class_b: b.name,
          tendency: hasStage ? "阶段" : ratio > 0.8 ? "同一" : "阶段",
          reason: `字段重合 ${shared.length}/${Math.max(a.fields.length, b.fields.length)}（${shared.join("、")}）${hasStage ? "；含状态字段" : ""}`,
        });
      }
    }
    return pairs;
  }
}

/* ---------- 真模型实现（key 就位后启用） ---------- */

export class AiSdkSlot implements LlmSlot {
  constructor(private model: never) {
    // generateObject({ model, schema, prompt }) —— 三个槽位同构，schema 即 lib/schema 里的 Zod
    void this.model;
    throw new Error("模型槽位待配置 API key 后启用；离线回退用 CannedSlot");
  }
  nlToQuery(): Promise<QueryRequest> {
    throw new Error("模型槽位未配置");
  }
  draftObjects(): Promise<Record<string, ObjectType>> {
    throw new Error("模型槽位未配置");
  }
  suggestPairs(): Promise<PairAdvice[]> {
    throw new Error("模型槽位未配置");
  }
}

/** 槽位选择：有 key 用真模型，否则离线回退。 */
export function getSlot(): LlmSlot {
  return new CannedSlot(); // ONTOS_LLM_KEY 就位后在这里换 AiSdkSlot
}
