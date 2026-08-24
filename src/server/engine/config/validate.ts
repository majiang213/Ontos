// 配置的语义校验 —— 附录 B 里 zod 管不着的约束，发布与加载时各跑一遍。
// 违反即抛错：identity 缺映射、派生属性进 fields、关系端点不存在、inform 指向未声明的出站等。

import { type OntologyConfig } from "../../schema/config";
import { checkFilterOperands, walkFilter } from "../../schema/spec/filterSpec";
import { checkActionValue, walkEffectItems, walkEffectValues, type CreateItem, type DeleteItem, type UpdateItem } from "../../schema/spec/actionSpec";

export function validateSemantics(config: OntologyConfig): void {
  /** 过滤树走查（schema 层 walkFilter）：键必须是该类属性，$link 关系名必须可解析（嵌套跟着目标类走）。$request/$exists 的内容不查（参数袋/布尔）。 */
  const checkFilterKeys = (clsName: string, f: Record<string, unknown>, trail: string): void => {
    if (!config.object_types[clsName]) return; // 类不存在由效应目标检查报「不存在的类」，这里不抢话
    walkFilter(config, clsName, f, {
      link: (_cls, ln, target) => {
        if (!target) throw new Error(`配置不合法：${trail} 引用了不存在的关系 ${ln}`);
      },
      prop: (cls, k) => {
        if (!config.object_types[cls]?.properties[k]) throw new Error(`配置不合法：${trail} 过滤了 ${cls} 上不存在的属性 ${k}`);
      },
    });
  };
  for (const [clsName, cls] of Object.entries(config.object_types)) {
    if (cls.identity && !cls.properties[cls.identity]) {
      throw new Error(`配置不合法：${clsName} 的 identity 指向不存在的属性 ${cls.identity}`);
    }
    if (cls.identity && cls.properties[cls.identity]?.derived) {
      throw new Error(`配置不合法：${clsName} 的 identity 指向派生属性 ${cls.identity}`);
    }
    const derivedProps = new Set(Object.entries(cls.properties).filter(([, d]) => d.derived).map(([p]) => p));
    for (const [srcName, entry] of Object.entries(cls.sources ?? {})) {
      const keyProp = entry.key ?? cls.identity;
      if (!keyProp) {
        throw new Error(`配置不合法：${clsName}.${srcName} 没有认行依据（类无 identity，条目也无 key）`);
      }
      if (!entry.fields[keyProp]) {
        throw new Error(`配置不合法：${clsName}.${srcName} 的 fields 缺对齐属性 ${keyProp}`);
      }
      for (const prop of Object.keys(entry.fields)) {
        if (derivedProps.has(prop)) throw new Error(`配置不合法：派生属性不得进 fields（${clsName}.${srcName} 的 ${prop}）`);
        if (!cls.properties[prop]) throw new Error(`配置不合法：${clsName}.${srcName} 的 fields 指向不存在的属性 ${prop}`);
      }
    }
    // when 派生的每条规则：键必须是该类的源条目名；规则里的过滤键必须是该源条目映射了的属性（拼错会被静默吞，发布闸拦住）
    for (const [prop, def] of Object.entries(cls.properties)) {
      if (!Array.isArray(def.derived)) continue;
      for (const rule of def.derived) {
        for (const [src, cond] of Object.entries(rule.when)) {
          const entry = cls.sources?.[src];
          if (!entry) throw new Error(`配置不合法：${clsName}.${prop} 的派生规则指向不存在的源条目 ${src}`);
          if (cond && typeof cond === "object") {
            // 遍历走 schema 层 walkFilter：顶层键查源条目映射；嵌套键按目标类查类属性（与 checkFilterKeys 同口径）
            walkFilter(config, clsName, cond as Record<string, unknown>, {
              prop: (c, k, _v, depth) => {
                if (depth === 0) {
                  if (!entry.fields[k]) throw new Error(`配置不合法：${clsName}.${prop} 的派生规则在 ${src} 上过滤未映射的属性 ${k}`);
                } else if (!config.object_types[c]?.properties[k]) {
                  throw new Error(`配置不合法：${clsName}.${prop} 的派生规则过滤了 ${c} 上不存在的属性 ${k}`);
                }
              },
              link: (_c, ln, target) => {
                if (!target) throw new Error(`配置不合法：${clsName}.${prop} 的派生规则引用了不存在的关系 ${ln}`);
              },
              special: (_c, k, _v) => {
                throw new Error(`配置不合法：${clsName}.${prop} 的派生规则里 ${src} 的过滤不支持 ${k}`);
              },
            });
          }
        }
      }
    }
    // 布尔过滤形态的派生：键是类属性、$link 关系名可解析
    for (const [prop, def] of Object.entries(cls.properties)) {
      const der = def.derived;
      if (!der || Array.isArray(der)) continue;
      checkFilterKeys(clsName, der as Record<string, unknown>, `${clsName}.${prop} 的派生`);
    }
    // 动作的前置与效应过滤同尺
    for (const [actName, act] of Object.entries(cls.actions ?? {})) {
      if (act.pre) checkFilterKeys(clsName, act.pre as Record<string, unknown>, `${clsName}.${actName} 的前置`);
      const effFilter = (item: UpdateItem | DeleteItem) => {
        if (item.filter) checkFilterKeys(item.object, item.filter as Record<string, unknown>, `${clsName}.${actName} 的效应过滤`);
      };
      walkEffectItems(act, { update: effFilter, delete: effFilter });
    }
  }
  for (const [linkName, link] of Object.entries(config.link_types)) {
    for (const end of [link.from, link.to]) {
      if (!config.object_types[end]) throw new Error(`配置不合法：关系 ${linkName} 的端点 ${end} 不存在`);
    }
    if (link.match) {
      for (const pair of link.match) {
        const fromDef = config.object_types[link.from].properties[pair.from];
        const toDef = config.object_types[link.to].properties[pair.to];
        if (!fromDef) {
          throw new Error(`配置不合法：关系 ${linkName} 的 match 指向不存在的属性 ${link.from}.${pair.from}`);
        }
        if (!toDef) {
          throw new Error(`配置不合法：关系 ${linkName} 的 match 指向不存在的属性 ${link.to}.${pair.to}`);
        }
        // 配对要读真实列值：派生属性没有列，配上了也永远不成立
        if (fromDef.derived) throw new Error(`配置不合法：关系 ${linkName} 的 match 指向派生属性 ${link.from}.${pair.from}`);
        if (toDef.derived) throw new Error(`配置不合法：关系 ${linkName} 的 match 指向派生属性 ${link.to}.${pair.to}`);
      }
    }
    if (link.transition) {
      const def = config.object_types[link.from].properties[link.transition.property];
      if (!def?.derived || !Array.isArray(def.derived)) {
        throw new Error(`配置不合法：关系 ${linkName} 的 transition.property 不是 when 派生（${link.from}.${link.transition.property}）`);
      }
      // 转化的两个端点值必须都在派生规则的产出里，否则运行期永远判不出来
      const values = new Set(def.derived.map((r) => r.value));
      if (!values.has(link.transition.from) || !values.has(link.transition.to)) {
        throw new Error(`配置不合法：关系 ${linkName} 的 transition 阶段值不在派生规则里（${String(link.transition.from)} / ${String(link.transition.to)}）`);
      }
    }
  }
  for (const [clsName, cls] of Object.entries(config.object_types)) {
    for (const [actName, act] of Object.entries(cls.actions ?? {})) {
      // 效应指向的类必须存在；update/create 写的属性必须是该类的源列属性；$request 认人的类必须存在
      const effTarget = (item: UpdateItem | CreateItem | DeleteItem) => {
        const target = config.object_types[item.object];
        if (!target) throw new Error(`配置不合法：${clsName}.${actName} 的效应指向不存在的类 ${item.object}`);
        if ("properties" in item && item.properties) {
          for (const prop of Object.keys(item.properties)) {
            if (!target.properties[prop]) throw new Error(`配置不合法：${clsName}.${actName} 的效应写了不存在的属性 ${item.object}.${prop}`);
            if (target.properties[prop].derived) throw new Error(`配置不合法：${clsName}.${actName} 的效应写了派生属性 ${item.object}.${prop}`);
          }
        }
      };
      walkEffectItems(act, { update: effTarget, create: effTarget, delete: effTarget }); // link：关系名由 link_types 表自身约束
      const reqBlock = act.pre?.$request as Record<string, unknown> | undefined;
      for (const cv of Object.values(reqBlock ?? {})) {
        if (cv !== null && typeof cv === "object" && "object" in (cv as Record<string, unknown>)) {
          const target = String((cv as Record<string, unknown>).object);
          if (!config.object_types[target]) throw new Error(`配置不合法：${clsName}.${actName} 的 $request 指向不存在的类 ${target}`);
        }
      }
      for (const inf of act.inform ?? []) {
        if (!config.object_types[inf.object]) throw new Error(`配置不合法：${clsName}.${actName} 的 inform 对象 ${inf.object} 不存在`);
        for (const outlet of inf.to) {
          if (!config.outlets?.[outlet]) throw new Error(`配置不合法：${clsName}.${actName} 的 inform 指向未声明的出站 ${outlet}`);
        }
      }
    }
  }
}

/* ---------- 动作形状四查（validateActionShapes） ----------
   validateSemantics 管指称（类/属性/关系存在），这里管附录 B 的形状——今天只有运行期才拦的四条：
   ① 效应 link 必须指向已存在的转化关系，且 from/to 都在宿主类上（与 action.ts 运行期同口径）；
   ② 每条 transition 关系必须被至少一条动作的效应 link 引用（孤儿转化关系发布不出去）；
   ③ 取值来源形状（规约在 schema/spec/actionSpec；过滤操作数在 schema/spec/filterSpec；词表原语在 schema/spec/valueSpec）；
   ④ update / delete 必须带 identity 或 filter（认人必须写明）。
   只在草稿写入/发布路径调（applyDraft / mutateDraft / publish 的 validateSemantics 之后）；
   loadPublished / rollbackTo 不调——历史已发布的坏配置加载放行，运行期由 action.ts 兜底。 */
export function validateActionShapes(config: OntologyConfig): void {
  for (const [clsName, cls] of Object.entries(config.object_types)) {
    for (const [actName, act] of Object.entries(cls.actions ?? {})) {
      const where = `${clsName}.${actName}`;
      // ① 效应 link 与 ④ 认人写明是结构条件（要查配置、要见整条 op），走 walkEffectItems 逐项直查；
      // 取值形状（③）走 actionSpec.walkEffectValues——位置分派不再在这里另写一份
      const identityOrFilter = (item: UpdateItem | DeleteItem) => {
        if (item.identity === undefined && !item.filter) {
          throw new Error(`配置不合法：${where} 的效应认人必须写明：${item.object} 缺 identity 或 filter`);
        }
      };
      walkEffectItems(act, {
        link: (name) => {
          const l = config.link_types[name];
          if (!l?.transition) throw new Error(`配置不合法：${where} 的效应 link 指向不存在的转化关系 ${name}`);
          if (l.from !== clsName || l.to !== clsName) throw new Error(`配置不合法：转化关系 ${name} 不在 ${clsName} 上`);
        },
        update: identityOrFilter,
        delete: identityOrFilter,
      });
      walkEffectValues(act, {
        // create 投影没有 current 上下文；from: generated 只许落在带 generate 列表的属性上
        createProp: (item, p, v) =>
          checkActionValue("effect.create.properties", v, `${where} 的效应（create ${item.object}.${p}）`, { hasGenerate: Boolean(config.object_types[item.object]?.properties[p]?.generate) }),
        // 认人键：current 不可用（认人发生在逐个体求值之前）
        identity: (_op, _item, v) => checkActionValue("effect.identity", v, `${where} 的效应认人`),
        // 效应过滤的取值：update/delete 逐个体求值，有 current 上下文
        filter: (_op, _item, f) => checkFilterOperands(f as Record<string, unknown>, `${where} 的效应过滤`),
        updateProp: (item, p, v) => checkActionValue("effect.update.properties", v, `${where} 的效应（update ${item.object}.${p}）`),
        // inform 的取值：没有 current 上下文，也没有 generated
        informProp: (_inf, p, v) => checkActionValue("inform.properties", v, `${where} 的 inform（${p}）`),
      });
    }
  }
  // ② 转化成对：每条 transition 关系必须被至少一条动作的效应 link 引用
  for (const [linkName, link] of Object.entries(config.link_types)) {
    if (!link.transition) continue;
    const referenced = Object.values(config.object_types).some((cls) =>
      Object.values(cls.actions ?? {}).some((act) => {
        let hit = false;
        walkEffectItems(act, { link: (name) => { if (name === linkName) hit = true; } });
        return hit;
      })
    );
    if (!referenced) {
      throw new Error(`配置不合法：转化关系 ${linkName} 没有任何动作的效应 link 引用它——先写一条同样 link 该转化关系的替代动作，再删旧的`);
    }
  }
}

/* 取值形状与过滤操作数的核对已收进规约层：schema/spec/actionSpec（checkActionValue，按位置放闸）与
   schema/spec/filterSpec（checkOperand/checkFilterOperands）。本文件只留指称校验与形状四查的编排。 */
