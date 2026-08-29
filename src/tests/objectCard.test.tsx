// 对象编辑卡渲染冒烟：头部 + 字段/阶段/动作/来源 标签页。条件全文（不再「按规则」）、前置白话（不落 JSON）、
// 阶段属性不再重复出现在字段页。表单状态机与 Esc 守卫见 ObjectCard 内注释与 decisionPanel 同款 renderToString 边界。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import ObjectCard from "../components/cards/ObjectCard";
import { configSchema } from "../server/schema/config";

const config = configSchema.parse(load(readFileSync(join(process.cwd(), "src/server/config/ontology.yaml"), "utf8")));

const noop = () => {};
const base = {
  ont: config,
  op: async () => true,
  refresh: async () => undefined,
  closeCard: noop,
  showToast: noop,
  onFormState: noop,
  currentRev: () => null,
};

describe("ObjectCard（头部 + 标签页）", () => {
  it("equipment 默认停在字段页：四个标签都在，阶段属性 status 不重复列在字段里", () => {
    const html = renderToString(<ObjectCard name="equipment" sel={config.object_types.equipment} {...base} />);
    for (const label of ["字段", "阶段", "动作", "来源"]) expect(html).toContain(label);
    expect(html).toContain("in_warranty");
    expect(html).not.toContain("<code>status</code>");
    expect(html).toContain("删除这个对象");
    expect(html).not.toContain("危险区");
  });

  it("阶段页：中文名为主、key 为辅；常驻输入框没了；条件全文与转化块照旧", () => {
    const html = renderToString(
      <ObjectCard name="equipment" sel={config.object_types.equipment} initialTab="stages" {...base} />
    );
    expect(html).toContain("在途"); // 中文名（值域 label）
    expect(html).toContain("在役");
    expect(html).toContain("报废");
    expect(html).toContain('class="stage-key">in_transit</code>'); // key 退居代码体
    expect(html).toContain("改标识");
    expect(html).not.toContain('value="in_transit"'); // 时期名不再是常驻输入框
    expect(html).toContain("purchase_sys.po_item 有这台、device_sys.device 没有这台");
    expect(html).toContain("device_sys.device 有这台，且 mark 是 scrapped");
    expect(html).not.toContain("按规则");
    expect(html).toContain("转为");
    expect(html).toContain("in_service");
    expect(html).toContain("convert");
    expect(html).toContain("status 是 in_transit");
    expect(html).toContain("转化 converted 还没发生");
    expect(html).toContain("新建 warranty_card");
    expect(html).not.toContain("&quot;"); // 阶段页任何地方都不落 JSON
  });

  it("动作页：演示动作的前置都是白话，不落 JSON", () => {
    const html = renderToString(
      <ObjectCard name="equipment" sel={config.object_types.equipment} initialTab="actions" {...base} />
    );
    expect(html).toContain("status 是 in_transit");
    expect(html).toContain("dept 不是 请求里的 dept");
    expect(html).toContain("这个对象还不存在");
    expect(html).not.toContain("&quot;");
  });

  it("department 没有阶段：不出现阶段标签", () => {
    const html = renderToString(<ObjectCard name="department" sel={config.object_types.department} {...base} />);
    expect(html).not.toContain("阶段");
    expect(html).toContain("删除这个对象");
  });

  it("字段页枚举值：有中文名的显示 中文(key)，没有的裸 key", () => {
    const sel = {
      description: "样例",
      identity: undefined,
      properties: { level: { type: "enum", description: "级别", values: [{ value: "high", label: "高" }, "low"] } },
      sources: {},
      actions: {},
    } as never;
    const html = renderToString(<ObjectCard name="sample" sel={sel} {...base} />);
    expect(html).toContain("高(high)");
    expect(html).toContain("low");
  });
});
