/**
 * 逐模型的「能不能看图」与「上下文预算」覆盖表。
 *
 * 上游给的 `supports_images` 是权威标记，但它有两个已知问题：
 *
 *   1. 码道把两个真能出图的多模态模型标成 `display_enabled=false`（Qwen3-VL-235B、
 *      kimi-k2.6-vl），而果办的 /models 只给 id、根本不给能力字段——两边都会让用户
 *      "明明能看图，卡片上却没有开关"。
 *   2. 反过来，某些纯文本模型被按 id 正则误判成多模态（`vl` 出现在名字里却只吃文本）。
 *
 * 所以卡片里给每个模型一个**用户可改的开关**，默认值取上游目录，用户改过的值存在
 * prefs 里并优先于目录。shim 在发请求前读同一份判定，把图片剥离或放行——两边必须
 * 是同一个函数，否则卡片说"能看图"而请求里图被剥掉，用户永远查不出原因。
 *
 * @module dsh-connect-huawei/media
 */

/** 按目录条目 + 用户覆盖算出"这个模型吃不吃图"。 */
export function imagesAllowedFor(entry, override) {
  if (typeof override === 'boolean') return override
  return entry?.supportsImages === true
}

/**
 * 一个模型在卡片上显示的图片能力来源，用于给用户解释"为什么默认是开的/关的"。
 *
 *   upstream   上游目录明确声明
 *   override   用户在卡片里改过
 *   heuristic  上游没给，按 id/描述推断（果办的情况）
 */
export function imageSourceFor(entry, override) {
  if (typeof override === 'boolean') return 'override'
  if (entry?.supportsImagesDeclared === true) return 'upstream'
  return entry?.supportsImages === true ? 'heuristic' : 'heuristic'
}

/** 上游没给能力字段时的保守推断：只认明确的多模态标记。 */
export function inferImages(id, description) {
  const haystack = String(id ?? '') + ' ' + String(description ?? '')
  return /(?:^|[^a-z])(?:vl|vision|multimodal)(?:[^a-z]|$)/iu.test(haystack) || /多模态|视觉/iu.test(haystack)
}

/**
 * 上下文预算的可选档位。
 *
 * 这些只是"卡片上能选什么"，真正的约束在 disguise.mjs 的 CONTEXT_WINDOW 注释里：
 * 声明值必须比 `maxTokens + headroom` 明显大，否则宿主的压缩器会抛
 * TargetPressureConfigError，压缩彻底失效。
 *
 * 默认取 262144（256k）—— 上游实测能吃到约 60 万 token，256k 留了一倍余量。
 */
export const CONTEXT_PRESETS = [131072, 262144, 524288, 1048576]

/** 把用户选的档位夹进可选集合；非法值返回默认值。 */
export function normalizeContextWindow(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return CONTEXT_PRESETS.includes(value) ? value : fallback
}
