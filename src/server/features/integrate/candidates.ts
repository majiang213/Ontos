// 疑似重复的候选 —— 「哪些对等着人裁」：候选集按草稿内容快照（adj_candidates），同一内容只问一次模型。
// 定案后钉快照（pinCandidateSnapshot）：并类/立公共对象只改写串里的对，不把串外拉进来。
// 资格谓词在 eligibility.ts。定案过滤在读时套——跳过不改草稿、同形异义只写 class_conclusions，清单仍即时消失。

import { createHash } from "node:crypto";
import type { EngineEnv } from "../env";
import { getDraft } from "../ontology/current";
import { connectionsOf, hasSources, pairEligible, pairKey } from "./eligibility";
import { rewriteAfterVerdict } from "./chain";
import { cleanAdvice, Verdict, type PairAdvice } from "../../schema/verdict";
import { enumValueKey, type ObjectType, type OntologyConfig } from "../../schema/config";
import type { ClassShot } from "../../infra/llm/llm";
import { MSG, toResult, type Result } from "../../errors";
import { DEFAULT_WORKSPACE } from "../../infra/workspace";
import { isSharedObjectName } from "../ontology/sharedName";

/** 建议规则版本：判定口径或可执行前提变了就 +1——混进哈希，旧规则写的快照自然失效重算。
 *  3：入围改为有源∧未定案（同一库两张表可成对）；三问改口规则。
 *  4：建议带可执行方案（keep / stage），人只点关系类型。
 *  5：建议输入带枚举值域 enums——时期名判据（原样取现成取值，不新造词）；演示实现不再带时期名与先后。 */
const ADVICE_RULES_VERSION = 5;

/** 投喂形状的哈希：类名 + 连接集 + 字段名 + 枚举值域（各自排序后序列化），前缀建议规则版本。快照的失效键——
 *  唯一键、字段类型、来源列对照、摆位都不在里头，改了不重算（它们不在模型的输入里；唯一键只是读时过滤清单，见 listCandidates）。
 *  排序一律按码元（不用 localeCompare）：多实例 ICU 本地化不同会把同一份内容排出两种序，哈希就白算了。 */
function shotHash(classes: ClassShot[]): string {
  const canon = [
    ADVICE_RULES_VERSION,
    ...classes.map((c) => [c.name, c.sources, [...c.fields].sort(), [...c.enums].sort((x, y) => (x.name < y.name ? -1 : 1))] as const).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
  ];
  return createHash("sha1").update(JSON.stringify(canon)).digest("hex");
}

/** 类的建议快照（唯一构造处）：字段名 + 枚举属性的取值 key。candidates 与 proposePair 共用，不另写投影。 */
export function classShots(d: OntologyConfig): ClassShot[] {
  return Object.entries(d.object_types)
    .filter(([, t]) => hasSources(t))
    .map(([name, t]) => ({
      name,
      sources: [...connectionsOf(t)].sort(),
      fields: Object.keys(t.properties),
      enums: Object.entries(t.properties)
        .filter(([, p]) => p.type === "enum" && p.values && p.values.length > 0)
        .map(([n, p]) => ({ name: n, values: p.values!.map(enumValueKey) })),
    }));
}

/** 写侧过筛：类还在、有源、未定案、同对只留一条。listCandidates 与钉快照共用。 */
function keepPairs(proposals: PairAdvice[], byName: Map<string, ObjectType>, decided: Set<string>): PairAdvice[] {
  const seen = new Set<string>();
  return proposals.filter((p) => {
    const a = byName.get(p.class_a);
    const b = byName.get(p.class_b);
    if (!a || !b || !pairEligible(a, b, decided, p.class_a, p.class_b)) return false;
    const k = pairKey(p.class_a, p.class_b);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 类名集合的变化是不是「并掉一个类 / 立了 shared_* 公共对象」：这种失配沿用还活着的对，不问模型。
 *  字段变了但类名没变（加字段）仍要再猜。 */
function nameChangeIsVerdict(prev: string[] | undefined, now: string[]): boolean {
  if (!prev) return false;
  const old = new Set(prev);
  const next = new Set(now);
  const gained = now.filter((n) => !old.has(n));
  const lost = prev.filter((n) => !next.has(n));
  if (lost.length === 0 && gained.length === 0) return false;
  return gained.every(isSharedObjectName);
}

/** 候选对建议原语（快照命中或问实现）：键未定的类同样在列——识别唯一键要用它当可比对象；
 *  疑似重复清单的键过滤见 listCandidates（ADR 0010：键未定的类不参与疑似重复）。 */
export async function pairProposals(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<PairAdvice[]> {
  const d = (await getDraft(env, workspace)).draft;
  const classes = classShots(d);
  const names = classes.map((c) => c.name);
  const hash = shotHash(classes);
  const snap = await env.meta.readCandidateSnapshot(workspace);
  const byName = new Map(Object.entries(d.object_types));
  const none = new Set<string>();
  let proposals: PairAdvice[];
  if (snap && snap.shot_hash === hash) {
    proposals = snap.proposals;
  } else if (snap && nameChangeIsVerdict(snap.class_names, names)) {
    proposals = keepPairs(snap.proposals, byName, none);
    try {
      await env.meta.writeCandidateSnapshot(workspace, { shot_hash: hash, proposals, class_names: names });
    } catch {
      // 钉失败不拦答案：本次用还活着的对；下次若仍失配且不是并类，才会再猜
    }
  } else {
    proposals = keepPairs((await env.llm(workspace).proposePairs(classes)).map(cleanAdvice), byName, none); // 出槽清一遍：stage 空壳不留快照
    try {
      await env.meta.writeCandidateSnapshot(workspace, { shot_hash: hash, proposals, class_names: names });
    } catch {
      // 快照写失败不拦答案：本次照常返回，下次读重算——快照只是省模型调用，不是事实源
    }
  }
  return proposals;
}

/** 疑似重复清单：建议原语 + 读时过滤（已定案、键未定的类都不进——交集率建在唯一键上，键没定就裁会出「合法但错误」的关系）。
 *  唯一键不进投喂形状哈希：定键/改键只是读时过滤，不重算快照（唯一键本就不在模型的输入里）。 */
export async function listCandidates(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<Result<PairAdvice[]>> {
  return toResult(async () => {
    const d = (await getDraft(env, workspace)).draft;
    const decided = new Set(
      (await env.meta.listDecisions(workspace)).filter((r) => r.version !== -1).map((r) => pairKey(r.class_a, r.class_b))
    );
    const proposals = await pairProposals(env, workspace);
    return proposals.filter((p) => {
      if (decided.has(pairKey(p.class_a, p.class_b))) return false;
      const a = d.object_types[p.class_a];
      const b = d.object_types[p.class_b];
      if (!a?.identity || !b?.identity) return false; // 键未定的类不参与疑似重复（ADR 0010）
      return true;
    });
  }, (v) => MSG.resultCandidates(v.length));
}

/** 定案之后钉住快照：按串改写还该问的对，并把哈希对齐到现在的类集合。
 *  没有快照则不动（下次列表按入围再猜）。跳过/同形异义不改清单——读时过滤，放弃未发布裁决后还能回来。 */
export async function pinCandidateSnapshot(
  env: EngineEnv,
  workspace: string,
  class_a: string,
  class_b: string,
  verdict: Verdict
): Promise<void> {
  try {
    const snap = await env.meta.readCandidateSnapshot(workspace);
    if (!snap) return;
    if (verdict === Verdict.Skip || verdict === Verdict.NameSimilar) return;
    const d = (await getDraft(env, workspace)).draft;
    const decided = new Set(
      (await env.meta.listDecisions(workspace)).filter((r) => r.version !== -1).map((r) => pairKey(r.class_a, r.class_b))
    );
    decided.add(pairKey(class_a, class_b));
    const proposals = keepPairs(
      rewriteAfterVerdict(snap.proposals, class_a, class_b, verdict, decided),
      new Map(Object.entries(d.object_types)),
      decided
    );
    const classes = classShots(d);
    await env.meta.writeCandidateSnapshot(workspace, {
      shot_hash: shotHash(classes),
      proposals,
      class_names: classes.map((c) => c.name),
    });
  } catch {
    // 钉失败不挡定案。listCandidates 若认出是并类/立公共对象，会沿用还活着的对，不把串外拉进来
  }
}
