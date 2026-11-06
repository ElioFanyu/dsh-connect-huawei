/**
 * 验证设置页（surface: 'settings'）下的外壳形态。
 *
 * 背景：DSH 0.2.x 把配置从 `plugins.bundle.config`（插件页里的一个 keyed 槽位）
 * 迁到了 `settings.section`（设置面板的一整页）。后者由 shell 提供标题栏、关闭
 * 按钮和滚动容器，所以卡片必须**自弃外壳**——否则页面上会出现两个标题、两个
 * 折叠箭头，而且 `<li>` 在设置页的 DOM 里是非法结构。
 *
 * 这个测试从源码里抽真函数渲染，改源码它就跟着变，不会自己骗自己。
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client/index.js', import.meta.url), 'utf8')

function extractFunction(name) {
  const head = `function ${name}(`
  const start = source.indexOf(head)
  if (start < 0) throw new Error(`找不到 ${head}`)
  const bodyStart = source.indexOf('{', source.indexOf(')', start))
  let depth = 0
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`${name} 大括号不配对`)
}

const ZH = new Function(`return (${source.match(/const ZH = (\{[\s\S]*?\n    \})/)[1]})`)()
function t(key, params) {
  let text = ZH[key]
  if (typeof text !== 'string') return key
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (m, name) => (params[name] === undefined ? m : String(params[name])))
}

// ---- 极简 hook 运行时：让 HuaweiCard 能真的跑起来 -------------------------
let cursor = 0
const values = []
function useState(initial) {
  const i = cursor++
  if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial
  return [values[i], (next) => {
    values[i] = typeof next === 'function' ? next(values[i]) : next
  }]
}
const noopRef = { current: true }
const useRef = () => noopRef
const useCallback = (fn) => fn
const useEffect = () => {}
const useMemo = (fn) => fn()

function h(type, props, ...children) {
  if (type === undefined) return null
  const flat = children.flat(Infinity)
  if (typeof type === 'function') {
    cursor = 0
    return type({ ...(props || {}), children: flat })
  }
  return { type, props: props || {}, children: flat }
}

/** 收集整棵树里的标签名，用来断言结构。 */
function tags(node, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) tags(child, out)
    return out
  }
  if (typeof node !== 'object') return out
  out.push(node.type)
  tags(node.children, out)
  return out
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

// HuaweiCard 依赖一批同文件的辅助组件与常量，按需注入桩件。
const factory = new Function(
  'h',
  't',
  'useState',
  'useRef',
  'useCallback',
  'useEffect',
  'useMemo',
  'fetch',
  'setInterval',
  'clearInterval',
  'ROUTE',
  'CARD_ICON',
  'BusyOverlay',
  'AccountRow',
  'ModelRow',
  'RegionCell',
  'DiagRow',
  'composerHelper',
  `${extractFunction('HuaweiCard')}
   return HuaweiCard`,
)

const Stub = () => null
const HuaweiCard = factory(
  h, t, useState, useRef, useCallback, useEffect, useMemo,
  async () => ({ ok: false, status: 599, json: async () => ({}) }),
  () => 0, () => {}, '/x', 'data:,', Stub, Stub, Stub, Stub, Stub, {},
)

function render(surface) {
  values.length = 0
  return HuaweiCard({ t, ...(surface === undefined ? {} : { surface }) })
}

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`)
  } else {
    failed += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : `\n     ${detail}`}`)
  }
}

// ---- 设置页形态 ----
const settingsTree = render('settings')
const settingsTags = tags(settingsTree)
const settingsText = textOf(settingsTree)

check('settings 模式根节点是 div（不是 li）', settingsTree.type === 'div', `实际: ${settingsTree.type}`)
check('settings 模式不出现 <li>', !settingsTags.includes('li'))
check(
  'settings 模式不渲染自己的标题栏',
  !settingsTags.includes('button') || !settingsText.includes(t('card.desc')),
  `标题描述出现在: ${settingsText.includes(t('card.desc'))}`,
)
check('settings 模式不含折叠箭头', !JSON.stringify(settingsTree).includes('dsm-hwc-card-chevron'))
check('settings 模式带 surface-settings 标记', String(settingsTree.props.className || '').includes('card-surface-settings'))
check('settings 模式仍然渲染内容', settingsText.length > 0)

// ---- 旧插件页形态（回归保护：别把老宿主弄坏） ----
const legacyTree = render(undefined)
const legacyTags = tags(legacyTree)
check('旧模式根节点仍是 li', legacyTree.type === 'li', `实际: ${legacyTree.type}`)
check('旧模式仍渲染折叠标题栏', legacyTags.includes('button'))
check('旧模式仍有标题文案', textOf(legacyTree).includes(t('card.title')))

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
