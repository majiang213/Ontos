// 部分重叠立出的公共对象叫什么：shared_${a}_${b}。起名和按名字拆回去同一处。

const SHARED_PREFIX = "shared_";

export function isSharedObjectName(name: string): boolean {
  return name.startsWith(SHARED_PREFIX);
}

/** 裁决立公共对象时的类名。画布按同形拆回两个原类。 */
export function sharedObjectName(a: string, b: string): string {
  return `${SHARED_PREFIX}${a}_${b}`;
}

/** 名字能拆成的所有两端：两端都在当前对象名集合里。一对都没有则空。 */
export function sharedEnds(name: string, present: ReadonlySet<string>): { a: string; b: string }[] {
  if (!isSharedObjectName(name)) return [];
  const rest = name.slice(SHARED_PREFIX.length);
  const out: { a: string; b: string }[] = [];
  for (const a of present) {
    if (a === name || !rest.startsWith(`${a}_`)) continue;
    const b = rest.slice(a.length + 1);
    if (b && present.has(b) && b !== name) out.push({ a, b });
  }
  return out;
}
