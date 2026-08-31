// 召回收敛（增量重问，T 08）——内容指纹没变的类不再重问；不含变化类的模型提议被机械丢弃；判定过的对不回流。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, draftEngine, setupRuntime, testEnv } from "./helpers";
import { metaStore } from "../server/meta/store";
import { listCandidates, pairProposals } from "../server/features/integrate/candidates";
import { decide } from "../server/features/integrate/decide";
import type { EngineEnv } from "../server/features/env";
import type { Llm, ClassShot } from "../server/infra/llm/llm";
import { Verdict, type PairAdvice } from "../server/schema/verdict";

const WORKSPACE = "test";

describe("召回收敛（增量重问）", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await setupRuntime("ontos-cand-");
  });
  afterEach(async () => {
    await cleanupRuntime(tmp);
  });

  const cls = (name: string, connection: string, table: string): ClassShot => ({
    name,
    kind: "thing",
    sources: [connection],
    fields: ["sn", "name"],
    enums: [],
  });

  it("指纹全同沿用零调用；变化类之外的新提议被丢弃；判定过的对不回流", async () => {
    const s = await draftEngine();
    await s.editDraft(
      {
        op: "import_objects",
        objects: {
          a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", fields: { sn: "sn", name: "item_name" } } } },
          b: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", fields: { sn: "serial_no", name: "name" } } } },
          c: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, note: { type: "string" } }, sources: { sc: { connection: "asset_sys", table: "asset", fields: { sn: "sn", note: "asset_name" } } } },
        },
      },
      WORKSPACE
    );

    // 假实现：记录调用次数，按剧本返回提议（含一个「没变类之间的噪音」剧本用于验证机械过滤）
    let calls = 0;
    let script: PairAdvice[] = [];
    const fakeLlm: Llm = {
      name: "fake-召回",
      nlToQuery: async () => ({ object: "a" }) as never,
      proposeObjects: async () => ({}),
      proposeKey: async () => ({ key: null, reason: "mock" }),
      proposePair: async ({ class_a, class_b }) => ({ class_a: class_a.name, class_b: class_b.name, tendency: Verdict.NameSimilar, reason: "" }),
      proposePairs: async (classes: ClassShot[]) => {
        calls++;
        return script;
      },
    };
    const env = { ...testEnv(), llm: () => fakeLlm } as unknown as EngineEnv;

    const pending = async () => {
      const r = await listCandidates(env, WORKSPACE);
      return r.code === 200 ? r.value.map((p) => `${p.class_a}|${p.class_b}`) : [`错误 ${r.code}`];
    };

    // 第一轮：全量首问。a×b、a×c 两对进清单；快照写 per-class 指纹
    script = [
      { class_a: "a", class_b: "b", tendency: Verdict.Same, reason: "同一种", keep: "a" },
      { class_a: "a", class_b: "c", tendency: Verdict.Overlap, reason: "部分重叠", keep: "a" },
    ];
    expect(await pending()).toEqual(["a|b", "a|c"]);
    expect(calls).toBe(1);

    // 内容没变再问：沿用快照，零模型调用
    expect(await pairProposals(env, WORKSPACE)).toHaveLength(2);
    expect(calls).toBe(1);
    expect(await pending()).toEqual(["a|b", "a|c"]);

    // 第二轮：b 加字段（b 指纹变）。剧本故意夹带 a×c（两边都没变的噪音）——机械过滤必须丢掉它
    script = [
      { class_a: "a", class_b: "b", tendency: Verdict.Same, reason: "同一种", keep: "a" },
      { class_a: "a", class_b: "c", tendency: Verdict.Overlap, reason: "两边都没变，纯噪音", keep: "a" },
      { class_a: "b", class_b: "c", tendency: Verdict.Overlap, reason: "b 变了，重问 b 参与的对", keep: "b" },
    ];
    await s.editDraft({ op: "add_property", object: "b", name: "extra", type: "string" }, WORKSPACE);
    expect(await pending()).toEqual(["a|b", "b|c"]); // a|c 被丢弃（不含变化类）
    expect(calls).toBe(2);

    // 判定 a×b 为各自留下：待定里不再回流
    const decided = await decide(env, { class_a: "a", class_b: "b", verdict: Verdict.NameSimilar, decided_by: "测试" }, WORKSPACE);
    expect(decided.code).toBe(200);
    expect(await pending()).toEqual(["b|c"]);
    // 钉快照必须把 per-class 指纹记忆带走：否则一次判定后指纹清零，下一次结构性小改会回退全量重问（无休无止）
    const snap = await metaStore().readCandidateSnapshot(WORKSPACE);
    // 快照按全类记指纹（测试空间还有模板类），关键是 a/b/c 的指纹随钉快照延续
    expect(["a", "b", "c"].every((n) => snap?.class_hashes?.[n])).toBe(true);
    // 指纹在：改 a 只重问 a 参与的对——b×c 噪音（两边都没变）被机械丢弃；a×b 已判定不回流 → 待定清零
    await s.editDraft({ op: "add_property", object: "a", name: "extra_a", type: "string" }, WORKSPACE);
    script = [
      { class_a: "a", class_b: "b", tendency: Verdict.Same, reason: "已判过的对再提", keep: "a" },
      { class_a: "b", class_b: "c", tendency: Verdict.Overlap, reason: "两边都没变的噪音", keep: "b" },
    ];
    expect(await pending()).toEqual([]);
  });
});
