// 真模型实现 —— Vercel AI SDK + xAI chat completions：三个出口同构 generateText({ model, prompt }) → 文本抠 JSON。
// 形状只走提示词（z.toJSONSchema），完全不下发 response_format：兼容网关普遍只实现 chat completions
//（Responses API 直接 404），带投机解码的模型连 json_object 都当语法约束拒绝（400）。
// 提示词工程住这里（唯一住所）；模型当顾问不当计算器：出槽前再过一道 Zod（模型乱说话 = 拒绝，不进引擎）。
// 失败落盘：generateText 抛错或出槽 parse 失败时，原始产出写 os.tmpdir()/ontos-llm-fail/（key 字面值打码），
// 进程 console.error 一行路径——不绑任何测试门闩（走查就是生产路径）；演示实现不写。

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { generateText, type LanguageModel } from "ai";
import { MSG } from "../../errors";
import type { QueryRequest } from "../../schema/request";
import { queryRequestSchema } from "../../schema/request";
import { enumValueKey, objectTypeSchema, type ObjectType, type OntologyConfig } from "../../schema/config";
import type { TableInfo } from "../../infra/driver";
import { TENDENCIES, VERDICT_LABELS, Verdict, type PairAdvice, type Tendency } from "../../schema/verdict";
import { IDENTITY_COL_RULE } from "./identityHint";
import type { ClassShot, KeyCandidateShot, KeySuggestion, Llm } from "./llm";

type Gen = typeof generateText;

const draftSchema = z.object({ object_types: z.record(z.string(), objectTypeSchema) });
const pairAdviceSchema = z.object({
  class_a: z.string(),
  class_b: z.string(),
  tendency: z.enum(TENDENCIES),
  reason: z.string(),
  keep: z.string().optional(),
  stage: z.object({ earlier: z.string(), from: z.string(), to: z.string() }).optional(),
});
const pairsSchema = z.object({
  pairs: z.array(pairAdviceSchema),
});
const keySuggestionSchema = z.object({ key: z.string().nullable(), reason: z.string() });

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

/** 失败落盘：出口名 / 实现名 / 输入摘要 / 原始产出或异常，写临时目录 JSON；OPENAI_API_KEY 字面值打码。
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
    console.error(`[ontos] 模型出口 ${slot} 失败，原始产出已写入 ${file}`);
  } catch {
    // 落盘失败吞掉：原错误照样抛
  }
}

export class AiSdkLlm implements Llm {
  readonly name: string;
  constructor(
    private model: LanguageModel,
    private gen: Gen = generateText // 测试注入假实现；生产是 SDK 的 generateText
  ) {
    this.name = `ai-sdk:${typeof model === "string" ? model : model.modelId}`;
  }

  /** 三个出口同一条失败闸：跑 run → 文本抠 JSON → parse；抛错或出槽校验失败都把原始文本落盘再原样抛出。 */
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
    // 真模型各空间通用：workspace 论元只在演示实现里当守门用（见 Llm 接口注释）
    const classes = Object.entries(config.object_types).map(([name, t]) => ({
      name,
      description: t.description,
      // 属性带类型与枚举值：过滤值必须按 values 里的 key 编（in_service，不是「在役」），否则编译过但查出来 0 行。
      // values 在配置里是 { value, label } 或裸字面量，这里只把 key 序列化给模型——提示词里的「字面量」才名实相符
      properties: Object.entries(t.properties).map(([p, d]) => ({ name: p, type: d.type, ...(d.values?.length ? { values: d.values.map(enumValueKey) } : {}) })),
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
$link 是关系过滤；date 属性可用 now/d 这类日期表达式；展开用 expand: [{ relation: 关系名, properties: [...] }]；聚合用 aggregate: { group_by: [实际分组键], metrics: [{ count: "*" }] }——按实际分组给键。
只问总数/多少条时不要用聚合：给普通列表查询（object + 可选 filter），对错板会数行数（引擎对空 group_by 的聚合按全体合计兜底，但不是首选）。
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
properties 的类型只用 string/number/boolean/date/enum；状态/阶段类列选 enum 并给 values（从列注释或取值里找现成词，原样照抄）；sources 里 fields 是「属性名→列名」；pk 写真主键，没有就不写；列带 unique 标记是数据库唯一约束（「唯一」的硬证据，判据见上）。
列带 comment 时把它的意思写进属性的 description（中文白话，别抄英文列名）。
不要把两张表合成一个类。
${occupied.length ? `已占用类名（不许再用）：${occupied.join("、")}。表名撞上已占用类名时，类名写成 {连接名}_{表名}（小写下划线，如 crm_sys_customer）。` : ""}
表：${JSON.stringify(tables.map((t) => ({ connection: t.connection, name: t.table.name, columns: t.table.columns })))}`,
        }),
      (output) => draftSchema.parse(output).object_types
    );
  }

  async proposePairs(classes: ClassShot[]): Promise<PairAdvice[]> {
    return this.runWithFailureDump(
      "proposePairs",
      { classes: classes.map((c) => c.name) },
      () =>
        this.gen({
          model: this.model,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          ...DECODING,
          prompt: `你是本体平台的整合顾问。下面是已上画布、有来源的对象（名字、来源连接集合、字段名、枚举属性 enums 的取值 key）。${shapeOf(pairsSchema)}
找出可能描述同一种或同一批现实事物的对，每对给倾向（枚举值 ${TENDENCIES.map((t) => `${t}=${VERDICT_LABELS[t]}`).join("、")}）与一句依据。每对都必须写 keep（两个类名之一，合并后留下的类；不要留下 shared_ 开头的公共对象）。
倾向生命周期时：写 stage.earlier（较早时期的类，个体先以哪一类存在）和 stage.from / stage.to——必须原样取自 enums 里同一属性的两个取值（早→晚），不许新造词、不许留空；没有可取的现成取值就整个省略 stage（引擎会用中性占位词）。其余倾向不要写 stage。人只点关系类型，留下谁、谁早谁晚按这几项执行。
同一连接上的两张表也可以成对——资格只看有没有源，不看跨不跨库。编号类字段即使名字不同（sn ≈ serial_no）也常常指向同一个体，是强召回线索。这是召回，不是判定：表可以是多行对多列，字段可以完全对不上，仍可能是${VERDICT_LABELS[Verdict.Same]}。
对象：${JSON.stringify(classes)}`,
        }),
      (output) => pairsSchema.parse(output).pairs
    );
  }

  async proposePair(input: {
    class_a: ClassShot;
    class_b: ClassShot;
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
4. 不论倾向是什么，都必须写 keep（两个类名之一；不要留下 shared_ 开头的公共对象）。倾向生命周期时再写 stage.earlier（较早时期的类，个体先以哪一类存在）和 stage.from / stage.to——必须原样取自给出的 enums 里同一属性的两个取值（早→晚），不许新造词、不许留空；没有可取的现成取值就整个省略 stage（引擎会用中性占位词）。其余倾向不要写 stage。人只点关系类型，融合按这几项执行。
5. 依据写一句人话，不要列编号。
对象：${JSON.stringify({ class_a: input.class_a, class_b: input.class_b, overlap: input.overlap })}`,
        }),
      (output) => pairAdviceSchema.parse(output)
    );
  }

  async proposeKey(input: { name: string; current?: string; candidates: KeyCandidateShot[] }): Promise<KeySuggestion> {
    return this.runWithFailureDump(
      "proposeKey",
      { name: input.name, candidates: input.candidates.map((c) => c.name) },
      () =>
        this.gen({
          model: this.model,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          ...DECODING,
          prompt: `你是本体平台的唯一键顾问。给一个类从候选列里选唯一键（identity），选不出就明确说。${shapeOf(keySuggestionSchema)}
对象：${JSON.stringify(input)}
规则：唯一键 = 跨源能对上同一个体的业务编号列（序列号、单号、证件号这类）。
1. 数据命中是硬证据：hits 里 hit > 0 的候选优先，命中越多越强；命中数少但值像业务编号的，按语义判断。
2. 表内唯一性：intraUnique 为 false 的候选在源表内就有重复，不能当唯一键。
3. 硬信号（unique / pk 标记）与数据命中一致最稳；pk / unique 标记都可能只是多列主键、多列唯一索引的一员——单列不唯一由 intraUnique 兜底；命中为 0 不否定候选——只说明没有数据佐证，可维持 current。
4. key 只能从候选列里选，不许新造；选不出就给 null，留给人定。reason 写一句白话，带依据（命中数、硬/软保证）。`,
        }),
      (output) => {
        const s = keySuggestionSchema.parse(output);
        if (s.key !== null && !input.candidates.some((c) => c.name === s.key)) return { key: null, reason: s.reason }; // 候选外乱选 = 没选
        return s;
      }
    );
  }
}
