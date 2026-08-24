// SKILL.md 同步闸：四份 SKILL.md 是生成物（scripts/build-skills.mjs），skills/_shared/ 的 fragment 才是源。
// 「生成物 = 源」在此钉死：改了 fragment 没跑生成器、或手改了生成段，这里就红。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SKILL_FILES, SKILLS_DIR, loadFragments, renderSkill } from "../../scripts/build-skills.mjs";

describe("skills 双轨闸（SKILL.md = fragment 生成物）", () => {
  const fragments: Record<string, string> = loadFragments();

  it("四份 SKILL.md 与其标记区间的生成结果逐字一致", () => {
    const stale: string[] = [];
    for (const rel of SKILL_FILES) {
      const p = join(SKILLS_DIR, rel);
      const current = readFileSync(p, "utf8");
      if (renderSkill(current, fragments) !== current) stale.push(rel);
    }
    expect(stale, "这些文件与 fragment 不同步：跑 node scripts/build-skills.mjs").toEqual([]);
  });

  it("四份都带 mcp-access 标记；查询语法共享段只在 ontos-query 与 ontos-action-run", () => {
    for (const rel of SKILL_FILES) {
      const s = readFileSync(join(SKILLS_DIR, rel), "utf8");
      expect(s, rel).toContain("<!-- BEGIN SHARED: mcp-access -->");
    }
    for (const rel of ["ontos-query/SKILL.md", "ontos-action-run/SKILL.md"]) {
      expect(readFileSync(join(SKILLS_DIR, rel), "utf8"), rel).toContain("<!-- BEGIN SHARED: query-syntax -->");
    }
  });

  it("防闸自假：改动 fragment 必须被检出（渲染结果确实随源变）", () => {
    const p = join(SKILLS_DIR, "ontos-query/SKILL.md");
    const current = readFileSync(p, "utf8");
    const tampered = renderSkill(current, { ...fragments, "mcp-access": fragments["mcp-access"] + "\n漂移一行" });
    expect(tampered).not.toBe(current); // fragment 变了渲染必变——上面的一致性断言不是空转
  });
});
