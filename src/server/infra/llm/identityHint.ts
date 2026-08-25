// 识别字段猜测规则 —— 编号列优先（唯一出处）。
// 罐头实现按正则猜列（canned.ts），真模型提示词按文案写规则（aiSdk.ts）——一处改，两处不漂移。

/** 编号列的形状：_no / _id 结尾。 */
export const IDENTITY_COL_RE = /_no$|_id$/;

/** 同一条规则的自然语言版（进提示词）。 */
export const IDENTITY_COL_RULE = "识别字段 identity 选业务编号列（_no/_id 结尾优先）";
