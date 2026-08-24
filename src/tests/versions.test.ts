// 版本历史与回滚测试：回到某版 = 用那一版覆盖当前工作副本（未发布），不新加版本；问数仍读已发布。
// 从 m4m6.test.ts 拆出，并并入 configStore.test.ts 的「版本不存在拒绝」断言（同一条行为链）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, freshStore, setupRuntime } from "./helpers";

describe("版本历史与回滚", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await setupRuntime("ontos-ver-");
  });
  afterEach(async () => {
    await cleanupRuntime(tmp);
  });

  it("回到某版：覆盖当前工作副本，不插入新版本；问数仍读已发布；版本不存在拒绝", async () => {
    const s = await freshStore(tmp); // 从干净内存态开始（default 空间，自带空白 v1）
    await s.applyDraft({ op: "create_object", name: "vendor", kind: "thing" });
    await s.publish(); // v2 含 vendor
    expect((await s.getPublished()).version).toBe(2);
    const { version } = await s.rollbackTo(1); // 用 v1 覆盖草稿
    expect(version).toBe(1);
    expect((await s.getPublished()).version).toBe(2); // 已发布不动
    expect((await s.getPublished()).config.object_types.vendor).toBeDefined();
    expect((await s.listVersions()).map((v) => v.version)).toEqual([1, 2]); // 没有 v3
    expect((await s.getDraft()).dirty).toBe(true);
    expect((await s.getDraft()).draft.object_types.vendor).toBeUndefined(); // 未发布改动直接覆盖
    await expect(s.rollbackTo(99)).rejects.toThrow("版本不存在");
  });
});
