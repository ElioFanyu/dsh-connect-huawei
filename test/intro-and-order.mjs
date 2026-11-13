/**
 * 锁住「顶部介绍区」与「平台顺序」。
 *
 * ## 为什么顺序需要测试
 *
 * 平台顺序在两个地方各有一份：宿主 `lib/index.mjs` 的 `PLATFORMS`（决定
 * status 里 platforms 的顺序）和客户端 `lib/client/index.js` 的
 * `PLATFORM_ORDER`（决定首帧骨架的顺序）。两份不一致会出现：
 * 骨架先画「果办/码道」，数据一到变成「码道/果办」——**位置互换**，
 * 点错的人会发现按钮跳了。这种一致性只能靠断言两个文件对齐。
 *
 * ## 为什么介绍区需要测试
 *
 * `card.desc` 只在旧插件页的标题栏里渲染。设置页的 shell 拿走了标题栏，
 * 所以那段"这是什么、怎么开始用"在设置页里**曾经完全消失**——用户进来
 * 第一眼就是两个平台开关。而且这段代码曾经真的炸过：`settingsSurface`
 * 定义在函数末尾，介绍区在中途引用它，`const` 处于暂时性死区，
 * 语法检查查不出、只有渲染才抛。所以这里既要有内容断言，也要有"能渲染"断言。
 */
import { readFileSync } from 'node:fs'

const clientSrc = readFileSync(new URL('../lib/client/index.js', import.meta.url), 'utf8')
const hostSrc = readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8')

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`)
  } else {
    failed += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : `\n     ${detail}`}`)
  }
}

// ---- 1. 两个文件的平台顺序必须一致，且码道在前 ----------------------------
const hostOrder = /export const PLATFORMS = \[([^\]]*)\]/.exec(hostSrc)
const clientOrder = /const PLATFORM_ORDER = \[([^\]]*)\]/.exec(clientSrc)

function parseList(raw) {
  return raw
    .split(',')
    .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter((part) => part !== '')
}

check('宿主声明了 PLATFORMS', hostOrder !== null)
check('客户端声明了 PLATFORM_ORDER', clientOrder !== null)

if (hostOrder !== null && clientOrder !== null) {
  const host = parseList(hostOrder[1])
  const client = parseList(clientOrder[1])
  check('平台列表含且仅含两个平台', host.length === 2 && client.length === 2, `host=${host} client=${client}`)
  check('码道排在第一（左右顺序）', host[0] === 'codearts' && client[0] === 'codearts', `host=${host} client=${client}`)
  check(
    '宿主与客户端的顺序完全一致',
    host.join(',') === client.join(','),
    `不一致会让骨架与真实数据的位置互换：host=${host.join(',')} client=${client.join(',')}`,
  )
}

// ---- 2. 客户端要给两个平台都备好显示名 ------------------------------------
const labelsBlock = /const PLATFORM_LABELS = \{([\s\S]*?)\n\s*\}/.exec(clientSrc)
check('声明了 PLATFORM_LABELS', labelsBlock !== null)
if (labelsBlock !== null) {
  const body = labelsBlock[1]
  const keys = [...body.matchAll(/(\w+):\s*'/g)].map((m) => m[1])
  check('PLATFORM_LABELS 覆盖两个平台', keys.includes('codearts') && keys.includes('officeace'), `实际: ${keys}`)
  check('码道的显示名含 CodeArts', /codearts:\s*'[^']*CodeArts/.test(body))
  check('果办的显示名含 OfficeAce', /officeace:\s*'[^']*OfficeAce/.test(body))
}

// ---- 3. 介绍区：文案齐全、位置在顶栏之上、只在设置页 ----------------------
for (const key of ['intro.title', 'intro.body', 'intro.stepSync', 'intro.note']) {
  const zh = new RegExp(`'${key.replace('.', '\\.')}':\\s*'[^']+'`).test(clientSrc)
  const en = clientSrc.split(`'${key}'`).length - 1
  check(`${key} 有中文文案`, zh)
  check(`${key} 中英两份都登记`, en >= 2, `只出现 ${en} 次，中英各需一次`)
}

check('介绍区组件存在', /className: 'dsm-hwc-intro'/.test(clientSrc))
check('介绍区有标题/正文/步骤/注解四个子块', [
  'dsm-hwc-intro-title',
  'dsm-hwc-intro-body',
  'dsm-hwc-intro-step',
  'dsm-hwc-intro-note',
].every((cls) => clientSrc.includes(cls)))

// 位置：intro 必须在 header 之前进入渲染树，否则它就跑到平台开关下面去了。
const usageBlock = /className: 'dsm-hwc-usage' \},([\s\S]{0,80})/.exec(clientSrc)
check(
  '介绍区排在顶栏之前',
  usageBlock !== null && /intro/.test(usageBlock[1]) && usageBlock[1].indexOf('intro') < usageBlock[1].indexOf('header'),
  usageBlock === null ? '没找到渲染块' : `实际顺序: ${usageBlock[1].replace(/\s+/g, ' ').trim()}`,
)

check(
  '介绍区只在设置页渲染（旧插件页已有标题栏）',
  /const intro = settingsSurface\s*\n\s*\?/.test(clientSrc),
)

// ---- 4. 关键回归：settingsSurface 必须在使用之前定义（暂时性死区）--------
const defineAt = clientSrc.indexOf('const settingsSurface = props.surface')
/** 首次引用：三元条件处可能换行，用更松的匹配。 */
const firstUseAt = clientSrc.indexOf('const intro = settingsSurface')
check(
  'settingsSurface 定义在首次使用之前',
  defineAt >= 0 && firstUseAt >= 0 && defineAt < firstUseAt,
  `定义位置 ${defineAt}，首次使用 ${firstUseAt}。定义在使用之后会让 const 处于暂时性死区，渲染时抛 ReferenceError（语法检查查不出来）`,
)
check(
  'settingsSurface 只定义一次',
  (clientSrc.match(/const settingsSurface =/g) ?? []).length === 1,
)

// ---- 5. 样式存在 ----------------------------------------------------------
check('介绍区样式已注册', /\.dsm-hwc-intro\{/.test(clientSrc))
check('介绍区标题样式已注册', /\.dsm-hwc-intro-title\{/.test(clientSrc))

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
