// 罐头槽位 —— 没有模型 key 时的离线确定性回退：问数只覆盖 test 演示空间的剧本（demoQueries，本文件末尾），
// 逆向建模与候选对建议是通用启发式（按列名猜类型、按字段重合度给倾向），各空间都能用。
// 产出一律过 Zod 校验，与真模型同闸。本文件是演示逻辑的唯一住所——引擎其余源码不出现领域词。

import type { QueryRequest } from "../../schema/request";
import { queryRequestSchema } from "../../schema/request";
import type { ObjectType, OntologyConfig } from "../../schema/config";
import type { TableInfo } from "../../infra/driver";
import { TEST_WORKSPACE } from "../../infra/workspace";
import { Verdict, type PairAdvice, type Tendency } from "../../schema/verdict";
import { EngineReject, MSG } from "../../errors";
import { IDENTITY_COL_RE } from "./identityHint";
import { prefixedTableName, type LlmSlot } from "./slot";

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
      let identity: string | undefined;
      const pkCol = table.columns.find((c) => c.pk);
      for (const col of table.columns) {
        if (col.pk) continue; // 表主键只定位行，不进属性——除非它就是识别字段（见下）
        properties[col.name] = { type: columnPropType(col.type, true), ...(col.comment ? { description: col.comment } : {}) }; // 列注释存成字段说明
        fields[col.name] = col.name;
        if (!identity && IDENTITY_COL_RE.test(col.name)) identity = col.name; // 识别字段先猜编号列（规则单源 identityHint）
      }
      // 编号列猜不到、主键本身就是业务编号（如 person_no）时：主键当识别字段，破格进属性
      if (!identity && pkCol) {
        identity = pkCol.name;
        properties[pkCol.name] = { type: columnPropType(pkCol.type, false), ...(pkCol.comment ? { description: pkCol.comment } : {}) };
        fields[pkCol.name] = pkCol.name;
      }
      // 撞名带连接前缀（本次已产出或草稿已占用都算撞）：跨连接同名表是裁决主场景，不静默覆盖
      // 前缀规则与落地前硬闸同一出处（slot.prefixedTableName）；仍撞的 _2 升级由硬闸（disambiguateClassNames）兜底
      const clsName = out[table.name] || taken.has(table.name) ? prefixedTableName(connection, table.name) : table.name;
      taken.add(clsName);
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

type ClassShot = { name: string; sources: string[]; fields: string[] };

function hasStageField(a: ClassShot, b: ClassShot): boolean {
  return [...a.fields, ...b.fields].some((f) => /status|state|阶段|状态/.test(f));
}

/** 只看名字和字段的倾向：列表建议与看过交集率之后的修订共用。同一库两张表也可以成对；字段名字都不像才不成对。 */
function schemaAdvice(a: ClassShot, b: ClassShot): PairAdvice | null {
  const shared = a.fields.filter((f) => b.fields.includes(f));
  const ratio = shared.length / Math.max(a.fields.length, b.fields.length, 1);
  const nameLike = a.name === b.name || (a.name.length > 2 && b.name.includes(a.name)) || (b.name.length > 2 && a.name.includes(b.name));
  if (ratio < 0.4 && !nameLike) return null; // 字段对不上、名字也不像，不进候选
  if (ratio < 0.4 && nameLike) {
    return { class_a: a.name, class_b: b.name, tendency: Verdict.NameSimilar, reason: `名字相近（${a.name} / ${b.name}），字段对不上` };
  }
  const hasStage = hasStageField(a, b);
  const tendency: Tendency = ratio > 0.8 ? Verdict.Same : hasStage ? Verdict.Stage : Verdict.Overlap;
  return {
    class_a: a.name,
    class_b: b.name,
    tendency,
    reason: `字段重合 ${shared.length}/${Math.max(a.fields.length, b.fields.length)}（${shared.join("、")}）${hasStage ? "；含状态字段" : ""}`,
  };
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** 按三问改口：命中为零不支持部分重叠、不能否定同一；命中大于零不支持仅名称相似。 */
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
    // 部分重叠要有交集、阶段要同一个体两头都在，都立不住，改口同一（命中为零不能否定同一）。
    const demote = base.tendency === Verdict.Overlap || (!empty && base.tendency === Verdict.Stage);
    const tendency = demote ? Verdict.Same : base.tendency;
    return {
      class_a: a.name,
      class_b: b.name,
      tendency,
      reason: empty
        ? `有一侧还没有行（${overlap.count_a} / ${overlap.count_b}），交集率说明不了是不是同一批，也不能据此否定同一。${base.reason}`
        : `交集率 ${pct(overlap.rate)}（${counts}），现在不是同一批个体；命中为零，数据不支持${base.tendency === Verdict.Stage ? "阶段（阶段要求同一个体两头都在）" : "部分重叠"}，也不能据此否定同一。${base.reason}`,
    };
  }
  // 接近全交：命中大于零才谈得上（这一支已保证）。有状态字段且第一版倾向阶段 → 维持阶段（第三问答案为「是」）；
  // 否则全交、只看这一批 → 同一。比率不再单独压过第三问——与 §3.2 合成表、ADR 0004 一致。
  if (overlap.rate >= 0.8) {
    const stage = hasStageField(a, b) && base.tendency === Verdict.Stage;
    return {
      class_a: a.name,
      class_b: b.name,
      tendency: stage ? Verdict.Stage : Verdict.Same,
      reason: stage
        ? `交集率 ${pct(overlap.rate)}（${counts}），接近全交、有状态字段、第一版已倾向阶段，维持阶段——同一批个体的不同时期。`
        : `交集率 ${pct(overlap.rate)}（${counts}），现在多半是同一批个体，倾向同一。`,
    };
  }
  const tendency = hasStageField(a, b) ? Verdict.Stage : Verdict.Overlap;
  return {
    class_a: a.name,
    class_b: b.name,
    tendency,
    reason:
      tendency === Verdict.Stage
        ? `交集率 ${pct(overlap.rate)}（${counts}），有交集又不是全交，又有状态字段，倾向阶段。`
        : `交集率 ${pct(overlap.rate)}（${counts}），有交集又不是同一批，倾向部分重叠。`,
  };
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
