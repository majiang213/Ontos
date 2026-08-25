// 结构守门 —— 评审六轴里能机器化的两条，写成测试永不过期：
// ① 用户可见错误文案唯一出处是 MSG（src/server/errors.ts），throw / error / note / warning / reason / zod message
//    出现内联中文即红——不许拿魔法字串绕过单源。
// ② 调用方向：schema 最底、meta 不碰 engine、infra 不上指 engine 其它包、draft 读路径纯函数层不 import 写路径、
//    errors.ts 保持纯叶子（前端经 purityBoundary 引它）。值侧 import 才查；type-only 编译期擦除，放行。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const IMPORT_RE = /^[ \t]*import\s+(type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm;
const REEXPORT_RE = /^[ \t]*export\s+(type\s+)?[^'"]*?\s+from\s+["']([^"']+)["']/gm;

function importsOf(file: string): { spec: string; typeOnly: boolean }[] {
  const text = readFileSync(file, "utf8");
  const out: { spec: string; typeOnly: boolean }[] = [];
  for (const re of [IMPORT_RE, REEXPORT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push({ spec: m[2], typeOnly: Boolean(m[1]) });
  }
  return out;
}

/** 相对说明符与 @/ 别名解析成 src 相对路径（不带扩展名）；包说明符返回 null。 */
function resolveSpec(spec: string, fromFile: string): string | null {
  if (spec.startsWith(".")) return relative(SRC, resolve(dirname(fromFile), spec));
  if (spec.startsWith("@/")) return spec.slice(2);
  return null;
}

/* ---------- ① MSG 单源：内联中文错误文案即红 ---------- */

/** 文案单源的家（豁免）：MSG（错误文案）与 Q_STATUS（验收状态词表）。其余文件的内联中文错误文案即绕行。 */
const COPY_HOMES = new Set([join(SRC, "server", "errors.ts"), join(SRC, "server", "engine", "query", "questionStatus.ts")]);
const COPY_PATTERNS: [RegExp, string][] = [
  [/throw new (?:EngineReject|DraftReject|ConnectionReject|WsReject|BadRequest|Error)\(\s*[`"'][^`"']*?[一-龥]/, "throw 内联中文文案"],
  [/reject\(\s*"(?:pre|effect|axiom|project)",\s*[`"'][^`"']*?[一-龥]/, "reject 阶段消息内联中文文案"],
  [/\berror:\s*[`"'][^`"']*?[一-龥]/, "error 字段内联中文文案"],
  [/\bnote:\s*[`"'][^`"']*?[一-龥]/, "note 字段内联中文文案"],
  [/\bwarning:\s*[`"'][^`"']*?[一-龥]/, "warning 字段内联中文文案"],
  [/\bmessage:\s*[`"'][^`"']*?[一-龥]/, "zod message 内联中文文案"],
];

/* ---------- ② 调用方向：区域 → 禁止的值侧 import 前缀（src 相对路径） ---------- */

const DIRECTION_RULES: { area: RegExp; forbidden: string[]; why: string }[] = [
  {
    area: /^server\/schema\//,
    forbidden: ["server/engine/", "server/meta/", "server/app/"],
    why: "schema 是最底层，不碰引擎/元库/路由（errors.ts 纯叶子除外）",
  },
  {
    area: /^server\/meta\//,
    forbidden: ["server/engine/", "server/app/"],
    why: "元库不反向依赖引擎与路由",
  },
  {
    area: /^server\/engine\/infra\//,
    forbidden: ["server/engine/draft/", "server/engine/adjudication/", "server/engine/action/", "server/engine/query/", "server/engine/llm/"],
    why: "infra 是驱动层，不上指 engine 其它包（删连接的引用判定走注入）",
  },
  {
    // draft 读路径纯函数层：refs / sameConfig / canvasState / lineage 不许碰 draft 内部任何写路径与 op 解释
    area: /^server\/engine\/draft\/(refs|sameConfig|canvasState|lineage)\.ts$/,
    forbidden: ["server/engine/draft/"],
    why: "draft 纯函数层不 import 写路径（type-only 的 DraftState 引用放行）",
  },
  {
    // views 是读路径：只许消费纯函数（refs/sameConfig/ops/replaceObject 的纯判定），不碰写路径与分派
    area: /^server\/engine\/draft\/views\.ts$/,
    forbidden: [
      "server/engine/draft/editDraft",
      "server/engine/draft/commit",
      "server/engine/draft/versions",
      "server/engine/draft/current",
      "server/engine/draft/canvasPack",
      "server/engine/draft/ops/index",
      "server/engine/draft/ops/edit",
      "server/engine/draft/ops/importObjects",
      "server/engine/draft/ops/subjectClass",
    ],
    why: "读路径不依赖写路径：views 只消费纯函数（ops/replaceObject 的 replaceBlockers 是纯判定，放行）",
  },
  {
    // errors.ts 是文案与错误类型的家：必须保持纯叶子（前端经 purityBoundary 引它），一个相对 import 都不许有
    area: /^server\/errors\.ts$/,
    forbidden: ["server/"],
    why: "errors.ts 保持零依赖纯叶子，前端才能安全引 MSG",
  },
];

describe("结构守门", () => {
  const files = [...walk(join(SRC, "server")), ...walk(join(SRC, "app")), ...walk(join(SRC, "components"))].filter((f) => /\.tsx?$/.test(f));

  it("① 错误文案唯一出处是 MSG：无内联中文魔法字串（throw / error / note / warning / reason / zod message）", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (COPY_HOMES.has(f)) continue; // 词表的家豁免——中文本该住这里
      const text = readFileSync(f, "utf8");
      for (const [re, what] of COPY_PATTERNS) {
        const m = text.match(re);
        if (m) offenders.push(`${relative(SRC, f)}：${what}（${m[0].slice(0, 50)}…）`);
      }
    }
    expect(offenders, "这些点绕过 MSG 内联了用户可见文案——搬进 src/server/errors.ts 的 MSG").toEqual([]);
  });

  it("② 调用方向：值侧 import 不越界（schema 最底 / meta 不碰 engine / infra 不上指 / draft 读不依赖写 / errors 纯叶子）", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(SRC, f);
      for (const rule of DIRECTION_RULES) {
        if (!rule.area.test(rel)) continue;
        for (const { spec, typeOnly } of importsOf(f)) {
          if (typeOnly) continue; // 类型边编译期擦除，放行（DraftState 这类形状引用）
          const target = resolveSpec(spec, f);
          if (!target) continue;
          for (const bad of rule.forbidden) {
            if (target === bad.replace(/\/$/, "") || target.startsWith(bad)) offenders.push(`${rel} → ${spec}（${rule.why}）`);
          }
        }
      }
    }
    expect(offenders, "这些 import 越了调用方向").toEqual([]);
  });

  it("守门自假检查：errors.ts 若被加 relative import 必须能被抓到（规则确实覆盖了它）", () => {
    const rule = DIRECTION_RULES.find((r) => r.area.test("server/errors.ts"));
    expect(rule, "errors.ts 必须有方向规则罩着").toBeTruthy();
  });
});
