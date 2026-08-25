// 键控串行队列 —— 每键一条链，task 顺序执行；prev 失败也续链（拒绝不拖死后续）。
// 全仓两层队列共用这一份：draft 写队列（current.enqueue 的 tails）与动作串行队列（runAction 的 actionTails）——
// 发号与 create 幂等是 check-then-act，没有串行化会重号、补偿重发会插重复行。

export function enqueueKeyed<T>(map: Map<string, Promise<void>>, key: string, task: () => Promise<T>): Promise<T> {
  const prev = map.get(key) ?? Promise.resolve();
  const run = prev.then(task, task); // 前一次拒绝也跑这一次
  map.set(key, run.then(() => undefined, () => undefined)); // 只续链，吞掉结果；拒绝仍传给调用方
  return run;
}
