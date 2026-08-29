// 部分重叠立出的公共对象叫什么：shared_${a}_${b}。起名一处。由来边读 class_conclusions，不靠拆这个名字。

const SHARED_PREFIX = "shared_";

export function isSharedObjectName(name: string): boolean {
  return name.startsWith(SHARED_PREFIX);
}

/** 裁决立公共对象时的类名。画布由来边读 class_conclusions.shared，不猜这个名字。 */
export function sharedObjectName(a: string, b: string): string {
  return `${SHARED_PREFIX}${a}_${b}`;
}
