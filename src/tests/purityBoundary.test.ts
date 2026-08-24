// 导入方向守门：前端组件（src/components）只许引用 server 的纯叶子模块。
// 纯叶子 = 值侧传递闭包里没有 node 内建设（node:fs 等）、没有数据库驱动包（mysql2 / pg / better-sqlite3）——
// 前端构建不打这些，碰了就炸包。类型引用也查：类型挂着的模块必须同样纯（防「类型能引值不能」的两张皮）。
// 组件自身的值侧导入同样不许直碰黑名单。

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "..");
const SERVER = join(SRC, "server");
const COMPONENTS = join(SRC, "components");

const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));
const SERVER_ONLY_PKGS = [/^mysql2(\/|$)/, /^pg(\/|$)/, /^better-sqlite3(\/|$)/];

// import ... from "x" / import "x" / export ... from "x"（含多行）；typeOnly 只认整句 import type / export type
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

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** 相对说明符与 @/ 别名解析成文件路径；包说明符返回 null（不跟进去）。 */
function resolveSpec(spec: string, fromFile: string): string | null {
  let p: string;
  if (spec.startsWith(".")) p = resolve(dirname(fromFile), spec);
  else if (spec.startsWith("@/")) p = join(SRC, spec.slice(2));
  else return null;
  for (const cand of [p, `${p}.ts`, `${p}.tsx`, `${p}.d.ts`, join(p, "index.ts"), join(p, "index.tsx")]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  return null;
}

/** 说明符是不是「前端构建打不了」的：node 内建设（含 node: 前缀）或数据库驱动包。 */
function blockedSpec(spec: string): boolean {
  if (BUILTINS.has(spec.replace(/^node:/, ""))) return true;
  return SERVER_ONLY_PKGS.some((re) => re.test(spec));
}

/* server 文件的纯度：值侧（非 type）传递闭包内无黑名单说明符。类型引用编译期擦除，不算杂质。 */
const serverFiles = walk(SERVER).filter((f) => f.endsWith(".ts"));
const memo = new Map<string, boolean>();
function isPure(file: string): boolean {
  const hit = memo.get(file);
  if (hit !== undefined) return hit;
  memo.set(file, true); // 环先按纯记，杂质会沿回边传染回来
  for (const { spec, typeOnly } of importsOf(file)) {
    if (typeOnly) continue;
    if (blockedSpec(spec)) return (memo.set(file, false), false);
    const target = resolveSpec(spec, file);
    if (target && target.startsWith(SERVER) && !isPure(target)) return (memo.set(file, false), false);
  }
  return memo.get(file)!;
}

describe("组件 → server 导入方向（只许纯叶子）", () => {
  it("组件引用的每个 server 模块都是纯叶子；组件自身的值侧导入不碰黑名单", () => {
    const offenders: string[] = [];
    for (const f of walk(COMPONENTS).filter((x) => /\.tsx?$/.test(x))) {
      for (const { spec, typeOnly } of importsOf(f)) {
        if (!typeOnly && blockedSpec(spec)) offenders.push(`${relative(SRC, f)} 直接引入 ${spec}`);
        const target = resolveSpec(spec, f);
        if (!target || !target.startsWith(SERVER)) continue;
        if (!isPure(target)) offenders.push(`${relative(SRC, f)} → ${spec}（${relative(SRC, target)} 的值侧闭包含 node 内建设或数据库驱动）`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("守门自检：元库与驱动实现被判不纯（meta/store、infra/sqlDriver、llmSlot）", () => {
    // 守门规则本身有效的活证：这几个已知不纯的模块必须被判出来，否则上面的全绿是假绿
    for (const [file, expectPure] of [
      ["meta/store.ts", false],
      ["engine/infra/sqlDriver.ts", false],
      ["engine/llmSlot.ts", false],
      ["etag.ts", true],
      ["engine/adjudication/verdict.ts", true],
      ["schema/spec/actionSpec.ts", true],
      ["engine/draft/lineage.ts", true],
    ] as const) {
      expect(isPure(join(SERVER, file)), file).toBe(expectPure);
    }
    expect(serverFiles.length).toBeGreaterThan(0);
  });
});
