/**
 * 卡片里的偏好：模型勾选、逐模型图片输入开关、账号池开关。
 *
 * ## 为什么不用宿主 settings
 *
 * 上游项目（dsh-huawei-connect）把这些写进 settings 的 `huawei-connect` 命名空间，
 * 代价是每次改形状都要处理迁移，而且 settings 的写入在 Windows 上会因为文件占用
 * 失败（卡片上表现为"保存了但没生效"）。这三份数据都只被本插件自己读，放在
 * 插件自己的目录里最直接：一次写入、立刻生效、卸载即清。
 *
 * ## 形状
 *
 *   {
 *     version: 1,
 *     enabledModels: { codearts: string[], officeace: string[] },   // 空 = 该平台不限制
 *     imageModels:   { codearts: { [id]: boolean }, officeace: {…} }, // 覆盖上游的 supports_images
 *     poolEnabled:   string[],                                       // 出现在这里 = 该平台启用账号池
 *     poolMembers:   { codearts: string[], officeace: string[] },    // 空 = 全部账号参与轮转
 *     accountOrder:  { codearts: string[], officeace: string[] },    // 手动排序（卡片里的 ↑↓）
 *   }
 *
 * 语义与 adapter.mjs 的过滤一致：enabledModels 存的是"允许出现的模型"，不是黑名单。
 *
 * @module dsh-connect-huawei/prefs
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const PREF_PLATFORMS = ['codearts', 'officeace']

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function cleanList(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const out = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '' || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
  }
  return out
}

/** 逐模型布尔覆盖表；只保留 true/false，其余丢掉。 */
function cleanBoolMap(value) {
  const source = asRecord(value)
  const out = {}
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === 'boolean') out[key] = entry
  }
  return out
}

/** 逐模型上下文预算表；只保留正整数，其余丢掉。 */
function cleanBudgetMap(value) {
  const source = asRecord(value)
  const out = {}
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) out[key] = Math.floor(entry)
  }
  return out
}

export function emptyPrefs() {
  return {
    version: 1,
    enabledModels: { codearts: [], officeace: [] },
    imageModels: { codearts: {}, officeace: {} },
    /**
     * 逐模型的上下文预算覆盖：`模型 id -> 窗口 token 数`。
     *
     * 表里没有的模型用 `disguise.mjs` 里的保守声明值（CONTEXT_WINDOW，262144）。
     * 卡片上 200K / 500K / 1M / 默认 四档单选写的就是这里：选「默认」= 删掉这一项，
     * 之后插件调整默认窗口时这一档会跟着变，不会把旧数字固化在配置里。
     */
    contextBudgets: { codearts: {}, officeace: {} },
    poolEnabled: [],
    /**
     * 参与轮转的账号 id。
     *
     * `null` = 不限制（该平台全部账号参与）；数组 = 只有列出的这些参与，
     * **空数组 = 一个都不参与**。
     *
     * 这两种"空"必须分开：卡片上有「全选」和「全不选」两个按钮，如果空数组
     * 同时表示"不限制"，点「全不选」就会被读成"全部放开"——正好相反。
     */
    poolMembers: { codearts: null, officeace: null },
    accountOrder: { codearts: [], officeace: [] },
  }
}

/** 成员清单：null 保留，数组去重，坏值退回 null（= 不限制）。 */
function cleanMemberList(value) {
  if (value === null) return null
  if (!Array.isArray(value)) return null
  return cleanList(value)
}

/**
 * 成员清单的**读取**规则，含旧格式迁移。
 *
 * 1.0.x 里成员清单只有"数组"一种形状，空数组表示"不限制"。1.1 起改成
 * `null` = 不限制、`[]` = 一个都不参与，于是旧文件里的 `[]` 必须按**旧语义**
 * 读成 null——否则老用户升级后会突然发现账号池一个号都不选，池直接空转。
 *
 * 判断依据是文件里有没有 `poolMembersVersion` 标记：有就按新语义读，没有就是旧档。
 */
function readMemberList(value, migrated) {
  if (value === null) return null
  if (!Array.isArray(value)) return null
  const list = cleanList(value)
  // 旧档的空数组 = 不限制；新档的空数组 = 一个都不选。
  if (!migrated && list.length === 0) return null
  return list
}

/** 把任意读到的值规范成完整形状；坏字段各自退回默认，不影响其它字段。 */
export function normalizePrefs(raw) {
  const base = emptyPrefs()
  const record = asRecord(raw)
  const enabled = asRecord(record['enabledModels'])
  const images = asRecord(record['imageModels'])
  const order = asRecord(record['accountOrder'])
  const members = asRecord(record['poolMembers'])
  const budgets = asRecord(record['contextBudgets'])
  const migrated = record['poolMembersVersion'] === 2
  for (const platform of PREF_PLATFORMS) {
    base.enabledModels[platform] = cleanList(enabled[platform])
    base.imageModels[platform] = cleanBoolMap(images[platform])
    base.accountOrder[platform] = cleanList(order[platform])
    base.poolMembers[platform] = readMemberList(members[platform], migrated)
    base.contextBudgets[platform] = cleanBudgetMap(budgets[platform])
  }
  base.poolEnabled = cleanList(record['poolEnabled']).filter((entry) => PREF_PLATFORMS.includes(entry))
  return base
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 偏好档：串行读改写，避免并发保存互相覆盖。
 *
 * 与账号档案一样用"临时文件 + rename"，Windows 上直接覆写正在被读的文件会拿到
 * EPERM（杀毒/索引器持有句柄）。
 */
export class PrefsStore {
  constructor(path) {
    this.path = path
    this.value = undefined
    this.queue = Promise.resolve()
  }

  async load() {
    if (this.value !== undefined) return this.value
    this.value = normalizePrefs(await readJson(this.path))
    return this.value
  }

  current() {
    return this.value ?? emptyPrefs()
  }

  async mutate(fn) {
    const run = this.queue.then(async () => {
      if (this.value === undefined) await this.load()
      // 内存里的档已经是新语义，规范化时必须带版本标记——否则空数组会被
      // 旧档迁移规则再读成 null，「全不选」就永远写不进去。
      const draft = normalizePrefs({ ...JSON.parse(JSON.stringify(this.value)), poolMembersVersion: 2 })
      const result = await fn(draft)
      this.value = normalizePrefs({ ...draft, poolMembersVersion: 2 })
      await this.flush()
      return result
    })
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async flush() {
    const path = this.path
    const temporary = path + '.tmp-' + process.pid
    await mkdir(dirname(path), { recursive: true })
    // 落盘时带上语义版本：下次读回来就知道 `[]` 是"一个都不选"而不是旧档的"不限制"。
    const payload = { ...this.value, poolMembersVersion: 2 }
    await writeFile(temporary, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  }
}
