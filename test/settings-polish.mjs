/**
 * 锁住三件事：导航短名、设置页无外框、分段渲染（先骨架后数据）。
 *
 * ## 为什么每一条都值得一个测试
 *
 * 1. **导航短名**。「接入使用华为双平台」在设置面板左侧那栏会被截成
 *    「接入使用华为双...」。这是纯文案问题，代码审查看不出来，只能靠比例判断——
 *    所以锁一个短名常量，谁改回去就红。
 *
 * 2. **设置页无外框**。设置页的 shell 已经给了边框，卡片再画一圈就是双框。
 *    这条**曾经是坏的**：`.dsm-hwc-card` 在 CARD_CSS 里有两条重复定义，
 *    后一条把 `.dsm-hwc-card-surface-settings{border:0}` 盖掉了（同特异性、
 *    靠后者胜）。光看源码"我写了 border:0"是查不出来的，必须做层叠模拟。
 *
 * 3. **分段渲染**。数据没到时四个面板原本返回 `null`，首帧是一片空白，
 *    内容到达时页面突然长高。现在改成渲染骨架。测试要同时确认：
 *    骨架真的出现、且**不再**是 null。
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client/index.js', import.meta.url), 'utf8')

const CARD_CSS = source.match(/const CARD_CSS = `([\s\S]*?)`\n/)[1]

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`)
  } else {
    failed += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : `\n     ${detail}`}`)
  }
}

// ---- 1. 导航短名 ----------------------------------------------------------
const zhShort = /'nav\.panel': '([^']+)'/.exec(source)
check('中文导航名存在', zhShort !== null)
check(
  '中文导航名足够短（不被设置导航截断）',
  zhShort !== null && [...zhShort[1]].length <= 6,
  zhShort === null ? '' : `当前 "${zhShort[1]}" 共 ${[...zhShort[1]].length} 字，建议 <=6`,
)
check('导航注册用的是 nav.panel 而不是长标题', /label: \(\) => bind\('nav\.panel'\)/.test(source))
check('卡片内仍保留完整长标题', /'card\.title': '接入使用华为双平台'/.test(source))

// ---- 2. 设置页无外框：真的做一次层叠模拟 --------------------------------
/**
 * 极简特异性：id*100 + class*10 + element。
 * 这里只用得上 class 计数，但保留完整算法以便以后加选择器时不用改。
 */
function specificity(selector) {
  const id = (selector.match(/#/g) ?? []).length
  const cls = (selector.match(/\.[a-zA-Z_-]/g) ?? []).length
  const el = (selector.match(/(^|[\s>+~])[a-zA-Z]/g) ?? []).length
  return id * 100 + cls * 10 + el
}

const stripped = CARD_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
const rules = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m, index) => ({
  selector: m[1].trim(),
  body: m[2],
  index,
}))

/** 模拟一个 class 列表最终生效的某个属性值。 */
function resolve(classes, property, selectors) {
  let winner = null
  for (const rule of rules) {
    /**
     * 按**完整选择器文本**匹配，而不是"包含这些 class 就算命中"。
     *
     * 原因：`.a.b .c` 这种后代选择器不是"一个元素同时有 a、b、c 三个 class"，
     * 朴素匹配会把它当成三 class 元素，特异性算成 30（真实是 20 + 后代），
     * 于是错误的规则胜出。这里要求调用方把想测的选择器写全。
     */
    const matched = rule.selector.split(',').some((part) => selectors.includes(part.trim()))
    if (!matched) continue
    if (!new RegExp('(^|;)\\s*' + property + '\\s*:').test(rule.body)) continue
    const spec = specificity(rule.selector)
    if (winner === null || spec > winner.spec || (spec === winner.spec && rule.index > winner.index)) {
      winner = { ...rule, spec }
    }
  }
  if (winner === null) return undefined
  const value = new RegExp('(?:^|;)\\s*' + property + '\\s*:\\s*([^;]+)').exec(winner.body)
  return { value: value === null ? undefined : value[1].trim(), selector: winner.selector }
}

const border = resolve(['dsm-hwc-card', 'dsm-hwc-card-surface-settings'], 'border', ['.dsm-hwc-card', '.dsm-hwc-card.dsm-hwc-card-surface-settings'])
check(
  '设置页卡片最终 border 为 0（无外框）',
  border !== undefined && border.value === '0',
  border === undefined ? '没找到任何 border 声明' : `胜出规则 ${border.selector} => border: ${border.value}`,
)

const bodyBorder = resolve(['dsm-hwc-card-body', 'dsm-hwc-card-body-flat'], 'border-top', ['.dsm-hwc-card-body', '.dsm-hwc-card.dsm-hwc-card-surface-settings .dsm-hwc-card-body-flat'])
check(
  '设置页卡片主体无上边框',
  bodyBorder !== undefined && bodyBorder.value === '0',
  bodyBorder === undefined ? '没找到' : `胜出 ${bodyBorder.selector} => ${bodyBorder.value}`,
)

// 反面保护：非设置页的卡片必须保留边框，否则插件页里那张卡会"消失"。
const plainBorder = resolve(['dsm-hwc-card'], 'border', ['.dsm-hwc-card'])
check(
  '非设置页卡片仍有边框（插件页形态不受影响）',
  plainBorder !== undefined && plainBorder.value !== '0' && plainBorder.value !== undefined,
  plainBorder === undefined ? '没找到 border' : `border: ${plainBorder.value}`,
)

// 重复定义检查：`.dsm-hwc-card` 出现两次会让"后者胜"埋掉前面的特例。
const cardSelectorCount = rules.filter((r) => r.selector === '.dsm-hwc-card').length
check(
  'CARD_CSS 里 .dsm-hwc-card 只有一条定义（避免覆盖特例）',
  cardSelectorCount <= 1,
  `发现 ${cardSelectorCount} 条，后一条会盖掉 .dsm-hwc-card-surface-settings 的 border:0`,
)

// 选择器卫生：同一个 class 在同**一个复合选择器**里重复出现（如 `.a.a.b`）通常是
// 批量替换的残留。注意不能整体去重比较——`.a+.a` 是合法的相邻兄弟选择器，
// `.a .a` 是合法的后代选择器，两者都会让"整串 class 去重"误报。
const duplicatedClass = rules.find((rule) =>
  rule.selector.split(',').some((part) => {
    // 按组合符切开，只看每个"单一元素"内部的 class 是否重复。
    const compounds = part.split(/[\s>+~]+/).filter(Boolean)
    return compounds.some((compound) => {
      const tokens = (compound.match(/\.[a-zA-Z0-9_-]+/g) ?? []).map((t) => t.slice(1))
      return tokens.length > 1 && new Set(tokens).size !== tokens.length
    })
  }),
)
check(
  '选择器里没有重复的 class 片段',
  duplicatedClass === undefined,
  duplicatedClass === undefined ? '' : `出现在: ${duplicatedClass.selector}`,
)

// ---- 3. 分段渲染 ----------------------------------------------------------
check('存在面板骨架组件', /function PanelSkeleton\(/.test(source))
check('骨架注册了样式类', /\.dsm-hwc-skeleton\{/.test(source))

// 四个面板都不能再在无数据时返回裸 null。
const nullFallbacks = [...source.matchAll(/(accounts|models|caps|diag)Panel =\s*\n\s*active === undefined\s*\n\s*\? ([^:\n]+)/g)]
check('四个面板都有无数据分支', nullFallbacks.length === 4, `只找到 ${nullFallbacks.length} 个`)
check(
  '无数据分支渲染骨架而不是 null',
  nullFallbacks.length === 4 && nullFallbacks.every((m) => m[2].includes('PanelSkeleton')),
  nullFallbacks.map((m) => `${m[1]}: ${m[2].trim()}`).join(' | '),
)

check(
  '顶栏在无数据时也用静态平台清单画骨架',
  /skeletonRows/.test(source) && /PLATFORM_ORDER\.map/.test(source),
)
check(
  '无数据时仍默认选中第一个平台（否则四栏都空）',
  /platforms\[0\]\.platform : PLATFORM_ORDER\[0\]/.test(source),
)
check('客户端持有静态平台顺序', /const PLATFORM_ORDER = \['officeace', 'codearts'\]/.test(source))
check(
  '顶栏格子支持 pending 态',
  /pending: row\.pending === true/.test(source) && /dsm-hwc-tab-cell-pending/.test(CARD_CSS),
)
check(
  'pending 时账号池开关禁用（背后没有真实状态）',
  /disabled: pending === true \|\| busy !== ''/.test(source),
)
check(
  '骨架尊重「减少动态效果」',
  /prefers-reduced-motion:reduce/.test(stripped),
)

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
