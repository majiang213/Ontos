// 客户端当前工作空间（页面级单值）：page.tsx 的切换器设置，全部 fetch 经 apiUrl 带上 ?ws=。
// 切换空间时两页按 key 重挂，所以这个单值只需要当前值，不需要历史。
"use client";

let current = "default";

export function setWs(ws: string): void {
  current = ws;
}

export function getWs(): string {
  return current;
}

export function apiUrl(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}ws=${encodeURIComponent(current)}`;
}
