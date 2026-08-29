// 真模型槽位 —— Vercel AI SDK + xAI chat completions：三个槽位同构 generateText({ model, prompt }) → 文本抠 JSON。
// 形状只走提示词（z.toJSONSchema），完全不下发 response_format：兼容网关普遍只实现 chat completions
//（Responses API 直接 404），带投机解码的模型连 json_object 都当语法约束拒绝（400）。
// 提示词工程住这里（唯一住所）；模型当顾问不当计算器：出槽前再过一道 Zod（模型乱说话 = 拒绝，不进引擎）。
// 失败落盘：generateText 抛错或出槽 parse 失败时，原始产出写 os.tmpdir()/ontos-llm-fail/（key 字面值打码），
// 进程 console.error 一行路径——不绑任何测试门闩（走查就是生产路径）；罐头槽位不写。

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { generateText, type LanguageModel } from "ai";
import { MSG } from "../../errors";
import type { QueryRequest } from "../../schema/request";
import { queryRequestSchema } from "../../schema/request";
import { objectTypeSchema, type ObjectType, type OntologyConfig } from "../../schema/config";
import type { TableInfo } from "../../infra/driver";
import { TENDENCIES, VERDICT_LABELS, Verdict, type PairAdvice, type Tendency } from "../../schema/verdict";
import { IDENTITY_COL_RULE } from "./identityHint";
import type { LlmSlot } from "./slot";

type Gen = typeof generateText;

const draftSchema = z.object({ object_types: z.record(z.string(), objectTypeSchema) });
const pairAdviceSchema = z.object({
  class_a: z.string(),
  class_b: z.string(),
  tendency: z.enum(TENDENCIES),
  reason: z.string(),
});
const pairsSchema = z.object({
  pairs: z.array(pairAdviceSchema),
});

/** 输出形状的提示词片段：response_format 完全不下发，形状只靠提示词给（zod → JSON Schema 的唯一渲染处）。 */
function shapeOf(schema: z.ZodType): string {
  return `只输出 JSON，形状按这份 JSON Schema：${JSON.stringify(z.toJSONSchema(schema))}`;
}

/** 输出 token 上限：网关默认上限会截断长草稿（多表 JSON 写一半就断，如 proposeObjects），显式放宽留足余量。 */
const MAX_OUTPUT_TOKENS = 8192;

/** 解码参数（单一住所）：零温度 + 固定种子——同一份输入必须给同一份答案（裁决建议、验收跑批都靠这个稳定）；
 *  零温度把采样方差压没，种子让供应商侧尽力确定性解码；两者都不改模型能力，只关随机性。 */
const DECODING = { temperature: 0, seed: 42 } as const;

/** 从模型文本里抠 JSON：兼容 ```json 围栏与前后闲话；抠不出或不是合法 JSON 都归一个文案（原始文本走失败落盘）。 */
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(MSG.noJsonInModelOutput);
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new Error(MSG.noJsonInModelOutput);
  }
}

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

  /** 三槽位同一条失败闸：跑 run → 文本抠 JSON → parse；抛错或出槽校验失败都把原始文本落盘再原样抛出。 */
  private async runWithFailureDump<T>(slot: string, input: unknown, run: () => Promise<{ text: string }>, parse: (output: unknown) => T): Promise<T> {
    let raw: unknown;
    try {
      const { text } = await run();
      raw = text;
      return parse(extractJson(text));
    } catch (e) {
      dumpFailure(slot, this.name, input, raw, e);
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
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          ...DECODING,
          prompt: `你是本体平台的问数编译器。把自然语言问题编译成结构化查询 JSON。${shapeOf(queryRequestSchema)}
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
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          ...DECODING,
          prompt: `你是本体平台的逆向建模器。把数据库表结构翻成本体对象类型（object_types）。${shapeOf(draftSchema)}
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
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          ...DECODING,
          prompt: `你是本体平台的整合顾问。下面是已上画布、有来源的对象（名字、来源连接集合、字段名）。${shapeOf(pairsSchema)}
找出可能描述同一种或同一批现实事物的对，每对给倾向（枚举值 ${TENDENCIES.map((t) => `${t}=${VERDICT_LABELS[t]}`).join("、")}）与一句依据。同一连接上的两张表也可以成对（候选人表和员工表）。这是召回，不是判定：表可以是多行对多列，字段可以完全对不上，仍可能是${VERDICT_LABELS[Verdict.Same]}。
对象：${JSON.stringify(classes)}`,
        }),
      (output) => pairsSchema.parse(output).pairs
    );
  }

  async proposePair(input: {
    class_a: { name: string; sources: string[]; fields: string[] };
    class_b: { name: string; sources: string[]; fields: string[] };
    overlap: { rate: number; count_a: number; count_b: number; count_hit: number };
    base?: { tendency: Tendency; reason: string };
  }): Promise<PairAdvice> {
    const labels = TENDENCIES.map((t) => `${t}=${VERDICT_LABELS[t]}`).join("、");
    const base = input.base;
    return this.runWithFailureDump(
      "proposePair",
      { class_a: input.class_a.name, class_b: input.class_b.name, overlap: input.overlap },
      () =>
        this.gen({
          model: this.model,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          ...DECODING,
          prompt: `你是本体平台的整合顾问。下面这一对已经算过交集率（唯一键洗过之后，两边对得上号的比例）。${shapeOf(pairAdviceSchema)}
倾向枚举：${labels}。class_a / class_b 必须用下面给的两个类名。
${base ? `第一版建议（只看字段和名字时给的）：「${VERDICT_LABELS[base.tendency]}」——${base.reason}
现在的任务是看过硬证据后决定「维持」还是「改口」：以第一版为锚，不要从头重判，同一对、同一份计数，答案必须唯一。` : "这一对没有第一版建议（清单之外）。按下面的判定顺序给倾向与一句白话依据，不要自由发挥：同一对、同一份计数，答案必须唯一。"}
按三问给倾向。第一问同一种事物：人定案；命中大于零是硬线索（对得上号的个体是同一个体），不许给${VERDICT_LABELS[Verdict.NameSimilar]}。命中为零不能否定${VERDICT_LABELS[Verdict.Same]}。第二问同一批个体：只看交集率。第三问不同时期：状态、日期只是线索。
硬约束：命中大于零不许给${VERDICT_LABELS[Verdict.NameSimilar]}；命中为零不许给${VERDICT_LABELS[Verdict.Overlap]}。表是多行还是多列、字段是否同名，不能当否决。
判定顺序：
1. 有一侧取不出取值：第二问沉默，证据不足以改口${base ? `——第一版若是${VERDICT_LABELS[Verdict.Overlap]}则改口${VERDICT_LABELS[Verdict.Same]}（没有交集）` : `——倾向${VERDICT_LABELS[Verdict.Same]}，不能定${VERDICT_LABELS[Verdict.NameSimilar]}`}。依据写清一侧还没行。
2. 两边都有取值、命中为零：现在不是同一批；不能定${VERDICT_LABELS[Verdict.Overlap]}；不能据此否定${VERDICT_LABELS[Verdict.Same]}。第一版是${VERDICT_LABELS[Verdict.NameSimilar]}可维持，否则倾向${VERDICT_LABELS[Verdict.Same]}。
3. 命中大于零、接近全交：接近全交本身只答「现在是同一批」。有状态字段、且第一版倾向${VERDICT_LABELS[Verdict.Stage]} → 维持${VERDICT_LABELS[Verdict.Stage]}（第三问为「是」）；否则 → ${VERDICT_LABELS[Verdict.Same]}。介于中间、有状态或日期 → ${VERDICT_LABELS[Verdict.Stage]}；介于中间否则 → ${VERDICT_LABELS[Verdict.Overlap]}。依据必须带比率与对得上号的条数。
4. 依据写一句人话，不要列编号。
对象：${JSON.stringify({ class_a: input.class_a, class_b: input.class_b, overlap: input.overlap })}`,
        }),
      (output) => pairAdviceSchema.parse(output)
    );
  }
}
