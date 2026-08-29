// 罐头槽位 —— 没有模型 key 时的离线确定性回退：问数只覆盖 test 演示空间的剧本（demoQueries，本文件末尾），
// 逆向建模与候选对建议是通用启发式（按列名猜类型、按字段重合度给倾向），各空间都能用。
// 产出一律过 Zod 校验，与真模型同闸。本文件是演示逻辑的唯一住所——引擎其余源码不出现领域词。

import type { QueryRequest } from "../../schema/request";
import { queryRequestSchema } from "../../schema/request";
import type { ObjectType, OntologyConfig } from "../../schema/config";
import { isSharedObjectName } from "../../schema/config";
import type { TableInfo } from "../../infra/driver";
import { TEST_WORKSPACE } from "../../infra/workspace";
import { VERDICT_LABELS, Verdict, type PairAdvice, type Tendency } from "../../schema/verdict";
import { EngineReject, MSG } from "../../errors";
import { prefixedTableName, type ClassShot, type LlmSlot } from "./slot";
/** 列类型 → 属性类型（唯一出处）：mysql 给 int(11)、pg 给 integer/timestamp，统一大写再判。
 *  allowDate=false 给破格进属性的主键用（主键当识别字段时只分 number/string）。 */
function columnPropType(rawType: string, allowDate: boolean): "string" | "number" | "date" {
  const t = rawType.toUpperCase();
  if (t.includes("INT")) return "number";
  if (allowDate && (t.includes("DATE") || t.includes("TIME"))) return "date";
  return "string";
}

export class CannedSlot implements LlmSlot {
  readonly name = "canned-离线回退";
  async nlToQuery(question: string, config: OntologyConfig, workspace: string): Promise<QueryRequest> {
    // 空间守门（真实约束，写进签名的原因）：剧本是 test 空间的演示数据，别的空间问数必须配模型 Key——
    // 不能靠「config 里有没有同名类」巧合放行，否则别的空间任何问法都会被静默编成演示查询（错答案比报错糟）
    if (workspace !== TEST_WORKSPACE) throw new EngineReject(MSG.cannedWsOnly);
    // 剧本在本文件 demoQueries（test 空间的演示数据）：正则顺序即优先级，末条兜底。
    // 形状与真模型槽位出槽 JSON 一致（generateText 出文本抠 JSON，不下发 response_format），过同一道 Zod。
    // 无模型时问数没有通用编译法，剧本只对上了类才编；对不上说明不是演示问题，得配模型 Key
    const hit = demoQueries.find((q) => q.pattern.test(question))!;
    if (!config.object_types[hit.query.object]) {
      throw new EngineReject(MSG.cannedScriptOnly);
    }
    return queryRequestSchema.parse(hit.query);
  }

  async proposeObjects(tables: { connection: string; table: TableInfo }[], occupied: string[] = []): Promise<Record<string, ObjectType>> {
    const out: Record<string, ObjectType> = {};
    const taken = new Set(occupied); // 草稿里已有的类名：撞名带连接前缀，不静默覆盖（跨次生成撞名与本次撞名同一规则）
    for (const { connection, table } of tables) {
      const properties: Record<string, ObjectType["properties"][string]> = {};
      const fields: Record<string, string> = {};
      const pkCol = table.columns.find((c) => c.pk);
      for (const col of table.columns) {
        if (col.pk) continue; // 表主键只定位行，不进属性——除非它就是业务编号主键（见下）
        properties[col.name] = { type: columnPropType(col.type, true), ...(col.comment ? { description: col.comment } : {}) }; // 列注释存成字段说明
        fields[col.name] = col.name;
      }
      // 罐头没有语义可读，不按列名形状猜识别字段（规则单源 identityHint：形状证明不了唯一，_no/_id 结尾同样可能是自增代理键）。
      // 只认硬信号：主键本身是业务编号（非整数，如 person_no / dept_id）才当识别字段，破格进属性；
      // 整数自增主键是表内行号，跨源对不上号，宁缺勿错——identity 留空，人到待确认面板①定。
      let identity: string | undefined;
      if (pkCol && columnPropType(pkCol.type, false) !== "number") {
        identity = pkCol.name;
        properties[identity] = { type: columnPropType(pkCol.type, false), ...(pkCol.comment ? { description: pkCol.comment } : {}) };
        fields[identity] = identity;
      }
      // 撞名带连接前缀（本次已产出或草稿已占用都算撞）：跨连接同名表是裁决主场景，不静默覆盖
      // 前缀规则与落地前硬闸同一出处（slot.prefixedTableName）；仍撞的 _2 升级由硬闸（disambiguateClassNames）兜底
      const clsName = out[table.name] || taken.has(table.name) ? prefixedTableName(connection, table.name) : table.name;
      taken.add(clsName);
      // 来源照挂：没猜到 identity 不丢映射，键在待确认面板①定（草稿允许有源无 identity，发布闸 cfgNoRowKey 拦）
      out[clsName] = {
        kind: "thing",
        ...(identity ? { identity } : {}),
        properties,
        sources: { [connection]: { connection, table: table.name, ...(pkCol ? { pk: pkCol.name } : {}), fields } }, // 主键读不出就不写，不编造
      };
    }
    return out;
  }

  async proposePairs(classes: ClassShot[]): Promise<PairAdvice[]> {
    const pairs: PairAdvice[] = [];
    for (let i = 0; i < classes.length; i++) {
      for (let j = i + 1; j < classes.length; j++) {
        const advice = schemaAdvice(classes[i], classes[j]);
        if (advice) pairs.push(advice);
      }
    }
    return pairs;
  }

  async proposePair(input: {
    class_a: ClassShot;
    class_b: ClassShot;
    overlap: { rate: number; count_a: number; count_b: number; count_hit: number };
    base?: { tendency: Tendency; reason: string };
  }): Promise<PairAdvice> {
    // 锚：调用方给的第一版建议（清单快照的同一裁判）优先；没给才用本地字段判定推一个
    const base = input.base
      ? { class_a: input.class_a.name, class_b: input.class_b.name, tendency: input.base.tendency, reason: input.base.reason }
      : (schemaAdvice(input.class_a, input.class_b) ?? {
          class_a: input.class_a.name,
          class_b: input.class_b.name,
          tendency: Verdict.NameSimilar,
          reason: `名字和字段都不像（${input.class_a.name} / ${input.class_b.name}）`,
        });
    return reviseWithOverlap(base, input.class_a, input.class_b, input.overlap);
  }
}

/** 状态类列名：只当召回线索（生命周期 vs 部分重叠的倾向偏置），不是生命周期判据——列名形状证明不了时期。 */
const STAGE_FIELD = /status|state|阶段|状态/;

function ownStage(c: ClassShot): boolean {
  return c.fields.some((f) => STAGE_FIELD.test(f));
}

function hasStageField(a: ClassShot, b: ClassShot): boolean {
  return ownStage(a) || ownStage(b);
}

/** 留下谁：不留公共对象（判定与 features/sharedName 同一份，住 schema）；字段更多的优先；否则留下先写的那个。 */
function pickKeep(a: ClassShot, b: ClassShot): string {
  const aShared = isSharedObjectName(a.name);
  const bShared = isSharedObjectName(b.name);
  if (aShared && !bShared) return b.name;
  if (bShared && !aShared) return a.name;
  return a.fields.length < b.fields.length ? b.name : a.name;
}

/** 人只点关系类型；留下谁由建议给出。时期名、谁早谁晚罐头不产（没有语义可读，也不看值域证据）——
 *  省略 stage，由 executionPlan 的中性占位词兜底，画布上看得见，人事后可改标识。 */
function withKeep(p: PairAdvice, a: ClassShot, b: ClassShot): PairAdvice {
  return { ...p, keep: pickKeep(a, b) };
}

/** 只看名字和字段的倾向：列表建议与看过交集率之后的修订共用。同一库两张表也可以成对；字段名字都不像才不成对。 */
function schemaAdvice(a: ClassShot, b: ClassShot): PairAdvice | null {
  const shared = a.fields.filter((f) => b.fields.includes(f));
  const ratio = shared.length / Math.max(a.fields.length, b.fields.length, 1);
  const nameLike = a.name === b.name || (a.name.length > 2 && b.name.includes(a.name)) || (b.name.length > 2 && a.name.includes(b.name));
  if (ratio < 0.4 && !nameLike) return null; // 字段对不上、名字也不像，不进候选
  if (ratio < 0.4 && nameLike) {
    return withKeep({ class_a: a.name, class_b: b.name, tendency: Verdict.NameSimilar, reason: `名字相近（${a.name} / ${b.name}），字段对不上` }, a, b);
  }
  const hasStage = hasStageField(a, b);
  const tendency: Tendency = ratio > 0.8 ? Verdict.Same : hasStage ? Verdict.Stage : Verdict.Overlap;
  return withKeep({
    class_a: a.name,
    class_b: b.name,
    tendency,
    reason: `字段重合 ${shared.length}/${Math.max(a.fields.length, b.fields.length)}（${shared.join("、")}）${hasStage ? "；含状态字段" : ""}`,
  }, a, b);
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** 按三问改口：命中为零不支持部分重叠、不能否定类等价；命中大于零不支持同形异义。 */
function reviseWithOverlap(
  base: PairAdvice,
  a: ClassShot,
  b: ClassShot,
  overlap: { rate: number; count_a: number; count_b: number; count_hit: number }
): PairAdvice {
  const counts = `${overlap.count_hit} 条对得上号（${overlap.count_a} / ${overlap.count_b}）`;
  const empty = overlap.count_a === 0 || overlap.count_b === 0;
  if (overlap.count_hit === 0) {
    // 空表＝第二问沉默：证据不足以改口，沿用第一版。非空命中为零：现在不是同一批——
    // 部分重叠要有交集、生命周期要同一个体两头都在，都立不住，改口类等价（命中为零不能否定类等价）。
    const demote = base.tendency === Verdict.Overlap || (!empty && base.tendency === Verdict.Stage);
    const tendency = demote ? Verdict.Same : base.tendency;
    return withKeep({
      class_a: a.name,
      class_b: b.name,
      tendency,
      reason: empty
        ? `有一侧还没有行（${overlap.count_a} / ${overlap.count_b}），交集率说明不了是不是同一批，也不能据此否定${VERDICT_LABELS[Verdict.Same]}。${base.reason}`
        : `交集率 ${pct(overlap.rate)}（${counts}），现在不是同一批个体；命中为零，数据不支持${base.tendency === Verdict.Stage ? `${VERDICT_LABELS[Verdict.Stage]}（${VERDICT_LABELS[Verdict.Stage]}要求同一个体两头都在）` : VERDICT_LABELS[Verdict.Overlap]}，也不能据此否定${VERDICT_LABELS[Verdict.Same]}。${base.reason}`,
    }, a, b);
  }
  // 接近全交：命中大于零才谈得上（这一支已保证）。有状态字段且第一版倾向生命周期 → 维持生命周期（第三问答案为「是」）；
  // 否则全交、只看这一批 → 类等价。比率不再单独压过第三问——与 §3.2 合成表、ADR 0004 一致。
  if (overlap.rate >= 0.8) {
    const stage = hasStageField(a, b) && base.tendency === Verdict.Stage;
    return withKeep({
      class_a: a.name,
      class_b: b.name,
      tendency: stage ? Verdict.Stage : Verdict.Same,
      reason: stage
        ? `交集率 ${pct(overlap.rate)}（${counts}），接近全交、有状态字段、第一版已倾向${VERDICT_LABELS[Verdict.Stage]}，维持${VERDICT_LABELS[Verdict.Stage]}——同一批个体的不同时期。`
        : `交集率 ${pct(overlap.rate)}（${counts}），现在多半是同一批个体，倾向${VERDICT_LABELS[Verdict.Same]}。`,
    }, a, b);
  }
  const tendency = hasStageField(a, b) ? Verdict.Stage : Verdict.Overlap;
  return withKeep({
    class_a: a.name,
    class_b: b.name,
    tendency,
    reason:
      tendency === Verdict.Stage
        ? `交集率 ${pct(overlap.rate)}（${counts}），有交集又不是全交，又有状态字段，倾向${VERDICT_LABELS[Verdict.Stage]}。`
        : `交集率 ${pct(overlap.rate)}（${counts}），有交集又不是同一批，倾向部分重叠。`,
  }, a, b);
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
