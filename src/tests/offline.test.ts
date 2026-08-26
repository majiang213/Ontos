// 离线门闩的活证：套件里任何用例都看不到 OPENAI_API_KEY / ONTOS_TOKEN（setup.offline.ts 剥离）。
// 本文件自己不写这两个变量；若别的文件在用例里写了假 key，afterEach 会在进入本用例前剥掉。

import { describe, expect, it } from "vitest";

describe("默认套件离线", () => {
  it("用例内读不到 OPENAI_API_KEY / ONTOS_TOKEN（即使外层 shell 导出了真 key）", () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.ONTOS_TOKEN).toBeUndefined();
  });
});
