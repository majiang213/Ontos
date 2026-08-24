// MCP 工具归位原语直测：actionSkeletonFor（骨架选择规则，adjudicate）与 draftClassesPayload（草稿视图 payload 形状，views）。
// 两个 handler 已回 parse+调用（mcp.test.ts 端到端断言不动，是等价活证）；这里钉原语本身的分支。

import { describe, expect, it } from "vitest";
import { actionSkeletonFor } from "../server/engine/adjudication/adjudicate";
import { draftClassesPayload } from "../server/engine/config/views";
import type { OntologyConfig } from "../server/schema/config";

const cfg = (over: Partial<OntologyConfig>): OntologyConfig => ({ object_types: {}, link_types: {}, ...over } as OntologyConfig);

describe("actionSkeletonFor（按类挑动作骨架）", () => {
  it("本类有转化关系：给 convert_to_* 转化模板（pre 早阶段 ∧ 未转化，effect link）", () => {
    const c = cfg({
      object_types: { eq: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } } } },
      link_types: { tr: { from: "eq", to: "eq", transition: { property: "status", from: "在途", to: "在役" } } },
    } as unknown as Partial<OntologyConfig>);
    const out = actionSkeletonFor(c, "eq");
    expect(out.name).toBe("convert_to_在役");
    expect(out.action).toEqual({
      description: "转化为在役",
      pre: { status: "在途", $link: { tr: false } },
      effect: [{ link: "tr" }],
    });
  });

  it("无转化关系：给 set_fields 骨架（唯一键不进，与导入自动生成同形同名）", () => {
    const c = cfg({
      object_types: { dept: { kind: "thing", identity: "did", properties: { did: { type: "string" }, name: { type: "string" } } } },
    } as unknown as Partial<OntologyConfig>);
    const out = actionSkeletonFor(c, "dept");
    expect(out.name).toBe("set_fields");
    expect(out.action).toEqual({
      description: "更新字段（导入时自动生成）",
      pre: {},
      effect: [{ update: { object: "dept", identity: { from: "identity" }, properties: { name: { from: "request" } } } }],
    });
  });

  it("无可写字段（只有唯一键）：action null 且说原因", () => {
    const c = cfg({
      object_types: { tag: { kind: "thing", identity: "code", properties: { code: { type: "string" } } } },
    } as unknown as Partial<OntologyConfig>);
    const out = actionSkeletonFor(c, "tag");
    expect(out).toEqual({ name: "set_fields", action: null, reason: "该类没有可写字段（唯一键与派生属性不可写）" });
  });

  it("类不存在：EngineReject（与 read_class 同文案）", () => {
    expect(() => actionSkeletonFor(cfg({}), "ghost")).toThrow("配置中没有类：ghost");
  });
});

describe("draftClassesPayload（list_classes 草稿视图整包）", () => {
  it("形状：space/dirty/rev/base_version/状态对照/outlets", () => {
    const draft = cfg({
      object_types: {
        kept: { kind: "thing", properties: {} },
        fresh: { kind: "thing", properties: {} },
      },
      outlets: { payroll: { description: "工资系统" } },
    } as unknown as Partial<OntologyConfig>);
    const published = cfg({ object_types: { kept: { kind: "thing", properties: {} } } } as unknown as Partial<OntologyConfig>);
    const out = draftClassesPayload({ draft, dirty: true, baseVersion: 2 }, published, 7);
    expect(out).toEqual({
      space: "draft",
      dirty: true,
      rev: 7,
      base_version: 2,
      classes: [
        { name: "kept", description: undefined, state: "same" },
        { name: "fresh", description: undefined, state: "new" },
      ],
      outlets: ["payroll"],
    });
  });
});
