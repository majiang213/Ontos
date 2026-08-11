// ============================================================
// 假源库数据 —— PROTOTYPE 专用
// MVP 里这一层是 M1 连接器：drizzle-kit pull 内省 schema + 只读账号采样。
// 这里用内存对象模拟两个库：招聘系统(MySQL 风) 与 HR 系统(PG 风)。
// 数据即 demo 剧本：50 候选人 / 40 员工 / 17 人身份证重合 → 交集率 34%。
// ============================================================

export interface Column {
  name: string;
  type: string;
  pk?: boolean;
  comment?: string;
}
export interface Table {
  name: string;
  comment?: string;
  columns: Column[];
  rows: Record<string, unknown>[];
}
export interface SourceDb {
  connection: string;
  kind: "mysql" | "pg";
  tables: Table[];
}

const SURNAMES = ["张", "王", "李", "赵", "陈", "刘", "杨", "黄", "周", "吴"];
const GIVEN = ["伟", "芳", "娜", "敏", "静", "磊", "洋", "勇", "艳", "杰", "涛", "明", "超", "秀英", "霞", "平", "刚", "桂英", "文轩", "雨桐"];

function personName(i: number): string {
  return SURNAMES[i % SURNAMES.length] + GIVEN[(i * 7 + 3) % GIVEN.length];
}
// 确定性假身份证（18 位格式合法即可，非真实）
function idCard(i: number): string {
  return `11010119${80 + (i % 20)}0${1 + (i % 9)}1${10 + (i % 80)}${i % 10}${(i * 3) % 10}${i % 3 === 0 ? "X" : (i * 7) % 10}`;
}
// 招聘库手机号故意脏格式：+86、空格、连字符 → 验证归一化
function messyPhone(i: number): string {
  const n = `13${8 + (i % 2)}${String(10000000 + i * 137).slice(0, 8)}`;
  return `+86 ${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7)}`;
}
function cleanPhone(i: number): string {
  return `13${8 + (i % 2)}${String(10000000 + i * 137).slice(0, 8)}`;
}

const DEPTS = [
  { dept_id: "D01", dept_name: "研发部" },
  { dept_id: "D02", dept_name: "产品部" },
  { dept_id: "D03", dept_name: "设计部" },
  { dept_id: "D04", dept_name: "运营部" },
];
const JOB_TITLES = ["前端工程师", "后端工程师", "产品经理", "UI设计师", "运营专员"];

// ---- 招聘系统 --------------------------------------------------
const candidateRows: Record<string, unknown>[] = [];
for (let i = 0; i < 50; i++) {
  candidateRows.push({
    cand_id: 1000 + i,
    candidate_name: personName(i),
    idcard_no: idCard(i), // 前 17 人会出现在 HR 库（已转正）
    mobile: messyPhone(i),
    applied_position: JOB_TITLES[i % JOB_TITLES.length],
    interview_score: 60 + ((i * 13) % 40),
    created_at: `2025-${String(1 + (i % 12)).padStart(2, "0")}-15`,
  });
}
const recruitingDeptRows = DEPTS.map((d) => ({ dept_code: d.dept_id, dept_name: d.dept_name }));
const jobPostingRows = JOB_TITLES.map((t, i) => ({
  job_id: 500 + i,
  title: t,
  jd_text: `${t}的岗位职责描述……`,
  dept_code: DEPTS[i % DEPTS.length].dept_id,
}));

// ---- HR 系统 ---------------------------------------------------
// 员工 40 人：工号 2000-2039；其中前 17 人 = 候选人前 17 人（转正），后 23 人身份证新段（社招直签）
const employeeRows: Record<string, unknown>[] = [];
for (let i = 0; i < 40; i++) {
  const fromRecruiting = i < 17;
  employeeRows.push({
    emp_no: `E${2000 + i}`,
    emp_name: fromRecruiting ? personName(i) : personName(i + 60),
    id_card: fromRecruiting ? idCard(i) : idCard(i + 200),
    phone: fromRecruiting ? cleanPhone(i) : cleanPhone(i + 60),
    dept_id: DEPTS[i % DEPTS.length].dept_id,
    status: i === 5 || i === 30 ? "离职" : "在职",
    hired_at: `2025-${String(1 + (i % 12)).padStart(2, "0")}-28`,
  });
}
const departmentRows = DEPTS.map((d) => ({ ...d, parent_id: null }));
const headcountRows = JOB_TITLES.map((t, i) => ({
  pos_id: 900 + i,
  title: t,
  headcount: 2 + (i % 5),
  dept_id: DEPTS[i % DEPTS.length].dept_id,
}));

export const SOURCES: SourceDb[] = [
  {
    connection: "recruiting",
    kind: "mysql",
    tables: [
      {
        name: "candidate",
        comment: "候选人",
        columns: [
          { name: "cand_id", type: "int", pk: true },
          { name: "candidate_name", type: "varchar(64)", comment: "姓名" },
          { name: "idcard_no", type: "varchar(18)", comment: "身份证号" },
          { name: "mobile", type: "varchar(32)", comment: "手机号" },
          { name: "applied_position", type: "varchar(64)", comment: "应聘职位" },
          { name: "interview_score", type: "int", comment: "面试评分" },
          { name: "created_at", type: "date", comment: "创建时间" },
        ],
        rows: candidateRows,
      },
      {
        name: "job_posting",
        comment: "招聘职位JD",
        columns: [
          { name: "job_id", type: "int", pk: true },
          { name: "title", type: "varchar(64)", comment: "职位名" },
          { name: "jd_text", type: "text", comment: "JD描述" },
          { name: "dept_code", type: "varchar(8)", comment: "用人部门" },
        ],
        rows: jobPostingRows,
      },
      {
        name: "department",
        comment: "部门",
        columns: [
          { name: "dept_code", type: "varchar(8)", pk: true },
          { name: "dept_name", type: "varchar(64)", comment: "部门名" },
        ],
        rows: recruitingDeptRows,
      },
    ],
  },
  {
    connection: "hr",
    kind: "pg",
    tables: [
      {
        name: "employee",
        comment: "员工",
        columns: [
          { name: "emp_no", type: "varchar(8)", pk: true },
          { name: "emp_name", type: "varchar(64)", comment: "姓名" },
          { name: "id_card", type: "varchar(18)", comment: "身份证号" },
          { name: "phone", type: "varchar(16)", comment: "手机号" },
          { name: "dept_id", type: "varchar(8)", comment: "部门" },
          { name: "status", type: "varchar(8)", comment: "在职状态" },
          { name: "hired_at", type: "date", comment: "入职日期" },
        ],
        rows: employeeRows,
      },
      {
        name: "department",
        comment: "部门",
        columns: [
          { name: "dept_id", type: "varchar(8)", pk: true },
          { name: "dept_name", type: "varchar(64)", comment: "部门名" },
          { name: "parent_id", type: "varchar(8)", comment: "上级部门" },
        ],
        rows: departmentRows,
      },
      {
        name: "headcount_position",
        comment: "岗位编制",
        columns: [
          { name: "pos_id", type: "int", pk: true },
          { name: "title", type: "varchar(64)", comment: "岗位名" },
          { name: "headcount", type: "int", comment: "编制数" },
          { name: "dept_id", type: "varchar(8)", comment: "所属部门" },
        ],
        rows: headcountRows,
      },
    ],
  },
];

export function getTable(connection: string, table: string): Table {
  const db = SOURCES.find((s) => s.connection === connection);
  const t = db?.tables.find((t) => t.name === table);
  if (!t) throw new Error(`unknown table ${connection}.${table}`);
  return t;
}
