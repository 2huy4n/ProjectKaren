# ProjectKaren

一个 DSH 插件：让角色**会睡觉、会被吵醒、会自己找事做、也会先开口说话**。

> A DeepSeek Harness plugin that gives a roleplay character a clock: sleep / wake, greetings,
> idle actions, proactive small talk, and optional outing photos.

角色卡与世界观**不由本插件提供**——懒狗作者假设你的会话里已经有角色了。
本插件只负责「时间」这一维：什么时候睡、什么时候醒、醒来之后干什么。

## 功能

- **睡眠 / 唤醒**
- **睡着**
- **吵醒**
- **问候**
- **自由动作**
- **主动搭话**
- **出游照片**

## 安装

从 GitHub：

```powershell
dsh plugin --profile <profile> add "git+https://github.com/2huy4n/ProjectKaren#v0.1.0"
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
| `apiBase` / `apiPath` / `apiKey` / `model` / `size` | 生图接口（OpenAI 兼容的 /images/generations） |
| `photoPrompt` | 没传 prompt 时用的默认画面描述 |
| `offsetMinutes` | 时钟偏移（调试用，整体平移插件看到的"现在"） |

## 状态与日志

配置与每会话状态存在 `~/.dsh/project-karen.json`（`DSH_HOME` 优先）。
面板里有「活跃会话」列表（状态 / 入睡醒来时刻 / 正在做什么 / 今日次数）和「最近动作」日志，可一键清空。

## License

**AGPL-3.0-or-later** —— GNU Affero General Public License v3.0 或更高版本。完整条文见 [LICENSE](./LICENSE)。

说人话：你可以自由使用、修改、再发布本插件，**但基于它的衍生作品也必须以同样的许可开源**；
而且**即使你只是把它架成在线服务给别人用（不发布二进制），也必须提供源码**。

```
ProjectKaren —— 一个让角色按「时间」行动的 DSH 插件
Copyright (C) 2026 2huy4n

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```
