/**
 * dsh-connect-huawei 浏览器半边：设置卡片 + 输入框积分胶囊。
 *
 * ## 页面结构（沿用 dsh-connect-workbuddy 的卡片语言）
 *
 *   [ 码道 CodeArts ⏻ ] [ 果办 OfficeAce ⏻ ]     ← 顶栏：两个供应商各一格，右侧开关 = 账号池
 *   账号 | 模型 | 能力 | 诊断                     ← 面板 tab
 *
 * 为什么照抄这套结构而不是自己设计：
 *
 *   1. 用户很可能两个连接器插件都装着。顶栏两格 + 面板 tab 这套骨架已经在那台机器上
 *      出现过，肌肉记忆是有效的；换一套骨架只会让"同一件事在两个插件里长得不一样"。
 *   2. 顶栏的格子本身就是"供应商切换 + 该供应商的账号池开关"的载体——workbuddy 用它
 *      表示区域启用，这里表示账号池启用。位置一样、含义同层（这一栏的整体行为），
 *      不需要在卡片里再造一个开关。
 *   3. 面板 tab 把"账号 / 模型 / 能力 / 诊断"分开，是因为这四件事的**更新频率**不同：
 *      账号几乎不变、模型偶尔变、能力（图片开关、并发槽）随时变、诊断只在出问题时看。
 *      挤在一列里滚动，等于让最常看的那条被最少看的那条推走。
 *
 * 与 workbuddy 的差异（都是华为这两条链路的真实约束，不是风格偏好）：
 *
 *   - **积分按账号读**：workbuddy 每个区域一份积分；华为是每个账号一份，而账号池换号
 *     的依据就是"谁还有额度"，所以积分必须落在表格的账号行上。
 *   - **并发槽**：码道每账号 3 个并发会话、每个占用约 1 分钟。表格里单开一列把它画出来，
 *     用户看到"3 个都占着"就能理解刚才为什么要等。
 *   - **图片开关逐模型**：两个平台都会把真能出图的多模态模型标成不可用或干脆不给字段，
 *     所以开关必须能覆盖上游的说法。
 *
 * 只依赖槽位、主题 token 与 locale——不导入任何 Harness Client 包。
 *
 * @module dsh-connect-huawei/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-connect-huawei',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** 宿主侧路由前缀（与 lib/index.mjs 的 ROUTE_PREFIX 一致）。 */
    const ROUTE = '/plugins/dsh-connect-huawei'

/**
 * 设置面板里这一页的 id。
 *
 * 这个字符串是**我们自己拥有**的，不与插件管理器清单里的包名做任何比对——
 * 见 apply() 里 settings.section 注册处的说明。它同时是导航图标的地址，
 * 因为 shell 用 `{ only: row.id }` 渲染 `settings.section.icon`。
 * 跨部署必须保持不变，所以取裸包名而不是某个 Loader entry id。
 */
const SETTINGS_SECTION_ID = 'dsh-connect-huawei'
    /** 卡片 CSS 的 id：两个连接器插件各插一份，靠这个属性区分。 */
    const CSS_ID = 'dsh-connect-huawei/client.css'

    // ---- 文案 ----
    const ZH = {
      'card.title': '接入使用华为双平台',
      'card.desc': '码道 CodeArts 与果办 OfficeAce 的模型一起接进 DSH：按账号读积分、逐模型勾选与图片开关、账号池自动换号，码道并发会话单独计数。',
      'card.expand': '展开',
      'card.collapse': '收起',
      'tab.switchPool': '该平台启用账号池',

      'panel.accounts': '账号',
      'panel.models': '模型',
      'panel.caps': '能力',
      'panel.diag': '诊断',

      'pool.title': '账号池',
      'pool.enabled': '账号池已启用',
      'pool.disabled': '单账号模式',
      'pool.hint': '默认只用一个账号、不做轮转。启用后才会在多个账号之间按健康度挑号——配了两个以上账号才值得开。',
      'pool.enabledHint': '开启：由账号池为每次请求挑号；只有可换号的失败才换下一个——请求本身不合法、模型不存在、转发层拒收这三类不换（换号只会为同一个拒绝白烧一次配额）。关闭：你选的账号服务每一次请求，失败如实报错。',
      'pool.current': '当前使用：{account}',
      'pool.currentBadge': '当前使用',
      'pool.toggle': '启用账号池',
      'pool.toggleHint': '关闭时只用你选中的那一个账号服务每一次请求',
      'pool.modeAuto': '自动挑号',
      'pool.modeManual': '单账号',
      'pool.membersTitle': '本池包含的账号',
      'pool.membersHint': '只有勾选的账号参与轮换与测试。',
      'pool.selectAllHint': '清空成员限制 = 该平台的每个账号都参与轮转',
      'pool.selectNone': '全不选',
      'pool.selectNoneHint': '一个都不参与轮转（仍然保留在表格里）',
      'act.rescan': '重新检测账号',
      'act.export': '导出账号',
      'act.exportHint': '只导出平台、账号 id 与显示名；凭证永远不出本机',
      'act.exportDone': '已导出 {n} 条账号信息',
      'act.importHint': '导入请用「同步登录态」从本机桌面端读取',
      'pool.selectAll': '全选',
      'pool.selectAllHint': '清空成员限制 = 该平台的每个账号都参与轮转',
      'pool.selectedCount': '已选 {n} / {total}',
      'pool.columnAccount': '账号',
      'pool.columnCredits': '积分',
      'pool.columnProbe': '状态',
      'pool.columnSlots': '并发槽',
      'pool.noAccount': '还没有账号。点「同步登录态」从本机桌面端读一份，或直接用「扫码登录」。',
      'pool.notMember': '不参与轮转',
      'pool.manual': '手动',
      'pool.auto': '自动',
      'pool.orderHint': '顺序就是回退顺序。',
      'pool.creditsNone': '—',
      'pool.creditsExpireAt': '最近积分包 {at} 过期',

      'state.ready': '可用',
      'state.disabled': '需重新登录',
      'state.cooling': '冷却 {sec} 秒',
      'state.disabledFor': '停用 {min} 分钟',
      'state.testedAt': '测试于 {at}',

      'act.sync': '同步登录态',
      'act.syncing': '正在同步…',
      'act.refreshModels': '刷新模型',
      'act.refreshing': '正在刷新…',
      'act.login': '扫码登录',
      'act.loggingIn': '等待浏览器完成授权…',
      'act.loginHint': '会打开浏览器让你在华为云登录，凭证自动落到本插件。',
      'act.remove': '移除',
      'act.save': '保存',
      'act.saving': '保存中…',
      'act.saved': '已保存',
      'act.discard': '放弃修改',
      'act.test': '测试',
      'act.probeOk': '{account} 可用，凭证已通过鉴权。',
      'act.probeFailed': '{account} 探测失败：{message}',
      'act.up': '上移',
      'act.down': '下移',

      'models.title': '模型',
      'models.total': '目录 {n} 个',
      'models.unrestricted': '不限制：该平台全部模型都开放',
      'models.chosen': '已勾选 {n} 个',
      'models.search': '按名称或 id 搜索…',
      'models.filterAll': '全部',
      'models.filterOn': '已启用',
      'models.filterImage': '可看图',
      'models.empty': '还没有模型目录，点「刷新模型」。',
      'models.sourceUpstream': '上游实时',
      'models.sourceCache': '上次缓存',
      'models.sourceSeed': '内置种子',
      'models.images': '图片',
      'models.context': '上下文 {n}',
      'models.output': '输出 {n}',
      'models.selectAll': '全部勾选',
      'models.selectNone': '不限（全部开放）',
      'models.enableHint': '勾上 = 出现在 DSH 的模型选择器里',
      'models.textOnly': '纯文本',
      'models.probeHint': '刷新目录，确认这个模型上游仍在',
      'models.probeRunning': '正在核对 {model}…',
      'models.probeOk': '{model} 上游仍可用。',
      'models.probeGone': '{model} 已从上游目录消失。',
      'models.maxContext': '最大上下文',
      'models.maxOutput': '最大输出',
      'models.budgetDefault': '默认（{n}）',
      'models.contextDefaultSuffix': '（默认 {n}）',
      'models.budgetHint': '上下文预算：越小，DSH 越早压缩对话。选「默认」= 用插件的保守窗口，其余档位直接覆盖声明值。',
      'models.noAccount': '{platform} 还没有账号，所以不列出模型。',
      'models.noAccountHint': '先在「账号」栏点「同步登录态」或「扫码登录」；拿到账号后这里会自动出现模型。',
      'models.hint': '这里的勾选只作用于当前这一栏的平台；一个都不勾 = 该平台不限制（全部开放）。',
      'models.imageHint': '图片开关覆盖上游的说法：勾上后请求里的图会原样发给该模型，取消则发请求前换成占位文本。',

      'caps.slotsTitle': '码道并发会话',
      'caps.slotsBody': '码道对每个账号只开 3 个并发会话，每个会话要占用约 1 分钟——中途停止也不减免。撞上时本插件原地排队等待（最多 90 秒），而不是把错误甩给你。',
      'caps.slotsNow': '当前占用：{used} / {limit}',
      'caps.slotsBusy': '三个槽都占着——下一个请求会等其中一个会话释放。再登录一个账号可以把容量翻倍。',
      'caps.mediaTitle': '自主生图 / 视频',
      'caps.mediaBody': '本插件只接模型，不提供自主生图或视频工具；需要那类工具请装对应的连接器插件。',
      'caps.proxyTitle': '转发层',
      'caps.proxyBody': '码道请求使用 SDK-HMAC-SHA256 签名。若本机有会重写请求体的转发层（如 billion-context），需要让它原样放行签名请求，否则每个回合都会失败。',

      'diag.region': '平台',
      'diag.host': '上游域名',
      'diag.shim': '本地转发',
      'diag.shimDown': '未启动（provider 未注册）',
      'diag.active': '当前服务账号',
      'diag.token': '登录有效期至',
      'diag.models': '目录中的模型',
      'diag.enabled': '已启用的模型',
      'diag.rates': '倍率已知',
      'diag.ratesNone': '上游未提供，内置表为空',
      'diag.ratesCount': '{n} 个模型有倍率',
      'diag.pool': '账号池',
      'diag.poolOn': '开启 · {n} 个账号',
      'diag.poolOff': '关闭（单账号）',
      'diag.lastFailure': '最近一次失败',
      'diag.noFailure': '没有报错。',
      'diag.slots': '并发槽位',
      'diag.creditsAt': '积分读取于 {at}',
      'diag.creditsStale': '（上次读取）',
      'diag.hint': '这张卡片实际读到了什么，方便贴进问题反馈。这里没有任何会改动设置的控件。',

      'err.title': '出错了',
      'err.credits': '积分不可用：{message}',
      'err.loginFailed': '登录失败：{message}',
      'err.loginPartial': '登录成功，但还差一步：{message}',
      'err.loginTimeout': '登录超时，请重试。',
      'err.syncOk': '已同步 {n} 个账号',

      'dock.credits': '积分 {n}',
      'dock.total': '{total} 总额中剩余 {remain}',
      'time.justNow': '刚刚',
      'time.minutes': '{n} 分钟前',
      'time.hours': '{n} 小时前',
    }

    const EN = {
      'card.title': 'Huawei dual platform',
      'card.desc': 'CodeArts (码道) and OfficeAce (果办) models in one card: per-account credits, per-model selection with image toggles, pool failover, and a separate CodeArts concurrency counter.',
      'card.expand': 'Expand',
      'card.collapse': 'Collapse',
      'tab.switchPool': 'Enable the account pool for this platform',

      'panel.accounts': 'Accounts',
      'panel.models': 'Models',
      'panel.caps': 'Capabilities',
      'panel.diag': 'Diagnostics',

      'pool.title': 'Account pool',
      'pool.enabled': 'Pool enabled',
      'pool.disabled': 'Single account',
      'pool.hint': 'One account is used by default, with no rotation. The pool only kicks in once enabled — it picks among accounts by health, which is worth it only with two or more accounts.',
      'pool.enabledHint': 'On: the pool picks an account per request and only fails over on failures another account could fix — an invalid request, a missing model and a proxy refusal are not retried elsewhere. Off: the account you pick serves every request, and failures are reported as they are.',
      'pool.current': 'Using {account}',
      'pool.currentBadge': 'Current',
      'pool.toggle': 'Enable pool',
      'pool.toggleHint': 'When off, the single selected account serves every request',
      'pool.modeAuto': 'auto pick',
      'pool.modeManual': 'single account',
      'pool.membersTitle': 'Accounts in this pool',
      'pool.membersHint': 'Only checked accounts take part in rotation and testing.',
      'pool.selectAllHint': 'Clear the member limit so every account on this platform rotates',
      'pool.selectNone': 'None',
      'pool.selectNoneHint': 'No account rotates (all stay listed in the table)',
      'act.rescan': 'Rescan accounts',
      'act.export': 'Export',
      'act.exportHint': 'Exports platform, account id and display name only; credentials never leave this machine',
      'act.exportDone': 'Exported {n} account record(s)',
      'act.importHint': 'To import, use “Sync sign-in” to read from the desktop app',
      'pool.selectAll': 'All',
      'pool.selectAllHint': 'Clear the member limit so every account on this platform rotates',
      'pool.selectedCount': '{n} / {total} selected',
      'pool.columnAccount': 'Account',
      'pool.columnCredits': 'Credits',
      'pool.columnProbe': 'Status',
      'pool.columnSlots': 'Slots',
      'pool.noAccount': 'No account yet. Hit “Sync sign-in” to read one from the desktop app, or sign in below.',
      'pool.notMember': 'not rotating',
      'pool.manual': 'manual',
      'pool.auto': 'auto',
      'pool.orderHint': 'This order is the failover order.',
      'pool.creditsNone': '—',
      'pool.creditsExpireAt': 'nearest credit pack expires {at}',

      'state.ready': 'ready',
      'state.disabled': 'needs sign-in',
      'state.cooling': 'cooling {sec}s',
      'state.disabledFor': 'disabled {min}m',
      'state.testedAt': 'tested {at}',

      'act.sync': 'Sync sign-in',
      'act.syncing': 'Syncing…',
      'act.refreshModels': 'Refresh models',
      'act.refreshing': 'Refreshing…',
      'act.login': 'Sign in',
      'act.loggingIn': 'Waiting for browser sign-in…',
      'act.loginHint': 'A browser window opens for Huawei Cloud sign-in. The credential lands here automatically.',
      'act.remove': 'Remove',
      'act.save': 'Save',
      'act.saving': 'Saving…',
      'act.saved': 'Saved',
      'act.discard': 'Discard',
      'act.test': 'Test',
      'act.probeOk': '{account} is usable — the credential passed authentication.',
      'act.probeFailed': '{account} probe failed: {message}',
      'act.up': 'Move up',
      'act.down': 'Move down',

      'models.title': 'Models',
      'models.total': '{n} in catalog',
      'models.unrestricted': 'Unrestricted: every model on this platform is offered',
      'models.chosen': '{n} checked',
      'models.search': 'Search by name or id…',
      'models.filterAll': 'All',
      'models.filterOn': 'Enabled',
      'models.filterImage': 'Image',
      'models.empty': 'No catalog yet — hit “Refresh models”.',
      'models.sourceUpstream': 'live',
      'models.sourceCache': 'cached',
      'models.sourceSeed': 'built-in',
      'models.images': 'Images',
      'models.context': 'context {n}',
      'models.output': 'output {n}',
      'models.selectAll': 'Check all',
      'models.selectNone': 'Unrestricted',
      'models.enableHint': 'Checked means this model appears in the DSH model picker',
      'models.textOnly': 'text only',
      'models.probeHint': 'Refresh the catalog to confirm this model still exists upstream',
      'models.probeRunning': 'Checking {model}…',
      'models.probeOk': '{model} is still available upstream.',
      'models.probeGone': '{model} disappeared from the upstream catalog.',
      'models.maxContext': 'Max context',
      'models.maxOutput': 'Max output',
      'models.budgetDefault': 'Default ({n})',
      'models.contextDefaultSuffix': ' (default {n})',
      'models.budgetHint': 'Context budget: smaller means DSH compacts earlier. “Default” uses the plugin’s conservative window; other tiers override the declared window.',
      'models.noAccount': '{platform} has no account, so no models are listed.',
      'models.noAccountHint': 'Use “Sync sign-in” or “Sign in” on the Accounts tab first; models appear here once an account exists.',
      'models.hint': 'This list applies only to the active platform tab. Nothing ticked means that platform is unrestricted.',
      'models.imageHint': 'The image toggle overrides the upstream claim: when ticked, images are sent to that model; when unticked, they are replaced with placeholder text before the request.',

      'caps.slotsTitle': 'CodeArts concurrency',
      'caps.slotsBody': 'CodeArts allows 3 concurrent sessions per account, each held about a minute even after you stop. When that limit is hit this plugin queues and retries in place (up to 90s) instead of handing you an error.',
      'caps.slotsNow': '{used} / {limit} in use',
      'caps.slotsBusy': 'All three slots are busy — the next request waits for one to free. Sign in a second account to double the capacity.',
      'caps.mediaTitle': 'Image and video generation',
      'caps.mediaBody': 'This plugin only routes models; it registers no image or video tool. Install the connector that owns that capability if you need it.',
      'caps.proxyTitle': 'Forwarding layer',
      'caps.proxyBody': 'CodeArts requests are signed with SDK-HMAC-SHA256. A local forwarding layer that rewrites bodies (such as billion-context) must pass signed requests through untouched, otherwise every turn fails.',

      'diag.region': 'Platform',
      'diag.host': 'Upstream host',
      'diag.shim': 'Local relay',
      'diag.shimDown': 'not started (provider unregistered)',
      'diag.active': 'Serving account',
      'diag.token': 'Sign-in valid until',
      'diag.models': 'Models in catalog',
      'diag.enabled': 'Models enabled',
      'diag.rates': 'Rates known',
      'diag.ratesNone': 'not provided upstream; built-in table empty',
      'diag.ratesCount': '{n} model(s) with a rate',
      'diag.pool': 'Account pool',
      'diag.poolOn': 'on · {n} accounts',
      'diag.poolOff': 'off (single account)',
      'diag.lastFailure': 'Last failure',
      'diag.noFailure': 'No errors.',
      'diag.slots': 'Session slots',
      'diag.creditsAt': 'credits read {at}',
      'diag.creditsStale': '(cached)',
      'diag.hint': 'What this card actually read, for pasting into a bug report. Nothing here changes any setting.',

      'err.title': 'Something failed',
      'err.credits': 'Credits unavailable: {message}',
      'err.loginFailed': 'Sign-in failed: {message}',
      'err.loginPartial': 'Signed in, but one step remains: {message}',
      'err.loginTimeout': 'Sign-in timed out — try again.',
      'err.syncOk': 'Synced {n} account(s)',

      'dock.credits': 'Credits {n}',
      'dock.total': '{remain} left of {total}',
      'time.justNow': 'just now',
      'time.minutes': '{n}m ago',
      'time.hours': '{n}h ago',
    }

    /** 卡片图标：内联 SVG 的 data URI，不依赖宿主任何资源路由。 */
    const CARD_ICON = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4IiB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJEU0ggQ29ubmVjdCBIdWF3ZWkiPiA8ZGVmcz4gPGxpbmVhckdyYWRpZW50IGlkPSJody1iZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPiA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiMyZjZkZjYiLz4gPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMWIzZmI4Ii8+IDwvbGluZWFyR3JhZGllbnQ+IDxsaW5lYXJHcmFkaWVudCBpZD0iaHctbWFyayIgeDE9IjAiIHkxPSIwIiB4Mj0iMCIgeTI9IjEiPiA8c3RvcCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiNmZmZmZmYiLz4gPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjZGZlOGZmIi8+IDwvbGluZWFyR3JhZGllbnQ+IDwvZGVmcz4gPHJlY3Qgd2lkdGg9IjEyOCIgaGVpZ2h0PSIxMjgiIHJ4PSIyOCIgZmlsbD0idXJsKCNody1iZykiLz4gPGcgZmlsbD0idXJsKCNody1tYXJrKSI+IDxyZWN0IHg9IjI2IiB5PSIzMCIgd2lkdGg9Ijc2IiBoZWlnaHQ9IjIwIiByeD0iMTAiIG9wYWNpdHk9IjAuOTUiLz4gPHJlY3QgeD0iMjYiIHk9IjU4IiB3aWR0aD0iNzYiIGhlaWdodD0iMjAiIHJ4PSIxMCIgb3BhY2l0eT0iMC43NSIvPiA8cmVjdCB4PSI1OCIgeT0iODYiIHdpZHRoPSIxMiIgaGVpZ2h0PSIxOCIgcng9IjYiIG9wYWNpdHk9IjAuOSIvPiA8L2c+IDxjaXJjbGUgY3g9Ijk4IiBjeT0iOTgiIHI9IjEyIiBmaWxsPSIjNGFkZTgwIi8+IDxwYXRoIGQ9Ik05Mi41IDk4LjJsMy42IDMuNiA3LTcuNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMGIyYTEyIiBzdHJva2Utd2lkdGg9IjMuNCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+IDwvc3ZnPg=='

    // ---- 卡片 CSS（由 dsh-connect-workbuddy 的样式表改名而来，见构建脚本说明） ----
    const CARD_CSS = `.dsm-hwc-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dsm-hwc-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-hwc-card-open{background:var(--dsw-alias-bg-layer-2,#25262b);border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-hwc-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsm-hwc-card-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:-2px}
.dsm-hwc-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsm-hwc-card-title{color:var(--dsw-alias-label-primary,#e6e6e6);font-size:15px;font-weight:600;line-height:1.4}
.dsm-hwc-card-description{color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5}
.dsm-hwc-card-chevron{color:var(--dsw-alias-label-tertiary,#999);flex:none;width:16px;height:16px;position:relative;transition:transform .16s}
.dsm-hwc-card-chevron::before{content:"";display:block;position:absolute;left:4px;top:5px;width:7px;height:7px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg)}
.dsm-hwc-card-chevron-open{transform:rotate(180deg)}
.dsm-hwc-card-body{border-top:1px solid var(--dsw-alias-border-l2,#36373b);margin:0 16px;padding:0 0 8px}
/* 设置页里 shell 已经给了标题栏、边框和滚动容器：这里只留内容，不重复上边框和横向缩进。 */
.dsm-hwc-card-surface-settings{border:0;background:transparent;border-radius:0}
.dsm-hwc-card-surface-settings .dsm-hwc-card-body-flat{border-top:0;margin:0;padding:0}
.dsm-hwc-nav-icon{flex:none}
.dsm-hwc-card-icon{width:32px;height:32px;flex:none;border-radius:7px}
.dsm-hwc-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dsm-hwc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-hwc-btn:disabled{opacity:.4;cursor:default}
.dsm-hwc-btn-outline{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent;font-weight:500}
.dsm-hwc-btn-outline:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:rgba(255,255,255,.04)}
.dsm-hwc-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dsm-hwc-btn-primary:hover:not(:disabled){opacity:.9}
.dsm-hwc-usage{display:flex;flex-direction:column;gap:16px;margin:0;padding:16px 0 4px}
.dsm-hwc-tabs{display:flex;gap:8px;align-items:stretch}
.dsm-hwc-tab-cell{display:flex;align-items:center;gap:4px;flex:1;min-width:0;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;background:var(--dsw-alias-bg-layer-3,#2a2c33);transition:border-color .15s,background .15s}
.dsm-hwc-tab-cell:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-hwc-tab-cell:has(.dsm-hwc-tab-active){border-color:var(--dsw-alias-brand-primary,#5686fe);background:var(--dsw-alias-bg-layer-2,#232529)}
.dsm-hwc-tab{appearance:none;font:inherit;cursor:pointer;flex:1;min-width:0;border:0;border-radius:7px;padding:0;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:600;line-height:20px;text-align:left;background:transparent;transition:color .15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsm-hwc-tab:hover:not(:disabled):not(.dsm-hwc-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-hwc-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-hwc-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-hwc-tab-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:7px;vertical-align:baseline}
.dsm-hwc-tab-switch{display:inline-flex;align-items:center;flex:none;margin-left:auto;padding-left:10px;border-left:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24));cursor:pointer}
.dsm-hwc-tab-switch input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-hwc-tab-switch input:disabled{cursor:default}
.dsm-hwc-panels{display:flex;align-items:stretch;gap:2px;margin:16px 0 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
.dsm-hwc-panel-tab{appearance:none;font:inherit;cursor:pointer;border:0;background:transparent;padding:7px 11px;margin-bottom:-1px;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;font-weight:600;line-height:20px;white-space:nowrap;transition:color .15s,border-color .15s}
.dsm-hwc-panel-tab:hover:not(.dsm-hwc-panel-tab-active){color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-hwc-panel-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-hwc-panel-tab-active{color:var(--dsw-alias-label-primary,#e6e6e6);border-bottom-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-hwc-panel{margin-top:12px}
.dsm-hwc-diag{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#232529)}
.dsm-hwc-diag-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:8px 12px}
.dsm-hwc-diag-row+.dsm-hwc-diag-row{border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.24))}
.dsm-hwc-diag-label{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-hwc-diag-value{min-width:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;line-height:18px;text-align:right;overflow-wrap:anywhere}
.dsm-hwc-diag-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.dsm-hwc-diag-bad{color:var(--dsw-alias-label-caution,#e8b34b)}
.dsm-hwc-diag-hint{margin:10px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-hwc-prefs{display:flex;flex-direction:column;gap:14px;padding:2px 0 0}
.dsm-hwc-pref{display:flex;align-items:flex-start;gap:10px;font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0);cursor:pointer}
.dsm-hwc-pref input{flex:none;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-hwc-pref-check,.dsm-hwc-image-tool-check,.dsm-hwc-video-tool-check,.dsm-hwc-cli-bridge-check,.dsm-hwc-upstream-check,.dsm-hwc-channel-continue-check{inline-size:15px;block-size:15px;margin:3px 0 0}
.dsm-hwc-pref input:disabled{cursor:default}
.dsm-hwc-pref:has(input:disabled){opacity:.6;cursor:default}
.dsm-hwc-pref-copy{display:flex;flex-direction:column;gap:3px;min-width:0}
.dsm-hwc-pref-label{font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-hwc-pref-indent{padding-left:25px}
.dsm-hwc-pref-lead{display:flex;align-items:center;justify-content:flex-start;gap:10px;min-width:0}
.dsm-hwc-pref-lead .dsm-hwc-pref-label{flex:none}
.dsm-hwc-pref-hint{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:17px}
.dsm-hwc-media{padding-left:25px}
.dsm-hwc-media-list{margin:2px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.dsm-hwc-media-row{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px;min-width:0}
.dsm-hwc-media-name{color:var(--dsw-alias-label-secondary,#b8bcc4);font-size:12px}
.dsm-hwc-media-id{color:var(--dsw-alias-label-tertiary,#8b8f98);font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.dsm-hwc-media-tags{display:inline-flex;flex-wrap:wrap;gap:4px}
.dsm-hwc-media-tag{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#8b8f98)}
.dsm-hwc-video-model-select{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#b8bcc4);background:var(--dsw-alias-bg-l1,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:1px 6px;max-width:100%;min-width:0}
.dsm-hwc-video-model-select:disabled{opacity:.6}
.dsm-hwc-media-empty,.dsm-hwc-media-error{font-size:12px;line-height:17px}
.dsm-hwc-media-empty{color:var(--dsw-alias-label-tertiary,#8b8f98)}
.dsm-hwc-media-error{color:var(--dsw-alias-label-error,#e5675f)}
.dsm-hwc-credit-position{flex:none;max-width:none;margin-top:0;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:7px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:12px;line-height:16px;cursor:pointer}
.dsm-hwc-credit-position:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-hwc-credit-position:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:1px}
.dsm-hwc-credit-position:disabled{opacity:.5;cursor:default}
.dsm-hwc-tab-off{opacity:.55}
.dsm-hwc-usage-account-actions{display:flex;gap:8px;margin:10px 0 0}
.dsm-hwc-tab-off-notice{color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px;margin:0 0 4px;padding:8px 10px;background:var(--dsw-alias-bg-layer-3,#2a2c33);border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:8px}
.dsm-hwc-usage-hint{padding-left:19px;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
.dsm-hwc-account-error{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;line-height:18px;white-space:pre-line}
.dsm-hwc-usage-select-wrap{position:relative}
.dsm-hwc-usage-select{appearance:none;width:100%;font:inherit;padding:10px 34px 10px 12px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:10px;color:var(--dsw-alias-label-primary,#e6e6e6);background:var(--dsw-alias-bg-layer-3,#2a2c33);cursor:pointer;transition:border-color .15s,box-shadow .15s}
.dsm-hwc-usage-select:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#5686fe);box-shadow:0 0 0 3px rgba(86,134,254,.22)}
.dsm-hwc-usage-select:disabled{opacity:.6;cursor:default}
.dsm-hwc-usage-select-wrap::after{content:"";position:absolute;top:50%;right:12px;width:7px;height:7px;transform:translateY(-65%) rotate(45deg);border-right:1.6px solid var(--dsw-alias-label-secondary,#c6c9d0);border-bottom:1.6px solid var(--dsw-alias-label-secondary,#c6c9d0);pointer-events:none}
.dsm-hwc-usage-text{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#b8b8b8)}
.dsm-hwc-usage-error{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-hwc-usage-error-block{display:flex;flex-direction:column;align-items:flex-start;gap:10px;margin-top:12px}
.dsm-hwc-usage-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
.dsm-hwc-models{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:14px}
.dsm-hwc-models-fold{display:flex;flex-direction:column;gap:10px}
.dsm-hwc-models-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsm-hwc-models-title-row{display:flex;align-items:center;gap:6px;min-width:0}
.dsm-hwc-models-title{margin:0;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:14px;font-weight:600;line-height:20px}
.dsm-hwc-models-dirty{margin-left:8px;padding:1px 6px;border-radius:6px;background:var(--dsw-alias-state-warn-primary,#f59e0b);color:#1b1d22;font-size:11px;font-weight:600;line-height:16px;vertical-align:1px;white-space:nowrap}
.dsm-hwc-models-summary{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-hwc-panel-note{margin:2px 0 0;color:var(--dsw-alias-label-tertiary,#999);font-size:12px;line-height:18px}
.dsm-hwc-models-sweep{white-space:nowrap}
.dsm-hwc-models-sweep-summary{margin:6px 0 0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-usage-cheer{display:inline-flex;align-items:center;gap:4px;flex:none;text-decoration:underline;text-underline-offset:2px;color:var(--dsw-alias-label-tertiary,#999);font-size:13px;line-height:1.5;transition:color .16s}
.dsm-hwc-usage-cheer-star{font-size:12px;line-height:1;display:inline-flex}
.dsm-hwc-usage-cheer:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-hwc-usage-cheer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5686fe);outline-offset:2px}
.dsm-hwc-pool{display:flex;flex-direction:column;gap:12px;margin:0;padding:16px 0 4px;border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-hwc-pool-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsm-hwc-pool-current-badge{margin-left:auto;padding:2px 10px;border-radius:999px;background:var(--dsw-alias-state-success-primary,#22c55e);border:1px solid rgba(34,197,94,.55);color:#fff;font-size:12px;font-weight:600;line-height:18px;white-space:nowrap}
.dsm-hwc-pool-head-pick{margin-left:auto;display:flex;align-items:center;gap:8px;font-size:12px}
.dsm-hwc-pool-head-pick-label{color:var(--dsw-alias-label-secondary,#c6c9d0);white-space:nowrap}
.dsm-hwc-pool-account-select{min-width:200px}
.dsm-hwc-pool-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-hwc-pool-badge{flex:none;padding:2px 9px;border-radius:999px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-brand-primary,#5686fe);background:rgba(86,134,254,.12);border:1px solid rgba(86,134,254,.32)}
.dsm-hwc-pool-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsm-hwc-pool-actions-group{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-hwc-pool-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-note{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-warn{margin:0;padding:9px 11px;border-radius:9px;font-size:12px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#f59e0b);background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.3)}
.dsm-hwc-pool-ghosts{display:flex;flex-direction:column;gap:6px}
.dsm-hwc-pool-ghost-list{display:flex;flex-wrap:wrap;gap:6px;margin:0;padding:0;list-style:none}
.dsm-hwc-pool-ghost{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 9px;border-radius:999px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary,#f59e0b);background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.3)}
.dsm-hwc-pool-ghost-name{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-hwc-pool-ghost-remove{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:999px;font-size:11px;line-height:1;cursor:pointer;color:inherit;background:transparent}
.dsm-hwc-pool-ghost-remove:hover:not(:disabled){background:rgba(245,158,11,.2)}
.dsm-hwc-pool-ghost-remove:disabled{cursor:default;opacity:.5}
.dsm-hwc-pool-error{margin:0;font-size:12px;line-height:17px;color:var(--dsw-alias-state-error-primary,#ef4444);white-space:pre-line}
.dsm-hwc-pool-table{border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-hwc-pool-row{display:grid;grid-template-columns:1.6fr 1fr 1.3fr .9fr .8fr;gap:10px;align-items:center;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:13px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-row:first-child{border-top:0}
.dsm-hwc-pool-row-head{padding:8px 14px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase}
.dsm-hwc-pool-row-current{box-shadow:inset 3px 0 0 var(--dsw-alias-brand-primary,#5686fe)}
.dsm-hwc-pool-account{display:flex;align-items:center;gap:8px;min-width:0}
.dsm-hwc-pool-account-name{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
/* 账号名一行排：名字占满剩余宽度并省略号截断，徽章不参与压缩。
   华为的账号名是 iam::<uuid>:user:<name> 这种长串，不截断会把整行撑成两行。 */
.dsm-hwc-pool-name-row{display:flex;align-items:center;gap:6px;min-width:0}
.dsm-hwc-pool-account-name b{font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}
.dsm-hwc-pool-name-row .dsm-hwc-pool-current-tag,.dsm-hwc-pool-name-row .dsm-hwc-pool-not-member{flex:none}
/* 只给「手动/自动 + 时间」那一行上小字样式。用直接子选择器限定，否则这条规则会
   盖掉名字行里徽章自己的字号与颜色（徽章是 <span>，正好在匹配范围内）。 */
.dsm-hwc-pool-account-name>.dsm-hwc-pool-order{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-hwc-pool-account-name .dsm-hwc-pool-current-tag{align-self:flex-start;margin-top:2px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-state-success-primary,#22c55e);border:1px solid rgba(34,197,94,.55);color:#fff;font-size:11px;font-weight:600;line-height:16px;white-space:nowrap}
.dsm-hwc-pool-account-name .dsm-hwc-pool-order{display:flex;align-items:center;gap:6px;margin-top:2px;flex-wrap:wrap}
.dsm-hwc-pool-account-name .dsm-hwc-pool-rank{display:inline-flex;align-items:center;border-radius:999px;border:1px solid rgba(86,134,254,.32);background:rgba(86,134,254,.12);color:var(--dsw-alias-brand-primary,#5686fe);font-size:11px;font-weight:600;line-height:16px;padding:1px 6px;white-space:nowrap;cursor:default;font-variant-numeric:tabular-nums}
.dsm-hwc-pool-account-name .dsm-hwc-pool-rank-auto{border:1px dashed var(--dsw-alias-border-l1,#2c2d31);background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-account-name .dsm-hwc-pool-move{display:inline-flex;align-items:center;gap:2px}
.dsm-hwc-pool-account-name .dsm-hwc-pool-move-btn{width:18px;height:18px;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,#2c2d31);background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:1;cursor:pointer}
.dsm-hwc-pool-account-name .dsm-hwc-pool-move-btn:disabled{opacity:.4;cursor:default}
.dsm-hwc-pool-account-name .dsm-hwc-pool-move-btn:not(:disabled):focus-visible{background:rgba(86,134,254,.16);border-color:rgba(86,134,254,.55);color:var(--dsw-alias-brand-primary,#5686fe);outline:2px solid rgba(86,134,254,.45);outline-offset:1px}
.dsm-hwc-pool-excluded{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-hwc-pool-order-rules{border:1px solid var(--dsw-alias-border-l1,#2c2d31);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#232529);overflow:hidden}
.dsm-hwc-pool-order-rules-summary{padding:8px 12px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:12px;font-weight:600;line-height:18px}
.dsm-hwc-pool-order-rules-summary:hover{color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-hwc-pool-order-rules-summary:focus-visible{outline:2px solid rgba(86,134,254,.55);outline-offset:-2px}
.dsm-hwc-pool-order-rules-body{display:flex;flex-direction:column;gap:8px;padding:0 12px 12px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);padding-top:10px}
.dsm-hwc-pool-order-rules-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-order-rules-list li{padding-left:2px}
.dsm-hwc-pool-order-rules-why{margin:0;padding:8px 10px;border-radius:8px;border-left:3px solid var(--dsw-alias-state-warn-primary,#f59e0b);background:rgba(245,158,11,.10);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-credits{display:flex;flex-direction:column;gap:1px;min-width:0;font-variant-numeric:tabular-nums}
.dsm-hwc-pool-credits b{color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:600}
.dsm-hwc-pool-soon{font-size:11px;line-height:16px;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-hwc-pool-soon-plain{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-hwc-pool-benefits{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#999);min-width:0}
.dsm-hwc-pool-benefit-tag{min-width:0;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsm-hwc-pool-benefit{display:flex;flex-wrap:wrap;align-items:center;gap:2px 5px;min-width:0;max-width:100%}
.dsm-hwc-pool-benefit-urgent{color:var(--dsw-alias-state-warn-primary,#f59e0b);font-weight:600}
.dsm-hwc-pool-reason{font-size:11px;line-height:15px;color:var(--dsw-alias-state-warn-primary,#f59e0b);overflow-wrap:anywhere;white-space:normal}
.dsm-hwc-pool-probe,.dsm-hwc-pool-checkin{font-size:12px;line-height:17px;color:var(--dsw-alias-label-tertiary,#999);min-width:0;overflow-wrap:anywhere}
.dsm-hwc-pool-probe{display:flex;flex-direction:column;gap:4px}
.dsm-hwc-pool-probe-main{color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-probe-prov{display:flex;align-items:center;gap:5px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#999);min-width:0;flex-wrap:wrap}
.dsm-hwc-pool-prov-tag{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-tertiary,#999);font-size:10px;font-weight:600;line-height:15px;white-space:nowrap}
.dsm-hwc-pool-prov-live{background:rgba(245,158,11,.16);color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-hwc-pool-prov-unknown{background:var(--dsw-alias-bg-layer-3,#2a2c33);border:1px solid var(--dsw-alias-border-l1,#2c2d31);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-prov-sep{color:var(--dsw-alias-label-dimmed,#9aa0a6);opacity:.7}
.dsm-hwc-pool-prov-age{color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}
.dsm-hwc-pool-prov-model{color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px}
.dsm-hwc-pool-members{display:flex;flex-direction:column;gap:10px}
.dsm-hwc-pool-members-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsm-hwc-pool-members-title{margin:0 0 3px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-hwc-pool-members-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-hwc-pool-small-btn{padding:3px 10px;font-size:12px}
.dsm-hwc-pool-check{display:inline-flex;align-items:center;flex:none;cursor:pointer}
.dsm-hwc-pool-check input{margin:0;cursor:pointer;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-hwc-pool-check input:disabled{cursor:default;opacity:.5}
.dsm-hwc-pool-checked{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-hwc-pool-unknown{color:var(--dsw-alias-label-dimmed,#9aa0a6)}
.dsm-hwc-pool-not-member{color:var(--dsw-alias-label-dimmed,#9aa0a6)}
.dsm-hwc-pool-settings-wrap{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:14px}
.dsm-hwc-pool-dirty{font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-hwc-pool-settings{display:flex;flex-direction:column;gap:1px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-hwc-pool-modebar{padding:12px 14px;gap:8px;border-color:rgba(86,134,254,.36);background:linear-gradient(180deg,rgba(86,134,254,.10),rgba(86,134,254,.02)),var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-hwc-pool-modebar-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsm-hwc-pool-modebar-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-hwc-pool-modebar-state{flex:none;padding:1px 9px;border-radius:999px;font-size:12px;line-height:18px;font-weight:500;color:var(--dsw-alias-brand-primary,#5686fe);background:rgba(86,134,254,.14);border:1px solid rgba(86,134,254,.3)}
.dsm-hwc-pool-modebar .dsm-hwc-pool-dirty{margin-left:auto}
.dsm-hwc-pool-modebar .dsm-hwc-pool-note{line-height:18px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-serving-note{padding-left:10px;border-left:2px solid rgba(86,134,254,.5);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-card-head{display:flex;align-items:center;gap:8px}
.dsm-hwc-pool-card-title{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-tools{display:flex;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:flex-start;gap:8px;border:1px dashed var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;padding:6px 10px}
.dsm-hwc-pool-tools .dsm-hwc-bar{flex:0 1 auto;min-width:0;margin:0}
.dsm-hwc-pool-tools .dsm-hwc-bar-status{white-space:normal}
.dsm-hwc-pool-set{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31)}
.dsm-hwc-pool-set:first-child{border-top:0}
.dsm-hwc-pool-set-copy{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.dsm-hwc-pool-set-copy b{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dsm-hwc-pool-set-copy span{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-hwc-pool-set-ctl{flex:none;display:flex;align-items:center;gap:8px}
.dsm-hwc-pool-num{width:74px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px;text-align:center;font-variant-numeric:tabular-nums}
.dsm-hwc-pool-select{max-width:260px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);font:inherit;font-size:13px;cursor:pointer}
.dsm-hwc-pool-select:disabled,.dsm-hwc-pool-num:disabled{opacity:.5;cursor:default}
/* 底部操作栏走正常文档流：跟着内容滚，滚到底才看得见。
   之前是 position:sticky;bottom:0;z-index:2，等于永远钉在卡片底边——
   模型一多就悬在列表上方，挡住最后一行，还会让人以为"改完必须立刻点"。
   现在它就在内容的末尾，读到底自然遇到。 */
.dsm-hwc-pool-save-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2,#36373b);padding-top:12px;margin-top:4px;padding-bottom:0}
.dsm-hwc-pool-save-buttons{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none;margin-left:auto}
.dsm-hwc-pool-conflict{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:11px 13px;border-radius:10px;background:rgba(245,158,11,.08);border:1px solid var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-hwc-pool-pending{flex:none;align-self:center;font-size:12px;line-height:17px;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-hwc-pool-conflict-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dsm-hwc-pool-conflict-main b{font-size:12px;font-weight:600;color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-hwc-pool-conflict-main span{font-size:12px;line-height:17px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-log{border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#24262c)}
.dsm-hwc-pool-log-head{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:var(--dsw-alias-bg-layer-3,#2a2c33);border-bottom:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-log-clear{padding:2px 10px;font-size:12px}
.dsm-hwc-pool-log-body{max-height:186px;overflow-y:auto}
.dsm-hwc-pool-log-row{display:flex;gap:10px;padding:7px 14px;border-top:1px solid var(--dsw-alias-border-l1,#2c2d31);font-size:12px;line-height:18px}
.dsm-hwc-pool-log-row:first-child{border-top:0}
.dsm-hwc-pool-log-time{flex:none;color:var(--dsw-alias-label-tertiary,#999);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dsm-hwc-pool-log-text{min-width:0;overflow-wrap:anywhere}
.dsm-hwc-pool-log-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-hwc-pool-log-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-hwc-pool-log-error{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dsm-hwc-pool-log-info{color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-pool-log-empty{padding:14px;font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}
.dsm-hwc-pool-row-actions{display:flex;gap:6px;align-items:center;justify-content:flex-end;flex:none}
.dsm-hwc-pool-row-actions .dsm-hwc-pool-small-btn{padding:2px 10px;font-size:12px}
.dsm-hwc-pool .sw{position:relative;display:inline-block;width:38px;height:22px;flex:none;cursor:pointer}
.dsm-hwc-pool .sw input{position:absolute;opacity:0;width:0;height:0}
.dsm-hwc-pool .sw-track{position:absolute;inset:0;border-radius:999px;background:var(--dsw-alias-border-l2,#3a3d45);transition:background .18s}
.dsm-hwc-pool .sw-track::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .18s;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.dsm-hwc-pool .sw input:checked+.sw-track{background:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-hwc-pool .sw input:checked+.sw-track::after{transform:translateX(16px)}
.dsm-hwc-pool .sw input:disabled+.sw-track{opacity:.4}
.dsm-hwc-pool .sw input:disabled{cursor:default}
.dsm-hwc-veil{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32));backdrop-filter:var(--dsw-mask-blur);cursor:progress}
.dsm-hwc-veil-card{display:flex;flex-direction:column;align-items:center;gap:8px;max-width:min(340px,80vw);padding:16px 20px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.35))}
.dsm-hwc-veil-text{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#0f1115);text-align:center}
.dsm-hwc-veil-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#61666b);text-align:center}
.dsm-hwc-veil-spinner{width:20px;height:20px;color:var(--dsw-alias-label-secondary,#61666b);animation:dsm-hwc-veil-spin 1.5s linear infinite}
.dsm-hwc-veil-spinner-track{opacity:.25}
.dsm-hwc-veil-spinner-arc{stroke-dasharray:12 150;animation:dsm-hwc-veil-dash 1.5s ease-in-out infinite}
@keyframes dsm-hwc-veil-spin{to{transform:rotate(360deg)}}
@keyframes dsm-hwc-veil-dash{0%{stroke-dasharray:12 150;stroke-dashoffset:0}50%{stroke-dasharray:24 150;stroke-dashoffset:-6}to{stroke-dasharray:12 150;stroke-dashoffset:0}}
.dsm-hwc-card{border:1px solid var(--dsw-alias-border-l2,#36373b);background:var(--dsw-alias-bg-layer-3,#202126);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dsm-hwc-card:hover{border-color:var(--dsw-alias-label-dimmed,#777)}
.dsm-hwc-subtle-text{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
/* 模型列表：不设高度上限、不出现滚动条。
   原来这里是 max-height:420px + overflow:auto，模型一多就变成内嵌滚动区，
   而它外层已经是设置页的滚动容器——两层滚动条叠在一起，用户要滚两次才看得到
   最后一个模型。workbuddy 的模型列表也是整列铺开，不内嵌滚动。 */
.dsm-hwc-model-scroll{display:flex;flex-direction:column;gap:0}
.dsm-hwc-search{flex:1;min-width:120px;font:inherit;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2,#3a3d45);border-radius:8px;background:var(--dsw-alias-bg-layer-3,#2a2c33);color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px}
.dsm-hwc-filter{display:flex;gap:6px;flex-wrap:wrap}
.dsm-hwc-credit-cell{display:flex;flex-direction:column;gap:1px;font-variant-numeric:tabular-nums}
.dsm-hwc-credit-big{color:var(--dsw-alias-label-primary,#e6e6e6);font-weight:600}
.dsm-hwc-link{color:var(--dsw-alias-brand-primary,#5686fe);text-decoration:underline;text-underline-offset:2px;cursor:pointer;background:none;border:0;font:inherit;padding:0}
/* ---- 模型行：结构与 dsh-connect-workbuddy 的模型面板一致（两段式行） ----
   类名前缀用 dsm-hwc-m-，避免与账号面板的 dsm-hwc-pool-* 混在一起。
   这些规则来自 workbuddy 的样式表（MIT, Copyright (c) 2026 LaoDing），
   只做类名替换，数值与 token 保持原样。 */
/* 模型面板的筛选 chip（全部/已启用/可看图）。workbuddy 没有这排筛选，
   所以这是本插件自己补的，视觉上沿用它的 meta-tag 语言。 */
.dsm-hwc-m-filter-chip{appearance:none;font:inherit;padding:1px 9px;border-radius:999px;font-size:11px;line-height:18px;background:rgba(174,179,187,.11);color:var(--dsw-alias-label-secondary,#c6c9d0);border:1px solid transparent;cursor:pointer;transition:border-color .15s,color .15s}
.dsm-hwc-m-filter-chip:hover{border-color:var(--dsw-alias-border-l2,#3a3d45)}
.dsm-hwc-m-filter-chip-on{color:var(--dsw-alias-brand-primary,#5686fe);background:rgba(86,134,254,.14);border-color:rgba(86,134,254,.32)}
/* 模型行右侧的开关组：图片 / 上下文预算 / 测试，全部水平排在名称右边。
   workbuddy 的同一位置就是这一组，间距与字号也照它取。 */
.dsm-hwc-m-model-switches{display:flex;align-items:center;gap:14px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.dsm-hwc-m-budget{display:inline-flex;align-items:center;gap:10px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-m-budget-opt{display:inline-flex;align-items:center;gap:4px;cursor:default}
.dsm-hwc-m-budget-opt input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-hwc-m-model-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2,#36373b);border-radius:10px;overflow:hidden}
.dsm-hwc-m-model{display:grid;grid-template-columns:minmax(0,1fr);gap:7px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2,#232529);transition:opacity .16s}
.dsm-hwc-m-model-disabled{opacity:.55}
.dsm-hwc-m-model+.dsm-hwc-m-model{border-top:1px solid var(--dsw-alias-border-l2,#36373b)}
.dsm-hwc-m-model-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dsm-hwc-m-model-enabled{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer;flex:1}
.dsm-hwc-m-model-enabled input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe);flex:none}
.dsm-hwc-m-model-image{display:inline-flex;align-items:center;gap:5px;flex:none;cursor:pointer;color:var(--dsw-alias-label-secondary,#c6c9d0);font-size:11px;line-height:16px}
.dsm-hwc-m-model-image input{margin:0;accent-color:var(--dsw-alias-brand-primary,#5686fe)}
.dsm-hwc-m-model-copy{display:flex;align-items:baseline;gap:8px;min-width:0}
.dsm-hwc-m-model-name{display:inline-flex;align-items:baseline;gap:7px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;font-weight:500;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-hwc-m-model-name-rate{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;font-weight:400;line-height:16px;flex:none}
.dsm-hwc-m-model-id{color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-hwc-m-model-desc{margin:0;color:var(--dsw-alias-label-tertiary,#9aa0a8);font-size:12px;line-height:18px}
.dsm-hwc-m-model-details{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}
.dsm-hwc-m-model-meta{display:flex;align-items:center;gap:7px 12px;flex-wrap:wrap;color:var(--dsw-alias-label-tertiary,#999);font-size:11px;line-height:16px}
.dsm-hwc-m-model-meta-tag{padding:1px 7px;border-radius:999px;font-size:11px;line-height:15px;background:rgba(174,179,187,.11);color:var(--dsw-alias-label-secondary,#c6c9d0)}
.dsm-hwc-m-models-head-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.dsm-hwc-m-models-head-actions .dsm-hwc-btn{white-space:nowrap}
.dsm-hwc-m-model-probe{flex:none;padding:3px 10px;font-size:11px;line-height:16px}
.dsm-hwc-m-model-probe-result{margin:0;font-size:12px;line-height:18px;word-break:break-word}
.dsm-hwc-m-model-probe-result-ok{color:var(--dsw-alias-state-success-primary,#22a06b)}
.dsm-hwc-m-model-probe-result-warn{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dsm-hwc-m-model-probe-result-bad{color:var(--dsw-alias-state-error-primary,#ef4444)}

`

    /** 插一份样式表；已存在则原地更新（HMR 与二次挂载都不会堆 style 标签）。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      const existing = document.querySelector(`style[data-plugin-css="${CSS_ID}"]`)
      if (existing !== null) {
        if (existing.textContent !== CARD_CSS) existing.textContent = CARD_CSS
        return
      }
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-connect-huawei'
      tag.dataset.pluginCss = CSS_ID
      tag.textContent = CARD_CSS
      document.head.appendChild(tag)
    }

    // ---- 小工具 ----
    function formatNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      return value.toFixed(value >= 100 ? 0 : 2).replace(/\.00$/u, '')
    }

    function compactTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
      if (value >= 1_048_576) return (value / 1_048_576).toFixed(value % 1_048_576 === 0 ? 0 : 1) + 'M'
      if (value >= 1024) return Math.round(value / 1024) + 'K'
      return String(value)
    }

    function clockOf(timestamp) {
      if (typeof timestamp !== 'number' || timestamp <= 0) return '—'
      const date = new Date(timestamp)
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      const hour = String(date.getHours()).padStart(2, '0')
      const minute = String(date.getMinutes()).padStart(2, '0')
      return month + '/' + day + ' ' + hour + ':' + minute
    }

    function relativeTime(timestamp, t) {
      if (typeof timestamp !== 'number' || timestamp <= 0) return '—'
      const delta = Date.now() - timestamp
      if (delta < 60_000) return t('time.justNow')
      if (delta < 3_600_000) return t('time.minutes', { n: Math.floor(delta / 60_000) })
      if (delta < 86_400_000) return t('time.hours', { n: Math.floor(delta / 3_600_000) })
      return clockOf(timestamp)
    }

    /**
     * 账号的**显示名**。
     *
     * 果办给的身份是 `iam::<domainId>:user:<name>` 这种长串，直接铺在表格里会把
     * 「当前使用」徽章和积分列一起挤走（实测截图里账号名占了半行）。这里只取
     * `user:` 之后的部分，没有这个形状就退回最后一个 `:` 之后。
     *
     * 注意这只改**显示**：账号 id 仍然是完整串，用于去重、排序与请求选号。
     */
    function displayNameOf(label) {
      const text = String(label ?? '').trim()
      if (text === '') return ''
      const afterUser = /:user:(.+)$/u.exec(text)
      if (afterUser !== null) return afterUser[1]
      const afterColon = /:([^:]+)$/u.exec(text)
      if (afterColon !== null && text.includes(':')) return afterColon[1]
      return text
    }

    /**
     * 把两个平台形状不同的积分口径归一成 {total, used, remain}。
     *
     *   码道：{ total: {total, used, remain}, bonus, basic, ... }
     *   果办：{ total: number, used: number, remain: number, groups: [...] }
     */
    function creditNumbers(credits) {
      if (credits === undefined || credits === null) return undefined
      const group = credits.total
      if (group !== undefined && group !== null && typeof group === 'object') {
        return { total: group.total, used: group.used, remain: group.remain }
      }
      if (typeof credits.total === 'number' || typeof credits.remain === 'number') {
        return { total: credits.total, used: credits.used, remain: credits.remain }
      }
      return undefined
    }

    /**
     * 最近一个过期时间。
     *
     * 两个平台的字段不同：码道给额度周期（periodEnd）与积分包到期，
     * 果办给订阅到期（expiresAt）与每个积分包自己的 expiresAt。
     * 取能解析出日期里最早的那个——用户想知道的是"什么时候会掉"，不是"最晚什么时候"。
     */
    function nearestExpiry(credits) {
      if (credits === undefined || credits === null) return undefined
      const candidates = []
      const push = (value) => {
        if (typeof value === 'string' && value.trim() !== '') candidates.push(value)
      }
      push(credits.expiresAt)
      push(credits.periodEnd)
      for (const group of Array.isArray(credits.groups) ? credits.groups : []) push(group.expiresAt)
      if (candidates.length === 0) return undefined
      const sorted = candidates
        .map((text) => ({ text, at: Date.parse(text) }))
        .filter((entry) => Number.isFinite(entry.at))
        .sort((a, b) => a.at - b.at)
      if (sorted.length === 0) return candidates[0]
      return sorted[0].text
    }

    /** 一个账号在卡片上的状态文案与色调。 */
    function accountState(account, t) {
      if (account.hasCredential === false) {
        return { text: t('state.disabled'), tone: 'bad', reason: account.syncError || '' }
      }
      if (account.disabled === true) {
        return {
          text: t('state.disabledFor', { min: Math.max(1, Math.ceil((account.disabledRemainingMs || 0) / 60_000)) }),
          tone: 'bad',
          reason: account.lastError || '',
        }
      }
      if (account.cooling === true) {
        return {
          text: t('state.cooling', { sec: Math.max(1, Math.ceil((account.cooldownRemainingMs || 0) / 1000)) }),
          tone: 'warn',
          reason: account.lastError || '',
        }
      }
      return { text: t('state.ready'), tone: 'ok', reason: '' }
    }

    // ---- 组件 ----
    function BusyOverlay(props) {
      return h(
        'div',
        { className: 'dsm-hwc-veil', role: 'status', 'aria-live': 'polite' },
        h(
          'div',
          { className: 'dsm-hwc-veil-card' },
          h('div', { className: 'dsm-hwc-veil-text' }, props.text),
          props.hint === undefined ? null : h('div', { className: 'dsm-hwc-veil-hint' }, props.hint),
        ),
      )
    }

    function DiagRow(props) {
      return h(
        'div',
        { className: 'dsm-hwc-diag-row' },
        h('span', { className: 'dsm-hwc-diag-label' }, props.label),
        h(
          'span',
          { className: 'dsm-hwc-diag-value' + (props.mono === true ? ' dsm-hwc-diag-mono' : '') + (props.bad === true ? ' dsm-hwc-diag-bad' : '') },
          props.children,
        ),
      )
    }

    function dotStyle(tone) {
      const color =
        tone === 'ok' ? 'var(--dsw-alias-state-success-primary,#22c55e)'
          : tone === 'warn' ? 'var(--dsw-alias-state-warn-primary,#f59e0b)'
            : tone === 'bad' ? 'var(--dsw-alias-state-error-primary,#ef4444)'
              : 'var(--dsw-alias-label-tertiary,#999)'
      return { background: color }
    }

    /** 顶栏一格：供应商名 + 该平台的账号池开关。 */
    function RegionCell(props) {
      const { label, active, tone, poolOn, onSelect, onTogglePool, t, busy } = props
      return h(
        'div',
        { className: 'dsm-hwc-tab-cell' },
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': active,
            className: 'dsm-hwc-tab' + (active ? ' dsm-hwc-tab-active' : ''),
            onClick: onSelect,
            title: label,
          },
          h('span', { 'aria-hidden': 'true', className: 'dsm-hwc-tab-dot', style: dotStyle(tone) }),
          label,
        ),
        h(
          'label',
          { className: 'dsm-hwc-tab-switch', title: t('tab.switchPool') },
          h('input', {
            type: 'checkbox',
            checked: poolOn,
            disabled: busy !== '',
            'aria-label': t('tab.switchPool') + ' — ' + label,
            onChange: (event) => onTogglePool(event.target.checked),
          }),
        ),
      )
    }

    /** 账号表格的一行。 */
    function AccountRow(props) {
      const { account, platform, checked, index, total, current, poolOn, slots, onToggle, onMove, onRemove, onTest, t, busy } = props
      const state = accountState(account, t)
      const numbers = creditNumbers(account.credits)
      const expiry = nearestExpiry(account.credits)
      const slot = Array.isArray(slots) ? slots.find((entry) => entry.accountId === account.id) : undefined
      return h(
        'div',
        { className: 'dsm-hwc-pool-row' + (current ? ' dsm-hwc-pool-row-current' : '') },
        h(
          'span',
          { className: 'dsm-hwc-pool-account' },
          h(
            'label',
            { className: 'dsm-hwc-pool-check' },
            h('input', {
              type: 'checkbox',
              checked,
              disabled: busy !== '' || !poolOn,
              title: poolOn ? '' : t('pool.disabled'),
              'aria-label': displayNameOf(account.label),
              onChange: (event) => onToggle(event.target.checked),
            }),
          ),
          h('span', { className: 'dsm-hwc-usage-dot', style: dotStyle(state.tone), 'aria-hidden': 'true' }),
          h(
            'span',
            { className: 'dsm-hwc-pool-account-name' },
            h(
              'span',
              { className: 'dsm-hwc-pool-name-row' },
              h('b', { title: account.label }, displayNameOf(account.label)),
              current ? h('span', { className: 'dsm-hwc-pool-current-tag' }, t('pool.currentBadge')) : null,
              checked ? null : h('span', { className: 'dsm-hwc-pool-not-member' }, t('pool.notMember')),
            ),
            h(
              'span',
              { className: 'dsm-hwc-pool-order' },
              h('span', { className: 'dsm-hwc-pool-rank dsm-hwc-pool-rank-auto' }, poolOn ? t('pool.auto') : t('pool.manual')),
              h(
                'span',
                { className: 'dsm-hwc-pool-move' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-hwc-pool-move-btn',
                    disabled: busy !== '' || index === 0,
                    title: t('act.up'),
                    'aria-label': t('act.up'),
                    onClick: () => onMove(-1),
                  },
                  '↑',
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-hwc-pool-move-btn',
                    disabled: busy !== '' || index === total - 1,
                    title: t('act.down'),
                    'aria-label': t('act.down'),
                    onClick: () => onMove(1),
                  },
                  '↓',
                ),
              ),
              h(
                'span',
                { className: 'dsm-hwc-subtle-text' },
                account.syncedAt === undefined ? '' : t('state.testedAt', { at: clockOf(account.syncedAt) }),
              ),
            ),
          ),
        ),
        h(
          'span',
          { className: 'dsm-hwc-credit-cell' },
          numbers === undefined
            ? h('span', null, t('pool.creditsNone'))
            : h('span', null, h('b', null, formatNumber(numbers.remain)), h('span', { className: 'dsm-hwc-subtle-text' }, ' / ' + formatNumber(numbers.total))),
          expiry === undefined ? null : h('span', { className: 'dsm-hwc-pool-soon-plain' }, t('pool.creditsExpireAt', { at: expiry })),
        ),
        h(
          'span',
          { className: 'dsm-hwc-pool-probe' },
          h('span', { className: 'dsm-hwc-pool-probe-main' }, state.text),
          // 原因完整显示（换行而非截断）：网关失败的 error_code 往往在后半句，
          // 截成 60 字就只剩"模型网关接口 401："，等于没说。
          state.reason === ''
            ? null
            : h('span', { className: 'dsm-hwc-pool-reason', title: state.reason }, state.reason),
        ),
        platform === 'codearts'
          ? h(
              'span',
              { className: 'dsm-hwc-pool-checkin' },
              slot === undefined ? '—' : t('caps.slotsNow', { used: slot.used, limit: slot.limit }),
            )
          : h('span', { className: 'dsm-hwc-pool-checkin' }, '—'),
        h(
          'span',
          { className: 'dsm-hwc-pool-row-actions' },
          h(
            'button',
            { type: 'button', className: 'dsm-hwc-btn dsm-hwc-btn-outline dsm-hwc-pool-small-btn', disabled: busy !== '', onClick: onTest },
            t('act.test'),
          ),
          h(
            'button',
            { type: 'button', className: 'dsm-hwc-btn dsm-hwc-btn-outline dsm-hwc-pool-small-btn', disabled: busy !== '', onClick: onRemove },
            t('act.remove'),
          ),
        ),
      )
    }

    /**
     * 一行模型：与 dsh-connect-workbuddy 的模型面板同形（图3）。
     *
     * 第一段（head）：[☑ 名字 x倍率 徽章] ................ [□ 图片] [□ 可关闭思考] [○200K ○500K ◉1M] [测试] [测速]
     * 第二段（details）：最大上下文 …  最大输出 …  默认推理强度 [档位 ▾]
     *
     * 为什么要两段：名称与它的开关属于"这是什么模型"，上下文/输出/推理档属于
     * "它怎么跑"。挤成一条网格时，名字一长就把后面的数字推到换行，整列读起来
     * 像一段散文——这正是上一版被压成窄列的原因之一。
     */
    function ModelRow(props) {
      const { model, on, images, onToggle, onToggleImage, onTest, onBudget, budget, busy, t } = props
      // displayName 由宿主算好（含倍率后缀），与选择器里显示的名字完全一致。
      const name = model.displayName || model.name || model.id
      const showId = model.name !== undefined && model.name !== model.id
      /**
       * 上下文预算三档：200K / 500K / 模型原生窗口。
       *
       * 选中值来自 `budget`（status 的 contextBudgets 里这一项）：
       *   - 有值 → 选中该档；
       *   - 没有 → 选中原生那一档（因为 DSH 拿到的正是原生窗口）。
       *
       * 之前这里把 `activeBudget` 硬算成 native、并把 input 设成 `disabled`，
       * 于是三个单选永远停在 256K 且谁都点不动——那是个 bug，不是设计。
       */
      const native = model.contextWindow
      /**
       * 上下文预算档位。
       *
       * 四档：200K / 500K / 1M / 默认窗口。
       *
       * 这里**不按模型窗口过滤固定档**：上游根本不提供真实窗口（果办 /models 只有
       * id/object/created/owned_by，码道目录也没有该字段），目录里的 256K 是我们
       * 自己选的保守默认值，不是物理上限。用实现细节去否决用户的选择，等于
       * 把"上游可能超时"这件事替他决定了。
       *
       * 默认档与某个固定档数值相同时只保留一个，避免出现两个同值选项。
       */
      const FIXED_BUDGETS = [
        { key: 204800, label: '200K' },
        { key: 512000, label: '500K' },
        { key: 1048576, label: '1M' },
      ]
      const budgets = [
        ...FIXED_BUDGETS.filter((tier) => tier.key !== native),
        { key: native, label: t('models.budgetDefault', { n: compactTokens(native) }) },
      ]
      const activeBudget = typeof budget === 'number' && budget > 0 ? budget : native
      /**
       * 真正生效的上下文窗口 = 选中的那一档。
       *
       * 之前这里直接渲染 `model.contextWindow`（目录里的保守默认值 262144），于是
       * 用户选了 1M，底部仍写「最大上下文 256K」——读起来像是选择没生效。其实
       * 生效了：adapter 的 `toPiModel` 就是拿这个 budget 覆盖 `contextWindow` 的。
       * 显示层跟着改，才不会自己打自己的脸。
       */
      const effectiveContext = activeBudget
      const budgetCustomised = activeBudget !== native
      return h(
        'div',
        { className: 'dsm-hwc-m-model' + (on ? '' : ' dsm-hwc-m-model-disabled') },
        // ---- 第一段：名称 + 右侧开关组 ----
        h(
          'div',
          { className: 'dsm-hwc-m-model-head' },
          h(
            'label',
            { className: 'dsm-hwc-m-model-enabled', title: t('models.enableHint') },
            h('input', { type: 'checkbox', checked: on, onChange: (event) => onToggle(event.target.checked) }),
            h(
              'span',
              { className: 'dsm-hwc-m-model-copy' },
              h(
                'span',
                { className: 'dsm-hwc-m-model-name', title: model.id },
                name,
                showId ? h('span', { className: 'dsm-hwc-m-model-name-rate' }, model.id) : null,
              ),
            ),
          ),
          h(
            'div',
            { className: 'dsm-hwc-m-model-switches' },
            h(
              'label',
              { className: 'dsm-hwc-m-model-image', title: t('models.imageHint') },
              h('input', { type: 'checkbox', checked: images, onChange: (event) => onToggleImage(event.target.checked) }),
              t('models.images'),
            ),
            // 上下文预算：三个单选，**可点**。选中值来自 status 的 contextBudgets；
            // 表里没有这一项 = 用原生窗口，所以此时原生那一档是选中的。
            h(
              'span',
              { className: 'dsm-hwc-m-budget', title: t('models.budgetHint') },
              ...budgets.map((option) =>
                h(
                  'label',
                  { key: String(option.key), className: 'dsm-hwc-m-budget-opt' },
                  h('input', {
                    type: 'radio',
                    name: 'budget-' + model.id,
                    checked: activeBudget === option.key,
                    disabled: busy !== '',
                    title: t('models.budgetHint'),
                    // 选「原生」= 传 null（宿主会删掉这一项），其余传具体 token 数。
                    onChange: () => onBudget(option.key === native ? null : option.key),
                  }),
                  option.label,
                ),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsm-hwc-btn dsm-hwc-btn-outline dsm-hwc-m-model-probe',
                disabled: busy !== '',
                title: t('models.probeHint'),
                onClick: onTest,
              },
              t('act.test'),
            ),
          ),
        ),
        // ---- 第二段：能力数字 ----
        h(
          'div',
          { className: 'dsm-hwc-m-model-details' },
          h(
            'span',
            { className: 'dsm-hwc-m-model-meta' },
            h(
              'span',
              null,
              t('models.maxContext') +
                ' ' +
                compactTokens(effectiveContext) +
                // 选了非默认档时，把保守默认值作为参考缀在后面：用户既能看到"现在是 1M"，
                // 也能看到"插件的保守默认是 256K"，不会以为两者矛盾。
                (budgetCustomised ? t('models.contextDefaultSuffix', { n: compactTokens(native) }) : ''),
            ),
            h('span', null, t('models.maxOutput') + ' ' + compactTokens(model.maxTokens)),
            images ? null : h('span', { className: 'dsm-hwc-m-model-id' }, t('models.textOnly')),
          ),
        ),
      )
    }

    function HuaweiCard(props) {
      const { t } = props

      const [status, setStatus] = useState(undefined)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [error, setError] = useState('')
      const [tab, setTab] = useState('')
      const [panel, setPanel] = useState('accounts')
      /** 默认展开：这张卡的全部内容都是状态读数，折叠着就没有意义了。 */
      const [open, setOpen] = useState(true)
      const [drafts, setDrafts] = useState({})
      const [imageDrafts, setImageDrafts] = useState({})
      const [search, setSearch] = useState('')
      const [filter, setFilter] = useState('all')
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const load = useCallback(async () => {
        try {
          const response = await fetch(ROUTE + '/status')
          if (!response.ok) throw new Error('status ' + response.status)
          const next = await response.json()
          if (!alive.current) return
          setStatus(next)
          setError('')
          // 没编辑过的栏目用宿主的值填充；改过但还没保存的草稿不被轮询覆盖。
          setDrafts((previous) => {
            const merged = { ...previous }
            for (const row of next.platforms ?? []) {
              if (merged[row.platform] === undefined) merged[row.platform] = Array.isArray(row.enabled) ? row.enabled : []
            }
            return merged
          })
          setImageDrafts((previous) => {
            const merged = { ...previous }
            for (const row of next.platforms ?? []) {
              if (merged[row.platform] === undefined) merged[row.platform] = { ...(row.images ?? {}) }
            }
            return merged
          })
        } catch (cause) {
          if (alive.current) setError(String(cause))
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => void load(), 60_000)
        return () => clearInterval(timer)
      }, [load])

      const call = useCallback(async (path, body, method) => {
        const response = await fetch(path, {
          method: method ?? (body === undefined ? 'GET' : 'POST'),
          ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error ?? 'HTTP ' + response.status)
        return payload
      }, [])

      const run = useCallback(
        async (key, work) => {
          setBusy(key)
          setNotice('')
          setError('')
          try {
            await work()
          } catch (cause) {
            setError(String(cause))
          } finally {
            setBusy('')
          }
        },
        [],
      )

      const onSync = useCallback(
        () =>
          run('sync', async () => {
            const result = await call(ROUTE + '/sync', {})
            if (result.status) setStatus(result.status)
            const total = (result.codearts?.accounts ?? 0) + (result.officeace?.accounts ?? 0)
            setNotice(t('err.syncOk', { n: total }))
            await load()
          }),
        [call, load, run, t],
      )

      const onRefreshModels = useCallback(
        () =>
          run('refresh', async () => {
            const result = await call(ROUTE + '/refresh-models', {})
            if (result.status) setStatus(result.status)
            setNotice(t('act.saved'))
          }),
        [call, run, t],
      )

      const onLogin = useCallback(
        (platform) =>
          run('login:' + platform, async () => {
            const started = await call(ROUTE + '/login', { platform })
            if (typeof window !== 'undefined' && started.authorizeUrl) {
              window.open(started.authorizeUrl, '_blank', 'noopener')
            }
            const deadline = Date.now() + 5 * 60 * 1000
            for (;;) {
              await new Promise((resolve) => setTimeout(resolve, 2000))
              const state = await call(ROUTE + '/login/status?platform=' + encodeURIComponent(platform))
              if (state.last && state.last.ok) {
                // 登录成功但差一步（果办的模型网关没取到）：如实报出来，
                // 否则用户看到"登录成功了"却依然用不了，只能反复重登。
                if (typeof state.last.warning === 'string' && state.last.warning !== '') {
                  setNotice(t('err.loginPartial', { message: state.last.warning }))
                } else {
                  setNotice(t('act.saved'))
                }
                await load()
                return
              }
              if (state.last && state.last.ok === false) {
                throw new Error(t('err.loginFailed', { message: state.last.message || '' }))
              }
              if (Date.now() > deadline) throw new Error(t('err.loginTimeout'))
            }
          }),
        [call, load, run, t],
      )

      const togglePool = useCallback(
        (platform, enabled) =>
          run('pool:' + platform, async () => {
            const result = await call(ROUTE + '/pool', { platform, enabled })
            if (result.status) setStatus(result.status)
            setNotice(enabled ? t('pool.enabled') : t('pool.disabled'))
          }),
        [call, run, t],
      )

      const removeAccount = useCallback(
        (platform, id) =>
          run('remove:' + id, async () => {
            await call(ROUTE + '/accounts?platform=' + encodeURIComponent(platform) + '&id=' + encodeURIComponent(id), undefined, 'DELETE')
            await load()
          }),
        [call, load, run],
      )

      /** 账号池成员勾选：整份清单一起写，避免连点时后一次覆盖前一次。 */
      const setMembers = useCallback(
        (platform, members) =>
          run('members:' + platform, async () => {
            const result = await call(ROUTE + '/pool-members', { platform, members })
            if (result.status) setStatus(result.status)
          }),
        [call, run],
      )

      const toggleMember = useCallback(
        (platform, row, id, next) => {
          // 宿主的 poolMembers 有三种取值：null（不限制，全部参与）、数组（只这些）、
          // 空数组（一个都不参与）。null 要先展开成"当前全部账号"再改，否则第一次
          // 取消勾选会被当成"清单从 null 变成 [id]"，语义正好反过来。
          const all = (row?.accounts ?? []).map((account) => account.id)
          const declared = row?.poolMembers
          const current = Array.isArray(declared) ? declared : all
          const value = next ? [...current, id] : current.filter((entry) => entry !== id)
          void setMembers(platform, [...new Set(value)])
        },
        [setMembers],
      )

      /**
       * 上下文预算：**立即生效**，不走保存按钮。
       *
       * 理由：这个值决定 DSH 何时压缩对话，属于"运行时参数"而不是"目录草稿"。
       * 放进草稿态会让用户以为点了保存才生效，而实际上它影响的是下一次请求。
       * `null` = 回到原生窗口（宿主侧会删掉这一项，而不是写一个固定数字）。
       */
      const onBudget = useCallback(
        (platform, modelId, budget) =>
          run('budget:' + modelId, async () => {
            const result = await call(ROUTE + '/context-budget', { platform, model: modelId, budget })
            if (result.status) setStatus(result.status)
          }),
        [call, run],
      )

      /** 保存：模型勾选与图片开关一起写，切到另一栏再按保存也不丢改动。 */
      const onSave = useCallback(
        () =>
          run('save', async () => {
            const enabled = {}
            for (const row of status?.platforms ?? []) enabled[row.platform] = drafts[row.platform] ?? row.enabled ?? []
            await call(ROUTE + '/enabled-models', { enabled })
            for (const row of status?.platforms ?? []) {
              const platform = row.platform
              const draft = imageDrafts[platform] ?? {}
              const baseline = row.images ?? {}
              const ids = new Set([...Object.keys(draft), ...Object.keys(baseline)])
              for (const id of ids) {
                if (draft[id] === baseline[id]) continue
                if (draft[id] === undefined) continue
                await call(ROUTE + '/images', { platform, model: id, enabled: draft[id] === true })
              }
            }
            setNotice(t('act.saved'))
            await load()
          }),
        [call, drafts, imageDrafts, load, run, status, t],
      )

      const moveAccount = useCallback(
        (platform, index, delta) =>
          run('order:' + platform, async () => {
            const row = (status?.platforms ?? []).find((entry) => entry.platform === platform)
            const ids = (row?.accounts ?? []).map((account) => account.id)
            const target = index + delta
            if (target < 0 || target >= ids.length) return
            const next = [...ids]
            const [moved] = next.splice(index, 1)
            next.splice(target, 0, moved)
            const result = await call(ROUTE + '/account-order', { platform, order: next })
            if (result.status) setStatus(result.status)
          }),
        [call, run, status],
      )

      const platforms = status?.platforms ?? []
      const activeTab = tab !== '' && platforms.some((row) => row.platform === tab) ? tab : (platforms.length > 0 ? platforms[0].platform : '')
      const active = platforms.find((row) => row.platform === activeTab)
      /**
       * 这个平台有没有可用账号。
       *
       * 与适配器的 hasAccount 是同一个判据（有凭证才算），因为两边必须一致：
       * 选择器里不列、卡片里却列，用户勾了也选不到；反过来卡片不列、选择器却列，
       * 就会出现"我从没勾过它，选择器里却有"。
       */
      const hasUsableAccount =
        active !== undefined && (active.accounts ?? []).some((account) => account.hasCredential !== false)
      const models = active?.models?.models ?? []
      const enabledDraft = active === undefined ? [] : Array.isArray(drafts[active.platform]) ? drafts[active.platform] : active.enabled ?? []
      const enabledSet = new Set(enabledDraft)
      const imagesDraft = active === undefined ? {} : imageDrafts[active.platform] ?? {}
      const imageOf = (model) => (typeof imagesDraft[model.id] === 'boolean' ? imagesDraft[model.id] : model.supportsImages === true)

      const filteredModels = useMemo(() => {
        const needle = search.trim().toLowerCase()
        return models.filter((model) => {
          if (filter === 'on' && !enabledSet.has(model.id)) return false
          if (filter === 'image' && !imageOf(model)) return false
          if (needle === '') return true
          return (model.name || '').toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle)
        })
      }, [models, filter, search, enabledDraft, imagesDraft])

      const toneOf = (row) => {
        if (row === undefined) return 'idle'
        if ((row.accounts ?? []).length === 0) return 'warn'
        if (row.creditsError !== undefined) return 'warn'
        const broken = (row.accounts ?? []).some((account) => account.hasCredential === false || account.disabled === true)
        return broken ? 'bad' : 'ok'
      }

      const busyText =
        busy === '' ? ''
          : busy === 'sync' ? t('act.syncing')
            : busy === 'refresh' ? t('act.refreshing')
              : busy === 'save' ? t('act.saving')
                : busy.startsWith('login:') ? t('act.loggingIn')
                  : t('act.saving')

      // ---- 顶栏 ----
      const header = h(
        'div',
        { className: 'dsm-hwc-tabs', role: 'tablist', 'aria-label': t('card.title') },
        ...platforms.map((row) =>
          h(RegionCell, {
            key: row.platform,
            label: row.displayName,
            active: row.platform === activeTab,
            tone: toneOf(row),
            poolOn: row.poolEnabled === true,
            onSelect: () => setTab(row.platform),
            onTogglePool: (enabled) => void togglePool(row.platform, enabled),
            t,
            busy,
          }),
        ),
      )

      // ---- 面板 tab ----
      const panels = h(
        'div',
        { className: 'dsm-hwc-panels', role: 'tablist', 'aria-label': t('card.title') },
        ...[
          ['accounts', t('panel.accounts')],
          ['models', t('panel.models')],
          ['caps', t('panel.caps')],
          ['diag', t('panel.diag')],
        ].map(([key, label]) =>
          h(
            'button',
            {
              key,
              type: 'button',
              role: 'tab',
              'aria-selected': panel === key,
              className: 'dsm-hwc-panel-tab' + (panel === key ? ' dsm-hwc-panel-tab-active' : ''),
              onClick: () => setPanel(key),
            },
            label,
          ),
        ),
      )

      // ---- 账号面板 ----
      //
      // 结构与 dsh-connect-workbuddy 对齐：标题行 → 账号池开关框 → 成员计数与
      // 全选/全不选 → 操作行 → 表格 → 虚线工具条。用户在两个连接器插件之间切换时
      // 不该重新学一遍"开关在哪、全选在哪、表格的列怎么读"。
      const memberCount = (active?.accounts ?? []).filter((account) => account.poolMember !== false).length
      const totalAccounts = (active?.accounts ?? []).length
      const slotsBusy =
        active?.platform === 'codearts' &&
        Array.isArray(active.sessions) &&
        active.sessions.length > 0 &&
        active.sessions.every((slot) => slot.used >= slot.limit)

      const accountsPanel =
        active === undefined
          ? null
          : h(
              'section',
              { className: 'dsm-hwc-pool' },
              // 标题行：左边「账号池」，右边当前服务的账号（短名）。
              h(
                'div',
                { className: 'dsm-hwc-pool-head' },
                h('h3', { className: 'dsm-hwc-pool-title' }, t('pool.title')),
                active.activeAccount === undefined
                  ? null
                  : h(
                      'span',
                      { className: 'dsm-hwc-pool-current-badge', title: active.activeAccount.label },
                      t('pool.current', { account: displayNameOf(active.activeAccount.label) }),
                    ),
              ),
              // 账号池开关框：整个框是一个带开关的说明区，与 workbuddy 同形。
              h(
                'div',
                { className: 'dsm-hwc-pool-settings dsm-hwc-pool-modebar' },
                h(
                  'div',
                  { className: 'dsm-hwc-pool-modebar-row' },
                  h(
                    'label',
                    { className: 'sw', title: t('pool.toggleHint') },
                    h('input', {
                      type: 'checkbox',
                      checked: active.poolEnabled === true,
                      disabled: busy !== '',
                      'aria-label': t('pool.toggle'),
                      onChange: (event) => void togglePool(active.platform, event.target.checked),
                    }),
                    h('span', { className: 'sw-track' }),
                  ),
                  h('b', { className: 'dsm-hwc-pool-modebar-label' }, t('pool.toggle')),
                  h(
                    'span',
                    { className: 'dsm-hwc-pool-modebar-state' },
                    active.poolEnabled === true ? t('pool.modeAuto') : t('pool.modeManual'),
                  ),
                ),
                h('p', { className: 'dsm-hwc-pool-note' }, active.poolEnabled ? t('pool.enabledHint') : t('pool.hint')),
              ),
              // 成员头：计数 + 全选 / 全不选。
              h(
                'div',
                { className: 'dsm-hwc-pool-members-head' },
                h(
                  'div',
                  null,
                  h('h4', { className: 'dsm-hwc-pool-members-title' }, t('pool.membersTitle')),
                  h('p', { className: 'dsm-hwc-pool-note' }, t('pool.membersHint')),
                ),
                h(
                  'div',
                  { className: 'dsm-hwc-pool-members-actions' },
                  h('span', { className: 'dsm-hwc-pool-hint' }, t('pool.selectedCount', { n: memberCount, total: totalAccounts })),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsm-hwc-btn dsm-hwc-btn-outline',
                      disabled: busy !== '' || active.poolEnabled !== true || totalAccounts === 0,
                      title: t('pool.selectAllHint'),
                      // null = 不限制（全部参与）。用 null 而不是 []，否则和「全不选」撞车。
                      onClick: () => void setMembers(active.platform, null),
                    },
                    t('pool.selectAll'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsm-hwc-btn dsm-hwc-btn-outline',
                      disabled: busy !== '' || active.poolEnabled !== true || totalAccounts === 0,
                      title: t('pool.selectNoneHint'),
                      onClick: () => void setMembers(active.platform, []),
                    },
                    t('pool.selectNone'),
                  ),
                ),
              ),
              // 操作行：左边是"同步 / 刷新模型 / 扫码登录"，右边是"重新检测账号"。
              h(
                'div',
                { className: 'dsm-hwc-pool-actions' },
                h(
                  'div',
                  { className: 'dsm-hwc-pool-actions-group' },
                  h(
                    'button',
                    { type: 'button', className: 'dsm-hwc-btn dsm-hwc-btn-primary', disabled: busy !== '', onClick: onSync },
                    busy === 'sync' ? t('act.syncing') : t('act.sync'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dsm-hwc-btn dsm-hwc-btn-outline', disabled: busy !== '', onClick: onRefreshModels },
                    busy === 'refresh' ? t('act.refreshing') : t('act.refreshModels'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dsm-hwc-btn dsm-hwc-btn-outline', disabled: busy !== '', onClick: () => void onLogin(active.platform) },
                    busy === 'login:' + active.platform ? t('act.loggingIn') : t('act.login'),
                  ),
                ),
                h(
                  'div',
                  { className: 'dsm-hwc-pool-actions-group' },
                  h(
                    'button',
                    { type: 'button', className: 'dsm-hwc-btn dsm-hwc-btn-outline', disabled: busy !== '', onClick: onSync },
                    t('act.rescan'),
                  ),
                ),
              ),
              slotsBusy ? h('p', { className: 'dsm-hwc-pool-warn' }, t('caps.slotsBusy')) : null,
              (active.accounts ?? []).length === 0
                ? h('p', { className: 'dsm-hwc-pool-warn' }, t('pool.noAccount'))
                : h(
                    'div',
                    { className: 'dsm-hwc-pool-table' },
                    h(
                      'div',
                      { className: 'dsm-hwc-pool-row dsm-hwc-pool-row-head' },
                      h('span', null, t('pool.columnAccount')),
                      h('span', null, t('pool.columnCredits')),
                      h('span', null, t('pool.columnProbe')),
                      h('span', null, active.platform === 'codearts' ? t('pool.columnSlots') : ''),
                      h('span', null),
                    ),
                    ...(active.accounts ?? []).map((account, index) =>
                      h(AccountRow, {
                        key: account.id,
                        account,
                        platform: active.platform,
                        index,
                        total: (active.accounts ?? []).length,
                        current: active.activeAccount?.id === account.id,
                        poolOn: active.poolEnabled === true,
                        slots: active.sessions,
                        checked: account.poolMember !== false,
                        onToggle: (next) => toggleMember(active.platform, active, account.id, next),
                        onMove: (delta) => void moveAccount(active.platform, index, delta),
                        onRemove: () => void removeAccount(active.platform, account.id),
                        onTest: () =>
                          void run('test:' + account.id, async () => {
                            // 走积分接口探测：它同样要过鉴权，能返回数字就证明凭证是活的，
                            // 而它不消耗对话额度——用聊天接口探测等于替用户烧一次配额。
                            const result = await call(ROUTE + '/probe', { platform: active.platform, id: account.id })
                            if (result.status) setStatus(result.status)
                            setNotice(
                              result.ok === true
                                ? t('act.probeOk', { account: displayNameOf(account.label) })
                                : t('act.probeFailed', { account: displayNameOf(account.label), message: result.message ?? '' }),
                            )
                          }),
                        t,
                        busy,
                      }),
                    ),
                  ),
              // 虚线工具条：与 workbuddy 的「扫码登录 / 导出账号 / 导入账号」同位置同形状。
              h(
                'div',
                { className: 'dsm-hwc-pool-tools' },
                h(
                  'button',
                  { type: 'button', className: 'dsm-hwc-btn dsm-hwc-btn-outline', disabled: busy !== '', onClick: () => void onLogin(active.platform) },
                  t('act.login'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-hwc-btn dsm-hwc-btn-outline',
                    disabled: busy !== '',
                    title: t('act.exportHint'),
                    onClick: () => void run('export', async () => {
                      // 只导出**非机密**字段：凭证永远不出本机。
                      const rows = (active.accounts ?? []).map((account) => ({
                        platform: active.platform,
                        id: account.id,
                        label: account.label,
                      }))
                      const blob = new Blob([JSON.stringify({ version: 1, accounts: rows }, null, 2)], { type: 'application/json' })
                      const url = URL.createObjectURL(blob)
                      const anchor = document.createElement('a')
                      anchor.href = url
                      anchor.download = 'dsh-connect-huawei-accounts.json'
                      anchor.click()
                      URL.revokeObjectURL(url)
                      setNotice(t('act.exportDone', { n: rows.length }))
                    }),
                  },
                  t('act.export'),
                ),
                h('span', { className: 'dsm-hwc-pool-hint' }, t('act.importHint')),
              ),
              h('p', { className: 'dsm-hwc-pool-note' }, t('pool.orderHint')),
              active.creditsError === undefined
                ? null
                : h('p', { className: 'dsm-hwc-pool-error' }, t('err.credits', { message: active.creditsError })),
            )

      // ---- 模型面板 ----
      const modelsPanel =
        active === undefined
          ? null
          : hasUsableAccount !== true
            ? // 没有账号：整栏换成一句可照做的提示，而不是列出缓存目录。
              // 列出模型的唯一含义是"这些你可以选"，而这个平台此刻一个请求都发不出去。
              h(
                'section',
                { className: 'dsm-hwc-models' },
                h(
                  'div',
                  { className: 'dsm-hwc-models-head' },
                  h(
                    'div',
                    { className: 'dsm-hwc-models-title-row' },
                    h('h3', { className: 'dsm-hwc-models-title' }, t('models.title')),
                  ),
                ),
                h('p', { className: 'dsm-hwc-pool-warn' }, t('models.noAccount', { platform: active.displayName })),
                h('p', { className: 'dsm-hwc-models-summary' }, t('models.noAccountHint')),
              )
            : h(
              'section',
              { className: 'dsm-hwc-models' },
              h(
                'div',
                { className: 'dsm-hwc-models-head' },
                h(
                  'div',
                  { className: 'dsm-hwc-models-title-row' },
                  h('h3', { className: 'dsm-hwc-models-title' }, t('models.title')),
                  h(
                    'span',
                    { className: 'dsm-hwc-pool-badge' },
                    t('models.total', { n: models.length }) + ' · ' + t('models.source' + (active.models?.source === 'upstream' ? 'Upstream' : active.models?.source === 'cache' ? 'Cache' : 'Seed')),
                  ),
                ),
                h(
                  'div',
                  { className: 'dsm-hwc-m-models-head-actions' },
                  h('input', {
                    type: 'search',
                    className: 'dsm-hwc-search',
                    placeholder: t('models.search'),
                    value: search,
                    onChange: (event) => setSearch(event.target.value),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsm-hwc-btn dsm-hwc-btn-outline',
                      onClick: () => setDrafts((previous) => ({ ...previous, [active.platform]: models.map((model) => model.id) })),
                    },
                    t('models.selectAll'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dsm-hwc-btn dsm-hwc-btn-outline', onClick: () => setDrafts((previous) => ({ ...previous, [active.platform]: [] })) },
                    t('models.selectNone'),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'dsm-hwc-filter' },
                ...[
                  ['all', t('models.filterAll')],
                  ['on', t('models.filterOn')],
                  ['image', t('models.filterImage')],
                ].map(([key, label]) =>
                  h(
                    'button',
                    {
                      key,
                      type: 'button',
                      className: 'dsm-hwc-m-filter-chip' + (filter === key ? ' dsm-hwc-m-filter-chip-on' : ''),
                      style: { cursor: 'pointer' },
                      onClick: () => setFilter(key),
                    },
                    label,
                  ),
                ),
              ),
              h(
                'p',
                { className: 'dsm-hwc-models-summary' },
                enabledSet.size === 0 ? t('models.unrestricted') : t('models.chosen', { n: enabledSet.size }),
              ),
              h(
                'div',
                { className: 'dsm-hwc-model-scroll' },
                filteredModels.length === 0
                  ? h('p', { className: 'dsm-hwc-pool-note' }, t('models.empty'))
                  : h(
                      // 两段式行的外框：workbuddy 用一整个带边框的列表容器，
                      // 行与行之间用 1px 分隔线，而不是每行各画一个圆角块。
                      'div',
                      { className: 'dsm-hwc-m-model-list' },
                      ...filteredModels.map((model) =>
                        h(ModelRow, {
                          key: model.id,
                          model,
                          on: enabledSet.has(model.id),
                          images: imageOf(model),
                          onToggle: (next) =>
                            setDrafts((previous) => {
                              const current = Array.isArray(previous[active.platform])
                                ? previous[active.platform]
                                : Array.isArray(active.enabled)
                                  ? active.enabled
                                  : []
                              const value = next ? [...current, model.id] : current.filter((entry) => entry !== model.id)
                              return { ...previous, [active.platform]: [...new Set(value)] }
                            }),
                          onToggleImage: (next) =>
                            setImageDrafts((previous) => ({
                              ...previous,
                              [active.platform]: { ...(previous[active.platform] ?? {}), [model.id]: next },
                            })),
                          // 「测试」只探测这个模型在上游是否可解析，不发对话请求。
                          onTest: () =>
                            void run('model:' + model.id, async () => {
                              setNotice(t('models.probeRunning', { model: model.name || model.id }))
                              const result = await call(ROUTE + '/refresh-models', {})
                              if (result.status) setStatus(result.status)
                              const stillThere = (result.status?.platforms ?? [])
                                .find((row) => row.platform === active.platform)
                                ?.models?.models?.some((entry) => entry.id === model.id)
                              setNotice(
                                stillThere === true
                                  ? t('models.probeOk', { model: model.name || model.id })
                                  : t('models.probeGone', { model: model.name || model.id }),
                              )
                            }),
                          // 上下文预算：立即生效（见 onBudget 的注释）。
                          budget: (active.contextBudgets ?? {})[model.id],
                          onBudget: (next) => void onBudget(active.platform, model.id, next),
                          busy,
                          t,
                        }),
                      ),
                    ),
              ),
              h('p', { className: 'dsm-hwc-models-summary' }, t('models.hint')),
              h('p', { className: 'dsm-hwc-models-summary' }, t('models.imageHint')),
            )

      // ---- 能力面板 ----
      const slots = active?.sessions ?? []
      const capsPanel =
        active === undefined
          ? null
          : h(
              'section',
              { className: 'dsm-hwc-prefs' },
              active.platform === 'codearts'
                ? h(
                    'div',
                    { className: 'dsm-hwc-pool-set' },
                    h(
                      'span',
                      { className: 'dsm-hwc-pool-set-copy' },
                      h('b', null, t('caps.slotsTitle')),
                      h('span', null, t('caps.slotsBody')),
                      ...slots.map((slot) =>
                        h('span', { key: slot.accountId, className: 'dsm-hwc-models-summary' }, slot.accountId.slice(0, 8) + ' · ' + t('caps.slotsNow', { used: slot.used, limit: slot.limit })),
                      ),
                      slots.length > 0 && slots.every((slot) => slot.used >= slot.limit)
                        ? h('span', { className: 'dsm-hwc-pool-warn' }, t('caps.slotsBusy'))
                        : null,
                    ),
                  )
                : null,
              h(
                'div',
                { className: 'dsm-hwc-pool-set' },
                h('span', { className: 'dsm-hwc-pool-set-copy' }, h('b', null, t('caps.mediaTitle')), h('span', null, t('caps.mediaBody'))),
              ),
              active.platform === 'codearts'
                ? h(
                    'div',
                    { className: 'dsm-hwc-pool-set' },
                    h('span', { className: 'dsm-hwc-pool-set-copy' }, h('b', null, t('caps.proxyTitle')), h('span', null, t('caps.proxyBody'))),
                  )
                : null,
            )

      // ---- 诊断面板 ----
      const diagPanel =
        active === undefined
          ? null
          : h(
              'section',
              null,
              h(
                'div',
                { className: 'dsm-hwc-diag' },
                h(DiagRow, { label: t('diag.region') }, active.displayName),
                h(DiagRow, { label: t('diag.host'), mono: true }, active.platform === 'codearts' ? 'snap-access.cn-north-4.myhuaweicloud.com' : 'versatile.cn-north-4.myhuaweicloud.com'),
                h(DiagRow, { label: t('diag.active') }, active.activeAccount === undefined ? '—' : displayNameOf(active.activeAccount.label)),
                h(
                  DiagRow,
                  { label: t('diag.shim'), mono: true, bad: status?.shimBaseUrl === undefined },
                  status?.shimBaseUrl === undefined ? t('diag.shimDown') : status.shimBaseUrl,
                ),
                h(
                  DiagRow,
                  { label: t('diag.token') },
                  active.accounts !== undefined && active.accounts[0]?.tokenRemainingMs !== undefined
                    ? Math.max(0, Math.round(active.accounts[0].tokenRemainingMs / 60000)) + ' min'
                    : '—',
                ),
                h(DiagRow, { label: t('diag.models') }, String(models.length)),
                h(DiagRow, { label: t('diag.enabled') }, String(enabledSet.size === 0 ? models.length : enabledSet.size)),
                // 倍率表里填了几条。0 表示"上游不提供、内置表也还没填"，
                // 这样用户看到模型名后没有倍率时，能立刻知道原因而不是以为插件漏了。
                h(
                  DiagRow,
                  { label: t('diag.rates'), bad: (active.ratesKnown ?? 0) === 0 },
                  (active.ratesKnown ?? 0) === 0 ? t('diag.ratesNone') : t('diag.ratesCount', { n: active.ratesKnown }),
                ),
                h(
                  DiagRow,
                  { label: t('diag.pool') },
                  active.poolEnabled ? t('diag.poolOn', { n: (active.accounts ?? []).length }) : t('diag.poolOff'),
                ),
                active.platform === 'codearts'
                  ? h(
                      DiagRow,
                      { label: t('diag.slots') },
                      slots.length === 0
                        ? '—'
                        : slots.map((slot) => slot.used + '/' + slot.limit).join(' · '),
                    )
                  : null,
                h(
                  DiagRow,
                  { label: t('diag.creditsAt') },
                  active.creditsFetchedAt === undefined
                    ? '—'
                    : relativeTime(active.creditsFetchedAt, t) + (active.creditsStale ? ' ' + t('diag.creditsStale') : ''),
                ),
                h(
                  DiagRow,
                  { label: t('diag.lastFailure'), bad: active.creditsError !== undefined },
                  active.creditsError ?? t('diag.noFailure'),
                ),
              ),
              h('p', { className: 'dsm-hwc-diag-hint' }, t('diag.hint')),
            )

      const panelBody =
        panel === 'accounts' ? accountsPanel
          : panel === 'models' ? modelsPanel
            : panel === 'caps' ? capsPanel
              : diagPanel

      /**
       * 两处挂载的外壳不一样，由宿主通过 `surface` 告诉我们：
       *
       * - `plugins.bundle.config`（旧）把一个 bundle 的配置渲染在**插件页**里，
       *   外壳由我们自己给（标题 + 折叠），那时候这张卡是页面里的一节。
       * - `settings.section`（新）是**设置面板的一整页**，标题栏、关闭按钮、
       *   滚动容器都由 shell 提供。此时再画一遍自己的标题和折叠箭头，页面上就会
       *   出现两个标题、两个箭头，而且 `<li>` 在设置页的 DOM 里是非法结构。
       *
       * 所以 settings 模式下换成一个普通 `<div>`，丢掉标题栏，内容永远展开。
       */
      const settingsSurface = props.surface === 'settings'
      if (settingsSurface) {
        return h(
          'div',
          { className: 'dsm-hwc-card dsm-hwc-card-surface-settings' },
          h(
            'div',
            { className: 'dsm-hwc-card-body dsm-hwc-card-body-flat' },
            h(
              'div',
              { className: 'dsm-hwc-usage' },
              header,
              panels,
              h('div', { className: 'dsm-hwc-panel' }, panelBody),
              notice === '' ? null : h('p', { className: 'dsm-hwc-models-summary' }, notice),
              error === '' ? null : h('p', { className: 'dsm-hwc-usage-error' }, t('err.title') + '：' + error),
              h(
                'div',
                { className: 'dsm-hwc-pool-save-bar' },
                h(
                  'div',
                  { className: 'dsm-hwc-pool-save-buttons' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsm-hwc-btn dsm-hwc-btn-outline',
                      disabled: busy !== '',
                      onClick: () => {
                        setDrafts({})
                        setImageDrafts({})
                        void load()
                      },
                    },
                    t('act.discard'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dsm-hwc-btn dsm-hwc-btn-primary', disabled: busy !== '', onClick: onSave },
                    busy === 'save' ? t('act.saving') : t('act.save'),
                  ),
                ),
              ),
            ),
          ),
          busy === '' ? null : h(BusyOverlay, { text: busyText, hint: t('card.title') }),
        )
      }

      return h(
        'li',
        { className: 'dsm-hwc-card' + (open ? ' dsm-hwc-card-open' : '') },
        h(
          'button',
          {
            type: 'button',
            className: 'dsm-hwc-card-header',
            'aria-expanded': open,
            'aria-label': t(open ? 'card.collapse' : 'card.expand') + ': ' + t('card.title'),
            onClick: () => setOpen(!open),
          },
          h('img', { className: 'dsm-hwc-card-icon', src: CARD_ICON, alt: '' }),
          h(
            'span',
            { className: 'dsm-hwc-card-head' },
            h('span', { className: 'dsm-hwc-card-title' }, t('card.title')),
            h('span', { className: 'dsm-hwc-card-description' }, t('card.desc')),
          ),
          h('span', { 'aria-hidden': 'true', className: 'dsm-hwc-card-chevron' + (open ? ' dsm-hwc-card-chevron-open' : '') }),
        ),
        h(
          'div',
          { className: 'dsm-hwc-card-body', hidden: !open },
          open
            ? h(
                'div',
                { className: 'dsm-hwc-usage' },
                header,
                panels,
                h('div', { className: 'dsm-hwc-panel' }, panelBody),
                notice === '' ? null : h('p', { className: 'dsm-hwc-models-summary' }, notice),
                error === '' ? null : h('p', { className: 'dsm-hwc-usage-error' }, t('err.title') + '：' + error),
                h(
                  'div',
                  { className: 'dsm-hwc-pool-save-bar' },
                  h(
                    'div',
                    { className: 'dsm-hwc-pool-save-buttons' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dsm-hwc-btn dsm-hwc-btn-outline',
                        disabled: busy !== '',
                        onClick: () => {
                          setDrafts({})
                          setImageDrafts({})
                          void load()
                        },
                      },
                      t('act.discard'),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'dsm-hwc-btn dsm-hwc-btn-primary', disabled: busy !== '', onClick: onSave },
                      busy === 'save' ? t('act.saving') : t('act.save'),
                    ),
                  ),
                ),
              )
            : null,
        ),
        busy === '' ? null : h(BusyOverlay, { text: busyText, hint: t('card.title') }),
      )
    }

    /**
     * 输入框积分胶囊。
     *
     * 只在会话当前选中的模型属于本插件时渲染——两个连接器插件共用 `input.right` 这一行，
     * 靠 provider 归属分开，谁都不去抢另一家的位置。
     */
    function ComposerCredits(props) {
      const { t, useProjection } = props
      const [numbers, setNumbers] = useState(undefined)
      const alive = useRef(true)

      let platform
      try {
        const selection = useProjection === undefined ? undefined : useProjection('modelSelection')
        const current = selection?.pending ?? selection?.next ?? selection?.lastUsed
        const provider = current?.provider
        if (provider === 'codearts' || provider === 'officeace') platform = provider
      } catch {
        /* 投影读不到就当作没选中，别让底栏崩 */
      }

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      useEffect(() => {
        if (platform === undefined) {
          setNumbers(undefined)
          return undefined
        }
        const pull = async () => {
          try {
            const response = await fetch(ROUTE + '/status')
            if (!response.ok) return
            const data = await response.json()
            const row = (data.platforms ?? []).find((entry) => entry.platform === platform)
            const account = row?.accounts?.find((entry) => entry.id === row.activeAccount?.id) ?? row?.accounts?.[0]
            const parsed = creditNumbers(account?.credits)
            if (alive.current) setNumbers(parsed)
          } catch {
            /* dock 拉取失败不影响对话 */
          }
        }
        void pull()
        const timer = setInterval(pull, 60_000)
        return () => clearInterval(timer)
      }, [platform])

      if (platform === undefined || numbers === undefined) return null
      const remain = Math.round(numbers.remain ?? 0)
      return h(
        'span',
        {
          className: 'dsm-hwc-credit-position',
          title: t('dock.total', { remain: formatNumber(numbers.remain), total: formatNumber(numbers.total) }),
          style: { cursor: 'default' },
        },
        t('dock.credits', { n: new Intl.NumberFormat().format(remain) }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      name: 'dsh-connect-huawei-client',
      apply(ctx) {
        try {
          ensureStyle()
          const namespace = 'settings.huawei-connect'
          ctx.effect(() => ctx.locale.register(namespace, { zh: ZH, en: EN }), 'dsh-connect-huawei: card copy')
          let translate
          try {
            translate = ctx.locale.bind(namespace)
          } catch {
            translate = undefined
          }
          const bind = (key, params) => {
            let text
            if (translate !== undefined) {
              try {
                const value = translate(key, params)
                if (typeof value === 'string' && value !== key) text = value
              } catch {
                /* 绑定失败就用内置中文，绝不让文案缺失把卡片炸掉 */
              }
            }
            if (text === undefined) text = ZH[key]
            if (typeof text !== 'string') return key
            if (params === undefined) return text
            return text.replace(/\{(\w+)\}/gu, (match, name) => (params[name] === undefined ? match : String(params[name])))
          }

          const registerCard = (slotName, key) => {
            try {
              return ctx.slots.inject(slotName, () =>
                ctx.slots.register({ name: slotName, key, priority: 30, inject: () => ({ t: bind }) }, HuaweiCard),
              )
            } catch (cause) {
              console.error(`[dsh-connect-huawei] card slot "${slotName}" failed to register:`, cause)
              return undefined
            }
          }
          /**
           * 设置面板里的这一页（DSH 0.2.x 起的正确位置）。
           *
           * `settings.section` 是 **list 槽位，id 由本插件自己拥有**，没有任何
           * 需要与插件管理器清单比对的字符串。这正是旧方案的问题所在：
           * `plugins.bundle.config` 是 **keyed** 槽位，插件页用
           * `entryKey: pkg.name` 派发，并且用 `ledger.bundles.has(pkg.name)`
           * 做**精确字符串比较**——而部署时完全可以把同一份代码挂在不同的
           * Loader entry id 下（我们这里是 `include:dsh-connect-huawei`）。
           * 猜错就什么都不渲染：没有小节、没有占位、也没有报错。
           *
           * 之前为此同时注册了裸包名和 `include:` 前缀两个 key，那是碰运气；
           * 而且两个 key 都命中时卡片会渲染两遍。现在按 id 注册一次即可。
           *
           * 图标走 `settings.section.icon`，shell 用 `{ only: row.id }` 渲染，
           * 所以必须与这一页同 id。两个注册放在同一个 inject 回调里，
           * 使配对成为结构性的，而不是靠约定。
           */
          try {
            ctx.effect(
              () =>
                ctx.slots.inject('settings.section', () => {
                  const disposers = []
                  disposers.push(
                    ctx.slots.register(
                      {
                        name: 'settings.section',
                        id: SETTINGS_SECTION_ID,
                        order: 34,
                        label: () => bind('card.title'),
                        locale: namespace,
                        inject: () => ({ t: bind, surface: 'settings' }),
                      },
                      HuaweiCard,
                    ),
                  )
                  try {
                    const iconInject = ctx.slots.inject('settings.section.icon', () =>
                      ctx.slots.register(
                        { name: 'settings.section.icon', id: SETTINGS_SECTION_ID, locale: namespace },
                        (iconProps) => {
                          const edge = typeof iconProps?.size === 'number' ? iconProps.size : 16
                          return h('img', {
                            src: CARD_ICON,
                            alt: '',
                            width: edge,
                            height: edge,
                            className: 'dsm-hwc-nav-icon',
                            style: {
                              width: edge + 'px',
                              height: edge + 'px',
                              borderRadius: '4px',
                              display: 'block',
                              objectFit: 'contain',
                              opacity: iconProps?.active === false ? 0.75 : 1,
                            },
                          })
                        },
                      ),
                    )
                    disposers.push(iconInject)
                  } catch (cause) {
                    console.error('[dsh-connect-huawei] settings icon slot failed to register:', cause)
                  }
                  return () => {
                    for (const dispose of disposers) {
                      try {
                        dispose()
                      } catch {
                        /* 单个 disposer 失败不该拦住其余清理 */
                      }
                    }
                  }
                }),
              'huawei: settings section',
            )
          } catch (cause) {
            console.error('[dsh-connect-huawei] settings section slot failed to register:', cause)
          }

          /**
           * 旧版 DSH 的挂载点，保留给还没有 `settings.section` 的宿主。
           *
           * 这里只注册**裸包名**一个 key：两个 key 同时注册时，新宿主里那张卡
           * 会渲染两遍（两个 key 都能命中）。`ctx.slots.inject` 本身就是
           * 能力探测——宿主没有该槽位时回调根本不会执行，不会抛错也不会占位。
           */
          ctx.effect(() => registerCard('plugins.bundle.config', 'dsh-connect-huawei'), 'huawei: bundle card')
          ctx.effect(() => registerCard('plugins.row.config', 'dsh-connect-huawei'), 'huawei: row card')

          try {
            ctx.effect(
              () =>
                ctx.slots.inject('conversation.input.right', () =>
                  ctx.slots.register(
                    {
                      name: 'conversation.input.right',
                      id: 'dsh-connect-huawei-composer-credits',
                      order: 5,
                      locale: namespace,
                      inject: () => ({ t: bind }),
                    },
                    ComposerCredits,
                  ),
                ),
              'huawei: composer credits',
            )
          } catch (cause) {
            console.error('[dsh-connect-huawei] composer credits slot failed to register:', cause)
          }
        } catch (cause) {
          console.error('[dsh-connect-huawei] client failed to load:', cause)
        }
      },
    }
  },
})
