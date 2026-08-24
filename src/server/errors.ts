// 域拒绝类型一处 —— 各层按类型映射错误码（路由 422 / MCP -32000 / 400），不再散在五个文件。
// query、config、infra、app 各层都向下依赖这里；映射阶梯留在 _shared 与 mcp/route，不动。

/** 引擎拒绝：请求或配置里的名字对不上已发布配置。路由按 422 处理；其它异常是引擎故障，按 500。 */
export class EngineReject extends Error {}

/** 草稿操作不合法：名字重了、对象不存在、被引用未解除等。 */
export class DraftReject extends Error {}

/** 连接生命周期拒绝：bad_request 对形状/路径，rejected 对资格（演示源、连不上、占用）。 */
export class ConnectionReject extends Error {
  constructor(
    message: string,
    readonly kind: "bad_request" | "rejected" = "rejected"
  ) {
    super(message);
    this.name = "ConnectionReject";
  }
}

/** 工作空间域拒绝（名字不合法、已存在）：路由按 422 处理，与其它域的 Reject 同层。 */
export class WsReject extends Error {}
