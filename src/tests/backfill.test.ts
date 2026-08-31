// 出槽列补齐的收养分支：模型只写概念类忘了挂 sources（单表批常见）——唯一无源类收养没主的表，不造孪生类。

import { describe, expect, it } from "vitest";
import { AiSdkLlm } from "../server/infra/llm/aiSdk";
import type { ObjectType } from "../server/schema/config";

const table = (name: string, columns: { name: string; type: string; pk: boolean }[]) => ({
  connection: "r_sys",
  table: { name, columns: columns.map((c) => ({ ...c, comment: undefined })), sample: [] },
});

const fakeGen =
  (raw: unknown) =>
  (async () => ({ text: JSON.stringify(raw) })) as never;

describe("出槽补齐：无源概念类收养", () => {
  it("单表批模型忘挂 sources：表挂回唯一无源类，不造孪生", async () => {
    const llm = new AiSdkLlm("fake", fakeGen({
      object_types: {
        repair: { kind: "event", identity: "repair_no", description: "维修工单", properties: { repair_no: { type: "string" }, serial_no: { type: "string" } } },
      },
    }));
    const out = await llm.proposeObjects([table("repair", [
      { name: "repair_no", type: "TEXT", pk: true },
      { name: "serial_no", type: "TEXT", pk: false },
      { name: "symptom", type: "TEXT", pk: false },
    ])], []);
    expect(Object.keys(out)).toEqual(["repair"]);
    const r: ObjectType = out.repair;
    expect(r.sources?.r_sys?.table).toBe("repair");
    expect(r.sources?.r_sys?.fields).toEqual({ repair_no: "repair_no", serial_no: "serial_no", symptom: "symptom" });
    expect((r.properties?.symptom as { description?: string }).description).toContain("自动补齐"); // 模型没写的列照旧补
    expect((r.properties?.repair_no as { description?: string }).description ?? "").not.toContain("自动补齐"); // 模型写过的属性不被补齐标注覆盖
  });

  it("两个无源类时不收养（归属歧义），退回孪生兜底", async () => {
    const llm = new AiSdkLlm("fake", fakeGen({
      object_types: {
        a: { kind: "thing", properties: {} },
        b: { kind: "thing", properties: {} },
      },
    }));
    const out = await llm.proposeObjects([table("t1", [{ name: "c1", type: "TEXT", pk: false }])], []);
    expect(Object.keys(out).sort()).toEqual(["a", "b", "t1"]); // t1 孪生兜底
    expect(out.t1.sources?.r_sys?.table).toBe("t1");
  });
});
