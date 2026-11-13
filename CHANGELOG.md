# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 1.2.0 — 2026-11-13

### 适配 DSH `0.2.2-rc.2`

- **修复图片输入（升级后必现的回归）**。`@deepseek-ai/dsh-llm-pi-ai` 在 0.2.x
  改了带图请求的前置条件：适配器转换消息时会调 `config.resolveAttachments()`，
  **拿不到就抛** `UNSUPPORTED_CONTENT`
  （`pi-ai image input requires the durable attachment service`）。

  它不是"把图丢掉继续发"，而是整条请求直接失败。所以这个缺陷只在**用户真发图**
  时暴露：文本对话全部正常，图片全部报错。1.1.0 及更早版本没有传这两个回调，
  在 0.2.2 上图片功能整体不可用。

  修复：
  - 新增 `resolveAttachments: () => attachments?.current?.()`，把宿主的
    `attachments` 服务交给适配器；
  - 新增 `resolveImageAccess`，走宿主的 `resolveImageAttachmentAccess`
    （从 `@deepseek-ai/dsh-llm` 取），把依附件的宿主路径映射成进程可读路径。
    自己拼路径会漏掉未映射的附件，所以必须用宿主这个函数。
  - 两者都用**惰性取值**（`ctx.get(...)`）而不是构造期快照：宿主服务由 fiber
    装配顺序决定，可能比适配器就绪更晚，构造期取值会永久拿到 `undefined`。
  - `@deepseek-ai/dsh-llm` 改为命名空间导入。用命名导入取一个旧版本不存在的
    符号会在 ESM 链接阶段直接失败，整个 provider 都起不来；命名空间导入 +
    可选调用则退化成"图片不可用、文本仍可用"。

- **`engines.dsh` 抬到 `>=0.2.0-0`**。1.1.0 声明 `>=0.1.7-rc.1`，但
  `settings.section` 是 0.2.x 才有的槽位，0.1.x 上装这个版本只能得到一张
  不显示的卡片。声明一个装不上的下限比声明得保守更诚实。

### 新增

- `test/image-input-contract.mjs`：直接读安装目录里 `dsh-llm-pi-ai` 的源码，
  断言"图片必须有耐用附件服务"这个契约仍然成立，再断言我们确实交出了两个回调、
  且都是惰性读取。已用变异测试验证——删掉两个回调后 4 项失败。

## 1.1.0 — 2026-11-06

### 适配 DSH 0.2.x（实测 `0.2.1-rc.5`）

- **配置页迁到 `settings.section`**。DSH 0.2.x 把插件的配置页从插件页里的
  `plugins.bundle.config` 迁到了设置面板。后者是 **list 槽位，id 由插件自己拥有**，
  不再需要拿包名去和插件管理器的 inventory 做精确字符串比较。

  旧方案的问题：`plugins.bundle.config` 是 **keyed** 槽位，插件页用
  `entryKey: pkg.name` 派发、并用 `ledger.bundles.has(pkg.name)` 门控；而部署
  可以把同一份代码挂在不同的 Loader entry id 下（本例是
  `include:dsh-connect-huawei`）。对不上时**整块不渲染**——没有小节、没有占位、
  也没有任何报错。此前为了覆盖两种拼写，同时注册了 `dsh-connect-huawei` 和
  `include:dsh-connect-huawei` 两个 key，属于碰运气。

- **修复卡片重复渲染**。两个 key 同时命中时那张卡会渲染两遍。现在主入口按 id 注册
  一次；旧哨位只保留裸包名一个 key，供未升级的宿主使用。

- **导航图标**。新增 `settings.section.icon` 注册，与设置页同 id（shell 用
  `{ only: row.id }` 渲染，id 不一致就永远不显示）。

- **设置页下自弃外壳**。引入 `surface: 'settings'`：shell 已经提供标题栏、关闭按钮
  和滚动容器，卡片不再重复画标题与折叠箭头，根节点也从 `<li>` 改为 `<div>`
  （`<li>` 在设置页的 DOM 里是非法结构）。

### 修复

- **「最大上下文」显示的是目录默认值，而非生效值**。底部那行渲染的是
  `model.contextWindow`（恒为保守默认 262144），所以选了 1M 之后仍显示
  「最大上下文 256K」——看起来像选择没生效。现在渲染**真正生效的档位**，
  并在选了非默认档时把默认值作为参考缀在后面：`最大上下文 1M（默认 256K）`。
  适配器一直是对的（`toPiModel` 用 budget 覆盖 `contextWindow`），只是显示层没跟上。

- **底部保存栏不再固定**。`.dsm-hwc-pool-save-bar` 原为
  `position:sticky;bottom:0;z-index:2` + 不透明底色，等于永远钉在卡片底边，
  模型一多就悬在列表上方挡住最后一行。改为正常文档流，滚到底才见到。

- **「默认」档文案**。单选里的「原生」改为「默认（256K）」，`budgetHint` 同步改口径：
  上游并不提供真实窗口，`256K` 是本插件自己选的保守声明值，不是物理上限。

### 新增

- `test/modelrow-display.mjs`：从源码抽取 `compactTokens` / `ModelRow` 原文，
  用假 React 渲染，断言各档预算下的文案。已用变异测试验证它能抓住修复前的行为。
- `test/settings-surface.mjs`：断言 settings 模式下的外壳形态（无 `<li>`、
  无重复标题、无折叠箭头），并保护旧插件页形态不被改坏。

### 说明

- 码道与果办的**最大输出**是两个平台各自的实测硬上限，与上下文档位无关：
  码道 65536（64K，65537 立刻 400）、果办 131072（128K，200000 被拒）。
  码道的 `openpangu-2.0-pro` / `flash` 更低，为 8192。
- 1M 是**可选档位**，不代表上游一定吃满。实测约 62.5 万 token 仍 200，
  约 125 万会撞网关 504（超时，不是拒绝）。大输入会明显变慢，这是保留
  「默认 256K」这一档的原因。

## 1.0.0

首个版本：码道 CodeArts 与果办 OfficeAce 两条 provider 路由、账号池与自动换号、
按账号读取积分余量、逐模型勾选与图片输入开关、码道并发会话闸门、
输入框积分胶囊。页面沿用 `dsh-connect-workbuddy` 的卡片样式。
