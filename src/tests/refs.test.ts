// 引用扫描契约测试：删除属性/关系前的拦截面（features/refs.ts）正反对照例。
// 拦截面漏一处 = 删出悬空引用还放行；这里的每条对应一类引用出处。

import { describe, expect, it } from "vitest";
import { configSchema, type OntologyConfig } from "../server/schema/config";
import { linkRefs, referencesOf } from "../server/features/ontology/refs";

/** 两个类 + 正反两个关系 + 各类动作/派生，覆盖全部引用出处。 */
function fixture(): OntologyConfig {
  return configSchema.parse({
    object_types: {
      a: {
        kind: "thing",
        identity: "sn",
        properties: {
          sn: { type: "string" },
          mark: { type: "string" },
          stat: { type: "string", derived: [{ when: { sa: { mark: "x" } }, value: "p" }] }, // 键侧：mark
          flag: { type: "boolean", derived: { mark: { eq: { property: "sn" } } } }, // 值侧：sn
        },
        sources: { sa: { connection: "c", table: "ta", fields: { sn: "sn", mark: "mark" } } },
        axioms: { ax1: { type: "mutex", property: "mark" } },
        actions: {
          act_a: {
            pre: { mark: "y", $request: { who: { property: "sn" } } }, // pre 键：mark；$request 里的 property 不算 sn 引用
            effect: [
              { update: { object: "a", filter: { sn: "z" }, properties: { mark: { property: "sn" } } } }, // 键：sn；值：sn
              { update: { object: "b", properties: { name: { property: "mark" } } } }, // 他类效应的 current 是目标类：不算 a.mark
            ],
            inform: [{ object: "b", to: ["out1"], properties: { name: { property: "mark" } } }], // inform 在宿主 a 上取值：mark
          },
        },
      },
      b: {
        kind: "thing",
        properties: {
          name: { type: "string" },
          stage: { type: "string", derived: [{ when: { sb: { $link: { ba: { mark: "m" } } } }, value: "q" }] }, // 经 $link 落到 a.mark（键侧，跨类）
          trail: { type: "string", derived: [{ when: { sb: { $link: { ba: { mark: { eq: { property: "sn" } } } } } }, value: "r" }] }, // 经 $link 落到 a，子过滤值侧引用 a.sn（跨类，值侧）
        },
        sources: { sb: { connection: "c", table: "tb", fields: { name: "name" } } },
        actions: {
          act_b: {
            pre: { $link: { ba: { mark: "deep" } } }, // $link 落到 a.mark（键侧，嵌套）
            effect: [{ delete: { object: "a", filter: { $link: { ab: { name: "n" } } } } }], // filter.$link 用 ab：linkRefs(ab) 命中
          },
          conv: { effect: [{ link: "ab" }] }, // effect link 项：linkRefs(ab) 命中
        },
      },
    },
    link_types: {
      ab: { from: "a", to: "b", inverse: "ba", match: [{ from: "sn", to: "name" }] }, // 配对：a.sn × b.name
      conv_rel: { from: "a", to: "b", transition: { property: "stat", from: "p", to: "q" } }, // 转化：a.stat
    },
    outlets: { out1: { connection: "c" } },
  });
}

describe("referencesOf（删属性前的引用扫描）", () => {
  const d = fixture();

  it("sn：源映射、关系配对、同类值侧派生、动作 pre/效应的值侧 全部命中", () => {
    const refs = referencesOf(d, "a", "sn");
    expect(refs).toContain("源映射 sa");
    expect(refs).toContain("关系 ab"); // match.from
    expect(refs).toContain("派生字段 a.flag"); // 布尔派生值侧 { property: "sn" }
    expect(refs).toContain("派生字段 b.trail"); // 他类派生的 $link 子过滤值侧引用 a.sn（跨类值侧盲区，R4 修）
    expect(refs).toContain("动作 a.act_a"); // pre 的 filter 键 + update.properties 的 { property: "sn" }
  });

  it("mark：公理、源映射、同类键侧派生、他类 $link 落点（含嵌套）、inform 值侧 命中；$request 块不算", () => {
    const refs = referencesOf(d, "a", "mark");
    expect(refs).toContain("公理 ax1");
    expect(refs).toContain("源映射 sa");
    expect(refs).toContain("派生字段 stat"); // when 过滤键
    expect(refs).toContain("派生字段 b.stage"); // 他类派生经 ba 落到 a.mark
    expect(refs).toContain("动作 a.act_a"); // pre 键 + inform 值侧
    expect(refs).toContain("动作 b.act_b"); // pre 的 $link 嵌套落点
  });

  it("stat：转化关系 transition.property 命中", () => {
    expect(referencesOf(d, "a", "stat")).toContain("关系 conv_rel");
  });

  it("b.name：关系配对另一侧命中", () => {
    expect(referencesOf(d, "b", "name")).toContain("关系 ab"); // match.to
  });

  it("未被引用的属性：清单为空（反例）", () => {
    const d2 = fixture();
    d2.object_types.a.properties.lonely = { type: "string" };
    expect(referencesOf(d2, "a", "lonely")).toEqual([]);
  });
});

describe("linkRefs（删关系前的引用扫描）", () => {
  const d = fixture();

  it("ab：effect 的 link 项、filter.$link、嵌套 $link 命中", () => {
    const refs = linkRefs(d, "ab");
    expect(refs).toContain("动作 b.conv");
    expect(refs).toContain("动作 b.act_b"); // delete.filter 的 $link.ab
  });

  it("ba（反向名）：pre 与列表派生 when 里的 $link 都命中", () => {
    // linkRefs 按出现的名字扫：pre 里写的是 ba；删 ab 时应同时挡反向名——这条钉住现状口径
    expect(linkRefs(d, "ba")).toContain("动作 b.act_b");
    // 列表派生的 when 是 src→cond 映射：$link 藏在 cond 层，不拆开就会漏（老实现的盲区）
    expect(linkRefs(d, "ba")).toContain("派生字段 b.stage");
  });

  it("conv_rel：转化关系只被 transition.property 引用，linkRefs 不收（反例）", () => {
    expect(linkRefs(d, "conv_rel")).toEqual([]);
  });
});
