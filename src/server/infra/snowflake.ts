// 雪花号 —— 无共享计数器的发号（generate 的 { snowflake: true }）。
// 64 位：41 位毫秒时间戳（~69 年）| 10 位实例 id（0–1023）| 12 位每毫秒序列（0–4095）。
// 状态（上次时间戳 + 序列）在闭包里，实例本地持有——多实例不撞号的前提是实例 id 不冲突
// （部署经 ONTOS_SNOWFLAKE_INSTANCE_ID 分配；未分配时随机，碰撞概率极低但存在，见 AGENTS.md）。
// 时钟回拨保底：时间戳倒退时沿用上次值 + 序列继续（不重复发号；可能号序乱——取舍文档化）。

export function makeSnowflake(clock: () => number, instanceId: number): () => string {
  const inst = BigInt(instanceId & 0x3ff);
  let lastMs = -1;
  let seq = 0;
  return () => {
    // clock 是 UTC Unix 秒（全仓口径，见 env.clock）；雪花时间戳用毫秒，×1000 后 41 位可到 2039 年
    let ms = clock() * 1000;
    if (ms < lastMs) ms = lastMs; // 回拨保底：不重复发号
    if (ms === lastMs) seq = (seq + 1) & 0xfff;
    else {
      lastMs = ms;
      seq = 0;
    }
    const n = (BigInt(ms) << 22n) | (inst << 12n) | BigInt(seq);
    return n.toString();
  };
}
