/**
 * 模型倍率表。
 *
 * ## 为什么需要一张内置表
 *
 * 两个平台的上游目录都**不提供**倍率：
 *
 *   - 果办 `GET /models`（实测 2026-11-05）：每个模型只有
 *     `{ id, object, created, owned_by }` 四个字段，没有任何倍率/价格。
 *   - 码道 `GET /v1/model/builtin`：给出 model_id / model_name / model_desc /
 *     supports_images / enable，同样没有倍率。
 *
 * 对照 workbuddy：它的倍率来自自己上游 `/v3/config` 的 `creditMultiplier` 字段，
 * 那是 WorkBuddy 平台特有的数据，华为这两个网关没有等价字段。所以倍率只能来自
 * 华为官方文档/控制台，由人抄进这张表。
 *
 * ## 设计约束
 *
 * 1. **表里没有的模型，名字后面什么都不加**——不猜、不填 1.00、不拿别的模型顶替。
 *    一个编出来的倍率比没有倍率更糟：用户会按它做成本判断。
 * 2. 表是纯数据，改这里即可，不牵动任何逻辑。
 * 3. 倍率写成字符串原样显示，避免浮点格式化把 0.10 显示成 0.1 这类不一致。
 *
 * @module dsh-connect-huawei/rates
 */

/**
 * 每个平台的倍率表：`模型 id -> 倍率字符串`。
 *
 * 目前两个表都是空的：本机无法验证码道接口，果办接口已确认没有该字段，
 * 而上游项目文档也从未提到倍率。等拿到官方数据后填在这里即可，
 * 格式参考：
 *
 *   codearts: { 'GLM-5.2': '0.79', 'glm-5.3': '0.69' }
 *   officeace: { 'deepseek-v4.1-flash': '0.11' }
 *
 * 只填**确认过**的条目；没确认的留空，界面上就不会显示。
 */
export const RATE_TABLE = {
  codearts: {},
  officeace: {},
}

/**
 * 查一个模型的倍率。
 *
 * 返回 `undefined` 表示"不知道"——调用方据此保持原名，绝不显示占位数字。
 */
export function rateOf(platform, modelId) {
  const table = RATE_TABLE[platform]
  if (table === undefined || table === null) return undefined
  const value = table[modelId]
  if (typeof value !== 'string' || value.trim() === '') return undefined
  return value.trim()
}

/**
 * 带倍率的显示名。
 *
 * 与 workbuddy 的 `workBuddyDisplayName` 同形：`GLM-5.3 · x0.79`。
 * 没有倍率时原样返回模型名——**不加任何后缀**。
 */
export function displayNameWithRate(platform, modelId, name) {
  const base = typeof name === 'string' && name.trim() !== '' ? name : modelId
  const rate = rateOf(platform, modelId)
  return rate === undefined ? base : base + ' · x' + rate
}

/** 这张表里当前有多少条（供诊断面板显示"倍率已知 N 个"）。 */
export function rateCount(platform) {
  const table = RATE_TABLE[platform]
  return table === undefined || table === null ? 0 : Object.keys(table).length
}
