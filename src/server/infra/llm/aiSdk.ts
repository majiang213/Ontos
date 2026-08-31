// 真模型实现 —— Vercel AI SDK + xAI chat completions：三个出口同构 generateText({ model, prompt }) → 文本抠 JSON。
// 形状只走提示词（z.toJSONSchema），完全不下发 response_format：兼容网关普遍只实现 chat completions
//（Responses API 直接 404），带投机解码的模型连 json_object 都当语法约束拒绝（400）。
// 提示词工程住这里（唯一住所）；模型当顾问不当计算器：出槽前再过一道 Zod（模型乱说话 = 拒绝，不进引擎）。
// 失败落盘：generateText 抛错或出槽 parse 失败时，原始产出写 os.tmpdir()/ontos-llm-fail/（key 字面值打码），
// 进程 console.error 一行路径——不绑任何测试门闩（走查就是生产路径）；演示实现不写。

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, ZodError } from "zod";
import { generateText, type LanguageModel } from "ai";
import { EngineReject, MSG } from "../../errors";
import type { QueryRequest } from "../../schema/request";
import { queryRequestSchema } from "../../schema/request";
import { enumValueKey, objectTypeSchema, type ObjectType, type OntologyConfig } from "../../schema/config";
import type { TableInfo } from "../../infra/driver";
import { TENDENCIES, VERDICT_LABELS, Verdict, type PairAdvice, type Tendency } from "../../schema/verdict";
import { IDENTITY_COL_RULE } from "./identityHint";
import { columnPropType, type ClassShot, type KeyCandidateShot, type KeySuggestion, type Llm } from "./llm";

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

/** D-a 出槽列覆盖率：输入的每一列都必须有归宿——模型丢的列按列定义自动补齐（属性 + fields），丢整表的补整对象。
 *  判定是纯代码对照（输入列清单 vs 覆盖清单），不需要模型参与；补齐的属性 description 带短标注，人可改可删。 */
function backfillUncoveredColumns(
  objects: Record<string, Record<string, unknown>>,
  tables: { connection: string; table: TableInfo }[]
): void {
  const covered = new Set<string>();
  const ownerOf = new Map<string, string>();
  for (const [oname, o] of Object.entries(objects)) {
    const srcs = (o.sources ?? {}) as Record<string, { connection: string; table: string; fields: Record<string, string> }>;
    for (const s of Object.values(srcs)) {
      ownerOf.set(`${s.connection}::${s.table}`, oname);
      for (const col of Object.values(s.fields ?? {})) covered.add(`${s.connection}::${s.table}::${col}`);
    }
  }
  // 模型有时只写概念类、忘了挂 sources（单表批尤其常见）：唯一无源类收养没主的表，把表挂回它，不造孪生类
  const sourceless = Object.entries(objects)
    .filter(([, o]) => !o.sources || Object.keys(o.sources as Record<string, unknown>).length === 0)
    .map(([n]) => n);
  const adopter = sourceless.length === 1 ? sourceless[0] : undefined;
  for (const t of tables) {
    const tk = `${t.connection}::${t.table.name}`;
    for (const col of t.table.columns) {
      const ck = `${tk}::${col.name}`;
      if (covered.has(ck)) continue;
      if (col.pk && col.type === "INTEGER" && !col.comment) { covered.add(ck); continue; } // 自增技术列：只定位行
      const oname = ownerOf.get(tk);
      if (!oname) {
        if (adopter) {
          ownerOf.set(tk, adopter);
        } else {
          const base = t.table.name;
          const newName = objects[base] ? `${base}_2` : base;
          objects[newName] = {
            kind: "thing",
            description: `${t.table.name}（出槽补齐：模型未覆盖此表，按列定义补为对象）`,
            properties: {},
            sources: { [t.connection]: { connection: t.connection, table: t.table.name, fields: {} } },
          };
          ownerOf.set(tk, newName);
        }
      }
      const o = objects[ownerOf.get(tk)!];
      (o as { sources?: Record<string, unknown> }).sources ??= {}; // 收养的类没有 sources 键：先落一个空壳，下面的条目才挂得上
      const srcs = (o.sources ?? {}) as Record<string, { connection: string; table: string; pk?: string; fields: Record<string, string> }>;
      const sname = Object.keys(srcs).find((k) => srcs[k].connection === t.connection && srcs[k].table === t.table.name) ?? t.connection;
      const entry = (srcs[sname] ??= { connection: t.connection, table: t.table.name, fields: {} });
      const props = (o.properties ??= {}) as Record<string, unknown>;
      if (!props[col.name]) {
        props[col.name] = {
          type: columnPropType(col.type),
          description: col.comment ? `${col.comment}（自动补齐：模型未覆盖此列，按列定义补为属性）` : "自动补齐：模型未覆盖此列，按列定义补为属性",
        };
      }
      entry.fields[col.name] = col.name;
      covered.add(ck);
    }
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

  /** 三个出口同一条失败闸：跑 run → 文本抠 JSON → parse；抛错或出槽校验失败都把原始文本落盘再抛出。
   *  出槽 Zod 失败是「模型乱说话」不是「请求形状不合法」——改抛 EngineReject，别让 respond 把它误标成请求错误。 */
  private async runWithFailureDump<T>(slot: string, input: unknown, run: () => Promise<{ text: string }>, parse: (output: unknown) => T): Promise<T> {
    let raw: unknown;
    try {
      const { text } = await run();
      raw = text;
      return parse(extractJson(text));
    } catch (e) {
      dumpFailure(slot, this.name, input, raw, e);
      if (e instanceof ZodError) throw new EngineReject(MSG.llmOutputShapeBad);
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
规则：object 必须是上面的类名，从 description 挑最贴题的一个——把 description 整句读完再挑，别只对上一个词；两个类都沾题面字样时，看描述里的领域词（管设备还是管办公）与题面一致才算；filter 的键是属性名（派生属性可过滤），枚举属性给了 values——过滤值只能取 values 里的字面量（原样照抄，不要翻成中文）；
关系条件必须套在 $link 里，不能把关系名直接当 filter 键：挂在关系上的条件写 filter: { "$link": { 关系名: 条件 } }（如保修期内的设备 → { "$link": { covered_by: { expiry: { gte: "now/d" } } } }），只要挂着这条关系、不带条件就写 true；
date 属性可用 now/d 这类日期表达式；展开用 expand: [{ relation: 关系名, properties: [...] }]；聚合用 aggregate: { group_by: [实际分组键], metrics: [{ count: "*" }] }——按实际分组给键。
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
          prompt: `你是本体平台的逆向建模器。先归纳：这批表在描述哪些概念？描述同一个体（或其不同时期/侧面）的表，并成同一个对象类型——sources 挂全部相关表；描述不同概念的表，各自立类。${shapeOf(draftSchema)}
行的性质判据：行是个体本身（或其时期，如采购条目之于在途设备、点检对象之于被点检设备、处置之于已处置设备）的表，与个体台账是同一概念；行是发生在个体上的动作记录或挂在其上的凭证（工单、流水、保修卡、门禁卡）的表，是独立概念——它的归宿是与主体建链，不在本次归纳里硬塞。两张表的列值重合（同一批序列号出现在两张表）不说明是同一概念，先看每行的性质再决定并不并。
每张输入表恰好归入一个类的 sources，一个表不要既并进一个类又单独立类；哪怕整批只有一张表，也要把这张表挂进它那个类的 sources（没有 sources 的对象落不了库）。
规则：对象类型名 = 概念名的小写下划线形（多个表同一概念时，取最能代表概念的表名）；kind 默 "thing"（记录动作的类用 "event"）；${IDENTITY_COL_RULE}；
properties 的类型只用 string/number/boolean/date/enum；状态/时期类列选 enum 并给 values——values 必须原样取自该列采样行里的真实值或列注释里的现成词（至少 2 个，照抄不翻译）；采样和注释都给不出 ≥2 个现成取值，就用 string，不要造 enum；sources 里 fields 是「属性名→列名」，同一概念的每张表都要有自己的源条目；pk 写真主键，没有就不写；列带 unique 标记是数据库唯一约束（「唯一」的硬证据，判据见上）。
每一列都必须有归宿：成为某对象的属性并进 sources.fields；纯技术列（自增整数主键且无注释）除外。
列带 comment 时把它的意思写进属性的 description（中文白话，别抄英文列名）。
${occupied.length ? `已占用类名（不许再用）：${occupied.join("、")}。新概念撞上已占用类名时，类名写成 {连接名}_{表名}（小写下划线，如 crm_sys_customer）。` : ""}
表：${JSON.stringify(tables.map((t) => ({ connection: t.connection, name: t.table.name, columns: t.table.columns, ...(t.table.sample?.length ? { sample_rows: t.table.sample } : {}) })))}`,
        }),
      (output) => {
        // 提示词承诺「kind 默 thing」「enum 凑不出 ≥2 个现成取值就用 string」：模型照约省略/欠妥时补默认再出槽——不整批拒绝（9 表批次曾因此全被否）
        const raw = (output as { object_types?: Record<string, Record<string, unknown>> }).object_types ?? {};
        const filled = Object.fromEntries(
          Object.entries(raw).map(([name, t]) => {
            const o = { ...t } as Record<string, unknown>;
            if (o.kind == null) o.kind = "thing";
            const props = (o.properties ?? {}) as Record<string, Record<string, unknown>>;
            o.properties = Object.fromEntries(
              Object.entries(props).map(([p, def]) => {
                const d = { ...def };
                if (d.type === "enum" && (!Array.isArray(d.values) || d.values.length < 2)) {
                  d.type = "string";
                  delete d.values;
                }
                return [p, d];
              })
            );
            return [name, o];
          })
        );
        backfillUncoveredColumns(filled, tables); // D-a：输入列必须有归宿——模型丢的列按列定义补回
        return draftSchema.parse({ object_types: filled }).object_types;
      }
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
          prompt: `你是本体平台的整合顾问。下面是已上画布、有来源的对象（名字、来源连接集合、存在方式 kind、字段名、枚举属性 enums 的取值 key）。${shapeOf(pairsSchema)}
先按行的性质分流：行是个体本身（或其时期，如采购条目之于在途设备、点检对象之于被点检设备）的两边，才比"是否同一概念"（同一种 → same/overlap/stage）；一边是发生在个体上的记录或挂在其上的凭证（工单、流水、保修卡、门禁卡）的配对，不比同类——倾向给 ${VERDICT_LABELS[Verdict.NameSimilar]}，它们的归宿是与主体建链，不进合并判定（行与个体一一对应的记录如处置、点检是个体的时期，仍可进合并判定）。
找出可能描述同一种或同一批现实事物的对，每对给倾向（枚举值 ${TENDENCIES.map((t) => `${t}=${VERDICT_LABELS[t]}`).join("、")}）与一句依据。每对都必须写 keep（两个类名之一，合并后留下的类；不要留下 shared_ 开头的公共对象）。
倾向生命周期时：写 stage.earlier（较早时期的类，个体先以哪一类存在）和 stage.from / stage.to——必须原样取自 enums 里同一属性的两个取值（早→晚），不许新造词、不许留空；没有可取的现成取值就整个省略 stage（引擎会用中性占位词）。其余倾向不要写 stage。人只点关系类型，留下谁、谁早谁晚按这几项执行。
同一连接上的两张表也可以成对——资格只看有没有源，不看跨不跨库。编号类字段即使名字不同（sn ≈ serial_no）也常常指向同一个体，是强召回线索；但列重合不压过行的性质（保修卡的设备序列号与资产表全对得上，卡也不是设备）。这是召回，不是判定：表可以是多行对多列，字段可以完全对不上，仍可能是${VERDICT_LABELS[Verdict.Same]}。
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
按三问给倾向。第一问同一种事物：人定案；命中大于零是硬线索（对得上号的个体是同一个体），不许给${VERDICT_LABELS[Verdict.NameSimilar]}。命中为零不回答第一问，但第二问的交集率是硬证据。第二问同一批个体：只看交集率。第三问不同时期：状态、日期只是线索。
硬约束：命中大于零不许给${VERDICT_LABELS[Verdict.NameSimilar]}；命中为零不许给${VERDICT_LABELS[Verdict.Same]}、${VERDICT_LABELS[Verdict.Overlap]}、${VERDICT_LABELS[Verdict.Stage]}——这三种都靠"对得上号的个体"撑腰，0 条对上号就是反证。表是多行还是多列、字段是否同名，不能当否决。
判定顺序：
1. 有一侧取不出取值：第二问沉默，证据不足以改口${base ? `——第一版若是${VERDICT_LABELS[Verdict.Overlap]}则改口${VERDICT_LABELS[Verdict.Same]}（没有交集）` : `——倾向${VERDICT_LABELS[Verdict.Same]}，不能定${VERDICT_LABELS[Verdict.NameSimilar]}`}。依据写清一侧还没行。
2. 两边都有取值、命中为零：0 条对得上号是硬证据——两边现在不是同一批个体，不许给${VERDICT_LABELS[Verdict.Same]}、${VERDICT_LABELS[Verdict.Overlap]}、${VERDICT_LABELS[Verdict.Stage]}。倾向${VERDICT_LABELS[Verdict.NameSimilar]}：依据必须带「交集率 0%」并点明两边的唯一键各是什么（如设备按序列号、工单按工单号——工单是指向设备的记录，不是设备本身）；怀疑键选错造成假 0 时，依据里写明请人工改唯一键再重算，倾向仍给${VERDICT_LABELS[Verdict.NameSimilar]}。第一版无论是什么都改口，不许维持。
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
0. 先分行：本表的行是个体本身（或其时期，如采购条目之于在途设备、点检对象之于设备），还是关于个体的记录（保修卡、工单、流水）？前者身份取个体编号列；后者取记录自己的单号列——身上指向别的个体的编号列（如保修卡上的设备序列号）是引用不是身份，命中越多越除名。
1. 数据命中是硬证据，但只对"行是个体本身/时期"的表加分：hits 里 hit > 0 的候选优先，命中越多越强；命中为 0 不否定候选——只说明没有数据佐证，可维持 current。
2. 表内唯一性：intraUnique 为 false 的候选在源表内就有重复，不能当唯一键。
3. 硬信号（unique / pk 标记）与分行判断、数据命中一致最稳；pk / unique 标记都可能只是多列主键的一员——单列不唯一由 intraUnique 兜底。
4. key 只能从候选列里选，不许新造；选不出就给 null，留给人定。reason 写一句白话，带依据（行性质、命中数、硬/软保证）。`,
        }),
      (output) => {
        const s = keySuggestionSchema.parse(output);
        if (s.key !== null && !input.candidates.some((c) => c.name === s.key)) return { key: null, reason: s.reason }; // 候选外乱选 = 没选
        return s;
      }
    );
  }
}
