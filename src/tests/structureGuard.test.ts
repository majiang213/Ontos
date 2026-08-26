// 结构守门 —— 评审六轴里能机器化的两条，写成测试永不过期：
// ① 用户可见错误文案唯一出处是 MSG（src/server/errors.ts），throw / reject 阶段消息 / error / note / warning /
//    zod message 出现内联中文即红——不许拿魔法字串绕过单源。
//    （reason 通道不机守：裁决建议的 reason 是展示文案不是报错（infra/llm/canned 的 PairAdvice），机守会误伤；
//    报错向的 reason 已有实例收在 MSG.noWritableProps。）
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
const COPY_HOMES = new Set([join(SRC, "server", "errors.ts"), join(SRC, "server", "features", "acceptance", "questionStatus.ts")]);
const COPY_PATTERNS: [RegExp, string][] = [
  [/throw new (?:EngineReject|DraftReject|ConnectionReject|WorkspaceReject|BadRequest|Error)\(\s*[`"'][^`"']*?[一-龥]/, "throw 内联中文文案"],
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
    forbidden: ["server/features/", "server/meta/", "server/app/"],
    why: "schema 是最底层共享内核，不碰领域/元库/路由（errors.ts 纯叶子除外）",
  },
  {
    area: /^server\/meta\//,
    forbidden: ["server/features/", "server/app/"],
    why: "元库不反向依赖领域与路由",
  },
  {
    area: /^server\/infra\//,
    forbidden: ["server/features/"],
    why: "infra 是适配层，不上指领域（删连接的引用判定走注入；留痕版本号由调用方传入）",
  },
  {
    area: /^server\/features\//,
    forbidden: ["server/runtime", "server/meta/"],
    why: "领域不摸进程级单例（runtime / metaStore / getSlot）：依赖由边界组装成 features/env 下传",
  },
  /* 域间依赖白名单：域 = 一条业务链的完整问题；域间依赖是业务真实耦合，方向必须成 DAG——
     ontology、query 是底座（不依赖任何域）；action 只许 query；integrate 只许 ontology+query；
     acceptance 只许 query+ontology。llm/trail 是共享能力住 infra，领域可自由下用（infra 规则管反向）。 */
  {
    area: /^server\/features\/query\//,
    forbidden: ["server/features/ontology/", "server/features/integrate/", "server/features/action/", "server/features/acceptance/"],
    why: "query 是纯净域：不依赖任何其它领域",
  },
  {
    area: /^server\/features\/ontology\//,
    forbidden: ["server/features/query/", "server/features/integrate/", "server/features/action/", "server/features/acceptance/"],
    why: "ontology 是纯净域：不依赖任何其它领域",
  },
  {
    area: /^server\/features\/action\//,
    forbidden: ["server/features/ontology/", "server/features/integrate/", "server/features/acceptance/"],
    why: "action 只许依赖 query（读个体）",
  },
  {
    area: /^server\/features\/integrate\//,
    forbidden: ["server/features/action/", "server/features/acceptance/"],
    why: "integrate 只许依赖 ontology（写草稿）+ query（个体原语）",
  },
  {
    area: /^server\/features\/acceptance\//,
    forbidden: ["server/features/action/", "server/features/integrate/"],
    why: "acceptance 只许依赖 query（跑批编译链）+ ontology（草稿/已发布取数）",
  },
  {
    // ontology 读路径纯函数层：refs / sameConfig / canvasState / lineage 不许碰域内任何写路径与 op 解释
    area: /^server\/features\/ontology\/(refs|sameConfig|canvasState|lineage)\.ts$/,
    forbidden: ["server/features/ontology/"],
    why: "读路径纯函数层不 import 写路径（type-only 的 DraftState 引用放行）",
  },
  {
    // views 是读路径：只许消费纯函数（refs/sameConfig/ops/replaceObject 的纯判定），不碰写路径与分派
    area: /^server\/features\/ontology\/views\.ts$/,
    forbidden: [
      "server/features/ontology/editDraft",
      "server/features/ontology/commit",
      "server/features/ontology/versions",
      "server/features/ontology/current",
      "server/features/ontology/canvasPack",
      "server/features/ontology/ops/index",
      "server/features/ontology/ops/edit",
      "server/features/ontology/ops/importObjects",
      "server/features/ontology/ops/classMustExist",
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

  it("① 错误文案唯一出处是 MSG：无内联中文魔法字串（throw / reject / error / note / warning / zod message）", () => {
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

  it("② 调用方向：值侧 import 不越界（schema 最底 / meta 不碰 engine / infra 不上指 / 引擎不摸单例 / draft 读不依赖写 / errors 纯叶子）", () => {
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

  /* ---------- ③ 时间与随机注入：引擎领域不读系统时钟 / crypto / Math.random ---------- */

  const TIME_RANDOM_PATTERNS: [RegExp, string][] = [
    [/Date\.now\(/, "Date.now("],
    [/new\s+Date\s*\(\s*\)/, "空参 new Date()"],
    [/Math\.random\(/, "Math.random("],
    [/crypto\./, "crypto."],
  ];

  it("③ 领域不读系统时钟与随机源：clock / uuid 由边界注入（无 Date.now( / 空参 new Date() / Math.random( / crypto.）", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (!/^server\/features\//.test(relative(SRC, f))) continue;
      const text = readFileSync(f, "utf8");
      for (const [re, what] of TIME_RANDOM_PATTERNS) {
        const m = text.match(re);
        if (m) offenders.push(`${relative(SRC, f)}：${what}（${m[0].slice(0, 50)}…）`);
      }
    }
    expect(offenders, "时间与随机必须注入（clock / uuid 由边界提供），领域不读系统时钟与 crypto").toEqual([]);
  });

  it("④ 共享能力不在领域包内：features 下无 llm/trail；schema/verdict 与 infra/llm 存在", () => {
    const offenders = files.filter((f) => /^server\/features\/(llm\/|trail\.ts)/.test(relative(SRC, f)));
    expect(offenders, "llm / trail 是跨域共享能力，住 infra 不住领域包").toEqual([]);
    expect(existsSync(join(SRC, "server", "infra", "llm", "slot.ts")), "共享词汇与槽位接口应在 schema/verdict 与 infra/llm").toBe(true);
    expect(existsSync(join(SRC, "server", "schema", "verdict.ts"))).toBe(true);
  });

  it("守门自假检查：errors.ts 若被加 relative import 必须能被抓到（规则确实覆盖了它）", () => {
    const rule = DIRECTION_RULES.find((r) => r.area.test("server/errors.ts"));
    expect(rule, "errors.ts 必须有方向规则罩着").toBeTruthy();
  });
});
