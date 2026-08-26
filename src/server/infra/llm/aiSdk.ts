// 真模型槽位 —— Vercel AI SDK + xAI：三个槽位同构 generateText({ model, output: Output.object({ schema }), prompt })。
// 提示词工程住这里（唯一住所）；模型当顾问不当计算器：出槽前再过一道 Zod（模型乱说话 = 拒绝，不进引擎）。
// 失败落盘：generateText 抛错或出槽 parse 失败时，原始产出写 os.tmpdir()/ontos-llm-fail/（key 字面值打码），
// 进程 console.error 一行路径——不绑任何测试门闩（走查就是生产路径）；罐头槽位不写。

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { generateText, Output, type LanguageModel } from "ai";
import type { QueryRequest } from "../../schema/request";
import { queryRequestSchema } from "../../schema/request";
import { objectTypeSchema, type ObjectType, type OntologyConfig } from "../../schema/config";
import type { TableInfo } from "../../infra/driver";
import { TENDENCIES, VERDICT_LABELS, type PairAdvice } from "../../schema/verdict";
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

/** 失败落盘：槽位名 / 实现名 / 输入摘要 / 原始产出或异常，写临时目录 JSON；OPENAI_API_KEY 字面值打码。
 *  落盘失败不挡原错误抛出（调试设施不能变成新故障源）。 */
function dumpFailure(slot: string, impl: string, input: unknown, output: unknown, err: unknown): void {
  try {
    const dir = join(tmpdir(), "ontos-llm-fail");
    mkdirSync(dir, { recursive: true });
    let text = JSON.stringify(
      { slot, impl, at: new Date().toISOString(), input, output, error: err instanceof Error ? (err.stack ?? err.message) : String(err) },
      null,
      2
    );
    const key = process.env.OPENAI_API_KEY;
    if (key) text = text.split(key).join("***"); // 密钥不进落盘文件
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slot}.json`);
    writeFileSync(file, text);
    console.error(`[ontos] 模型槽位 ${slot} 失败，原始产出已写入 ${file}`);
  } catch {
    // 落盘失败吞掉：原错误照样抛
  }
}

export class AiSdkSlot implements LlmSlot {
  readonly name: string;
  constructor(
    private model: LanguageModel,
    private gen: Gen = generateText // 测试注入假实现；生产是 SDK 的 generateText
  ) {
    this.name = `ai-sdk:${typeof model === "string" ? model : model.modelId}`;
  }

  /** 三槽位同一条失败闸：跑 run + parse，抛错或出槽校验失败都把原始产出落盘再原样抛出（parse 失败时能看见原文）。 */
  private async runWithFailureDump<T>(slot: string, input: unknown, run: () => Promise<{ output: unknown }>, parse: (output: unknown) => T): Promise<T> {
    let output: unknown;
    try {
      output = (await run()).output;
      return parse(output);
    } catch (e) {
      dumpFailure(slot, this.name, input, output, e);
      throw e;
    }
  }

  async nlToQuery(question: string, config: OntologyConfig, _ws: string): Promise<QueryRequest> {
    // 真模型各空间通用：workspace 论元只在罐头实现里当守门用（见 LlmSlot 接口注释）
    const classes = Object.entries(config.object_types).map(([name, t]) => ({
      name,
      description: t.description,
      // 属性带类型与枚举值：过滤值必须按 values 里的字面量编（in_service，不是「在役」），否则编译过但查出来 0 行
      properties: Object.entries(t.properties).map(([p, d]) => ({ name: p, type: d.type, ...(d.values ? { values: d.values } : {}) })),
      identity: t.identity,
      relations: Object.entries(config.link_types)
        .filter(([, l]) => l.from === name || l.to === name)
        // 反向只在有 inverse 时给（与 views.readClass 同口径；没有反向名的关系从本类看没有出站名）
        .flatMap(([linkName, l]) => (l.from === name ? [`${l.from} -[${linkName}]-> ${l.to}`] : l.inverse ? [`${l.from} <-[${l.inverse}]- ${l.to}`] : [])),
    }));
    return this.runWithFailureDump(
      "nlToQuery",
      { question, classes: classes.map((c) => c.name) },
      () =>
        this.gen({
          model: this.model,
          output: Output.object({ schema: queryRequestSchema }),
          prompt: `你是本体平台的问数编译器。把自然语言问题编译成结构化查询 JSON（schema 已约束形状）。
本体：${JSON.stringify(classes)}
规则：object 必须是上面的类名；filter 的键是属性名（派生属性可过滤），枚举属性给了 values——过滤值只能取 values 里的字面量（原样照抄，不要翻成中文）；
$link 是关系过滤；date 属性可用 now/d 这类日期表达式；展开用 expand: [{ relation: 关系名, properties: [...] }]；聚合用 aggregate: { group_by: [...], metrics: [{ count: "*" }] }。
答不出就返回最保守的空查询。问题：${question}`,
        }),
      (output) => queryRequestSchema.parse(output) // 出槽再验一次
    );
  }

  async proposeObjects(tables: { connection: string; table: TableInfo }[], occupied: string[] = []): Promise<Record<string, ObjectType>> {
    return this.runWithFailureDump(
      "proposeObjects",
      { tables: tables.map((t) => `${t.connection}.${t.table.name}`), occupied },
      () =>
        this.gen({
          model: this.model,
          output: Output.object({ schema: draftSchema }),
          prompt: `你是本体平台的逆向建模器。把数据库表结构翻成本体对象类型（object_types）。
规则：类名=表名的小写下划线形；kind 默 "thing"（记录事件的表用 "event"）；${IDENTITY_COL_RULE}；
properties 的类型只用 string/number/boolean/date/enum；sources 里 fields 是「属性名→列名」；pk 写真主键，没有就不写。
列带 comment 时把它的意思写进属性的 description（中文白话，别抄英文列名）。
不要把两张表合成一个类。
${occupied.length ? `已占用类名（不许再用）：${occupied.join("、")}。表名撞上已占用类名时，类名写成 {连接名}_{表名}（小写下划线，如 crm_sys_customer）。` : ""}
表：${JSON.stringify(tables.map((t) => ({ connection: t.connection, name: t.table.name, columns: t.table.columns })))}`,
        }),
      (output) => draftSchema.parse(output).object_types
    );
  }

  async proposePairs(classes: { name: string; sources: string[]; fields: string[] }[]): Promise<PairAdvice[]> {
    return this.runWithFailureDump(
      "proposePairs",
      { classes: classes.map((c) => c.name) },
      () =>
        this.gen({
          model: this.model,
          output: Output.object({ schema: pairsSchema }),
          prompt: `你是本体平台的整合顾问。下面是来自不同源的对象（名字、来源连接集合、字段名）。
找出跨源疑似同义的对，每对给倾向（枚举值 ${TENDENCIES.map((t) => `${t}=${VERDICT_LABELS[t]}`).join("、")}）与一句依据。有共同连接的不成对；字段和名字都不像的不进候选。
对象：${JSON.stringify(classes)}`,
        }),
      (output) => pairsSchema.parse(output).pairs
    );
  }
}
