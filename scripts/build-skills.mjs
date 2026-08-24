// SKILL.md 生成器 —— 四份 SKILL.md 是生成物，skills/_shared/ 的 fragment 才是源。
// 外部 Agent 可能只装一个 skill，每份必须自包含（不能用文件引用），所以共享段落只能生成：
// <!-- BEGIN SHARED: <名> --> 与 <!-- END SHARED: <名> --> 之间的内容由同名 fragment 替换。
// 直接 `node scripts/build-skills.mjs` 重写四份；测试（skillsSync.test.ts）用 renderSkill 核对「生成物 = 源」。

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
export const SKILL_FILES = ["ontos-query", "ontos-action-run", "ontos-canvas", "ontos-action"].map((d) => join(d, "SKILL.md"));

/** 读全部 fragment：文件名（不含 .md）→ 内容（裁尾部空白，拼进时统一补一个换行）。 */
export function loadFragments(skillsDir = SKILLS_DIR) {
  const out = {};
  for (const name of ["query-syntax", "mcp-access"]) {
    out[name] = readFileSync(join(skillsDir, "_shared", `${name}.md`), "utf8").trimEnd();
  }
  return out;
}

const MARKER_RE = /<!-- BEGIN SHARED: ([\w-]+) -->\n[\s\S]*?<!-- END SHARED: \1 -->/g;

/** 把文本里所有 SHARED 标记区间替换成对应 fragment。标记没有对应 fragment、或 BEGIN/END 不成对，都算错。 */
export function renderSkill(content, fragments) {
  const seen = new Set();
  const out = content.replace(MARKER_RE, (m, name) => {
    if (!(name in fragments)) throw new Error(`SKILL.md 引用了不存在的 fragment：${name}`);
    seen.add(name);
    return `<!-- BEGIN SHARED: ${name} -->\n${fragments[name]}\n<!-- END SHARED: ${name} -->`;
  });
  const begins = [...out.matchAll(/<!-- BEGIN SHARED: ([\w-]+) -->/g)].map((m) => m[1]);
  const ends = [...out.matchAll(/<!-- END SHARED: ([\w-]+) -->/g)].map((m) => m[1]);
  if (begins.length !== ends.length || begins.some((b, i) => ends[i] !== b)) throw new Error("SHARED 标记不成对");
  return out;
}

/** 重写四份 SKILL.md（幂等）。返回是否有文件被改动。 */
export function buildSkills(skillsDir = SKILLS_DIR) {
  const fragments = loadFragments(skillsDir);
  let changed = false;
  for (const rel of SKILL_FILES) {
    const p = join(skillsDir, rel);
    const next = renderSkill(readFileSync(p, "utf8"), fragments);
    if (next !== readFileSync(p, "utf8")) {
      writeFileSync(p, next);
      changed = true;
    }
  }
  return changed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const changed = buildSkills();
  console.log(changed ? "SKILL.md 已重新生成" : "SKILL.md 已与 fragment 同步（无改动）");
}
