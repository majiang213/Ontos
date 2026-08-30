// 三波走查的对错板（唯一出处）：「换成第 N 波问题」装入的题面与期望数字全部住这里——
// 组件与测试同引这一份，组件里不许另写数字。
// 数字口径（ADR 0012）：新建空白空间 + 十二套演示库（npm run demo:seed）按走查剧本裁完之后的世界——
// 在役 97 / 在途 81 / 报废 3（设备源 100 行含 3 台台账 scrapped）、点检覆盖 40、在保 20（30 张卡 10 张过期）、
// 处置档案 8、IT 报修 12、门禁 35、外包 5、办公设备 40、采购订单 25、未结束维修 1。
// 题面只写白话（观众看得见）；「判定哪一类」靠节点上的来源标签认，不写进问句。
// 纯数据叶子：组件经 purityBoundary 引它，值侧闭包不许带 node 内建设。

export interface QuestionPack {
  key: string;
  name: string; // 按钮与 toast 用：「换成${name}问题」「已换成 N 条${name}问题」
  questions: { question: string; expected: string }[];
}

export const QUESTION_PACKS: QuestionPack[] = [
  {
    key: "wave1",
    name: "第一波",
    // 设备前半生：设备 × 资产类等价、点检 × 设备部分重叠、采购 × 设备生命周期（早 in_transit / 晚 in_service）之后
    questions: [
      { question: "在役设备一共多少台", expected: "97" }, // 设备源 100 行 − 3 台台账 scrapped；来源标签认设备台账那张表，不是公共对象
      { question: "在途设备一共多少台", expected: "81" }, // 121 − 40
      { question: "序列号 SN-40217 且处于在途阶段的设备有多少台", expected: "1" }, // 主角还在采购源
      { question: "维修工单有多少条", expected: "15" }, // 独立库 15 条；点检覆盖 40 那题真模型编不出交集查询，留演示剧本
    ],
  },
  {
    key: "wave2",
    name: "第二波",
    // 办公线：生产设备 × 办公设备同形异义、维修工单 × IT 报修单同形异义、台账车间 × OA 部门同形异义、
    // 办公账号 × 门禁卡部分重叠之后
    questions: [
      { question: "有门禁卡的正式账号有多少个", expected: "35" }, // 40 账号中 35 正式都有卡，5 外包没卡
      { question: "外包账号有多少个", expected: "5" },
      { question: "IT 报修单有多少条", expected: "12" }, // it_sys.ticket 12 条，与维修工单不是一回事
      { question: "办公设备有多少台", expected: "40" }, // 来源标签认 IT 系统那张表
    ],
  },
  {
    key: "wave3",
    name: "第三波",
    // 设备后半生：设备 × 处置档案生命周期、保修卡 × 设备跳过、采购订单 × 采购条目跳过之后
    // （初稿的「资产 × 保修卡」随类等价合并消失——asset 已并入设备类，同库两张表由 order × po_item 承担）
    questions: [
      { question: "处置档案记录了多少台设备", expected: "8" }, // 处置档案表 8 行（3 台台账 scrapped + 5 台台账已移除）
      { question: "保修期内的设备有多少台", expected: "20" }, // 30 张保修卡，10 张已过期
      { question: "采购订单有多少条", expected: "25" }, // 采购订单表 25 条；误裁类等价会变成 146
      { question: "未结束的维修工单有多少条", expected: "1" }, // 15 条中 1 条 ended_at 空
    ],
  },
  {
    key: "post_accept",
    name: "验收后",
    // 画布外跑过动作（转固 SN-40217、报废一台、预订会议室）之后：对错板翻面
    questions: [
      { question: "在役设备一共多少台", expected: "97" }, // 97 + 1 转固 − 1 报废
      { question: "在途设备一共多少台", expected: "80" }, // 81 − 1
      { question: "序列号 SN-40217 且处于在役阶段的设备有多少台", expected: "1" },
      { question: "会议室预订一共有多少条", expected: "21" }, // 20 + 预订动作 1 条
    ],
  },
];
