// API 适配器 —— 前端到后端路由的唯一接缝。
// 统一三件事：工作空间路径段拼串（/api/<空间名>/…）、JSON 解析、错误归一（非 2xx 抛 ApiError，message 取上游 error/detail）。
// 调用方只剩语义：要什么数据、失败往哪显示（toast / 消息流 / 卡内）。
// 当前工作空间是这个模块的构造参数：page.tsx 的切换器设置，切换时两页按 key 重挂，所以只需要当前值。
"use client";

/** 后端非 2xx 的统一错误：status + 上游 message。 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let current = "default";

export function setWorkspace(workspace: string): void {
  current = workspace;
}

export function getWorkspace(): string {
  return current;
}

/* ---------- 上次打开的工作空间（cookie：SSR 首屏直接渲染，不闪不切） ----------
   服务端渲染时读 cookie 决定初始空间；客户端切换时写回。写不进（隐私模式等）只是下次回 default，不拦。 */
const LAST_WORKSPACE_KEY = "ontos.lastWorkspace";

export function rememberWorkspace(workspace: string): void {
  try {
    if (typeof document === "undefined") return;
    document.cookie = `${LAST_WORKSPACE_KEY}=${encodeURIComponent(workspace)}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    // 记不住不拦主流程
  }
}

function apiUrl(path: string): string {
  // 全局注册表路由（/api/workspaces 列表与新建）不按空间前缀；其余都挂在 /api/<空间名>/ 下
  if (path === "/api/workspaces") return path;
  return `/api/${encodeURIComponent(current)}${path.slice("/api".length)}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(apiUrl(path), init);
  const data: unknown = await r.json().catch(() => ({})); // 非 JSON 体（极少）按空对象走，错误用状态码兜
  if (!r.ok) {
    const d = data as { error?: string; detail?: string };
    throw new ApiError(r.status, d.error ?? d.detail ?? `请求失败（${r.status}）`);
  }
  return data as T;
}

/** GET。返回形状由调用方断（各路由出自己的 JSON）。 */
export function apiGet<T = Record<string, unknown>>(path: string): Promise<T> {
  return request<T>(path);
}

/** POST JSON：body 给对象（内部序列化）；省略 body 发空对象。只收 object——调用方在 seam 处把字符串归一成 object。 */
export function apiPost<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

/** DELETE JSON。 */
export function apiDel<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}
