// LLM 槽位 —— 模型只在这几个槽位里出现（《ontos-article.md》§4、§5.3）。
// 接口 + 离线确定性回退：没有模型 key 时由罐头实现产出；key 就位后换 AiSdkSlot。
// 模型当顾问不当计算器：产出一律过 Zod 校验，不合法即拒绝。

import type { QueryRequest } from "../schema/request";
import { queryRequestSchema } from "../schema/request";
import type { ObjectType, OntologyConfig } from "../schema/config";
import type { TableInfo } from "./driver";

export interface LlmSlot {
  /** 实现名，留痕用（离线回退 / 真模型名） */
  readonly name: string;
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
  tendency: "同一" | "部分重叠" | "阶段" | "仅名称相似";
  reason: string;
}

/* ---------- 离线确定性回退 ---------- */

export class CannedSlot implements LlmSlot {
  readonly name = "canned-离线回退";
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
      const pkCol = table.columns.find((c) => c.pk);
      for (const col of table.columns) {
        if (col.pk) continue; // 表主键只定位行，不进属性——除非它就是识别字段（见下）
        const t = col.type.toUpperCase(); // mysql 给 int(11)、pg 给 integer/timestamp，统一大写再判
        const type = t.includes("INT") ? "number" : t.includes("DATE") || t.includes("TIME") ? "date" : "string";
        properties[col.name] = { type };
        fields[col.name] = col.name;
        if (!identity && /_no$|_id$/.test(col.name)) identity = col.name; // 识别字段先猜编号列
      }
      // 编号列猜不到、主键本身就是业务编号（如 person_no）时：主键当识别字段，破格进属性
      if (!identity && pkCol) {
        identity = pkCol.name;
        const t = pkCol.type.toUpperCase();
        properties[pkCol.name] = { type: t.includes("INT") ? "number" : "string" };
        fields[pkCol.name] = pkCol.name;
      }
      // 跨连接同名表是裁决主场景：撞名带连接前缀，不静默覆盖
      const clsName = out[table.name] ? `${connection}_${table.name}` : table.name;
      // 还是猜不到识别字段：不挂 sources 进 manual 桶（有源无 identity 过不了发布闸），人到编辑卡拉列设置
      out[clsName] = identity
        ? {
            kind: "thing",
            identity,
            properties,
            sources: { [connection]: { connection, table: table.name, ...(pkCol ? { pk: pkCol.name } : {}), fields } }, // 主键读不出就不写，不编造
          }
        : { kind: "thing", properties };
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
        const nameLike = a.name === b.name || (a.name.length > 2 && b.name.includes(a.name)) || (b.name.length > 2 && a.name.includes(b.name));
        if (ratio < 0.4 && !nameLike) continue; // 字段对不上、名字也不像，不进候选
        if (ratio < 0.4 && nameLike) {
          pairs.push({ class_a: a.name, class_b: b.name, tendency: "仅名称相似", reason: `名字相近（${a.name} / ${b.name}），字段对不上` });
          continue;
        }
        const hasStage = [...a.fields, ...b.fields].some((f) => /status|state|阶段|状态/.test(f));
        const tendency = ratio > 0.8 ? "同一" : hasStage ? "阶段" : "部分重叠";
        pairs.push({
          class_a: a.name,
          class_b: b.name,
          tendency,
          reason: `字段重合 ${shared.length}/${Math.max(a.fields.length, b.fields.length)}（${shared.join("、")}）${hasStage ? "；含状态字段" : ""}`,
        });
      }
    }
    return pairs;
  }
}

/* ---------- 真模型实现 ----------
   key 就位后在这里接 generateObject（Vercel AI SDK）：
   三个槽位同构——generateObject({ model, schema, prompt })，schema 即 lib/schema 里的 Zod。
   getSlot() 按环境变量选实现。 */

/** 槽位选择：当前恒为离线回退；真模型就位后在这里按环境变量换实现。 */
export function getSlot(): LlmSlot {
  return new CannedSlot(); // ONTOS_LLM_KEY 就位后在这里换真模型实现
}
