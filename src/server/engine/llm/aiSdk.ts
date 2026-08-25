// 真模型槽位 —— Vercel AI SDK + xAI：三个槽位同构 generateText({ model, output: Output.object({ schema }), prompt })。
// 提示词工程住这里（唯一住所）；模型当顾问不当计算器：出槽前再过一道 Zod（模型乱说话 = 拒绝，不进引擎）。

import { z } from "zod";
import { generateText, Output, type LanguageModel } from "ai";
import type { QueryRequest } from "../../schema/request";
import { queryRequestSchema } from "../../schema/request";
import { objectTypeSchema, type ObjectType, type OntologyConfig } from "../../schema/config";
import type { TableInfo } from "../infra/driver";
import { TENDENCIES, VERDICT_LABELS, type PairAdvice } from "../adjudication/verdict";
import { IDENTITY_COL_RULE } from "./identityHint";
import type { LlmSlot } from "./slot";

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

  async nlToQuery(question: string, config: OntologyConfig, _ws: string): Promise<QueryRequest> {
    // 真模型各空间通用：ws 论元只在罐头实现里当守门用（见 LlmSlot 接口注释）
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
规则：类名=表名的小写下划线形；kind 默 "thing"（记录事件的表用 "event"）；${IDENTITY_COL_RULE}；
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
