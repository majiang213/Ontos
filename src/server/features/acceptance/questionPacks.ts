// 三波走查的对错板（唯一出处）：「换成第 N 波问题」装入的题面与期望数字全部住这里——
// 组件与测试同引这一份，组件里不许另写数字。
// 数字口径：新建空白空间 + 十二套演示库（npm run demo:seed）按走查剧本裁完之后的阶段世界
// （在役 100 / 在途 81，不是附录 C 的 97/81——那是 test 空间的内存 fixture 世界，别混）。
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
    // 物：设备 × 资产类等价、点检 × 设备部分重叠、采购 × 设备生命周期（早 in_transit / 晚 in_service）之后
    questions: [
      { question: "在役设备一共多少台", expected: "100" }, // 设备源 100 行（含 3 台台账 scrapped）；来源标签认设备台账那张表，不是公共对象
      { question: "在途设备一共多少台", expected: "81" }, // 121 − 40
      { question: "序列号 SN-40217 且处于在途阶段的设备有多少台", expected: "1" }, // 主角还在采购源
      { question: "维修工单有多少条", expected: "15" }, // 独立库；误裁类等价这条会红
    ],
  },
  {
    key: "wave2",
    name: "第二波",
    // 人：办公账号 × 员工部分重叠（唯一键 person_no）、候选人 × 员工生命周期（身份证，早 candidate / 晚 employed）之后
    questions: [
      { question: "在职人员一共多少人", expected: "50" }, // {hr: true}，含 30 个两边都有身份证的
      { question: "还停在候选人阶段、人事还没有行的人一共多少", expected: "50" }, // {recruit: true, hr: false}
      { question: "名叫张三的人员有多少", expected: "1" }, // 张三在 30 人交集里，合并人员类供姓名
      { question: "身份证 11010119900101000X 且处于在职阶段的人员有多少", expected: "1" }, // 张三
      { question: "身份证 11010119900101030X 且处于候选人阶段的人员有多少", expected: "1" }, // C031，人事没有这行
    ],
  },
  {
    key: "wave3",
    name: "第三波",
    // 客货：客户档案 × 销售客户部分重叠、两张 order 同形异义之后
    questions: [
      { question: "销售订单有多少条", expected: "60" }, // 来源标签认销售订单表；采购办公订单被裁成类等价会变成 85
      { question: "仓库里有多少种 sku", expected: "30" }, // 库存表，30 种
      { question: "应收发票有多少张", expected: "40" }, // 发票表，40 行
      { question: "销售系统客户表里的客户有多少", expected: "40" }, // 销售客户那一类，不是上位对象（并集 50）
    ],
  },
  {
    key: "post_accept",
    name: "验收后",
    // 画布外跑过 convert_to_in_service + SN-40217（写回源库）之后：对错板从 100/81 翻成 101/80
    questions: [
      { question: "在役设备一共多少台", expected: "101" },
      { question: "在途设备一共多少台", expected: "80" },
      { question: "序列号 SN-40217 且处于在役阶段的设备有多少台", expected: "1" },
      { question: "序列号 SN-40217 且处于在途阶段的设备有多少台", expected: "0" },
    ],
  },
];
