// 部分重叠立出的公共对象叫什么、长什么样：shared_${a}_${b}。
// 起名与判定住在 schema/config（infra 也要认它），这里按注册表原地再出口，消费方照旧从这里引。

export { isSharedObjectName, sharedObjectName } from "../../schema/config";
