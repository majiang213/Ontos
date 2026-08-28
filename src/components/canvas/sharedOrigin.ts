// 公共对象的由来：部分重叠立出的 shared_A_B 怎样认出两个原类、变成画布边。
// 名字式样在 sharedName（起名/拆名同一处）；这里只做画布投影。不进配置、不落库。

import type { CanvasLink } from "./layout";
import { sharedEnds } from "../../server/features/ontology/sharedName";

export interface OriginTriple {
  shared: string; // 公共对象（sharedObjectName 的产物）
  a: string; // sharedObjectName(a, b) 的两个原类
  b: string;
}

type OriginInput = string | { name: string; sources?: { label: string }[] };

/** 从当前对象认出公共对象由来。多拆分时用来源对得上的那一对；对不上再取更长的原类名。 */
export function originTriples(objects: OriginInput[]): OriginTriple[] {
  const rows = objects.map((o) =>
    typeof o === "string"
      ? { name: o, labels: new Set<string>() }
      : { name: o.name, labels: new Set((o.sources ?? []).map((s) => s.label)) }
  );
  const names = new Set(rows.map((r) => r.name));
  const labelsOf = new Map(rows.map((r) => [r.name, r.labels] as const));
  const out: OriginTriple[] = [];
  for (const n of names) {
    const matches = sharedEnds(n, names);
    if (matches.length === 0) continue;
    const picked = pickEnds(n, matches, labelsOf);
    out.push({ shared: n, a: picked.a, b: picked.b });
  }
  return out.sort((x, y) => (x.shared < y.shared ? -1 : x.shared > y.shared ? 1 : 0));
}

function pickEnds(
  shared: string,
  matches: { a: string; b: string }[],
  labelsOf: Map<string, Set<string>>
): { a: string; b: string } {
  const sharedLabels = labelsOf.get(shared) ?? new Set();
  let pool = matches;
  if (sharedLabels.size > 0) {
    const hit = matches.filter(
      ({ a, b }) => overlaps(labelsOf.get(a), sharedLabels) && overlaps(labelsOf.get(b), sharedLabels)
    );
    if (hit.length > 0) pool = hit;
  }
  return pool.reduce((best, m) => (m.a.length > best.a.length ? m : best));
}

function overlaps(a: Set<string> | undefined, b: Set<string>): boolean {
  if (!a || a.size === 0) return false;
  for (const x of a) if (b.has(x)) return true;
  return false;
}

const SHARED_KIND = "shared" as const;
export const SHARED_COLOR = "#9a94b8"; // = var(--shared)；SVG marker 不吃 CSS var

/** 一组三元组 → 两条由来边（原类 → 公共对象；反向进 dagre 后公共对象排在上层）。 */
export function originLinksOf(triples: OriginTriple[]): CanvasLink[] {
  return triples.flatMap((t) =>
    [t.a, t.b].map((cls) => ({
      name: `shared:${t.shared}:${cls}`,
      from: cls,
      to: t.shared,
      description: "公共部分",
      kind: SHARED_KIND,
    }))
  );
}

export function isSharedLink(l: CanvasLink): boolean {
  return l.kind === "shared";
}
