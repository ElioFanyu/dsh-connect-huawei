/**
 * 验证「最大上下文」显示的是**生效值**，不是目录默认值。
 *
 * 做法：直接从 lib/client/index.js 里按大括号配对抽出 `compactTokens` 和 `ModelRow`
 * 的源码原文，和假 React 一起求值。这样测的是真正发布的那段代码，而不是我另抄一份
 * 相似逻辑——抄一份的话，改了源码测试照样绿。
 *
 * 为什么需要这个测试：修复前的第 1089 行渲染的是 `model.contextWindow`（恒为 262144），
 * 用户选 1M 之后底部仍写「最大上下文 256K」。下面的第一个断言用例在修复前必然失败，
 * 所以它能抓住这个回归。
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(
  process.env.HWC_CLIENT_SRC || new URL('../lib/client/index.js', import.meta.url),
  'utf8',
)

/** 从 `head` 出现处起，按大括号配对截出一整个函数体。 */
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

const compactSrc = extractFunction('compactTokens')
const modelRowSrc = extractFunction('ModelRow')

// 假 React：把树摊平成文本，够用来断言文案。
function h(type, props, ...children) {
  if (type === undefined) return null
  const flat = children.flat(Infinity)
  if (typeof type === 'function') return type({ ...(props || {}), children: flat })
  return { type, props: props || {}, children: flat }
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

/** 复刻宿主 t()：ZH 表里没有的 key 原样返回，支持 {n} 插值。 */
const ZH = new Function(`return (${source.match(/const ZH = (\{[\s\S]*?\n    \})/)[1]})`)()
function t(key, params) {
  let text = ZH[key]
  if (typeof text !== 'string') return key
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (m, name) => (params[name] === undefined ? m : String(params[name])))
}

const factory = new Function(
  'h',
  't',
  `${compactSrc}\n${modelRowSrc}\nreturn ModelRow`,
)
const ModelRow = factory(h, t)

const model = { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 262144, maxTokens: 65536 }

function render(budget) {
  return textOf(
    ModelRow({
      model,
      on: true,
      images: true,
      onToggle: () => {},
      onToggleImage: () => {},
      onTest: () => {},
      onBudget: () => {},
      budget,
      busy: '',
      t,
    }),
  )
}

/**
 * `forbid` 只用来断言"默认档不该带后缀"。不能直接写 '默认'——单选组里本来就有
 * 一个叫「默认（256K）」的档位标签，那样断言永远失败，和被测行为无关。
 */
const cases = [
  { budget: undefined, expectContext: '最大上下文 256K', forbid: '最大上下文 256K（默认' },
  { budget: 1048576, expectContext: '最大上下文 1M（默认 256K）', forbid: null },
  { budget: 512000, expectContext: '最大上下文 500K（默认 256K）', forbid: null },
  { budget: 204800, expectContext: '最大上下文 200K（默认 256K）', forbid: null },
  { budget: 0, expectContext: '最大上下文 256K', forbid: '最大上下文 256K（默认' },
]

let failed = 0
for (const testCase of cases) {
  const out = render(testCase.budget)
  const ok = out.includes(testCase.expectContext) && (testCase.forbid === null || !out.includes(testCase.forbid))
  if (!ok) {
    failed += 1
    console.error(`FAIL budget=${testCase.budget}\n  期望包含: ${testCase.expectContext}\n  实际: ${out}`)
  } else {
    console.log(`ok   budget=${String(testCase.budget).padEnd(8)} -> ${testCase.expectContext}`)
  }
}

// 输出档位单独校验：码道 64K、果办 128K 都必须照实显示。
const codeartsOut = textOf(ModelRow({ model: { ...model, maxTokens: 65536 }, on: true, images: false, onToggle: () => {}, onToggleImage: () => {}, onTest: () => {}, onBudget: () => {}, budget: undefined, busy: '', t }))
const officeaceOut = textOf(ModelRow({ model: { ...model, maxTokens: 131072 }, on: true, images: false, onToggle: () => {}, onToggleImage: () => {}, onTest: () => {}, onBudget: () => {}, budget: undefined, busy: '', t }))
if (!codeartsOut.includes('最大输出 64K')) {
  failed += 1
  console.error(`FAIL 码道输出档位\n  实际: ${codeartsOut}`)
} else console.log('ok   码道 maxTokens=65536 -> 最大输出 64K')
if (!officeaceOut.includes('最大输出 128K')) {
  failed += 1
  console.error(`FAIL 果办输出档位\n  实际: ${officeaceOut}`)
} else console.log('ok   果办 maxTokens=131072 -> 最大输出 128K')

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
