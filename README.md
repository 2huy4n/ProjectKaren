# ProjectKaren

一个 DSH 插件：让角色**会睡觉、会被吵醒、会自己找事做、也会先开口说话**。

> A DeepSeek Harness plugin that gives a roleplay character a clock: sleep / wake, greetings,
> idle actions, proactive small talk, and optional outing photos.

角色卡与世界观**不由本插件提供**——懒狗作者假设你的会话里已经有角色了。
本插件只负责「时间」这一维：什么时候睡、什么时候醒、醒来之后干什么。

## 功能

- **睡眠 / 唤醒**：角色也有自己的生活，会睡觉，会起床
- **睡着**：当TA睡着的时候，不要打扰TA哦
- **吵醒**：TA会因为你的“短信轰炸”醒来
- **问候**：早安、午安，还有晚安
- **自由动作**：当你不理TA的时候，TA会自己找点事做
- **主动搭话**：当你不理TA的时候，TA会主动找上来
- **出游照片**：当TA旅游到名胜景点，会给你拍照片
- **静默指令**：`/mute 30` —— 你让TA闭嘴一段时间，TA就不再主动开口（你说话TA照常回）
- **天气**：填了城市，TA会知道外面什么天，问候和闲聊里会自然带上
- **节日**：节日当天有不一样的问候、话题与行动
- **生日**：支持填写你和TA的生日，
- **中英双语**：面板文案跟随 DSH 界面语言；注入给模型的提示词也跟随

## 安装

从 GitHub：

```powershell
dsh plugin --profile <profile> add "git+https://github.com/2huy4n/ProjectKaren#v0.2.1"
```

安装后需要重启 DSH，在「设置 → ProjectKaren」里配置。

## 配置项

| 键 | 含义 |
|---|---|
| `enabled` | 总开关 |
| `defaultMuted` | 新会话是否默认静音 |
| `sleepStart` / `sleepJitter` | 入睡基准时刻 / 模糊 ±分钟 |
| `wakeStart` / `wakeJitter` | 醒来基准时刻 / 模糊 ±分钟 |
| `greetEnabled` / `greetWindowMinutes` | 早安+晚安开关 / 醒来后多久内还补早安 |
| `greetNoonEnabled` / `noonStart` / `noonJitterMinutes` | 午安开关 / 中午基准 / 模糊 ±分钟 |
| `nightLeadMinutes` | 睡前提前多少分钟道晚安 |
| `barrageCount` / `barrageWindowMinutes` / `barrageAwakeMinutes` | 吵醒阈值 / 统计窗口 / 清醒时长 |
| `talkEnabled` / `talkIntervalMinutes` / `talkJitterMinutes` / `talkDailyMax` | 主动搭话开关 / 间隔 / 模糊 / 每日上限 |
| `talkQuietStart` / `talkQuietEnd` | 静默时段（留空 = 不设） |
| `actionEnabled` / `actionIntervalMinutes` / `actionJitterMinutes` / `actionIdleMinutes` | 自由动作开关 / 间隔 / 模糊 / 静默多久才动 |
| `actionDefaultMinutes` / `actionMinMinutes` / `actionMaxMinutes` / `actionDailyMax` | 动作时长默认 / 最短 / 最长 / 每日上限 |
| `citySelf` / `cityUser` | 角色所在城市 / 用户所在城市（留空 = 同城） |
| `weatherEnabled` | 天气开关 |
| `holidayEnabled` | 节日开关 |
| `birthdayEnabled` | 生日开关 |
| `birthdaySelf` / `birthdayUser` | 角色生日 / 用户生日（`MM-DD`） |
| `apiBase` / `apiPath` / `apiKey` / `model` / `size` | 生图接口（OpenAI 兼容的 /images/generations） |
| `photoPrompt` | 没传 prompt 时用的默认画面描述 |
| `offsetMinutes` | 时钟偏移（调试用，整体平移插件看到的"现在"） |

## `/mute` 指令

让TA闭嘴一段时间。这个指令**不会进模型**，TA看不到。

| 你输入 | 结果 |
|---|---|
| `/mute 30` · `/mute 30m` · `/mute 30min` · `/mute 30 minutes` · `/mute 30分钟` | 静默 30 分钟 |
| `/mute 2h` · `/mute 2 hours` · `/mute 2小时` | 静默 2 小时 |
| `/mute 1d` · `/mute 1 day` · `/mute 1天` | 静默 1 天 |
| `/mute 到22:00` · `/mute until 22:00` · `/mute 22:00` | 到今晚 22:00（时刻已过则顺延到明天） |
| `/mute off` · `/mute 取消` | 解除静默 |

静默期间：不再主动搭话、不再问候、不再播报自由动作的收尾；**你主动找TA时照常回复**。
可设范围 1 分钟 ~ 7 天。不写单位按分钟算，大小写和多余空格都无所谓。

## 天气

在面板里填城市即可（中英文都认，如 `杭州` / `Hangzhou`）。|
天气数据来自 [Open-Meteo.com](https://open-meteo.com/)（[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)），
免 API Key、无需注册。

- **两个城市相同**（或只填了一个）：TA按「TA和你在同一个地方」来说天气。
- **两个城市不同**：TA会知道你不在TA那边，可以顺口提一句你那边的天气（比如提醒你带伞）。

天气每小时最多刷新一次，面板里有「立即刷新天气」。取不到天气时TA**不会编造**。

## 节日与生日

生日填 `MM-DD`，例如 `05-20`。

节日表**内置 10 年（2026–2035）**，含公历节日（元旦 / 情人节 / 妇女节 / 愚人节 / 劳动节 /
儿童节 / 教师节 / 国庆 / 万圣节 / 平安夜 / 圣诞 / 跨年）与农历节日（春节 / 元宵 / 端午 /
七夕 / 中秋 / 重阳）。超出 2035 年会自动只认公历节日，面板会提示。

## 中英双语

- **面板文案**：跟随 DSH 的界面语言设置（客户端 `ctx.locale`）。
- **注入给模型的提示词、工具描述、报错**：同样跟随 DSH 界面语言；客户端还没打开过、没上报时，回退到系统语言。
- 目前只支持中文和英文——DSH 宿主本身也只提供这两种（`zh` / `en`）。
- 要改文案只改这两处：`dsh/i18n/{zh,en}.json`（宿主）与 `client/client.js` 里的两个字典对象。

## 状态与日志

配置与每会话状态存在 `~/.dsh/project-karen.json`（`DSH_HOME` 优先）。
除配置与会话状态外，这个文件还保存照片引用、天气缓存和客户端上报的语言。
面板里有「活跃会话」列表（状态 / 入睡醒来时刻 / 正在做什么 / 今日次数 / 是否静默）和「最近动作」日志，可一键清空。

## License

**AGPL-3.0-or-later** —— GNU Affero General Public License v3.0 或更高版本。

Copyright (C) 2026 2huy4n · 完整条文见 [LICENSE](./LICENSE)
