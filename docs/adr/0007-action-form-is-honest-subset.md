# 对象卡动作表单是附录 B 的诚实子集

写入请求是 `{ action, object, identity, request? }`。动作定义是 `pre` / `effect` / `inform`。`actionSchema` 校验定义，不校验请求。表单不是写入请求的编辑器。

表单只覆盖：`update` / `delete` 作用在请求点名的那一个体上；`create` 必须有 `object`；`link` 只选已有转化，没有另一端；`properties` 只收非派生源列。不做 `inform`，不加 `write`，不引入 `$root`，不新开本体键。

认人键只写在 `update` / `delete`：`object` 加 `identity: { from: identity }`。`create` 与 `link` 没有这个键。每条 `update` / `delete` 必须有 `identity` 或 `filter`，不许都缺。`delete` 的 `object` 是宿主类。列表按钮叫「删除」；效应摘要叫「撤走」。
