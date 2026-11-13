/**
 * 锁住 DSH 0.2.x 的图片输入契约。
 *
 * ## 这个测试要挡的是什么
 *
 * `@deepseek-ai/dsh-llm-pi-ai` 从 0.2.x 起改了图片输入的前置条件：适配器收到
 * 带图消息时会调 `config.resolveAttachments()`，**拿不到就抛**
 * `UNSUPPORTED_CONTENT`（"pi-ai image input requires the durable attachment
 * service"）。它不是"把图丢掉继续发"，而是整条请求直接失败。
 *
 * 我们这张插件在旧版是能发图的，所以升级到 0.2.x 后如果没补这两个回调，
 * 就会变成一个**只在用户发图时才暴露**的故障——文本对话全部正常，
 * 图片全部报错。这种"半残"最难被自测发现，所以单独立一个测试。
 *
 * ## 为什么要读宿主源码而不是断言我们自己的代码
 *
 * 断言"我们传了 resolveAttachments"只能证明我们写了那一行，不能证明宿主要求
 * 它。下面第一组检查直接读安装目录里的 `dsh-llm-pi-ai` 源码，确认这个契约
 * 仍然存在；如果将来宿主把它改成可选，这组检查会失效并提醒我们放宽。
 */
import { readFileSync, openSync, readSync, closeSync, existsSync } from 'node:fs'

const ASAR = 'D:/Dev Tools/DeepSeek Harness/resources/app.asar'

/** 从 asar 归档里按路径取出文本；归档不可用时返回 null。 */
function asarRead(path) {
  if (!existsSync(ASAR)) return null
  let fd
  try {
    fd = openSync(ASAR, 'r')
    const b16 = Buffer.alloc(16)
    readSync(fd, b16, 0, 16, 0)
    const hdrSize = b16.readUInt32LE(12)
    const hdr = Buffer.alloc(hdrSize)
    readSync(fd, hdr, 0, hdrSize, 16)
    const index = JSON.parse(hdr.toString('utf8').replace(/\u0000+$/, ''))
    let node = index
    for (const part of path.split('/')) {
      if (!node.files || !node.files[part]) return null
      node = node.files[part]
    }
    if (!node.size) return null
    const buf = Buffer.alloc(node.size)
    readSync(fd, buf, 0, node.size, 16 + hdrSize + Number(node.offset))
    return buf.toString('utf8')
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const adapterSrc = readFileSync(new URL('../lib/adapter.mjs', import.meta.url), 'utf8')
const indexSrc = readFileSync(new URL('../lib/index.mjs', import.meta.url), 'utf8')

let failed = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`)
  } else {
    failed += 1
    console.error(`FAIL ${label}${detail === undefined ? '' : `\n     ${detail}`}`)
  }
}

// ---- 第一组：宿主契约是否仍在（读安装目录，不是读我们的代码）---------------
const hostAdapter = asarRead('dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js')

if (hostAdapter === null) {
  console.log('skip 读不到宿主源码（非 Desktop 安装或 asar 布局变化），跳过契约核对')
} else {
  check(
    '宿主仍要求 resolveAttachments（拿不到就抛 UNSUPPORTED_CONTENT）',
    /resolveAttachments\?\.\(\)/.test(hostAdapter) &&
      /image input requires the durable attachment service/.test(hostAdapter),
    '宿主源码里没找到该调用或错误文案；可能契约已变，请复核后再决定是否仍需本测试',
  )
  check(
    '宿主仍通过 config.resolveImageAccess 解析图片路径',
    /this\.config\.resolveImageAccess\?\.\(attachments, ref\)/.test(hostAdapter),
  )
  check(
    '宿主仍在 profiles() 里读 piProvider',
    /profile\.piProvider !== void 0/.test(hostAdapter),
  )
}

// ---- 第二组：我们确实把两个回调交给了适配器 --------------------------------
check(
  '适配器传了 resolveAttachments',
  /resolveAttachments:\s*\(\)\s*=>/.test(adapterSrc),
)
check(
  '适配器传了 resolveImageAccess',
  /resolveImageAccess:\s*\(/.test(adapterSrc),
)
check(
  'resolveImageAccess 使用了宿主的 resolveImageAttachmentAccess',
  /dshLlm\.resolveImageAttachmentAccess\??\.?\(/.test(adapterSrc) &&
    /import \* as dshLlm from '@deepseek-ai\/dsh-llm'/.test(adapterSrc),
  '需要从 @deepseek-ai/dsh-llm 导入该函数，自己拼路径会漏掉未映射的附件',
)
check(
  '两个回调都是惰性读取而非构造期快照',
  /attachments\?\.current\?\.\(\)/.test(adapterSrc) && /fs\?\.current\?\.\(\)/.test(adapterSrc),
  '宿主服务可能晚于适配器就绪，构造期取值会永久拿到 undefined',
)

// ---- 第三组：调用方真的把服务传进来了 --------------------------------------
check(
  'index.mjs 传入 attachments 取值器',
  /attachments:\s*\{\s*current:/.test(indexSrc),
)
check(
  'index.mjs 传入 fs 取值器',
  /fs:\s*\{\s*current:/.test(indexSrc),
)
check(
  '取值器用 ctx.get() 而不是硬注入',
  /ctx\.get\('attachments'\)/.test(indexSrc),
  '硬注入会让宿主未挂该服务时整个 provider 起不来',
)

// ---- 第四组：profile 仍带齐 pi-ai 需要的图片预算 ---------------------------
check(
  'profile 覆盖了图片预算字段',
  /maxRequestImageBytes/.test(adapterSrc) &&
    /requestImagePixelBudget/.test(adapterSrc) &&
    /requestImageMaxBytes/.test(adapterSrc),
)

if (failed > 0) {
  console.error(`\n${failed} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
