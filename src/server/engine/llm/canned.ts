// 罐头槽位 —— 没有模型 key 时的离线确定性回退：问数只覆盖 test 演示空间的剧本（demoQueries，本文件末尾），
// 逆向建模与候选对建议是通用启发式（按列名猜类型、按字段重合度给倾向），各空间都能用。
// 产出一律过 Zod 校验，与真模型同闸。本文件是演示逻辑的唯一住所——引擎其余源码不出现领域词。

import type { QueryRequest } from "../../schema/request";
import { queryRequestSchema } from "../../schema/request";
import type { ObjectType, OntologyConfig } from "../../schema/config";
import type { TableInfo } from "../infra/driver";
import { TEST_WS } from "../infra/workspace";
import { Verdict, type PairAdvice, type Tendency } from "../adjudication/verdict";
import { EngineReject } from "../../errors";
import { IDENTITY_COL_RE } from "./identityHint";
import type { LlmSlot } from "./slot";

export class CannedSlot implements LlmSlot {
  readonly name = "canned-离线回退";
  async nlToQuery(question: string, config: OntologyConfig, ws: string): Promise<QueryRequest> {
    // 空间守门（真实约束，写进签名的原因）：剧本是 test 空间的演示数据，别的空间问数必须配模型 Key——
    // 不能靠「config 里有没有同名类」巧合放行，否则别的空间任何问法都会被静默编成演示查询（错答案比报错糟）
    if (ws !== TEST_WS) throw new EngineReject("离线回退只覆盖 test 演示空间的问法：配 OPENAI_API_KEY，或到 test 演示空间问");
    // 剧本在本文件 demoQueries（test 空间的演示数据）：正则顺序即优先级，末条兜底。
    // 形状与 generateText + Output.object 产物一致，过同一道 Zod。
    // 无模型时问数没有通用编译法，剧本只对上了类才编；对不上说明不是演示问题，得配模型 Key
    const hit = demoQueries.find((q) => q.pattern.test(question))!;
    if (!config.object_types[hit.query.object]) {
      throw new EngineReject("离线回退只覆盖演示剧本的问法：配 OPENAI_API_KEY，或到 test 演示空间问");
    }
    return queryRequestSchema.parse(hit.query);
  }

  async proposeObjects(tables: { connection: string; table: TableInfo }[]): Promise<Record<string, ObjectType>> {
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
        properties[col.name] = { type, ...(col.comment ? { description: col.comment } : {}) }; // 列注释存成字段说明
        fields[col.name] = col.name;
        if (!identity && IDENTITY_COL_RE.test(col.name)) identity = col.name; // 识别字段先猜编号列（规则单源 identityHint）
      }
      // 编号列猜不到、主键本身就是业务编号（如 person_no）时：主键当识别字段，破格进属性
      if (!identity && pkCol) {
        identity = pkCol.name;
        const t = pkCol.type.toUpperCase();
        properties[pkCol.name] = { type: t.includes("INT") ? "number" : "string", ...(pkCol.comment ? { description: pkCol.comment } : {}) };
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

  async proposePairs(classes: { name: string; sources: string[]; fields: string[] }[]): Promise<PairAdvice[]> {
    const pairs: PairAdvice[] = [];
    for (let i = 0; i < classes.length; i++) {
      for (let j = i + 1; j < classes.length; j++) {
        const a = classes[i];
        const b = classes[j];
        if (a.sources.some((s) => b.sources.includes(s))) continue; // 有共同连接不成对
        const shared = a.fields.filter((f) => b.fields.includes(f));
        const ratio = shared.length / Math.max(a.fields.length, b.fields.length, 1);
        const nameLike = a.name === b.name || (a.name.length > 2 && b.name.includes(a.name)) || (b.name.length > 2 && a.name.includes(b.name));
        if (ratio < 0.4 && !nameLike) continue; // 字段对不上、名字也不像，不进候选
        if (ratio < 0.4 && nameLike) {
          pairs.push({ class_a: a.name, class_b: b.name, tendency: Verdict.NameSimilar, reason: `名字相近（${a.name} / ${b.name}），字段对不上` });
          continue;
        }
        const hasStage = [...a.fields, ...b.fields].some((f) => /status|state|阶段|状态/.test(f));
        const tendency: Tendency = ratio > 0.8 ? Verdict.Same : hasStage ? Verdict.Stage : Verdict.Overlap;
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

/* ---------- 演示问数剧本（test 空间离线回退的编译脚本） ----------
   正则 → 查询，顺序即优先级，最后一条兜底。这是演示数据，不是引擎逻辑。 */

export const demoQueries: { pattern: RegExp; query: QueryRequest }[] = [
  {
    pattern: /每个部门|各部门|多少台|多少设备/,
    query: { object: "equipment", filter: { status: "in_service" }, aggregate: { group_by: ["dept"], metrics: [{ count: "*" }] } },
  },
  {
    pattern: /过保/,
    query: { object: "equipment", properties: ["name", "serial_no"], filter: { in_warranty: false } },
  },
  {
    pattern: /在途/,
    query: { object: "equipment", properties: ["name", "serial_no"], filter: { status: "in_transit" } },
  },
  {
    pattern: /报废/,
    query: { object: "equipment", properties: ["name", "serial_no"], filter: { status: "scrapped" } },
  },
  {
    pattern: /在役|部门/,
    query: { object: "equipment", properties: ["name"], filter: { status: "in_service" }, expand: [{ relation: "belongs_to", properties: ["name"] }] },
  },
  {
    pattern: /.*/,
    query: { object: "equipment", properties: ["name", "status"] },
  },
];
