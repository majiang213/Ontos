// LLM 槽位 —— 模型只在这几个槽位里出现（《ontos-article.md》§4、§5.3）。
// 接口 + 离线确定性回退：没有模型 key 时由罐头实现产出；key 就位后换 AiSdkSlot。
// 罐头只服务 test 演示空间，剧本是 fixture 的演示数据（demoQueries），本文件不出现领域词。
// 模型当顾问不当计算器：产出一律过 Zod 校验，不合法即拒绝。

import type { QueryRequest } from "../schema/request";
import { queryRequestSchema } from "../schema/request";
import { objectTypeSchema, type ObjectType, type OntologyConfig } from "../schema/config";
import type { TableInfo } from "./infra/driver";
import { TENDENCIES, VERDICT_LABELS, Verdict, type PairAdvice, type Tendency } from "./adjudication/verdict";
import { demoQueries } from "./infra/fixture";
import { resolveTableInfos } from "./infra/load";
import type { DriverRegistry } from "./infra/registry";
import { runtime } from "../runtime";
import { EngineReject } from "../errors";
import { z } from "zod";
import { generateText, Output, type LanguageModel } from "ai";
import { createXai } from "@ai-sdk/xai";

export interface LlmSlot {
  /** 实现名，留痕用（离线回退 / 真模型名） */
  readonly name: string;
  /** NL → 查询 JSON（问数槽位） */
  nlToQuery(question: string, config: OntologyConfig): Promise<QueryRequest>;
  /** 表结构 → 本体草稿（逆向建模槽位） */
  proposeObjects(tables: { connection: string; table: TableInfo }[]): Promise<Record<string, ObjectType>>;
  /** 跨源类两两比对 → 候选对与倾向（整合槽位）。sources 是该类的连接集合（跨源判定在实现里做）。 */
  proposePairs(classes: { name: string; sources: string[]; fields: string[] }[]): Promise<PairAdvice[]>;
}

/* ---------- 离线确定性回退 ---------- */

export class CannedSlot implements LlmSlot {
  readonly name = "canned-离线回退";
  async nlToQuery(question: string, config: OntologyConfig): Promise<QueryRequest> {
    // 剧本在 fixture.demoQueries（test 空间的演示数据）：正则顺序即优先级，末条兜底。
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
        if (!identity && /_no$|_id$/.test(col.name)) identity = col.name; // 识别字段先猜编号列
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

/* ---------- 真模型实现（Vercel AI SDK + xAI）----------
   三个槽位同构：generateText({ model, output: Output.object({ schema }), prompt })。
   模型当顾问不当计算器：出槽前再过一道 Zod（模型乱说话 = 拒绝，不进引擎）。 */

type Gen = typeof generateText;

const draftSchema = z.object({ object_types: z.record(z.string(), objectTypeSchema) });
const pairsSchema = z.object({
  pairs: z.array(z.object({
    class_a: z.string(),
    class_b: z.string(),
    tendency: z.enum(TENDENCIES),
    reason: z.string(),
  })),
});

export class AiSdkSlot implements LlmSlot {
  readonly name: string;
  constructor(
    private model: LanguageModel,
    private gen: Gen = generateText // 测试注入假实现；生产是 SDK 的 generateText
  ) {
    this.name = `ai-sdk:${typeof model === "string" ? model : model.modelId}`;
  }

  async nlToQuery(question: string, config: OntologyConfig): Promise<QueryRequest> {
    const classes = Object.entries(config.object_types).map(([name, t]) => ({
      name,
      description: t.description,
      properties: Object.keys(t.properties),
      identity: t.identity,
      relations: Object.values(config.link_types)
        .filter((l) => l.from === name || l.to === name)
        .map((l) => (l.from === name ? `${l.from} -[${Object.keys(config.link_types).find((k) => config.link_types[k] === l)}]-> ${l.to}` : `${l.from} <-[${l.inverse}]- ${l.to}`)),
    }));
    const { output } = await this.gen({
      model: this.model,
      output: Output.object({ schema: queryRequestSchema }),
      prompt: `你是本体平台的问数编译器。把自然语言问题编译成结构化查询 JSON（schema 已约束形状）。
本体：${JSON.stringify(classes)}
规则：object 必须是上面的类名；filter 的键是属性名（派生属性可过滤）；$link 是关系过滤；date 属性可用 now/d 这类日期表达式；
展开用 expand: [{ relation: 关系名, properties: [...] }]；聚合用 aggregate: { group_by: [...], metrics: [{ count: "*" }] }。
答不出就返回最保守的空查询。问题：${question}`,
    });
    return queryRequestSchema.parse(output); // 出槽再验一次
  }

  async proposeObjects(tables: { connection: string; table: TableInfo }[]): Promise<Record<string, ObjectType>> {
    const { output } = await this.gen({
      model: this.model,
      output: Output.object({ schema: draftSchema }),
      prompt: `你是本体平台的逆向建模器。把数据库表结构翻成本体对象类型（object_types）。
规则：类名=表名的小写下划线形；kind 默 "thing"（记录事件的表用 "event"）；识别字段 identity 选业务编号列（_no/_id 结尾优先）；
properties 的类型只用 string/number/boolean/date/enum；sources 里 fields 是「属性名→列名」；pk 写真主键，没有就不写。
列带 comment 时把它的意思写进属性的 description（中文白话，别抄英文列名）。
表：${JSON.stringify(tables.map((t) => ({ connection: t.connection, name: t.table.name, columns: t.table.columns })))}`,
    });
    return draftSchema.parse(output).object_types;
  }

  async proposePairs(classes: { name: string; sources: string[]; fields: string[] }[]): Promise<PairAdvice[]> {
    const { output } = await this.gen({
      model: this.model,
      output: Output.object({ schema: pairsSchema }),
      prompt: `你是本体平台的整合顾问。下面是来自不同源的对象（名字、来源连接集合、字段名）。
找出跨源疑似同义的对，每对给倾向（枚举值 ${TENDENCIES.map((t) => `${t}=${VERDICT_LABELS[t]}`).join("、")}）与一句依据。有共同连接的不成对；字段和名字都不像的不进候选。
对象：${JSON.stringify(classes)}`,
    });
    return pairsSchema.parse(output).pairs;
  }
}

/** 槽位选择：有 OPENAI_API_KEY 走真模型（OpenAI 兼容协议，通用键同 Claude Code / Codex），实例缓存在 runtime 上；
 *  否则离线回退（CannedSlot：问数只覆盖演示剧本，逆向建模与候选对建议是通用启发式，各空间都能用）。
 *  模型必须显式指定 OPENAI_MODEL，不设默认；接入点用 OPENAI_BASE_URL，不设走 SDK 默认端点。 */
export function getSlot(): LlmSlot {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return new CannedSlot();
  const rt = runtime();
  if (!rt.llmSlot) {
    const model = process.env.OPENAI_MODEL;
    if (!model) throw new Error("OPENAI_MODEL 未设置：接真模型必须显式指定模型名");
    const xai = createXai({ apiKey: key, baseURL: process.env.OPENAI_BASE_URL ?? undefined });
    rt.llmSlot = new AiSdkSlot(xai.responses(model));
  }
  return rt.llmSlot;
}

/** 「表结构 → 对象建议」的组合原语：按连接内省定位 + 槽位产草稿。REST（generate_objects）与 MCP（propose_objects）共用；
 *  notFound 产出的错误类型由调用方定（路由 DraftReject、MCP EngineReject）。 */
export async function proposeObjectsFor(
  registry: DriverRegistry,
  tables: { connection: string; table: string }[],
  notFound: (msg: string) => Error
): Promise<Record<string, ObjectType>> {
  const infos = await resolveTableInfos(registry, tables, notFound);
  return getSlot().proposeObjects(infos);
}
