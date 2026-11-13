/**
 * DSH 适配器：把 shim 暴露成 pi-ai 认得的 provider 路由。
 *
 * ## 这里有两个必须钉死的 compat 开关，否则会被上游拒绝
 *
 * pi-ai 在把 DSH 的消息翻译成 OpenAI 请求时，会按 \`model.compat\` 选择行为。默认值
 * 对**通用 OpenAI 端点**是合理的，对华为这两个端点则会产生上游不接受的请求：
 *
 * ### 1. \`supportsDeveloperRole: false\` —— 不设就必定被拒
 *
 * \`instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system"\`
 *
 * 非标准端点检测给出 \`supportsDeveloperRole: true\`，于是一个**带推理**的模型会让
 * pi-ai 把 system 提示词发成 \`role: "developer"\`。码道的实测反应是
 * \`InferHub.001001044.400 Message role cannot empty\` —— 整轮直接失败，而且这不是
 * 偶发：凡是带 system 提示词的请求都会中（DSH 每一轮都带）。
 *
 * 所以这里显式关掉。\`system\` 两个平台都接受（实测），这才是它们认的形状。
 *
 * ### 2. \`reasoning\` 如实声明 —— 影响思考内容能否透传
 *
 * pi-ai 只在 \`model.reasoning\` 为真时，才把 \`delta.reasoning_content\` 收进
 * thinking 块并回放成 \`assistant.reasoning_content\`。声明成 false 的后果是：思考
 * 过程被静默丢弃，多轮工具调用时上游拿不到它自己上一轮的推理，回答质量下降。
 *
 * 两个平台**都**会发 \`reasoning_content\`（实测），所以这里统一声明为 true，并把
 * 可选档位限制在它们真认的 \`low\`/\`high\`（其余档位置 null，pi-ai 会把 null 当
 * "不支持"从而不下发该字段）。
 *
 * 注意 \`reasoning: true\` 不会主动打开思考——上游本来就一直思考。它只控制 DSH
 * 怎么**读**与怎么**回放**。
 *
 * @module dsh-huawei-connect/adapter
 */
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import * as dshLlm from '@deepseek-ai/dsh-llm'
import { CONTEXT_WINDOW, MAX_CONTEXT_CEILING } from './disguise.mjs'
import { displayNameWithRate } from './rates.mjs'

/** 订阅/额度制，无法给出每 token 价格；报 0 比编一个数字诚实。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** 空闲上限。华为的免费推理后端偶尔吐几个 token 后长时间静默，90s 让重试更早接管。 */
export const HUAWEI_STREAM_IDLE_TIMEOUT_MS = 90_000

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}

/** 两个平台都认 system 角色、都不认 developer（实测）。 */
const COMPAT = {
  supportsDeveloperRole: false,
  supportsMidConvoSystemMessages: false,
  supportsReasoningEffort: false,
  requiresAssistantAfterToolResult: false,
  requiresReasoningContentOnAssistantMessages: false,
}

/**
 * pi-ai 的凭证平面在这里是空转的：真正的鉴权由 shim 完成，适配器只需要一个能通过
 * shim 校验的 bearer。
 */
const INERT_AUTH = {
  credentials: {
    async read() {
      return undefined
    },
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-huawei-connect has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {
      return undefined
    },
    async fileExists() {
      return false
    },
  },
}

/**
 * 一个平台模型的元数据形状（与 codearts.mjs / officeace.mjs 返回的一致）。
 *
 * `budget` 是用户为这个模型选的上下文预算（token 数）；`undefined` 表示用默认窗口。
 * 这个值直接决定 DSH 何时压缩对话：声明得越小，宿主越早压缩。
 *
 * ## 关于"原生窗口"
 *
 * 上游**不提供**上下文窗口：果办的 `/models` 只回 id/object/created/owned_by，
 * 码道的 `/v1/model/builtin` 也没有该字段（两处都实测过）。所以目录里的
 * `contextWindow` 是 `disguise.mjs` 里我们自己选的保守声明值 262144。
 *
 * 这意味着两件事：
 *   1. 它不是"物理上限"，不该拿它去否决用户选的更大档位；
 *   2. 用户选 1M 是合理的诉求（上游实测约 60 万 token 仍 200，只是大输入更慢），
 *      拦下来等于用一个实现细节限制他。
 *
 * 所以这里**不按 native 夹取**，只保证：正数、整数、不超过一个明确的天花板
 * （MAX_CONTEXT_CEILING，远高于实测可用值，纯粹防手滑）。
 */
function toPiModel(platform, model, shimBaseUrl, acceptsImages, budget) {
  const fallback =
    Number.isInteger(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : CONTEXT_WINDOW
  const contextWindow =
    typeof budget === 'number' && Number.isFinite(budget) && budget > 0
      ? Math.min(Math.floor(budget), MAX_CONTEXT_CEILING)
      : fallback
  // 图片能力以「用户覆盖 > 上游目录」的判定为准，与 shim 剥离图片时用的是同一个函数。
  // 两边读不同的来源会出现"选择器说能传图、请求里图被剥掉"这种查不出来的怪象。
  const images = acceptsImages === undefined ? model.supportsImages === true : acceptsImages(model.id)
  return {
    id: model.id,
    // 倍率内嵌进显示名（与 workbuddy 的 `GLM-5.3 · x0.79` 同形）。倍率表里没有的
    // 模型保持原名——不猜、不填占位数字，见 rates.mjs 的说明。
    name: displayNameWithRate(platform, model.id, model.name || model.id),
    api: 'openai-completions',
    provider: platform,
    baseUrl: shimBaseUrl + '/' + platform + '/v1',
    input: images ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    // 如实声明：两个平台都发 reasoning_content，声明 false 会让思考内容被丢弃。
    reasoning: true,
    thinkingLevelMap: { off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: null },
    contextWindow,
    maxTokens: model.maxTokens,
    compat: COMPAT,
  }
}

/**
 * 一个平台的适配器。
 *
 * catalog 是实时的：模型清单会在后台刷新，getModels() 每次都读最新值，所以用户在
 * 卡片里勾选/取消之后不必重启 DSH。
 *
 * ## 没有账号就不列出模型
 *
 * `hasAccount()` 为假时 buildModels 返回**空列表**。理由是"列出来只会点到就失败"：
 * 码道没登录时，选择器里仍挂着 GLM-5.2、Qwen3-VL-235B 等 8 个模型，用户点进去、
 * 打字、发送，才拿到 503 unconfigured。模型出现在选择器里就是"可选"的承诺，
 * 而这个承诺此刻兑现不了。
 *
 * provider 本身**始终注册**——卡片正是登录入口，撤销注册会让用户再也点不到它。
 * 只是目录为空，选择器里这一栏自然不显示模型。
 */
export function createHuaweiAdapter(options) {
  const {
    platform,
    displayName,
    catalog,
    shim,
    enabledModels,
    acceptsImages,
    hasAccount,
    contextBudget,
    /**
     * 宿主 `attachments` 服务。DSH 0.2.x 起 `PiAiAdapter` **必须**能拿到它，
     * 否则任何带图片的请求在转换阶段就抛
     * `pi-ai image input requires the durable attachment service`。
     *
     * 之前的版本里图片由适配器自己从消息里取，所以没有这个字段也没事；
     * 现在缺它 = 图片功能整体失效（不是降级，是直接报错）。
     * 因此这里是 lazy 读取：拿不到时返回 undefined，让上层给出可读错误，
     * 而不是在构造期就炸掉整个 provider。
     */
    attachments,
    /** 宿主 `fs` 服务，用于把依附件的宿主路径映射成进程可读路径。 */
    fs,
  } = options

  const buildModels = () => {
    // 没有可用账号：不列出任何模型（见上面的注释）。
    if (hasAccount !== undefined && hasAccount() !== true) return []
    const baseUrl = shim.baseUrl()
    const allowed = enabledModels === undefined ? undefined : new Set(enabledModels())
    return catalog
      .current()
      .filter((model) => allowed === undefined || allowed.size === 0 || allowed.has(model.id))
      .map((model) => toPiModel(platform, model, baseUrl, acceptsImages, contextBudget?.(model.id)))
  }

  const provider = {
    ...createProvider({
      id: platform,
      name: displayName,
      auth: {
        apiKey: {
          name: displayName + ' shim',
          async resolve({ credential }) {
            const apiKey = credential?.key
            return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: displayName }
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  }

  const profile = {
    provider: platform,
    displayName,
    streamIdleTimeoutMs: HUAWEI_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: dshLlm.resolveRetryPolicy(undefined, 'dsh-huawei-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  const inner = new PiAiAdapter({
    profiles: () => new Map([[platform, profile]]),
    auth: INERT_AUTH,
    resolveApiKey: async () => shim.token(),
    /**
     * 耐用附件服务（DSH 0.2.x 的图片输入前置条件）。
     *
     * `PiAiAdapter` 的逻辑是：消息里有图 → 调 `resolveAttachments()`；
     * 拿不到就抛 `UNSUPPORTED_CONTENT`，**不会**退化成"把图丢掉继续发"。
     * 所以这里必须真的把服务交出去。
     *
     * 用函数而非常量：`attachments` 是注入进来的服务对象，可能比适配器构造
     * 更晚就绪（宿主按 fiber 顺序装配）。每次调用时再读，能自动跟上。
     */
    resolveAttachments: () => attachments?.current?.(),
    /**
     * 把依附件的宿主路径映射成当前进程可读的路径。
     *
     * `fs` 缺失时传 undefined——`resolveImageAttachmentAccess` 会返回
     * undefined，调用方据此按"不可直接读"处理（走 base64 内联路径），
     * 而不是拿到一个错路径去 open。
     */
    resolveImageAccess: (attachmentsService, ref) =>
      dshLlm.resolveImageAttachmentAccess?.(attachmentsService, (hostPath) => fs?.current?.()?.processPathFromHostPath?.(hostPath), ref),
  })

  /**
   * 宿主读模型列表走的是适配器的 `listModels`，而 PiAiAdapter 的默认实现读的是
   * **provider 创建时冻结的那份 models 数组**——它不调用 `getModels()`。
   *
   * 后果：卡片里勾选的模型过滤（以及"没有账号就不列模型"）在选择器里完全不生效。
   * 用户勾了 3 个，选择器照样列出全部 13 个；这与卡片显示的数字直接矛盾。
   * （dsh-connect-volcengine 在同一位置显式包了 listModels，所以它没有这个问题。）
   *
   * 所以这里把 `listModels` 覆盖成每次实时算一遍 `buildModels()`。
   * 其余方法原样委托——它们与目录过滤无关。
   */
  const adapter = {
    providerInfo: (p) => inner.providerInfo(p),
    providerRetryPolicy: (p) => inner.providerRetryPolicy(p),
    imageRequestPricing: (p, m) => inner.imageRequestPricing(p, m),
    imageRequestTarget: (p, m, image) => inner.imageRequestTarget(p, m, image),
    listModels: async () => buildModels().map(toLlmModelInfo),
    resolveModel: (p, m, s) => inner.resolveModel(p, m, s),
    prepareCall: (p, m, s) => inner.prepareCall(p, m, s),
    stream: (options) => inner.stream(options),
  }

  return { adapter, provider }
}

/**
 * 把 pi 形态的模型对象收成宿主认的 `LlmModelInfo`。
 *
 * 只保留宿主真正会读的字段；`input` 数组转成 `inputModalities`，因为那是
 * `LlmModelInfo` 的字段名（两者在 pi-ai 与 dsh-llm 里叫法不同）。
 */
function toLlmModelInfo(model) {
  const modalities = Array.isArray(model.input) ? model.input : ['text']
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    ...(model.description === undefined ? {} : { description: model.description }),
    inputModalities: modalities,
  }
}
