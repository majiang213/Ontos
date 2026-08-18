// 路由共用的小件：请求体解析与尽力留痕。
// 非路由文件（非 route.ts），只被各条 api 路由 import。

/** 请求体不是合法 JSON 时抛它——裸 SyntaxError 落进 catch 会被当成 500。 */
export class BadRequest extends Error {}

export async function bodyJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequest("请求体不是合法 JSON");
  }
}

/** 留痕尽力而为：500 的根因若正是元库故障，catch 里再抛就成非 JSON 响应。 */
export function safeLog(fn: () => void): void {
  try {
    fn();
  } catch {
    // 留痕失败不挡响应
  }
}
