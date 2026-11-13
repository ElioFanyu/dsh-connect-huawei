/**
 * dsh-connect-huawei：把华为「码道 CodeArts」与「果办 OfficeAce」接进 DSH。
 *
 * 功能对照上游项目 wang111928/dsh-huawei-connect（MIT）：两条 provider 路由、
 * 账号池与自动换号、积分余量、模型勾选、官方客户端同形态的请求伪装、码道并发会话闸门。
 *
 * ## 与上游项目的关系
 *
 * 上游的 host 半边（适配器 / shim / 签名 / OAuth / 凭据发现 / 失败分类）是实测出来的
 * 协议知识，逐字保留，只改了**存储与界面契约**：
 *
 *   - 偏好（模型勾选、图片开关、账号池开关、账号顺序）从宿主 settings 挪到本插件自己的
 *     `prefs.json`：形状由本插件演进，不牵动宿主迁移逻辑，也避开 Windows 上
 *     "settings 写入被文件占用挡掉、卡片以为保存成功"的失败模式。
 *   - 积分改成**按账号**读取（卡片表格每行一个数字）。上游只读第一个账号，多账号时
 *     用户看不出"哪个号还有额度"，而账号池换号的唯一依据恰恰就是这个。
 *   - 页面样式改为 dsh-connect-workbuddy 的卡片语言（tab 栏 + 面板 tab + 表格），
 *     见 lib/client/index.js 顶部注释。
 *
 * ## 上游的真实限制（不是本插件能绕开的）
 *
 * 码道每账号 3 个并发会话、每个会话占用约 1 分钟且中途停止不减免。这里把它当成
 * 一等公民：撞上就原地排队重试（90s 预算），而不是把 400 甩给用户。
 *
 * @module dsh-connect-huawei
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { accountsPath, catalogPath, creditsPath, pluginHome, prefsPath, usagePath } from './paths.mjs'
import {
  AccountStore,
  listOfficeAceCredentialTargets,
  readCodeArtsAccounts,
  readOfficeAceAccount,
} from './store.mjs'
import {
  CODEARTS_SEED_MODELS,
  fetchCodeArtsCredits,
  fetchCodeArtsIdentity,
  fetchCodeArtsModels,
} from './codearts.mjs'
import {
  OFFICEACE_SEED_MODELS,
  fetchLocalControl,
  fetchOfficeAceModels,
  modelGatewayOf,
  parseOfficeAcePackageUsage,
  parseOfficeAceSubscription,
} from './officeace.mjs'
import { readOfficeAceSession } from './session.mjs'
import { startLogin, remainingMs } from './oauth.mjs'
import { AccountPool } from './pool.mjs'
import { createShim } from './shim.mjs'
import { createHuaweiAdapter } from './adapter.mjs'
import { describeFailure, classifyUpstreamFailure } from './disguise.mjs'
import { PrefsStore, normalizePrefs } from './prefs.mjs'
import { enabledListFor, isPlatformRecord, normalizeEnabledModels, withPlatformList } from './enabled.mjs'
import { imagesAllowedFor } from './media.mjs'
import { displayNameWithRate, rateCount } from './rates.mjs'

// 果办在前、码道在后：果办是绝大多数人的日常入口（办公），码道是编码专用。
// 顺序同时决定了卡片顶栏两格的左右位置，所以这里就是"显示顺序"的唯一来源。
export const PLATFORMS = ['officeace', 'codearts']

export const PLATFORM_DISPLAY_NAMES = {
  codearts: '码道 CodeArts',
  officeace: '果办 OfficeAce',
}

/** 卡片与 dock 读的状态接口前缀。 */
export const ROUTE_PREFIX = '/plugins/dsh-connect-huawei'

/**
 * 本地前置条件失败（不是上游拒绝）。
 *
 * 与上游失败分开，是因为两者的处置完全不同：上游失败要换号/退避/重试，而
 * "果办没开"这类问题换一百个账号也没用，唯一有用的动作是告诉用户去打开它。
 * 混在一起会被 classifyUpstreamFailure 归成 `server`，最终显示成
 * 「上游服务暂时不可用」——一句与真实原因无关、也无法照做的话。
 */
class LocalPrerequisiteError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LocalPrerequisiteError'
  }
}

/** 把异常压成一句能放进卡片的话：去掉 `Error: ` 前缀与多余空白。 */
function trimMessage(cause) {
  const text = cause instanceof Error ? cause.message : String(cause)
  return text.replace(/^Error:\s*/u, '').replace(/\s+/gu, ' ').trim().slice(0, 160)
}

/** 卡片状态轮询的预算：积分慢请求不该把整张卡拖成转圈。 */
const CREDIT_TIMEOUT_MS = 12_000
/** 模型目录刷新周期（与上游项目一致，每小时）。 */
const CATALOG_REFRESH_MS = 3_600_000

/** 一个平台的模型目录（内存态 + 落盘缓存）。 */
class ModelCatalog {
  constructor(seed, blacklist = new Set()) {
    this.models = [...seed].filter((model) => !blacklist.has(model.id ?? model.name))
    this.updatedAt = 0
    this.source = 'seed'
    this.blacklist = blacklist
  }

  current() {
    return this.models
  }

  replace(models, source) {
    if (models.length === 0) return false
    const filtered = models.filter((model) => !this.blacklist.has(model.id ?? model.name))
    if (filtered.length === 0) return false
    this.models = filtered
    this.updatedAt = Date.now()
    this.source = source
    return true
  }

  /** 记下一个实测不可用的模型 id（只在真正调用失败时走到这里，不额外消耗额度）。 */
  dropUnavailable(id) {
    if (typeof id !== 'string' || id === '') return false
    this.blacklist.add(id)
    const next = this.models.filter((model) => (model.id ?? model.name) !== id)
    if (next.length === this.models.length) return false
    this.models = next
    this.updatedAt = Date.now()
    return true
  }

  entry(id) {
    return this.models.find((model) => (model.id ?? model.name) === id)
  }

  snapshot() {
    return { models: this.models, updatedAt: this.updatedAt, source: this.source }
  }
}

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 同步读一份小 JSON：黑名单在启动路径上，异步没必要。 */
function readJsonSync(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function writeFileJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.tmp-' + process.pid
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  // 先写临时文件再 rename：Windows 上直接覆写正在被读的文件会拿到 EPERM。
  await rename(temporary, path)
}

// ---- 积分磁盘缓存：关掉桌面端 / 云端抖动时，卡片仍能显示"上次读取"的数字 ----
async function writeCreditsCache(value) {
  try {
    await writeFileJson(creditsPath(), { ...value, cachedAt: Date.now() })
  } catch {
    /* 缓存写不进去不影响读取 */
  }
}

async function readCreditsCache() {
  const cached = await readJson(creditsPath())
  if (cached === undefined) return undefined
  const byAccount = asRecord(cached['byAccount'])
  return Object.keys(byAccount).length === 0 ? undefined : byAccount
}

/** 实测不可用的模型黑名单（上游 /models 清单会反复灌回坏模型，必须持久化过滤）。 */
function modelBlacklistPath() {
  return join(pluginHome(), 'model-blacklist.json')
}

const MODEL_BLACKLIST_SEED = {
  officeace: [
    'kimi-k3-test-1009', 'kimi-k3-1019', 'glm-5.2-a3', 'glm-5.2-harmony', 'glm-5.3-flash',
    'glm-5.3-test', 'deepseek-v4-pro', 'deepseek-v4.1-flash-1017', 'deepseek-v4.1-flash-bnt',
    'glm-5.2-zx', 'glm-5.3-zx', 'glm.5.2-arkts-spark', 'openpangu-2.0-pro', 'openpangu-2.0-flash',
  ],
  codearts: [],
}

function loadModelBlacklist() {
  const raw = asRecord(readJsonSync(modelBlacklistPath()))
  const out = {}
  for (const platform of PLATFORMS) {
    const saved = Array.isArray(raw[platform]) ? raw[platform] : []
    const seed = MODEL_BLACKLIST_SEED[platform] ?? []
    out[platform] = new Set([...seed, ...saved.filter((x) => typeof x === 'string')])
  }
  return out
}

async function saveModelBlacklist(blacklists) {
  const payload = { version: 1 }
  for (const platform of PLATFORMS) payload[platform] = [...(blacklists[platform] ?? [])]
  await writeFileJson(modelBlacklistPath(), payload).catch(() => {})
}

/**
 * 本机用量账本。
 *
 * 只统计**本机经本插件发出**的请求数，不等于账号额度——码道与果办的官方额度以各自
 * 控制台为准。这样做是因为两个平台的额度接口都是账号级的、且只有积分总数，没有
 * "这次请求花了多少"的明细。
 */
class UsageLedger {
  constructor(path = usagePath()) {
    this.path = path
    this.days = {}
    this.loaded = false
    this.dirty = false
  }

  async load() {
    if (this.loaded) return
    this.loaded = true
    const raw = await readJson(this.path)
    if (raw !== undefined) this.days = asRecord(asRecord(raw)['days'])
  }

  record(platform, model) {
    const day = new Date().toISOString().slice(0, 10)
    const days = this.days
    const entry = asRecord(days[day])
    const platformEntry = asRecord(entry[platform])
    platformEntry['requests'] = (typeof platformEntry['requests'] === 'number' ? platformEntry['requests'] : 0) + 1
    platformEntry['lastModel'] = model
    platformEntry['lastAt'] = Date.now()
    entry[platform] = platformEntry
    days[day] = entry
    this.dirty = true
    return this.flush()
  }

  async flush() {
    if (!this.dirty) return
    this.dirty = false
    const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)
    for (const day of Object.keys(this.days)) {
      if (day < cutoff) delete this.days[day]
    }
    await writeFileJson(this.path, { version: 1, days: this.days }).catch(() => {})
  }

  snapshot() {
    const day = new Date().toISOString().slice(0, 10)
    const today = asRecord(this.days[day])
    return {
      today: Object.fromEntries(PLATFORMS.map((platform) => [platform, asRecord(today[platform])])),
      days: Object.keys(this.days).length,
    }
  }
}

/**
 * 插件主体。
 *
 * 装配顺序刻意是"先建 shim、再注册适配器"：适配器的 baseUrl 来自 shim 的随机端口，
 * 反过来拿不到。shim 起不来就不注册适配器——宁可让用户在卡片上看到错误，也不要
 * 注册一条所有请求都失败的 provider。
 */
export function apply(ctx) {
  const logger = ctx.logger
  const store = new AccountStore(accountsPath())
  const prefs = new PrefsStore(prefsPath())
  const pools = {}
  for (const platform of PLATFORMS) {
    pools[platform] = new AccountPool({
      platform,
      onRefreshed: async (accountId, credential) => {
        await store.saveRefreshed(platform + ':' + accountId, credential)
      },
    })
  }
  const usage = new UsageLedger()
  const modelBlacklists = loadModelBlacklist()
  const catalogs = {
    codearts: new ModelCatalog(CODEARTS_SEED_MODELS, modelBlacklists.codearts),
    officeace: new ModelCatalog(OFFICEACE_SEED_MODELS, modelBlacklists.officeace),
  }
  /** 偏好：模型勾选按平台一份（空 = 不限制），图片开关按模型，池开关按平台。 */
  let prefsValue = normalizePrefs(undefined)
  /** 正在进行的登录（每平台最多一个）与最近一次结果，供前端轮询。 */
  const activeLogins = {}
  const lastLogins = {}
  /** 每个账号的积分快照（内存），key 是 `platform:id`。 */
  const creditsByAccount = {}
  /** shim 是否已经监听成功（决定了 provider 有没有注册）。 */
  let shimStarted = false
  let shutDown = false

  function poolOn(platform) {
    return prefsValue.poolEnabled.includes(platform)
  }

  /**
   * 参与轮转的账号 id：`null` = 不限制（全部参与），数组 = 只这些参与，空数组 = 一个都不参与。
   *
   * 卡片上的勾选就是这个清单。它只影响**账号池开着**时的候选集合；单账号模式永远
   * 只挑一个号，勾不勾都不改变行为，所以卡片上那列在池关闭时是灰的。
   */
  function poolMembersFor(platform) {
    const value = prefsValue.poolMembers[platform]
    return value === undefined ? null : value
  }

  /** 池开着时按成员过滤；null（不限制）原样返回，空数组则是"一个都不选"。 */
  function rotatable(platform, rows) {
    const members = poolMembersFor(platform)
    if (members === null) return rows
    const allowed = new Set(members)
    return rows.filter((account) => allowed.has(account.id))
  }

  /**
   * 卡片轮询用的状态快照。
   *
   * 每个平台各自返回"账号 / 模型 / 积分 / 错误"，一个平台坏掉不影响另一个——这是
   * 用户同时接了两个平台时最需要的性质。
   */
  async function statusSnapshot(signal) {
    await store.load()
    await prefs.load()
    prefsValue = prefs.current()
    const accounts = store.snapshot()
    const rows = []
    for (const platform of PLATFORMS) {
      const platformAccounts = orderedAccounts(platform, accounts.filter((account) => account.platform === platform))
      const on = poolOn(platform)
      // 单账号模式也得让卡片说得出"现在在用谁"，否则用户只能靠猜。
      const active = (on ? pools[platform].rank(rotatable(platform, platformAccounts)) : pickSingle(platform, platformAccounts))[0]
      const credits = await creditsForPlatform(platform, platformAccounts, signal)
      const members = poolMembersFor(platform)
      const memberSet = members === null ? null : new Set(members)
      rows.push({
        platform,
        displayName: PLATFORM_DISPLAY_NAMES[platform],
        accounts: platformAccounts.map((account) => {
          const view = pools[platform].snapshot([account])[0] ?? {}
          return {
            id: account.id,
            label: account.label || account.userName || account.id,
            userName: account.userName,
            syncedAt: account.syncedAt,
            syncError: account.syncError,
            origin: account.origin,
            hasCredential:
              platform === 'codearts' ? account.codeArts !== undefined : account.officeAce !== undefined,
            usable: view.usable !== false,
            disabled: view.disabled === true,
            cooling: view.cooling === true,
            disabledRemainingMs: view.disabledRemainingMs ?? 0,
            cooldownRemainingMs: view.cooldownRemainingMs ?? 0,
            lastError: view.lastError ?? '',
            successes: view.successes ?? 0,
            failures: view.failures ?? 0,
            tokenRemainingMs: view.remainingMs ?? undefined,
            // 勾选状态：null（不限制）= 全部参与；否则看这个 id 在不在清单里。
            // 「全不选」时清单是空数组，这里会正确地返回 false。
            poolMember: memberSet === null ? true : memberSet.has(account.id),
            credits: credits.byAccount[platform + ':' + account.id],
          }
        }),
        models: {
          ...catalogs[platform].snapshot(),
          // 卡片上的名字要与选择器里看到的一致：倍率表里有的模型带上 ` · x0.79`，
          // 否则用户在卡片上勾一个、在选择器里却看到另一个名字，会以为是两个模型。
          models: catalogs[platform]
            .current()
            .map((model) => ({ ...model, displayName: displayNameWithRate(platform, model.id, model.name || model.id) })),
        },
        enabled: enabledListFor(prefsValue.enabledModels, platform),
        images: asRecord(prefsValue.imageModels[platform]),
        // 逐模型的上下文预算覆盖（模型 id -> token 数）。表里没有的 = 用原生窗口。
        contextBudgets: asRecord(prefsValue.contextBudgets[platform]),
        // 倍率表里已知多少条：0 表示上游不给、内置表也还没填，卡片据此说明原因。
        ratesKnown: rateCount(platform),
        // 单账号模式（false）还是账号池轮转（true），以及当前服务的是哪个号。
        poolEnabled: on,
        poolMembers: poolMembersFor(platform),
        activeAccount:
          active === undefined ? undefined : { id: active.id, label: active.label || active.userName || active.id },
        pool: pools[platform].snapshot(platformAccounts),
        ...(platform === 'codearts'
          ? { sessions: shim.sessions(platformAccounts.map((account) => account.id)) }
          : {}),
        ...(credits.error === undefined ? {} : { creditsError: credits.error }),
        ...(credits.stale === true ? { creditsStale: true } : {}),
        ...(credits.fetchedAt === undefined ? {} : { creditsFetchedAt: credits.fetchedAt }),
      })
    }
    return {
      platforms: rows,
      usage: usage.snapshot(),
      sessionLimit: { codearts: 3 },
      settingsNamespace: 'dsh-connect-huawei',
      // 本地转发层是否已经起来：卡片上要能一眼看出"provider 到底注册没注册"。
      ...(shimStarted ? { shimBaseUrl: safeShimBaseUrl() } : {}),
    }
  }

  /** shim 的 baseUrl 只在监听成功后才有；拿不到就当作没起来，不要把异常抛给卡片。 */
  function safeShimBaseUrl() {
    try {
      return shim.baseUrl()
    } catch {
      return undefined
    }
  }

  /** 卡片里的手动排序：prefs 里出现的 id 排前面，其余按同步顺序。 */
  function orderedAccounts(platform, rows) {
    const order = prefsValue.accountOrder[platform] ?? []
    if (order.length === 0) return rows
    const rank = new Map(order.map((id, index) => [id, index]))
    return [...rows].sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER
      const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER
      return ra === rb ? 0 : ra - rb
    })
  }

  /**
   * 一个平台所有账号的积分。
   *
   * 逐个账号读，一个失败不影响其它行（表格里只有那一行是"读取失败"）。任何一个账号
   * 都没读到时，退回磁盘上"上次成功读到"的快照并标记 stale——关掉桌面端也能看到数字。
   */
  async function creditsForPlatform(platform, platformAccounts, signal) {
    const byAccount = {}
    let fetchedAt
    let stale = false
    let error
    for (const account of platformAccounts) {
      const key = platform + ':' + account.id
      try {
        const value = await creditForAccount(platform, account, signal)
        byAccount[key] = value
        creditsByAccount[key] = value
        fetchedAt = Date.now()
      } catch (cause) {
        const cached = creditsByAccount[key]
        if (cached !== undefined) {
          byAccount[key] = cached
          stale = true
        } else {
          // 用 trimMessage 而不是 String(cause)：后者会带上 "Error: " 前缀，
          // 卡片上就变成「积分不可用：Error: …」，多一层噪音。
          error = trimMessage(cause)
        }
      }
    }
    if (Object.keys(byAccount).length === 0) {
      const disk = await readCreditsCache()
      if (disk !== undefined) {
        for (const account of platformAccounts) {
          const key = platform + ':' + account.id
          if (disk[key] !== undefined) {
            byAccount[key] = disk[key]
            stale = true
          }
        }
      }
    } else {
      const previous = (await readCreditsCache()) ?? {}
      void writeCreditsCache({ byAccount: { ...previous, ...byAccount } })
    }
    return {
      byAccount,
      ...(fetchedAt === undefined ? {} : { fetchedAt }),
      ...(stale ? { stale } : {}),
      ...(error === undefined ? {} : { error }),
    }
  }

  /**
   * 单个账号的积分；失败抛出，由调用方决定是报错还是沿用缓存。
   *
   * ## 为什么不用 classifyUpstreamFailure 兜住全部异常
   *
   * 那个分类器读的是**上游 HTTP 响应文案**（APIG.0301、ModelArts.81001 之类）。
   * 本地前置条件失败——果办桌面端没开、会话文件解不开、端口不通——不含任何上游
   * 文案，分类器认不出，于是落到 `server`，再被 describeFailure 翻成
   * 「上游服务暂时不可用」。用户看到的是一句和真实原因无关的话，而真实原因
   * （"去打开果办"）恰恰是他唯一能照做的动作。
   *
   * 所以这里区分两类失败：
   *   - **本地原因**：自己抛 LocalPrerequisiteError，文案原样往上传；
   *   - **上游响应**：只有真的拿到上游响应时才交给分类器翻译。
   */
  async function creditForAccount(platform, account, signal) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CREDIT_TIMEOUT_MS)
    timer.unref?.()
    signal?.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      if (platform === 'codearts') {
        const credential =
          account.oauth === undefined
            ? account.codeArts
            : await pools.codearts.ensureFresh({ id: account.id, credential: account.oauth })
        return await fetchCodeArtsCredits(credential, controller.signal)
      }
      const session = await readOfficeAceSession()
      if (session === undefined) {
        throw new LocalPrerequisiteError(
          '读不到果办本机会话。请先打开并登录果办桌面端（积分来自它本机的控制面），再回来点「测试」。',
        )
      }
      let subscription
      try {
        subscription = parseOfficeAceSubscription(
          await fetchLocalControl(session.value, '/api/subscription/current', controller.signal),
        )
      } catch (cause) {
        // 本机接口本身不可达 / 拒绝会话：这是果办那边的事，不是"上游模型服务"。
        throw new LocalPrerequisiteError(
          '果办本机接口没有回应：' + trimMessage(cause) + '。请确认果办桌面端正在运行并已登录。',
        )
      }
      if (subscription === undefined) {
        throw new LocalPrerequisiteError('果办的额度接口这次没有给出积分口径（可能该账号没有订阅），不影响对话。')
      }
      let packageUsage
      try {
        packageUsage = parseOfficeAcePackageUsage(
          await fetchLocalControl(session.value, '/api/codeagent-package/usage', controller.signal),
        )
      } catch {
        packageUsage = undefined
      }
      return { ...subscription, ...(packageUsage === undefined ? {} : { packageUsage }) }
    } catch (cause) {
      // 本地原因原样上抛；剩下的才是真·上游失败，交给分类器翻译。
      if (cause instanceof LocalPrerequisiteError) throw cause
      const failure = classifyUpstreamFailure(500, String(cause))
      throw new Error(describeFailure(failure))
    } finally {
      clearTimeout(timer)
    }
  }

  /** 登录成功后拿稳定身份。 */
  /**
   * 登录成功后拿稳定身份。
   *
   * ## 为什么不能只信 STS 的 user_id
   *
   * 华为 STS 的 OAuth2 换 token 响应**不保证**带 `user_id` / `domain_id`——
   * 实测果办那条链路只回 `credentials`（security_token / access_key_id /
   * secret_access_key / expiration）与 `refresh_token`，没有任何身份字段。
   * 早期实现直接读这两个键，于是登录成功后立刻抛
   * 「登录成功但拿不到稳定身份，请重试」——用户重试多少次都一样，因为响应
   * 永远不会变成他期望的形状。
   *
   * ## 兜底策略
   *
   * 身份的唯一用途是"同一个账号归一到同一条记录"（去重、排序、选号）。
   * 所以拿不到上游 id 时，用**凭据本身派生**一个稳定标识即可：
   *
   *   - 有 accessKeyId：用它。AK 是账号级的、每次换 token 不变。
   *   - 只有 refresh_token：用它的哈希前 16 位。refresh_token 每次续期都会换，
   *     所以只在新登录（没有既有记录）时用到，之后续期会保留原 id。
   *
   * 这不影响任何请求的正确性：请求用的是 token/AK/SK，不是这个 id。
   */
  async function resolveIdentity(platform, credential) {
    if (platform === 'codearts') {
      const fromToken = credential.userId || credential.domainId
      if (fromToken) return { id: fromToken, userName: credential.userName || fromToken }
      // 码道还有一条权威来源：/snap-manager/v1/current/user。
      const identity = await fetchCodeArtsIdentity(
        {
          accessKeyId: credential.accessKeyId,
          secretAccessKey: credential.secretAccessKey,
          securityToken: credential.securityToken,
        },
        AbortSignal.timeout(15_000),
      ).catch(() => undefined)
      const id = identity?.userId || credential.domainId || credential.userId || derivedIdentity(credential)
      if (!id) throw new Error('登录成功但拿不到稳定身份，请重试')
      return { id, userName: identity?.userName || credential.userName || id }
    }
    const id = credential.userId || credential.domainId || derivedIdentity(credential)
    if (!id) throw new Error('登录成功但拿不到稳定身份，请重试')
    return { id, userName: credential.userName || id }
  }

  /**
   * 从凭据本身派生一个稳定标识（见 resolveIdentity 的注释）。
   *
   * 优先 AK（账号级、跨续期不变）；没有 AK 才用 refresh_token 的哈希。
   * 两者都没有时返回空串，由调用方决定是否报错。
   */
  function derivedIdentity(credential) {
    if (typeof credential.accessKeyId === 'string' && credential.accessKeyId !== '') {
      return credential.accessKeyId
    }
    if (typeof credential.refreshToken === 'string' && credential.refreshToken !== '') {
      return createHash('sha256').update(credential.refreshToken).digest('hex').slice(0, 16)
    }
    return ''
  }

  /**
   * 果办登录之后要找模型网关（地址与 appKey/appSecret）。
   *
   * ## 为什么先读本机凭据
   *
   * 网关信息有两个来源，可靠性差别很大：
   *
   *   1. **本机凭据管理器**里的 providerState —— 果办桌面端登录时自己写下的，
   *      带完整的 model_api_url_base / model_app_key / model_app_secret。
   *      实测这台机器上它一直在，且**不需要桌面端正在运行**（凭据是持久化的）。
   *   2. 云端 `POST /v1/claw/client-subscription` —— 上一版只用这条，实测它对本插件
   *      换来的 token 一律回 `401 APIGW.0301 decrypt token fail`（试过带/不带
   *      X-Project-Id、x-subscription-type 四种组合，全部 401）。也就是说扫码登录
   *      在这条路径上永远拿不到网关，用户看到的就是「需重新登录」。
   *
   * 所以顺序反过来：**先读本机**，读不到才问云端。这样扫码登录在本机有桌面端
   * 登录态时能直接成功，而全新机器（本机没有 providerState）仍有一条云端兜底。
   *
   * 拿不到就把**原因**记进账号的 syncError，而不是默默返回 false——否则用户只能
   * 反复重登，永远不知道卡在哪一步。
   */
  async function refreshOfficeAceGateway(key) {
    const account = store.get(key)
    if (account === undefined) return { ok: false, reason: '账号不存在' }

    // ---- 1. 本机凭据管理器（首选）----
    try {
      const targets = await listOfficeAceCredentialTargets()
      for (const target of targets) {
        const local = await readOfficeAceAccount(target)
        if (local === undefined || local.gateway === undefined) continue
        await store.upsert({
          ...account,
          platform: 'officeace',
          id: account.id,
          officeAce: { gateway: local.gateway },
          syncError: '',
        })
        logger?.debug?.('[dsh-connect-huawei] officeace gateway from local credential store')
        return { ok: true, source: 'local' }
      }
    } catch (error) {
      logger?.debug?.('[dsh-connect-huawei] local gateway lookup failed: ' + String(error))
    }

    // ---- 2. 云端下发（兜底）----
    if (account.oauth === undefined) {
      return { ok: false, reason: '本机没有果办登录态，且这次登录没有可用的 OAuth 凭证' }
    }
    let failure = ''
    try {
      const response = await fetch('https://versatile.cn-north-4.myhuaweicloud.com/v1/claw/client-subscription', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=utf8',
          'x-auth-token': account.oauth.securityToken,
          'X-Project-Id': account.oauth.domainId ?? '',
          'x-subscription-type': 'v2',
        },
        body: '{}',
        signal: AbortSignal.timeout(20_000),
      })
      const text = await response.text()
      if (!response.ok) {
        // 原样保留上游的 error_code / error_msg：这是判断"凭证类型不对"还是
        // "没开通订阅"的唯一线索。
        failure = '模型网关接口 ' + response.status + '：' + text.slice(0, 200)
      } else {
        let body
        try {
          body = JSON.parse(text)
        } catch {
          failure = '模型网关接口返回的不是 JSON：' + text.slice(0, 160)
        }
        if (failure === '') {
          const modelInfo = body?.model_info ?? body?.subscription?.model_info
          const gateway = modelGatewayOf({ modelInfo })
          if (gateway === undefined) {
            failure = '云端没有下发模型网关（model_api_url_base / app_key / app_secret 缺失），可能该账号未开通订阅'
          } else {
            await store.upsert({ ...account, platform: 'officeace', id: account.id, officeAce: { gateway }, syncError: '' })
            return { ok: true, source: 'cloud' }
          }
        }
      }
    } catch (error) {
      failure = '模型网关接口请求失败：' + trimMessage(error)
    }
    // 把原因记到账号上，卡片与诊断面板都能看到。
    await store
      .upsert({ ...account, platform: 'officeace', id: account.id, syncError: failure.slice(0, 300) })
      .catch(() => {})
    return { ok: false, reason: failure }
  }

  /**
   * 从上游同步登录态。幂等：重复调用只是刷新同一批条目，某个平台失败不影响另一个。
   */
  async function sync() {
    const results = {}

    // ---- 码道 ----
    try {
      const found = await readCodeArtsAccounts()
      for (const entry of found) {
        const identity = await fetchCodeArtsIdentity(entry.credential).catch(() => undefined)
        const id = identity?.userId || entry.id
        // 上游客户端那份文件里**有** refresh_token 与 DPoP 私钥，本插件也能自己续期。
        // 但不能无条件用上游文件覆盖本插件自己的登录凭证（那份文件可能是已过期的旧档）。
        const existing = store.get('codearts:' + id)
        const localOAuth = existing?.oauth
        const incomingRemaining = entry.oauth === undefined ? undefined : remainingMs(entry.oauth)
        const localRemaining = localOAuth === undefined ? undefined : remainingMs(localOAuth)
        const localStillUsable = localOAuth !== undefined && localRemaining !== undefined && localRemaining > 0
        const incomingUsable = entry.oauth !== undefined && incomingRemaining !== undefined && incomingRemaining > 0
        if (localStillUsable && !(incomingUsable && (incomingRemaining ?? 0) > (localRemaining ?? 0))) {
          await store.upsert({
            platform: 'codearts',
            id,
            label: entry.label || existing?.label || '',
            userName: identity?.userName || existing?.userName || entry.userName,
            userId: id,
            syncedAt: existing?.syncedAt ?? Date.now(),
            syncError: '',
          })
        } else {
          await store.upsert({
            platform: 'codearts',
            id,
            label: entry.label || '',
            userName: identity?.userName || entry.userName,
            userId: id,
            syncedAt: Date.now(),
            syncError: '',
            codeArts: entry.credential,
            ...(entry.oauth === undefined ? {} : { oauth: entry.oauth, origin: 'import+oauth' }),
          })
        }
        // 同步时向上游认证成功过，池里可能残留的"认证失败停用"必须清掉，
        // 否则用户会一直重复"登录 → 还是 503"这个循环。
        if (identity !== undefined) pools.codearts?.enable(id)
      }
      results.codearts =
        found.length === 0
          ? { ok: false, accounts: 0, message: '没有找到码道登录态：请先用码道桌面端登录（或装 dsh-codearts 插件登录一次）' }
          : { ok: true, accounts: found.length }
    } catch (error) {
      results.codearts = { ok: false, accounts: 0, message: String(error) }
    }

    // ---- 果办 ----
    try {
      const targets = await listOfficeAceCredentialTargets()
      let count = 0
      for (const target of targets) {
        const account = await readOfficeAceAccount(target)
        if (account === undefined) continue
        count += 1
        await store.upsert({
          platform: 'officeace',
          id: account.id,
          label: account.label || '',
          userName: account.userName,
          userId: account.id,
          syncedAt: Date.now(),
          syncError: '',
          officeAce: { gateway: account.gateway },
        })
        pools.officeace?.enable(account.id)
      }
      results.officeace =
        count === 0
          ? { ok: false, accounts: 0, message: '没有找到果办登录态：请先打开果办并登录，再点同步' }
          : { ok: true, accounts: count }
    } catch (error) {
      results.officeace = { ok: false, accounts: 0, message: String(error) }
    }

    await refreshCatalogs().catch(() => {})
    return results
  }

  /** 刷新两个平台的模型目录。任一失败保留旧目录（不要让选择器空掉）。 */
  async function refreshCatalogs() {
    await store.load()
    const accounts = store.snapshot()

    const codeArtsAccount = accounts.find((account) => account.platform === 'codearts')
    if (codeArtsAccount !== undefined) {
      try {
        const models = await fetchCodeArtsModels(codeArtsAccount.codeArts, AbortSignal.timeout(20_000))
        if (catalogs.codearts.replace(models, 'upstream')) {
          logger?.debug?.('[dsh-connect-huawei] codearts catalog: ' + models.length + ' models')
        }
      } catch (error) {
        logger?.debug?.('[dsh-connect-huawei] codearts catalog refresh failed: ' + String(error))
      }
    }

    const officeAceAccount = accounts.find((account) => account.platform === 'officeace')
    if (officeAceAccount !== undefined) {
      try {
        const models = await fetchOfficeAceModels(officeAceAccount.officeAce.gateway, AbortSignal.timeout(20_000))
        if (catalogs.officeace.replace(models, 'upstream')) {
          logger?.debug?.('[dsh-connect-huawei] officeace catalog: ' + models.length + ' models')
        }
      } catch (error) {
        logger?.debug?.('[dsh-connect-huawei] officeace catalog refresh failed: ' + String(error))
      }
    }

    await writeFileJson(catalogPath(), {
      version: 1,
      codearts: catalogs.codearts.snapshot(),
      officeace: catalogs.officeace.snapshot(),
    }).catch(() => {})
    return { codearts: catalogs.codearts.current().length, officeace: catalogs.officeace.current().length }
  }

  /** 从落盘缓存恢复上次的模型目录（冷启动先有东西可选）。 */
  async function restoreCatalogs() {
    const cached = await readJson(catalogPath())
    if (cached === undefined) return
    for (const platform of PLATFORMS) {
      const entry = asRecord(asRecord(cached)[platform])
      const models = entry['models']
      if (Array.isArray(models) && models.length > 0) {
        catalogs[platform].replace(models, 'cache')
        catalogs[platform].updatedAt = typeof entry['updatedAt'] === 'number' ? entry['updatedAt'] : 0
      }
    }
  }

  /**
   * 这个平台现在为什么没有可用账号——把池里的停用 / 冷却状态摊开说。
   *
   * 不区分的话，"账号被停用"和"从来没配过账号"在用户眼里是同一个 503。
   */
  function explainUnavailable(platform) {
    const rows = store.list(platform)
    if (rows.length === 0) {
      return '这个平台还没有配置任何账号：请在卡片里登录，或点「同步登录态」从上游客户端读一份。'
    }
    const parts = []
    for (const account of rows) {
      const view = pools[platform].snapshot([account])[0]
      const who = account.label || account.userName || account.id
      if (account.platform === 'codearts' && account.codeArts === undefined) {
        parts.push(who + ' 没有可用的凭证（codeArts 缺失）')
        continue
      }
      if (account.platform === 'officeace' && account.officeAce === undefined) {
        parts.push(who + ' 没有可用的凭证（officeAce 缺失）')
        continue
      }
      if (view.disabled) {
        parts.push(
          who + ' 已被停用，还剩 ' + Math.ceil(view.disabledRemainingMs / 60000) + ' 分钟' +
            (view.lastError === '' ? '' : '（上游最后报：' + view.lastError + '）'),
        )
        continue
      }
      if (view.cooling) {
        parts.push(who + ' 正在冷却，还剩 ' + Math.ceil(view.cooldownRemainingMs / 1000) + ' 秒')
        continue
      }
      parts.push(who + ' 凭证已过期且续期失败')
    }
    return parts.join('；') + '。点「同步登录态」或重新登录即可解除停用。'
  }

  /**
   * 单账号模式交给 shim 的那**一个**账号。
   *
   * 与池的关键区别是"健康标记只用来挑，不用来删"：优先挑一个健康的，一个健康的都没有
   * 就退回到第一个有凭证的号。因此单账号模式**永远不会**出现"候选为空"的 503。
   */
  function pickSingle(platform, rows) {
    const withCredential = rows.filter((account) =>
      platform === 'codearts' ? account.codeArts !== undefined : account.officeAce !== undefined,
    )
    if (withCredential.length === 0) return []
    const [healthy] = pools[platform].rank(withCredential)
    return [healthy ?? withCredential[0]]
  }

  /**
   * 用户为某个模型选的上下文预算（token 数）。
   *
   * 返回 `undefined` 表示"没选过"，适配器据此用模型原生窗口。
   * 选「原生」这一档时 prefs 里**不写这一项**，而不是写一个恰好等于窗口的数字——
   * 这样上游日后调大窗口，这一档会跟着变大，不会把用户钉死在旧值上。
   */
  function contextBudgetFor(platform, modelId) {
    const value = asRecord(prefsValue.contextBudgets[platform])[modelId]
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
  }

  /**
   * 某个模型现在吃不吃图：用户覆盖优先，其次上游目录。
   *
   * shim 与卡片必须读**同一个**判定（见 media.mjs 的注释），所以这里只暴露一个函数。
   */
  function modelAcceptsImages(platform, modelId) {
    const entry = catalogs[platform]?.entry(modelId)
    const override = asRecord(prefsValue.imageModels[platform])[modelId]
    return imagesAllowedFor(entry, override)
  }

  const shim = createShim({
    accounts: (platform) => {
      // 顺序用卡片里的手动顺序：池开着时它就是回退顺序，用户排了不生效等于没排。
      const rows = orderedAccounts(platform, store.list(platform))
      const candidates = poolOn(platform) ? pools[platform].rank(rotatable(platform, rows)) : pickSingle(platform, rows)
      if (platform === 'codearts') {
        return candidates
          .filter((account) => account.codeArts !== undefined)
          .map((account) => ({ id: account.id, credential: account.codeArts }))
      }
      return candidates
        .filter((account) => account.officeAce !== undefined)
        .map((account) => ({ id: account.id, gateway: account.officeAce.gateway }))
    },
    explainUnavailable,
    onAccountFailure: (platform, accountId, kind, message, model) => {
      // 模型级失败（403 无权限 / 404 不存在）：把这个模型从目录里剔除，而不是惩罚账号。
      if (kind === 'model_unavailable') {
        if (model !== undefined && catalogs[platform]?.dropUnavailable(model)) {
          logger?.debug?.('[dsh-connect-huawei] drop unavailable model: ' + platform + '/' + model)
          void saveModelBlacklist(modelBlacklists)
          void writeFileJson(catalogPath(), {
            version: 1,
            codearts: catalogs.codearts.snapshot(),
            officeace: catalogs.officeace.snapshot(),
          }).catch(() => {})
        }
        return
      }
      pools[platform]?.noteFailure(accountId, kind, message)
    },
    onAccountSuccess: (platform, accountId) => {
      pools[platform]?.noteSuccess(accountId)
    },
    refreshAccount: async (platform, accountId) => {
      const account = store.get(platform + ':' + accountId)
      if (account === undefined) return undefined
      if (platform === 'codearts') {
        if (account.oauth === undefined) return account.codeArts
        const fresh = await pools[platform].ensureFresh({ id: account.id, credential: account.oauth })
        return { accessKeyId: fresh.accessKeyId, secretAccessKey: fresh.secretAccessKey, securityToken: fresh.securityToken }
      }
      // 果办的模型网关用 appKey/appSecret，不随 OAuth token 过期，无需续期。
      return account.officeAce?.gateway
    },
    logger,
    supportsImages: (platform, modelId) => modelAcceptsImages(platform, modelId),
    onUsage: (platform, model) => {
      void usage.record(platform, model)
    },
  })

  let releases = []

  ctx.effect(() => () => {
    shutDown = true
    for (const release of releases) {
      try {
        release()
      } catch {
        /* ignore */
      }
    }
    releases = []
    void shim.close()
  })

  shim.ready
    .then(async () => {
      if (shutDown) return
      shimStarted = true
      await restoreCatalogs()
      await store.load()
      await prefs.load()
      prefsValue = prefs.current()

      for (const platform of PLATFORMS) {
        const built = createHuaweiAdapter({
          platform,
          displayName: PLATFORM_DISPLAY_NAMES[platform],
          catalog: catalogs[platform],
          shim,
          /**
           * 图片输入所需的两个宿主服务（DSH 0.2.x 起是硬需求）。
           *
           * `PiAiAdapter` 收到带图消息时会调 `resolveAttachments()`；拿不到
           * 就抛 `UNSUPPORTED_CONTENT`——不是丢图降级，是整条请求失败。
           * 这里传 lazy 取值器而不是服务本身：`ctx.attachments` 的可用时机
           * 由 fiber 装配顺序决定，可能在适配器构造之后才就绪。
           * 用 `ctx.get()` 而不是硬注入，避免宿主没挂这个服务时整个 provider
           * 起不来——那种情况下图片会报错，但文本对话仍然可用。
           */
          attachments: { current: () => ctx.get('attachments') },
          fs: { current: () => ctx.get('fs') },
          enabledModels: () => enabledListFor(prefsValue.enabledModels, platform),
          acceptsImages: (modelId) => modelAcceptsImages(platform, modelId),
          // 用户为这个模型选的上下文预算；没选过则 undefined（用原生窗口）。
          contextBudget: (modelId) => contextBudgetFor(platform, modelId),
          // 没有可用账号时不往选择器里列模型（见 adapter.mjs 的注释）。
          // 判据是"有凭证"，不是"账号条目存在"：同步过来的账号可能缺凭证。
          hasAccount: () =>
            store
              .list(platform)
              .some((account) =>
                platform === 'codearts' ? account.codeArts !== undefined : account.officeAce !== undefined,
              ),
        })
        try {
          const releaseAdapter = ctx.llm.registerAdapter([platform], built.adapter)
          const releaseDirectory = ctx.llm.registerConfigurableProviders([
            {
              provider: platform,
              displayName: PLATFORM_DISPLAY_NAMES[platform],
              settingsNs: 'dsh-connect-huawei',
              settingsPath: [],
              declared: false,
            },
          ])
          releases.push(releaseAdapter, releaseDirectory)
        } catch (error) {
          logger?.error?.('[dsh-connect-huawei] cannot register ' + platform + ' provider: ' + String(error))
        }
      }

      // 启动时同步一次，并且每小时刷新一次模型目录。
      void sync().catch((error) => logger?.debug?.('[dsh-connect-huawei] initial sync failed: ' + String(error)))
      const timer = setInterval(() => void refreshCatalogs().catch(() => {}), CATALOG_REFRESH_MS)
      timer.unref?.()
      ctx.effect(() => () => clearInterval(timer))
    })
    .catch((error) => {
      logger?.error?.('[dsh-connect-huawei] shim failed to start; providers not registered: ' + String(error))
    })

  // ---- web 状态接口（卡片与 dock 用） ----
  ctx.inject(['webServer'], (webCtx) => {
    const routes = []
    const register = (path, handler) => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path,
        // 每个 handler 都先过回环校验：这些接口能读积分、动账号、起登录流程。
        handler: (request, response) => (loopbackOnly(request, response) ? handler(request, response) : undefined),
      })
      routes.push(dispose)
    }

    register(ROUTE_PREFIX + '/status', async (request, response) => {
      try {
        writeResponseJson(response, 200, await statusSnapshot())
      } catch (error) {
        writeResponseJson(response, 500, { error: String(error) })
      }
    })

    // 客户端自检上报：把卡片/dock 的执行情况写盘，排查"积分条不显示"。
    register(ROUTE_PREFIX + '/client-diag', async (request, response) => {
      try {
        const body = JSON.parse((await readBodyOf(request)).toString('utf8') || '{}')
        const path = join(pluginHome(), 'client-diag.json')
        await mkdir(dirname(path), { recursive: true }).catch(() => {})
        const previous = (await readJson(path)) ?? { events: [] }
        const events = Array.isArray(previous.events) ? previous.events : []
        events.push({ at: Date.now(), ...body })
        await writeFile(path, JSON.stringify({ events: events.slice(-200) }, null, 2), 'utf8')
        writeResponseJson(response, 200, { ok: true })
      } catch (error) {
        writeResponseJson(response, 500, { error: String(error) })
      }
    })

    register(ROUTE_PREFIX + '/sync', async (request, response) => {
      try {
        const result = await sync()
        writeResponseJson(response, 200, { ...result, status: await statusSnapshot() })
      } catch (error) {
        writeResponseJson(response, 500, { error: String(error) })
      }
    })

    register(ROUTE_PREFIX + '/refresh-models', async (request, response) => {
      try {
        const counts = await refreshCatalogs()
        writeResponseJson(response, 200, { ...counts, status: await statusSnapshot() })
      } catch (error) {
        writeResponseJson(response, 500, { error: String(error) })
      }
    })

    register(ROUTE_PREFIX + '/login', async (request, response) => {
      if (request.method !== 'POST') {
        writeResponseJson(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse((await readBodyOf(request)).toString('utf8'))
        const platform = String(body['platform'] ?? '')
        if (!PLATFORMS.includes(platform)) {
          writeResponseJson(response, 400, { error: 'unknown platform: ' + platform })
          return
        }
        if (activeLogins[platform] !== undefined) {
          writeResponseJson(response, 409, { error: '该平台已有登录在进行中', authorizeUrl: activeLogins[platform].authorizeUrl })
          return
        }

        const session = startLogin(platform)
        const authorizeUrl = await session.authorizeUrl
        activeLogins[platform] = { session, authorizeUrl, startedAt: Date.now() }

        session.promise
          .then(async (credential) => {
            const identity = await resolveIdentity(platform, credential)
            const key = platform + ':' + identity.id
            await store.upsert({
              platform,
              id: identity.id,
              userName: identity.userName || identity.id,
              userId: identity.id,
              label: '',
              syncedAt: Date.now(),
              syncError: '',
              origin: 'login',
              oauth: credential,
              ...(platform === 'codearts'
                ? {
                    codeArts: {
                      accessKeyId: credential.accessKeyId,
                      secretAccessKey: credential.secretAccessKey,
                      securityToken: credential.securityToken,
                      userId: identity.id,
                      userName: identity.userName,
                      expiresAt: credential.expiration || undefined,
                    },
                  }
                : {}),
            })
            pools[platform]?.enable(identity.id)
            // 果办还差一步：拿到模型网关才算真正可用（网关带 appKey/appSecret，
            // 没有它连一次推理都发不出去）。网关失败时登录本身仍算成功——凭证已存好，
            // 但要如实把原因报给卡片，而不是让用户面对一句"需重新登录"。
            let gatewayFailure
            if (platform === 'officeace') {
              const gateway = await refreshOfficeAceGateway(key)
              if (gateway.ok !== true) {
                gatewayFailure = gateway.reason ?? '未知原因'
                // 拿不到网关的账号是**不可用**的：它既不能推理，也不该在池里占位。
                // 删掉这条记录，避免卡片上多出一个永远「需重新登录」的僵尸账号。
                // 用户的凭证没有被丢弃——需要时重新扫码即可，本机凭据也仍在原处。
                await store.remove(key).catch(() => {})
                logger?.debug?.('[dsh-connect-huawei] officeace login left no usable gateway: ' + gatewayFailure)
              }
            }
            lastLogins[platform] = {
              ok: gatewayFailure === undefined,
              at: Date.now(),
              accountId: identity.id,
              ...(gatewayFailure === undefined
                ? {}
                : { message: '登录已通过，但取不到模型网关：' + gatewayFailure }),
            }
            await refreshCatalogs().catch(() => {})
          })
          .catch((error) => {
            lastLogins[platform] = { ok: false, at: Date.now(), message: String(error).slice(0, 300) }
          })
          .finally(() => {
            delete activeLogins[platform]
            session.close()
          })

        writeResponseJson(response, 200, { authorizeUrl, platform })
      } catch (error) {
        writeResponseJson(response, 500, { error: String(error) })
      }
    })

    register(ROUTE_PREFIX + '/login/status', async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const platform = url.searchParams.get('platform') ?? ''
      if (!PLATFORMS.includes(platform)) {
        writeResponseJson(response, 400, { error: 'unknown platform: ' + platform })
        return
      }
      const pending = activeLogins[platform]
      const last = lastLogins[platform]
      writeResponseJson(response, 200, {
        pending: pending !== undefined,
        ...(pending === undefined ? {} : { authorizeUrl: pending.authorizeUrl }),
        ...(last === undefined ? {} : { last }),
      })
    })

    register(ROUTE_PREFIX + '/accounts', async (request, response) => {
      if (request.method !== 'DELETE') {
        writeResponseJson(response, 405, { error: 'method not allowed' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://localhost')
      const platform = url.searchParams.get('platform') ?? ''
      const id = url.searchParams.get('id') ?? ''
      if (!PLATFORMS.includes(platform) || id === '') {
        writeResponseJson(response, 400, { error: 'platform and id are required' })
        return
      }
      await store.remove(platform + ':' + id)
      delete creditsByAccount[platform + ':' + id]
      writeResponseJson(response, 200, { removed: true, status: await statusSnapshot() })
    })

    /**
     * 模型勾选清单，按平台一份。
     *
     * POST 接受三种体：
     *   { enabled: { codearts: [...], officeace: [...] } }  —— 卡片保存整份记录（切栏不丢改动）
     *   { platform, enabled: [...] }                       —— 只改一个平台
     *   { enabled: [...] }                                 —— 旧形状：按目录归属拆到各平台
     */
    register(ROUTE_PREFIX + '/enabled-models', async (request, response) => {
      if (request.method === 'GET') {
        await prefs.load()
        writeResponseJson(response, 200, { enabled: prefs.current().enabledModels })
        return
      }
      if (request.method !== 'POST') {
        writeResponseJson(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse((await readBodyOf(request)).toString('utf8'))
        const platform = typeof body['platform'] === 'string' ? body['platform'] : ''
        await prefs.mutate((draft) => {
          if (isPlatformRecord(body['enabled'])) {
            draft.enabledModels = normalizeEnabledModels(body['enabled'], undefined)
          } else if (PLATFORMS.includes(platform)) {
            draft.enabledModels = withPlatformList(draft.enabledModels, platform, body['enabled'])
          } else if (Array.isArray(body['enabled'])) {
            // 旧形状（没有 platform 的扁平数组）：按"这个 id 属于哪个平台"拆开。
            draft.enabledModels = normalizeEnabledModels(body['enabled'], {
              codearts: catalogs.codearts.current().map((model) => model.id),
              officeace: catalogs.officeace.current().map((model) => model.id),
            })
          } else {
            throw new Error('enabled is required')
          }
        })
        prefsValue = prefs.current()
        writeResponseJson(response, 200, { enabled: prefsValue.enabledModels, status: await statusSnapshot() })
      } catch (error) {
        writeResponseJson(response, 400, { error: String(error) })
      }
    })

    /** 逐模型图片输入开关。改完立刻生效（shim 每次请求都读 prefs）。 */
    register(ROUTE_PREFIX + '/images', async (request, response) => {
      if (request.method !== 'POST') {
        writeResponseJson(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse((await readBodyOf(request)).toString('utf8'))
        const platform = typeof body['platform'] === 'string' ? body['platform'] : ''
        if (!PLATFORMS.includes(platform)) {
          writeResponseJson(response, 400, { error: 'platform must be one of ' + PLATFORMS.join(', ') })
          return
        }
        const modelId = typeof body['model'] === 'string' ? body['model'] : ''
        const enabled = body['enabled'] === true
        await prefs.mutate((draft) => {
          if (modelId === '') {
            // 整栏重置：清掉该平台所有覆盖，回到上游目录的说法。
            draft.imageModels[platform] = {}
            return
          }
          draft.imageModels[platform][modelId] = enabled
        })
        prefsValue = prefs.current()
        writeResponseJson(response, 200, { images: prefsValue.imageModels[platform], status: await statusSnapshot() })
      } catch (error) {
        writeResponseJson(response, 400, { error: String(error) })
      }
    })

    /**
     * 逐模型的上下文预算。
     *
     * 请求体：`{ platform, model, budget }`，`budget: null` 表示"用原生窗口"
     * （即删掉这一项，而不是写一个数字）。
     *
     * 这个值直接决定 DSH 何时压缩对话：声明得越小，宿主越早压缩。
     */
    register(ROUTE_PREFIX + '/context-budget', async (request, response) => {
      if (request.method !== 'POST') {
        writeResponseJson(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse((await readBodyOf(request)).toString('utf8'))
        const platform = typeof body['platform'] === 'string' ? body['platform'] : ''
        if (!PLATFORMS.includes(platform)) {
          writeResponseJson(response, 400, { error: 'platform must be one of ' + PLATFORMS.join(', ') })
          return
        }
        const modelId = typeof body['model'] === 'string' ? body['model'] : ''
        if (modelId === '') {
          writeResponseJson(response, 400, { error: 'model is required' })
          return
        }
        const raw = body['budget']
        const budget =
          raw === null || raw === undefined
            ? null
            : typeof raw === 'number' && Number.isFinite(raw) && raw > 0
              ? Math.floor(raw)
              : undefined
        if (budget === undefined) {
          writeResponseJson(response, 400, { error: 'budget must be a positive number or null' })
          return
        }
        await prefs.mutate((draft) => {
          if (budget === null) delete draft.contextBudgets[platform][modelId]
          else draft.contextBudgets[platform][modelId] = budget
        })
        prefsValue = prefs.current()
        writeResponseJson(response, 200, {
          contextBudgets: prefsValue.contextBudgets[platform],
          status: await statusSnapshot(),
        })
      } catch (error) {
        writeResponseJson(response, 400, { error: String(error) })
      }
    })

    /**
     * 账号池开关。默认关闭 = 单账号模式。
     *
     * 单独一条路由：这是刻意的"显式启用"，因为它会改变选号策略
     * （多个账号之间轮转 + 按健康度剔除候选），而不是一个纯展示选项。
     */
    register(ROUTE_PREFIX + '/pool', async (request, response) => {
      if (request.method === 'GET') {
        await prefs.load()
        writeResponseJson(response, 200, { poolEnabled: prefs.current().poolEnabled })
        return
      }
      if (request.method !== 'POST') {
        writeResponseJson(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse((await readBodyOf(request)).toString('utf8'))
        const platform = typeof body['platform'] === 'string' ? body['platform'] : ''
        if (!PLATFORMS.includes(platform)) {
          writeResponseJson(response, 400, { error: 'platform must be one of ' + PLATFORMS.join(', ') })
          return
        }
        const want = body['enabled'] === true
        await prefs.mutate((draft) => {
          draft.poolEnabled = want
            ? PLATFORMS.filter((entry) => entry === platform || draft.poolEnabled.includes(entry))
            : draft.poolEnabled.filter((entry) => entry !== platform)
        })
        prefsValue = prefs.current()
        writeResponseJson(response, 200, { poolEnabled: prefsValue.poolEnabled, status: await statusSnapshot() })
      } catch (error) {
        writeResponseJson(response, 400, { error: String(error) })
      }
    })

    /**
     * 探测一个账号是否真的还能用。
     *
     * 走**积分接口**而不是聊天接口：积分接口同样要过鉴权（码道的 AK/SK 签名、果办的
     * 本机会话），能返回数字就证明凭证是活的，而它不消耗对话额度。用聊天接口做探测
     * 会让一次"点一下试试"变成一次真实的计费请求。
     */
    register(ROUTE_PREFIX + '/probe', async (request, response) => {
      if (request.method !== 'POST') {
        writeResponseJson(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse((await readBodyOf(request)).toString('utf8'))
        const platform = typeof body['platform'] === 'string' ? body['platform'] : ''
        const id = typeof body['id'] === 'string' ? body['id'] : ''
        if (!PLATFORMS.includes(platform) || id === '') {
          writeResponseJson(response, 400, { error: 'platform and id are required' })
          return
        }
        await store.load()
        const account = store.get(platform + ':' + id)
        if (account === undefined) {
          writeResponseJson(response, 404, { error: 'no such account: ' + platform + ':' + id })
          return
        }
        try {
          const credits = await creditForAccount(platform, account)
          creditsByAccount[platform + ':' + id] = credits
          pools[platform]?.enable(id)
          writeResponseJson(response, 200, { ok: true, credits, status: await statusSnapshot() })
        } catch (error) {
          // 探测失败不改账号状态：失败可能只是桌面端没开（果办）或网络抖动。
          // 卡片要显示的是"这次探测说了什么"，而不是替用户决定把号停掉。
          writeResponseJson(response, 200, { ok: false, message: trimMessage(error) })
        }
      } catch (error) {
        writeResponseJson(response, 400, { error: String(error) })
      }
    })

    /** 账号池的成员清单（卡片里那一列勾选）。空清单 = 全部账号参与轮转。 */
    register(ROUTE_PREFIX + '/pool-members', async (request, response) => {
      if (request.method !== 'POST') {
        writeResponseJson(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse((await readBodyOf(request)).toString('utf8'))
        const platform = typeof body['platform'] === 'string' ? body['platform'] : ''
        if (!PLATFORMS.includes(platform)) {
          writeResponseJson(response, 400, { error: 'platform must be one of ' + PLATFORMS.join(', ') })
          return
        }
        // members: null = 不限制（全部参与）；数组 = 只有这些参与；[] = 一个都不参与。
        const rawMembers = body['members']
        const members =
          rawMembers === null
            ? null
            : Array.isArray(rawMembers)
              ? rawMembers.filter((entry) => typeof entry === 'string')
              : null
        await prefs.mutate((draft) => {
          draft.poolMembers[platform] = members
        })
        prefsValue = prefs.current()
        writeResponseJson(response, 200, { members: prefsValue.poolMembers[platform], status: await statusSnapshot() })
      } catch (error) {
        writeResponseJson(response, 400, { error: String(error) })
      }
    })

    /** 账号手动排序（卡片里的 ↑↓）。池开着时顺序就是回退顺序。 */
    register(ROUTE_PREFIX + '/account-order', async (request, response) => {
      if (request.method !== 'POST') {
        writeResponseJson(response, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = JSON.parse((await readBodyOf(request)).toString('utf8'))
        const platform = typeof body['platform'] === 'string' ? body['platform'] : ''
        if (!PLATFORMS.includes(platform)) {
          writeResponseJson(response, 400, { error: 'platform must be one of ' + PLATFORMS.join(', ') })
          return
        }
        const order = Array.isArray(body['order']) ? body['order'].filter((entry) => typeof entry === 'string') : []
        await prefs.mutate((draft) => {
          draft.accountOrder[platform] = order
        })
        prefsValue = prefs.current()
        writeResponseJson(response, 200, { order: prefsValue.accountOrder[platform], status: await statusSnapshot() })
      } catch (error) {
        writeResponseJson(response, 400, { error: String(error) })
      }
    })

    ctx.effect(() => () => {
      for (const dispose of routes) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    })
  })
}

/** 一次 HTTP JSON 响应。名字与文件写入器分开，避免把响应对象当路径传进去。 */
function writeResponseJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  response.end(payload)
}

/**
 * 只服务本机。
 *
 * 这些接口会**读积分、动账号、起登录流程**，而 DSH 的 web 服务默认只绑回环——
 * 但"默认"不是保证（用户可以用 `--host` 暴露出去）。所以自己判一次：
 * Host 头必须指向回环地址，带了 Origin 就必须是回环 Origin。
 *
 * 浏览器发起的跨站请求一定带 Origin；不带 Origin 的只可能是本机进程或非浏览器客户端，
 * 而它们本来就能直接读本机的账号文件，挡不挡都无所谓。
 */
function loopbackOnly(request, response) {
  const host = String(request.headers.host ?? '')
  const hostname = host.replace(/:\d+$/u, '').toLowerCase()
  const hostOk = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
  if (!hostOk) {
    writeResponseJson(response, 403, { error: 'host-not-trusted' })
    return false
  }
  const origin = request.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    let originHost = ''
    try {
      originHost = new URL(origin).hostname.toLowerCase()
    } catch {
      originHost = ''
    }
    const originOk = originHost === '127.0.0.1' || originHost === 'localhost' || originHost === '::1'
    if (!originOk) {
      writeResponseJson(response, 403, { error: 'origin-not-trusted' })
      return false
    }
  }
  return true
}

function readBodyOf(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

/** DSH 依赖注入：需要 llm 服务；webServer 是可选增强（卡片用）。 */
export const inject = ['llm']
export const name = 'dsh-connect-huawei'
