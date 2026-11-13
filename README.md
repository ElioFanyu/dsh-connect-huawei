# DSH Connect Huawei

把华为两个平台的模型接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）：
**码道 CodeArts**（编码）与 **果办 OfficeAce**（办公）。两个平台都出现在 DSH 的模型选择器里，
各带账号、积分余量、模型勾选与图片输入开关。

功能对照 [`wang111928/dsh-huawei-connect`](https://github.com/wang111928/dsh-huawei-connect)（MIT）重写，
页面样式沿用 [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy)（MIT）的卡片语言。

## 与上游项目的差别

| | 上游 dsh-huawei-connect | 本插件 |
|---|---|---|
| 页面 | 单列阅读流 | workbuddy 的卡片骨架：图标标题栏 + 双供应商顶栏 + 面板 tab |
| 偏好存储 | 宿主 settings（`huawei-connect` 命名空间） | 插件自己的 `prefs.json` |
| 积分 | 只读第一个账号 | 按账号逐行读，表格里一账号一行 |
| 账号池成员 | 全部账号参与 | 卡片里逐账号勾选 |
| 账号顺序 | 无 | 卡片里 ↑↓ 手动排序，池开着时就是回退顺序 |
| 图片能力 | 只信上游 `supports_images` | 逐模型开关，可覆盖上游的说法 |
| 并发槽 | 只在文字里提一句 | 表格单开一列，逐账号显示 `已占 / 上限` |

host 半边的协议实现（签名、OAuth、shim、失败分类、伪装）逐字沿用上游——那是实测出来的知识，
不是可以随手重写的东西。

## 安装

```sh
# 本目录已经在 profile 里时
dsh plugin --profile <profile> add file:/绝对路径/dsh-connect-huawei
```

桌面端（DSH Desktop）请在 **设置 → 插件** 里用「从本地目录安装」指向这个目录。

## 前置要求

- DeepSeek Harness `>=0.2.0-0 <0.3.0-0`（已在 `0.2.2-rc.2` 上实测）
- Node.js `^22.19.0 || >=24.0.0`
- 果办需要 Windows（读取 Windows 凭据管理器）；码道跨平台可用
- 码道：用码道桌面端登录过一次；果办：桌面端需在 Windows 上运行并登录

装好后，打开 **设置 → 华为双平台**（与其它插件并列在左侧导航里），点「同步登录态」，
即可在模型选择器里挑选模型。

> **关于入口位置（1.1.0 变更）**
>
> DSH `0.2.x` 把插件的配置页从插件页里的 `plugins.bundle.config` 哨位迁到了设置面板的
> `settings.section`。后者是 **list 槽位，id 由插件自己拥有**，不再拿包名去和插件管理器
> 清单做精确字符串比较——而部署完全可以把同一份代码挂在不同的 Loader entry id 下
> （这里就是 `include:dsh-connect-huawei`），比较失败时旧哨位**什么都不渲染，也不报错**。
>
> 1.1.0 起主入口是 `settings.section`（id `dsh-connect-huawei`，导航图标由
> `settings.section.icon` 提供）。旧哨位仍然注册着，只保留裸包名一个 key，
> 供还没升级的宿主使用；同一张卡不会因此渲染两遍。

## 卡片怎么用

顶栏两格各是一个平台，右侧开关是该平台的**账号池**：

- **关**（默认）= 单账号模式。只用一个号服务每一次请求，失败如实报错。日常就够用。
- **开** = 账号池。按健康度在勾选的账号之间挑号，只有"换号能解决"的失败才换下一个。

面板 tab：

- **账号**：账号表格（积分 / 状态 / 并发槽）、勾选参与轮转、↑↓ 排序、测试、移除。
- **模型**：勾选进选择器的模型（一个都不勾 = 该平台不限制），逐模型图片开关，搜索与筛选。
- **能力**：码道并发会话的说明与当前占用，以及转发层注意事项。
- **诊断**：这张卡实际读到了什么，方便贴进问题反馈。

## 已知限制

- 码道请求使用 `SDK-HMAC-SHA256` 签名；若本机有会重写请求体的转发层（如 `billion-context`），
  需让它原样放行：`{"resign":{"sdk-hmac-sha256":{"passthrough":true}}}` 或环境变量
  `BILI_RESIGN_PASSTHROUGH=1`，否则每个回合都会失败。
- 码道每账号最多 3 个并发会话，约 1 分钟释放；在卡片里再登录一个账号可翻倍。
- 果办积分接口要求本机会话：必须开着果办并保持登录。
- 果办与码道的额度接口都是账号级的，只给积分总数，没有"这次请求花了多少"的明细；
  卡片上的积分是余额，不是本次消耗。

## 许可证

MIT。协议实现与请求伪装部分源自 `wang111928/dsh-huawei-connect`（MIT）；
卡片视觉源自 `dingminhua/dsh-connect-workbuddy`（MIT, Copyright (c) 2026 LaoDing）。
