// 疑似重复的候选 —— 「哪些对等着人裁」：候选集按草稿内容快照（adj_candidates），同一内容只问一次模型。
// 资格谓词在 eligibility.ts；路由只做解析与 JSON。定案过滤在读时套——定案不动草稿（跳过/仅名称相似）也即时生效。

import { createHash } from "node:crypto";
import type { EngineEnv } from "../env";
import { getDraft } from "../ontology/current";
import { connectionsOf, hasSources, pairEligible, pairKey } from "./eligibility";
import { rewriteAfterVerdict } from "./chain";
import { Verdict, type PairAdvice } from "../../schema/verdict";
import type { OntologyConfig } from "../../schema/config";
import { MSG, toResult, type Result } from "../../errors";
import { DEFAULT_WORKSPACE } from "../../infra/workspace";

/** 建议规则版本：判定口径或可执行前提变了就 +1——混进哈希，旧规则写的快照自然失效重算。
 *  3：入围改为有源∧未定案（同一库两张表可成对）；三问改口规则。 */
const ADVICE_RULES_VERSION = 3;

/** 投喂形状的哈希：类名 + 连接集 + 字段名（各自排序后序列化），前缀建议规则版本。快照的失效键——
 *  唯一键、字段类型、来源列对照、摆位都不在里头，改了不重算（它们不影响成对资格，也不在模型的输入里）。
 *  排序一律按码元（不用 localeCompare）：多实例 ICU 本地化不同会把同一份内容排出两种序，哈希就白算了。 */
function shotHash(classes: { name: string; sources: string[]; fields: string[] }[]): string {
  const canon = [
    ADVICE_RULES_VERSION,
    ...classes.map((c) => [c.name, c.sources, [...c.fields].sort()] as const).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
  ];
  return createHash("sha1").update(JSON.stringify(canon)).digest("hex");
}

/** 已上画布、有来源的候选对（同一库两张表也算）：快照命中直接用，失配才问槽位并重写快照（资格闸复核 + 同对去重在写侧）；
 *  定案过滤在读时套——已放弃的裁决（version=-1）不算定案。 */
export async function listCandidates(env: EngineEnv, workspace: string = DEFAULT_WORKSPACE): Promise<Result<PairAdvice[]>> {
  return toResult(async () => {
    const d = (await getDraft(env, workspace)).draft;
    const decided = new Set(
      (await env.meta.listDecisions(workspace)).filter((r) => r.version !== -1).map((r) => pairKey(r.class_a, r.class_b))
    );
    const classes = classShots(d);
    const hash = shotHash(classes);
    const snap = await env.meta.readCandidateSnapshot(workspace);
    let proposals: PairAdvice[];
    if (snap && snap.shot_hash === hash) {
      proposals = snap.proposals;
    } else {
      const byName = new Map(Object.entries(d.object_types));
      const none = new Set<string>(); // 写侧只套静态资格（有源 ∧ 同名去重），定案留给读时
      const seen = new Set<string>();
      proposals = (await env.llm.proposePairs(classes)).filter((p) => {
        const a = byName.get(p.class_a);
        const b = byName.get(p.class_b);
        if (!a || !b || !pairEligible(a, b, none, p.class_a, p.class_b)) return false;
        const k = pairKey(p.class_a, p.class_b); // 模型会把同一对写两遍或对调两端，无序键只留先到的
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      try {
        await env.meta.writeCandidateSnapshot(workspace, { shot_hash: hash, proposals });
      } catch {
        // 快照写失败不拦答案：本次照常返回，下次读重算——快照只是省模型调用，不是事实源
      }
    }
    return proposals.filter((p) => !decided.has(pairKey(p.class_a, p.class_b)));
  }, (v) => MSG.resultCandidates(v.length));
}

function classShots(d: OntologyConfig): { name: string; sources: string[]; fields: string[] }[] {
  return Object.entries(d.object_types)
    .filter(([, t]) => hasSources(t))
    .map(([name, t]) => ({
      name,
      sources: [...connectionsOf(t)].sort(),
      fields: Object.keys(t.properties),
    }));
}

/** 定案之后钉住快照：按串改写还该问的对，并把哈希对齐到现在的类集合——避免 listCandidates 把串外的类拉进来。
 *  没有快照则不动（下次列表会按入围再猜，那是加了新对象，不是这一裁）。 */
export async function syncCandidatesAfterVerdict(
  env: EngineEnv,
  workspace: string,
  class_a: string,
  class_b: string,
  verdict: Verdict
): Promise<void> {
  try {
    const snap = await env.meta.readCandidateSnapshot(workspace);
    if (!snap) return;
    if (verdict === Verdict.Skip || verdict === Verdict.NameSimilar) return; // 清单不动，读时过滤；放弃未发布裁决后还能回来
    const d = (await getDraft(env, workspace)).draft;
    const byName = new Map(Object.entries(d.object_types));
    const decided = new Set(
      (await env.meta.listDecisions(workspace)).filter((r) => r.version !== -1).map((r) => pairKey(r.class_a, r.class_b))
    );
    decided.add(pairKey(class_a, class_b)); // 本裁可能还没留痕
    const seen = new Set<string>();
    const proposals = rewriteAfterVerdict(snap.proposals, class_a, class_b, verdict, decided).filter((p) => {
      const a = byName.get(p.class_a);
      const b = byName.get(p.class_b);
      if (!a || !b || !pairEligible(a, b, decided, p.class_a, p.class_b)) return false;
      const k = pairKey(p.class_a, p.class_b);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    await env.meta.writeCandidateSnapshot(workspace, { shot_hash: shotHash(classShots(d)), proposals });
  } catch {
    // 串快照失败不挡定案：下次列表若哈希失配会再猜——那是降级，不是这一裁的事实源
  }
}
