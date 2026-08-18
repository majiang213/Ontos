// 配置的语义校验 —— 附录 B 里 zod 管不着的约束，发布与加载时各跑一遍。
// 违反即抛错：identity 缺映射、派生属性进 fields、关系端点不存在、inform 指向未声明的出站等。

import type { OntologyConfig } from "../schema/config";

export function validateSemantics(config: OntologyConfig): void {
  // 关系名能否从该类解析（正向名在 from 侧，反向名在 to 侧）
  const linkResolves = (clsName: string, ln: string) => {
    const direct = config.link_types[ln];
    return Boolean((direct && direct.from === clsName) || Object.values(config.link_types).some((l) => l.inverse === ln && l.to === clsName));
  };
  /** 过滤树走查：键必须是该类属性，$link 关系名必须可解析（嵌套跟着目标类走）。$request/$exists 的内容不查（参数袋/布尔）。 */
  const checkFilterKeys = (clsName: string, f: Record<string, unknown>, trail: string): void => {
    if (!config.object_types[clsName]) return; // 类不存在由效应目标检查报「不存在的类」，这里不抢话
    for (const [k, v] of Object.entries(f)) {
      if (k === "$link") {
        for (const [ln, sub] of Object.entries(v as Record<string, unknown>)) {
          if (!linkResolves(clsName, ln)) throw new Error(`配置不合法：${trail} 引用了不存在的关系 ${ln}`);
          const target = config.link_types[ln]?.to ?? Object.values(config.link_types).find((l) => l.inverse === ln && l.to === clsName)?.from;
          if (target && sub && typeof sub === "object") checkFilterKeys(target, sub as Record<string, unknown>, trail);
        }
        continue;
      }
      if (k.startsWith("$")) continue;
      if (!config.object_types[clsName]?.properties[k]) throw new Error(`配置不合法：${trail} 过滤了 ${clsName} 上不存在的属性 ${k}`);
    }
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
            for (const [k, sub] of Object.entries(cond as Record<string, unknown>)) {
              if (k === "$link") {
                // $link 的关系名必须能从该类解析（正向名或反向名）
                for (const ln of Object.keys(sub as Record<string, unknown>)) {
                  if (!linkResolves(clsName, ln)) throw new Error(`配置不合法：${clsName}.${prop} 的派生规则引用了不存在的关系 ${ln}`);
                }
                continue;
              }
              if (k.startsWith("$")) throw new Error(`配置不合法：${clsName}.${prop} 的派生规则里 ${src} 的过滤不支持 ${k}`);
              if (!entry.fields[k]) throw new Error(`配置不合法：${clsName}.${prop} 的派生规则在 ${src} 上过滤未映射的属性 ${k}`);
            }
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
      for (const item of act.effect ?? []) {
        const op = "update" in item ? item.update : "delete" in item ? item.delete : null;
        if (op && "filter" in op && op.filter) checkFilterKeys(op.object, op.filter as Record<string, unknown>, `${clsName}.${actName} 的效应过滤`);
      }
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
      for (const item of act.effect ?? []) {
        const op = "update" in item ? item.update : "delete" in item ? item.delete : "create" in item ? item.create : null;
        if (!op) continue; // link：关系名由 link_types 表自身约束
        const target = config.object_types[op.object];
        if (!target) throw new Error(`配置不合法：${clsName}.${actName} 的效应指向不存在的类 ${op.object}`);
        if ("properties" in op && op.properties) {
          for (const prop of Object.keys(op.properties)) {
            if (!target.properties[prop]) throw new Error(`配置不合法：${clsName}.${actName} 的效应写了不存在的属性 ${op.object}.${prop}`);
            if (target.properties[prop].derived) throw new Error(`配置不合法：${clsName}.${actName} 的效应写了派生属性 ${op.object}.${prop}`);
          }
        }
      }
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
