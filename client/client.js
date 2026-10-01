// ProjectKaren 设置面板：睡眠窗口 + 模糊区间 + 轰炸唤醒 + 自由动作 + 日期/节日/生日 + 生图 + 会话状态。
//
// i18n 分两层（跟 DSH 的约定一致）：
//   · 本文件负责「面板 UI」文案——ctx.locale.register(NS, { zh, en }) + bind，跟随 DSH 界面语言。
//   · 注入给模型的提示词/工具描述在宿主侧 dsh/i18n/{zh,en}.json。
window.__ModuleLoader__.load({ id: "project-karen", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  const react = require("react");

  const NS = "project-karen";
  const name = "project-karen";
  const inject = ["locale", "slots"];
  const API = "/project-karen";
  const PHOTO_TOOL = "karen_photo";
  const h = react.createElement;

  /** 绑不上 locale 时原样返回 key，页面不崩。 */
  let t = (key) => key;

  // ── 面板文案字典 ──────────────────────────────────────────────────
  const zh = {
    "loading": "加载中…",
    "loadFailed": "加载失败：{msg}",
    "error": "错误：{msg}",
    "save": "保存配置",
    "saved": "已保存",
    "configPath": "配置文件：{path}",
    "desc": "本插件仅提供模拟角色经由「时间」产生的一系列动作。生图功能仅为「出游」行动配套配置。角色卡及注入相关问题烦请用户自行解决。",
    "enabled": "总开关",
    "defaultMuted": "新会话默认静音 · 首次出现的会话需手动「恢复生效」",

    "section.behavior": "角色行为",
    "section.date": "日期 · 节日 · 生日",
    "section.ability": "能力",
    "section.debug": "调试",

    "sleep.group": "睡眠 / 唤醒",
    "sleep.groupHint": "每个会话每天摇一次入睡与醒来时刻",
    "sleep.sleepStart": "入睡基准 / sleep at",
    "sleep.sleepJitter": "入睡模糊 ±分钟",
    "sleep.wakeStart": "醒来基准 / wake at",
    "sleep.wakeJitter": "醒来模糊 ±分钟",

    "greet.group": "问候",
    "greet.groupHint": "早安 / 午安 / 晚安，各每天最多一次",
    "greet.enabled": "打招呼 · 睡醒时道早安、睡前道晚安",
    "greet.window": "问候最多迟到 / 分钟",
    "greet.nightLead": "睡前提前 / 分钟",
    "greet.noon": "午安 · 中午主动打招呼",
    "greet.noonStart": "中午基准 / noon at",
    "greet.noonJitter": "中午模糊 ±分钟",

    "barrage.group": "吵醒",
    "barrage.groupHint": "短时间内连发多条消息 → 临时清醒",
    "barrage.count": "吵醒阈值 / 条数",
    "barrage.window": "统计窗口 / 分钟",
    "barrage.awake": "吵醒后清醒 / 分钟",

    "talk.group": "主动搭话",
    "talk.groupHint": "沉默够久让她先开口；每天有上限，静默时段不打扰",
    "talk.enabled": "主动搭话 · 沉默久了主动找用户说话",
    "talk.interval": "沉默多久后开口 / 分钟",
    "talk.jitter": "间隔模糊 ±分钟",
    "talk.dailyMax": "每天最多 / 次（0 = 不限）",
    "talk.quiet": "静默时段 · 两个都留空 = 不设",
    "talk.quietTo": "到",

    "action.group": "自由动作",
    "action.groupHint": "没人说话时她自己找事做",
    "action.enabled": "自由动作 · 醒着且没人说话时自己找事做",
    "action.interval": "动作间隔 / 分钟",
    "action.jitter": "间隔模糊 ±分钟",
    "action.idle": "静默多久才动 / 分钟",
    "action.default": "动作默认时长 / 分钟",
    "action.min": "动作最短 / 分钟",
    "action.max": "动作最长 / 分钟",
    "action.dailyMax": "每天最多 / 次（0 = 不限）",

    "date.groupHint": "城市用于天气；节日与生日各自可单独关闭",
    "date.citySelf": "角色所在城市",
    "date.cityUser": "用户所在城市（留空 = 同城）",
    "date.cityHint": "填城市名即可（中英文都行，如 杭州 / Hangzhou）。同城与异地会用不同的说法。",
    "date.weatherEnabled": "天气 · 把当前天气写进角色背景",
    "date.holidayEnabled": "节日 · 节日当天有特殊问候与话题",
    "date.birthdayEnabled": "生日 · 生日当天有特殊问候",
    "date.birthdaySelf": "角色生日（MM-DD）",
    "date.birthdayUser": "用户生日（MM-DD）",
    "date.birthdayPlaceholder": "如 05-20",
    "date.refreshWeather": "立即刷新天气",
    "date.weatherHint": "天气来自 Open-Meteo（免 Key）。填城市并保存后会自动获取。",
    // CC BY 4.0 要求：显示天气数据的地方旁边必须有指向 Open-Meteo 的链接。
    "date.weatherCredit": "Weather data by Open-Meteo.com",
    "date.weatherSelf": "角色：{place} {text} {temp}°C",
    "date.weatherUser": "用户：{place} {text} {temp}°C",
    "date.weatherAt": "更新于 {time}",
    "date.today": "今天：{list}",
    "date.todayNone": "今天不是节日，也不是任何人的生日",
    "date.birthday.self": "今天是角色的生日",
    "date.birthday.user": "今天是用户的生日",
    "date.birthday.both": "今天是角色和用户共同的生日",
    "date.lunarOut": "农历节日表只覆盖 {min}–{max} 年；{year} 年只认公历节日。",

    "debug.groupHint": "平时不用动",
    "debug.offset": "时钟偏移 / 分钟",

    "photo.group": "生图（karen_photo）",
    "photo.groupHint": "仅为「出游」行动配套",
    "photo.note": "角色出游到名胜景点（或你明确要求）时才会拍照：\n· 配了 API Key：按提示词调用生图接口，照片以卡片显示在她那一侧。\n· 没配 API Key：她不会调用这个工具；到了该拍照的场景，改用模型自身的能力把眼前景象用文字描述出来。",
    "photo.apiBase": "API Base",
    "photo.apiPath": "路径 / path",
    "photo.model": "模型 / model",
    "photo.size": "尺寸 / size",
    "photo.apiKey": "API Key（当前 {state}）",
    "photo.apiKeyNone": "未配置",
    "photo.apiKeyPlaceholder": "粘贴新 Key 后点保存（不改就别填）",
    "photo.clearKey": "清空已保存的 Key",
    "photo.prompt": "默认画面提示词",
    "photo.promptPlaceholder": "留空 = 用默认画面提示词",

    "sessions.title": "活跃会话 / live sessions",
    "sessions.empty": "当前没有活跃会话；打开一个对话后这里会出现。",
    "recent.title": "最近动作 / recent",
    "recent.clear": "清空日志",
    "recent.empty": "还没有动作记录。",

    "session.asleep": "😴 睡着",
    "session.awake": "☀️ 醒着",
    "session.off": "此会话不生效",
    "session.sleepWindow": "本次睡眠 {sleepLocal} → {wakeLocal}（{sleepAt} ~ {wakeAt}）",
    "session.toWake": " · 还要睡 {n}",
    "session.toSleep": " · 距入睡 {n}",
    "session.stirredUntil": " · 被吵醒至 {t}",
    "session.stirCount": " · 被吵醒 {n} 次",
    "session.mutedUntil": " · 已静默至 {t}",
    "session.actions": "自由动作：已做 {total} 次 · 今天 {today} 次",
    "session.nextAction": " · 下次约 {t}（{n} 后）",
    "session.talkOn": "主动搭话：已开口 {total} 次 · 今天 {today} 次",
    "session.talkOff": "主动搭话：已关闭",
    "session.quietNow": " · 现在在静默时段",
    "session.nextTalk": " · 下次约 {t}（{n} 后）",
    "session.doing": "正在：{label}{motive} · 还剩 {left}",
    "session.motive": "（{motive}）",
    "session.idle": "现在没在做别的事",
    "btn.sleepNow": "让它睡",
    "btn.wakeNow": "叫醒",
    "btn.stirNow": "模拟吵醒",
    "btn.actNow": "立刻动作一次",
    "btn.endAction": "结束动作",
    "btn.unskip": "恢复生效",
    "btn.skip": "此会话不生效",
    "btn.reset": "重置",

    "photoCard.taking": "拍照中…",
    "photoCard.failed": "照片失败：{msg}",
    "photoCard.noMeta": "照片已显示（缺少元数据）",
    "photoCard.alt": "照片",

    "dur.mins": "{n} 分钟",
    "dur.hours": "{h} 小时 {m} 分",
  };

  const en = {
    "loading": "Loading…",
    "loadFailed": "Load failed: {msg}",
    "error": "Error: {msg}",
    "save": "Save settings",
    "saved": "Saved",
    "configPath": "Config file: {path}",
    "desc": "This plugin only supplies the actions a roleplay character derives from time. Image generation exists solely to support the \"going out\" action. Character cards and prompt-injection issues are the user's own to solve.",
    "enabled": "Master switch",
    "defaultMuted": "New sessions start muted · a session must be switched on manually",

    "section.behavior": "Character behaviour",
    "section.date": "Date · holidays · birthdays",
    "section.ability": "Capabilities",
    "section.debug": "Debug",

    "sleep.group": "Sleep / wake",
    "sleep.groupHint": "Bedtime and wake time are rolled once per session per day",
    "sleep.sleepStart": "Bedtime",
    "sleep.sleepJitter": "Bedtime jitter ±min",
    "sleep.wakeStart": "Wake time",
    "sleep.wakeJitter": "Wake jitter ±min",

    "greet.group": "Greetings",
    "greet.groupHint": "Morning / noon / night, at most once each per day",
    "greet.enabled": "Greetings · good morning on waking, good night before bed",
    "greet.window": "Latest greeting delay / min",
    "greet.nightLead": "Lead time before bed / min",
    "greet.noon": "Midday · greet at noon",
    "greet.noonStart": "Noon base time",
    "greet.noonJitter": "Noon jitter ±min",

    "barrage.group": "Waking her up",
    "barrage.groupHint": "Several messages in a row → briefly awake",
    "barrage.count": "Threshold / messages",
    "barrage.window": "Window / min",
    "barrage.awake": "Awake for / min",

    "talk.group": "Speaking up",
    "talk.groupHint": "She speaks first after a long silence; daily cap, quiet hours respected",
    "talk.enabled": "Speaking up · start a conversation when the silence is long",
    "talk.interval": "Silence before speaking / min",
    "talk.jitter": "Interval jitter ±min",
    "talk.dailyMax": "Max per day (0 = unlimited)",
    "talk.quiet": "Quiet hours · leave both blank for none",
    "talk.quietTo": "to",

    "action.group": "Free time actions",
    "action.groupHint": "She finds something to do when nobody is talking",
    "action.enabled": "Free time actions · she does something when awake and idle",
    "action.interval": "Action interval / min",
    "action.jitter": "Interval jitter ±min",
    "action.idle": "Idle before acting / min",
    "action.default": "Default duration / min",
    "action.min": "Shortest / min",
    "action.max": "Longest / min",
    "action.dailyMax": "Max per day (0 = unlimited)",

    "date.groupHint": "Cities drive the weather; holidays and birthdays each switch independently",
    "date.citySelf": "Character's city",
    "date.cityUser": "User's city (blank = same city)",
    "date.cityHint": "Just the city name (Chinese or English, e.g. 杭州 / Hangzhou). Same-city and long-distance get different wording.",
    "date.weatherEnabled": "Weather · put the current weather in her background",
    "date.holidayEnabled": "Holidays · special greetings and topics on the day",
    "date.birthdayEnabled": "Birthdays · special greetings on the day",
    "date.birthdaySelf": "Character's birthday (MM-DD)",
    "date.birthdayUser": "User's birthday (MM-DD)",
    "date.birthdayPlaceholder": "e.g. 05-20",
    "date.refreshWeather": "Refresh weather now",
    "date.weatherHint": "Weather comes from Open-Meteo (no API key). It is fetched automatically once a city is saved.",
    // CC BY 4.0 requires a link to Open-Meteo next to wherever its data is displayed.
    "date.weatherCredit": "Weather data by Open-Meteo.com",
    "date.weatherSelf": "Character: {place} {text} {temp}C",
    "date.weatherUser": "User: {place} {text} {temp}C",
    "date.weatherAt": "Updated {time}",
    "date.today": "Today: {list}",
    "date.todayNone": "No holiday today, and nobody's birthday",
    "date.birthday.self": "It is the character's birthday",
    "date.birthday.user": "It is the user's birthday",
    "date.birthday.both": "It is both the character's and the user's birthday",
    "date.lunarOut": "The lunar holiday table covers {min}–{max} only; for {year} only fixed-date holidays apply.",

    "debug.groupHint": "You normally do not need this",
    "debug.offset": "Clock offset / min",

    "photo.group": "Image generation (karen_photo)",
    "photo.groupHint": "Only to support the \"going out\" action",
    "photo.note": "She only takes a photo when she is out somewhere notable (or when you explicitly ask):\n· With an API key: the image model is called with the prompt and the photo appears as a card on her side.\n· Without an API key: she will not call this tool; she describes what is in front of her in words instead.",
    "photo.apiBase": "API base",
    "photo.apiPath": "Path",
    "photo.model": "Model",
    "photo.size": "Size",
    "photo.apiKey": "API key (currently {state})",
    "photo.apiKeyNone": "not configured",
    "photo.apiKeyPlaceholder": "Paste a new key then save (leave blank to keep it)",
    "photo.clearKey": "Clear the stored key",
    "photo.prompt": "Default image prompt",
    "photo.promptPlaceholder": "Leave blank to use the default prompt",

    "sessions.title": "Live sessions",
    "sessions.empty": "No live sessions right now; open a conversation and it will appear here.",
    "recent.title": "Recent activity",
    "recent.clear": "Clear log",
    "recent.empty": "No activity recorded yet.",

    "session.asleep": "😴 asleep",
    "session.awake": "☀️ awake",
    "session.off": "switched off for this session",
    "session.sleepWindow": "This sleep {sleepLocal} → {wakeLocal} ({sleepAt} ~ {wakeAt})",
    "session.toWake": " · {n} until waking",
    "session.toSleep": " · {n} until bedtime",
    "session.stirredUntil": " · woken until {t}",
    "session.stirCount": " · woken {n} times",
    "session.mutedUntil": " · muted until {t}",
    "session.actions": "Free time actions: {total} total · {today} today",
    "session.nextAction": " · next around {t} (in {n})",
    "session.talkOn": "Speaking up: {total} total · {today} today",
    "session.talkOff": "Speaking up: off",
    "session.quietNow": " · in quiet hours now",
    "session.nextTalk": " · next around {t} (in {n})",
    "session.doing": "Doing: {label}{motive} · {left} left",
    "session.motive": " ({motive})",
    "session.idle": "Nothing else going on",
    "btn.sleepNow": "Put to sleep",
    "btn.wakeNow": "Wake up",
    "btn.stirNow": "Simulate waking",
    "btn.actNow": "Act once now",
    "btn.endAction": "End action",
    "btn.unskip": "Enable",
    "btn.skip": "Disable",
    "btn.reset": "Reset",

    "photoCard.taking": "Taking a photo…",
    "photoCard.failed": "Photo failed: {msg}",
    "photoCard.noMeta": "Photo shown (metadata missing)",
    "photoCard.alt": "Photo",

    "dur.mins": "{n} min",
    "dur.hours": "{h} h {m} min",
  };

  async function call(path, body) {
    const res = await fetch(API + path, body
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      : { cache: "no-store" });
    const data = await res.json();
    if (!data || data.ok === false) throw new Error((data && data.error) || ("HTTP " + res.status));
    return data;
  }

  function clock(ms) {
    if (!ms) return "-";
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function human(minutes) {
    const m = Number(minutes);
    if (!Number.isFinite(m)) return "-";
    if (m < 60) return t("dur.mins", { n: m });
    return t("dur.hours", { h: Math.floor(m / 60), m: m % 60 });
  }

  // ── karen_photo 工具卡片（角色侧内联图片）────────────────────────────
  // ptc 中转会把 presentationMeta 丢掉，所以 meta 拿不到时退回去读工具结果文字里的 sha256。
  const ATTACHMENT_ID_RE = /sha256:[0-9a-f]{64}/i;

  function blockText(block) {
    let out = "";
    const content = block && block.content;
    if (Array.isArray(content)) {
      for (const b of content) if (b && b.type === "text" && typeof b.text === "string") out += b.text;
    }
    return out;
  }

  function attachmentIdOf(block) {
    const meta = block && block.meta;
    if (meta && typeof meta === "object" && typeof meta.attachmentId === "string" && meta.attachmentId !== "") return meta.attachmentId;
    const hit = ATTACHMENT_ID_RE.exec(blockText(block) || "");
    return hit ? hit[0] : "";
  }

  function PhotoCard(props) {
    const block = props && props.block;
    if (!block || typeof block !== "object") return null;
    if (!("kind" in block)) return h("div", { style: st.card }, t("photoCard.taking"));
    if (block.isError === true) return h("div", { style: st.warn }, t("photoCard.failed", { msg: blockText(block) || "unknown" }));
    const id = attachmentIdOf(block);
    if (!id) return h("div", { style: st.card }, blockText(block) || t("photoCard.noMeta"));
    const meta = block.meta && typeof block.meta === "object" ? block.meta : {};
    const src = API + "/raw/" + encodeURIComponent(id);
    return h("div", { style: st.photoRow },
      meta.caption ? h("div", { style: st.hint }, String(meta.caption)) : null,
      h("img", {
        src,
        alt: t("photoCard.alt"),
        loading: "lazy",
        style: { maxWidth: "100%", maxHeight: 420, borderRadius: 8, display: "block" },
        onClick: () => { try { window.open(src, "_blank"); } catch { /* 弹窗被拦就算了 */ } },
      }));
  }

  function installPhotoToolview(ctx) {
    if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;
    try {
      ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
        name: "tool.call.toolview",
        key: PHOTO_TOOL,
        locale: NS,
      }, PhotoCard));
    } catch { /* 卡槽不可用就退回普通工具行 */ }
  }

  function sessionRow(a, busy, debug) {
    const head = h("div", { style: st.sessionHead },
      h("span", { style: a.phase === "asleep" ? st.badgeSleep : st.badgeAwake }, t(a.phase === "asleep" ? "session.asleep" : "session.awake")),
      h("span", { style: st.sessionTitle }, a.title || a.sessionId.slice(-12)),
      a.muted ? h("span", { style: st.badgeMute }, t("session.mutedUntil", { t: clock(a.mutedUntil) })) : null,
      a.skipped ? h("span", { style: st.badgeOff }, t("session.off")) : null);
    const detail = t("session.sleepWindow", {
      sleepLocal: a.sleepLocal || "-",
      wakeLocal: a.wakeLocal || "-",
      sleepAt: clock(a.sleepAt),
      wakeAt: clock(a.wakeAt),
    }) +
      (a.phase === "asleep" ? t("session.toWake", { n: human(a.minutesToWake) }) : t("session.toSleep", { n: human(a.minutesToSleep) })) +
      (a.awakeUntil ? t("session.stirredUntil", { t: clock(a.awakeUntil) }) : "") +
      t("session.stirCount", { n: a.stirCount });
    const act = t("session.actions", { total: a.actionCount, today: a.actionToday || 0 }) +
      (a.nextActionAt ? t("session.nextAction", { t: clock(a.nextActionAt), n: human(a.minutesToAction) }) : "");
    const talk = a.talkEnabled
      ? t("session.talkOn", { total: a.talkCount || 0, today: a.talkToday || 0 }) +
        (a.quietNow ? t("session.quietNow") : (a.nextTalkAt ? t("session.nextTalk", { t: clock(a.nextTalkAt), n: human(a.minutesToTalk) }) : ""))
      : t("session.talkOff");
    const doing = a.actionLabel
      ? t("session.doing", {
          label: a.actionLabel,
          motive: a.actionMotive ? t("session.motive", { motive: a.actionMotive }) : "",
          left: human(a.minutesToActionEnd),
        })
      : t("session.idle");
    const buttons = h("div", { style: st.row },
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("sleep-now", a.sessionId) }, t("btn.sleepNow")),
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("wake-now", a.sessionId) }, t("btn.wakeNow")),
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("stir-now", a.sessionId) }, t("btn.stirNow")),
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("act-now", a.sessionId) }, t("btn.actNow")),
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("end-action", a.sessionId) }, t("btn.endAction")),
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug(a.skipped ? "unskip" : "skip", a.sessionId) }, t(a.skipped ? "btn.unskip" : "btn.skip")),
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("reset", a.sessionId) }, t("btn.reset")));
    return h("div", { key: a.sessionId, style: st.session },
      head, h("div", { style: st.hint }, detail), h("div", { style: st.hint }, act),
      h("div", { style: st.hint }, talk), h("div", { style: st.hint }, doing), buttons);
  }

  function logRow(entry, i) {
    const tail = " " + entry.kind +
      (entry.sessionId ? " · " + String(entry.sessionId).slice(-12) : "") +
      (entry.reason ? " · " + entry.reason : "") +
      (entry.message ? " · " + entry.message : "");
    return h("div", { key: i, style: st.logRow },
      h("span", { style: st.mono }, clock(entry.ts)),
      h("span", { style: st.logText }, tail));
  }

  function Panel() {
    const [cfg, setCfg] = react.useState(null);
    const [status, setStatus] = react.useState(null);
    const [error, setError] = react.useState("");
    const [note, setNote] = react.useState("");
    const [busy, setBusy] = react.useState(false);
    const [dirty, setDirty] = react.useState(false);
    const [keyDraft, setKeyDraft] = react.useState("");

    const refresh = react.useCallback(async (adopt) => {
      try {
        const s = await call("/status");
        setStatus(s);
        if (adopt) setCfg(s.config);
        setError("");
      } catch (e) { setError(String((e && e.message) || e)); }
    }, []);

    react.useEffect(() => {
      refresh(true);
      const timer = setInterval(() => refresh(false), 5000);
      return () => clearInterval(timer);
    }, [refresh]);

    const set = (key, value) => { setDirty(true); setNote(""); setCfg((prev) => ({ ...prev, [key]: value })); };
    const guard = async (fn) => {
      setBusy(true);
      try { await fn(); } catch (e) { setError(String((e && e.message) || e)); } finally { setBusy(false); }
    };
    const save = () => guard(async () => {
      const payload = { ...cfg };
      // cfg.apiKey 是服务端回的 '***xxxx' 脱敏回显，绝不能原样回传（会把真实 Key 覆盖成掩码）。
      // 只有用户这次真的输入了新 Key 才带 apiKey 字段。
      delete payload.apiKey;
      if (keyDraft.trim()) payload.apiKey = keyDraft.trim();
      const r = await call("/config", { config: payload });
      setCfg(r.value); setKeyDraft(""); setDirty(false); setNote(t("saved"));
      await refresh(false);
    });
    const clearThing = (target) => guard(async () => {
      const r = await call("/clear", { target });
      if (target === "log") setNote(t("recent.clear"));
      else { setCfg((prev) => (prev ? { ...prev, apiKey: "" } : prev)); setKeyDraft(""); setNote(t("photo.clearKey")); }
      await refresh(false);
    });
    const debug = (action, sessionId) => guard(async () => {
      const r = await call("/debug", { action, sessionId });
      setNote(action + " → " + r.affected);
      await refresh(false);
    });
    const refreshWeather = () => guard(async () => {
      await call("/debug", { action: "weather-now" });
      await refresh(false);
    });

    if (!cfg) {
      return h("div", { style: st.card },
        h("p", { style: st.hint }, error ? t("loadFailed", { msg: error }) : t("loading")));
    }

    const agents = (status && status.agents) || [];
    const log = (status && status.log) || [];
    const wx = (status && status.weather) || {};
    const today = (status && status.today) || {};
    const lunar = (status && status.lunar) || {};
    const num = (key) => h("input", {
      style: st.input, type: "number", value: cfg[key],
      onChange: (e) => set(key, Number(e.target.value)),
    });
    const text = (key, placeholder) => h("input", {
      style: st.input, value: cfg[key], placeholder: placeholder || "",
      onChange: (e) => set(key, e.target.value),
    });
    const check = (key, label) => h("label", { style: st.fieldFull },
      h("span", { style: st.label }, label),
      h("input", { type: "checkbox", checked: cfg[key] !== false, onChange: (e) => set(key, e.target.checked) }));

    const group = (title, hint, children) => h("div", { style: st.group },
      h("div", { style: st.groupTitle }, title, hint ? h("span", { style: st.groupHint }, hint) : null),
      children);

    const sleepFields = group(t("sleep.group"), t("sleep.groupHint"), h("div", { style: st.grid },
      h("label", { style: st.field }, h("span", { style: st.label }, t("sleep.sleepStart")), text("sleepStart")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("sleep.sleepJitter")), num("sleepJitter")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("sleep.wakeStart")), text("wakeStart")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("sleep.wakeJitter")), num("wakeJitter"))));

    const greetFields = group(t("greet.group"), t("greet.groupHint"), h("div", { style: st.grid },
      check("greetEnabled", t("greet.enabled")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("greet.window")), num("greetWindowMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("greet.nightLead")), num("nightLeadMinutes")),
      check("greetNoonEnabled", t("greet.noon")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("greet.noonStart")), text("noonStart")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("greet.noonJitter")), num("noonJitterMinutes"))));

    const barrageFields = group(t("barrage.group"), t("barrage.groupHint"), h("div", { style: st.grid },
      h("label", { style: st.field }, h("span", { style: st.label }, t("barrage.count")), num("barrageCount")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("barrage.window")), num("barrageWindowMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("barrage.awake")), num("barrageAwakeMinutes"))));

    const talkFields = group(t("talk.group"), t("talk.groupHint"), h("div", { style: st.grid },
      check("talkEnabled", t("talk.enabled")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("talk.interval")), num("talkIntervalMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("talk.jitter")), num("talkJitterMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("talk.dailyMax")), num("talkDailyMax")),
      h("label", { style: st.fieldFull }, h("span", { style: st.label }, t("talk.quiet")),
        h("div", { style: st.row },
          h("input", { style: st.inputTime, value: cfg.talkQuietStart, placeholder: "23:30", onChange: (e) => set("talkQuietStart", e.target.value) }),
          h("span", { style: st.label }, t("talk.quietTo")),
          h("input", { style: st.inputTime, value: cfg.talkQuietEnd, placeholder: "08:00", onChange: (e) => set("talkQuietEnd", e.target.value) })))));

    const actionFields = group(t("action.group"), t("action.groupHint"), h("div", { style: st.grid },
      check("actionEnabled", t("action.enabled")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("action.interval")), num("actionIntervalMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("action.jitter")), num("actionJitterMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("action.idle")), num("actionIdleMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("action.default")), num("actionDefaultMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("action.min")), num("actionMinMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("action.max")), num("actionMaxMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("action.dailyMax")), num("actionDailyMax"))));

    // 天气现状 + 今天是什么日子（文案由宿主按同一语言生成，面板直接显示）
    const weatherLines = [];
    if (wx.self) {
      weatherLines.push(t("date.weatherSelf", { place: wx.self.place, text: wx.selfText || "", temp: wx.self.tempC == null ? "?" : wx.self.tempC }));
    }
    if (wx.user) {
      weatherLines.push(t("date.weatherUser", { place: wx.user.place, text: wx.userText || "", temp: wx.user.tempC == null ? "?" : wx.user.tempC }));
    }
    if (wx.at) weatherLines.push(t("date.weatherAt", { time: clock(wx.at) }));
    const todayNames = (today.holidays || []).map((x) => x.name);
    if (today.birthday) todayNames.push(t("date.birthday." + today.birthday));
    const lunarWarn = lunar.covered === false
      ? t("date.lunarOut", { min: lunar.min, max: lunar.max, year: new Date((status && status.nowMs) || Date.now()).getFullYear() })
      : "";

    const dateFields = group(t("section.date"), t("date.groupHint"), h("div", null,
      h("p", { style: st.groupNote }, t("date.cityHint")),
      h("div", { style: st.grid },
        h("label", { style: st.field }, h("span", { style: st.label }, t("date.citySelf")), text("citySelf", "杭州")),
        h("label", { style: st.field }, h("span", { style: st.label }, t("date.cityUser")), text("cityUser", "上海")),
        h("label", { style: st.field }, h("span", { style: st.label }, t("date.birthdaySelf")), text("birthdaySelf", t("date.birthdayPlaceholder"))),
        h("label", { style: st.field }, h("span", { style: st.label }, t("date.birthdayUser")), text("birthdayUser", t("date.birthdayPlaceholder")))),
      check("weatherEnabled", t("date.weatherEnabled")),
      check("holidayEnabled", t("date.holidayEnabled")),
      check("birthdayEnabled", t("date.birthdayEnabled")),
      h("p", { style: st.groupNote },
        weatherLines.length ? weatherLines.join("　") : t("date.weatherHint")),
      // CC BY 4.0：显示天气的地方旁边必须有这个链接，不能只写在 README 里。
      h("p", { style: st.credit },
        h("a", { href: "https://open-meteo.com/", target: "_blank", rel: "noreferrer", style: st.creditLink },
          t("date.weatherCredit"))),
      h("p", { style: st.groupNote },
        todayNames.length ? t("date.today", { list: todayNames.join("、") }) : t("date.todayNone")),
      lunarWarn ? h("p", { style: st.warnSmall }, lunarWarn) : null,
      h("div", { style: st.row },
        h("button", { style: st.buttonAlt, disabled: busy, onClick: refreshWeather }, t("date.refreshWeather")))));

    const debugFields = group(t("section.debug"), t("debug.groupHint"), h("div", { style: st.grid },
      h("label", { style: st.field }, h("span", { style: st.label }, t("debug.offset")), num("offsetMinutes"))));

    const photoFields = group(t("photo.group"), t("photo.groupHint"), h("div", null,
      h("p", { style: st.groupNote }, t("photo.note")),
      h("div", { style: st.grid },
      h("label", { style: st.field }, h("span", { style: st.label }, t("photo.apiBase")), text("apiBase")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("photo.apiPath")), text("apiPath")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("photo.model")), text("model")),
      h("label", { style: st.field }, h("span", { style: st.label }, t("photo.size")), text("size")),
      h("label", { style: st.fieldFull },
        h("span", { style: st.label }, t("photo.apiKey", { state: cfg.apiKey ? cfg.apiKey : t("photo.apiKeyNone") })),
        h("input", { style: st.input, type: "password", placeholder: t("photo.apiKeyPlaceholder"),
          value: keyDraft, onChange: (e) => { setKeyDraft(e.target.value); setDirty(true); setNote(""); } }),
        h("div", { style: st.row },
          h("button", { style: st.buttonAlt, disabled: busy, onClick: () => clearThing("apiKey") }, t("photo.clearKey")))),
      h("label", { style: st.field }, h("span", { style: st.label }, t("photo.prompt")), text("photoPrompt", t("photo.promptPlaceholder"))))));

    const sessions = agents.length === 0
      ? h("p", { style: st.hint }, t("sessions.empty"))
      : h("div", null, agents.map((a) => sessionRow(a, busy, debug)));
    const recent = log.length === 0
      ? h("p", { style: st.hint }, t("recent.empty"))
      : h("div", null, log.map(logRow));

    return h("div", { style: st.card },
      h("h3", { style: st.title }, "ProjectKaren"),
      h("p", { style: st.hint }, t("desc")),
      error ? h("div", { style: st.warn }, t("error", { msg: error })) : null,
      note ? h("div", { style: st.ok }, note) : null,
      check("enabled", t("enabled")),
      check("defaultMuted", t("defaultMuted")),
      h("h4", { style: st.subtitle }, t("section.behavior")),
      sleepFields,
      greetFields,
      barrageFields,
      talkFields,
      actionFields,
      dateFields,
      h("h4", { style: st.subtitle }, t("section.ability")),
      photoFields,
      h("h4", { style: st.subtitle }, t("section.debug")),
      debugFields,
      h("div", { style: st.row },
        h("button", { style: st.button, disabled: busy || !dirty, onClick: save }, dirty ? t("save") : t("saved"))),
      h("p", { style: st.hint }, t("configPath", { path: (status && status.path) || "-" })),
      h("h4", { style: st.subtitle }, t("sessions.title")),
      sessions,
      h("div", { style: st.row },
        h("h4", { style: st.subtitleRow }, t("recent.title")),
        h("button", { style: st.buttonAlt, disabled: busy, onClick: () => clearThing("log") }, t("recent.clear"))),
      recent);
  }

  const st = {
    card: { padding: "16px", maxWidth: 880, color: "#e6edf3" },
    title: { margin: "0 0 6px", fontSize: 16, fontWeight: 600, color: "#f0f6fc" },
    subtitle: { margin: "18px 0 8px", fontSize: 14, fontWeight: 600, color: "#f0f6fc" },
    hint: { fontSize: 12, color: "#9da7b3", margin: "0 0 10px" },
    ok: { margin: "0 0 12px", padding: "6px 12px", borderRadius: 8, fontSize: 13, background: "#12291d", color: "#3fb950", border: "1px solid #238636" },
    warn: { margin: "0 0 12px", padding: "8px 12px", borderRadius: 8, fontSize: 13, background: "#2d2410", color: "#d29922", border: "1px solid #9e6a03" },
    warnSmall: { margin: "0 0 10px", padding: "6px 10px", borderRadius: 8, fontSize: 12, background: "#2d2410", color: "#d29922", border: "1px solid #9e6a03" },
    grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 },
    group: { border: "1px solid #21262d", borderRadius: 8, padding: "10px 12px", margin: "0 0 10px", background: "#0b0f14" },
    groupTitle: { fontSize: 13, fontWeight: 600, color: "#f0f6fc", margin: "0 0 4px" },
    groupHint: { fontSize: 11, fontWeight: 400, color: "#8b949e", marginLeft: 8 },
    groupNote: { fontSize: 12, color: "#9da7b3", margin: "0 0 10px", lineHeight: 1.6, whiteSpace: "pre-line" },
    credit: { fontSize: 11, color: "#768390", margin: "0 0 10px" },
    creditLink: { color: "#58a6ff", textDecoration: "none" },
    subtitleRow: { margin: "0", fontSize: 14, fontWeight: 600, color: "#f0f6fc" },
    inputTime: { width: 92, padding: "6px 8px", fontSize: 13, borderRadius: 6, border: "1px solid #30363d", background: "#0d1117", color: "#e6edf3" },
    field: { display: "block", margin: "8px 0" },
    fieldFull: { display: "block", margin: "8px 0", gridColumn: "1 / -1" },
    label: { display: "block", fontSize: 12, fontWeight: 500, marginBottom: 3, color: "#c9d1d9" },
    input: { width: "100%", boxSizing: "border-box", padding: "6px 8px", fontSize: 13, borderRadius: 6, border: "1px solid #30363d", background: "#0d1117", color: "#e6edf3" },
    row: { display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" },
    button: { padding: "6px 16px", fontSize: 13, borderRadius: 6, cursor: "pointer", border: "1px solid #1f6feb", background: "#1f6feb", color: "#fff" },
    buttonAlt: { padding: "4px 12px", fontSize: 12, borderRadius: 6, cursor: "pointer", border: "1px solid #30363d", background: "#21262d", color: "#e6edf3" },
    session: { border: "1px solid #21262d", borderRadius: 8, padding: "10px 12px", margin: "0 0 8px" },
    sessionHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 },
    sessionTitle: { fontSize: 13, color: "#f0f6fc" },
    badgeSleep: { fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "#1f2937", color: "#a5b4fc" },
    badgeAwake: { fontSize: 12, padding: "2px 8px", borderRadius: 999, background: "#2d2410", color: "#facc15" },
    badgeOff: { fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "#2b2b2b", color: "#9da7b3" },
    badgeMute: { fontSize: 11, padding: "2px 8px", borderRadius: 999, background: "#2b2410", color: "#d29922" },
    logRow: { padding: "3px 0", fontSize: 11, display: "flex", gap: 6 },
    logText: { color: "#9da7b3" },
    mono: { fontSize: 11, fontFamily: "monospace", color: "#768390" },
    photoRow: { padding: "4px 0" },
  };

  function apply(ctx) {
    if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;
    // 面板 UI 文案：注册两种语言并绑定当前语言。
    try {
      ctx.locale.register(NS, { zh, en });
      t = ctx.locale.bind(NS);
    } catch { /* locale 不可用时 t 退回原样返回 key */ }
    // 宿主侧注入的提示词也要用同一种语言——把解析结果报上去（宿主没有 locale 服务）。
    const reportLang = () => {
      try {
        const snap = typeof ctx.locale.getSnapshot === "function" ? ctx.locale.getSnapshot() : null;
        const lang = snap && snap.active;
        if (!lang) return;
        fetch(API + "/locale", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lang }),
        }).catch(() => {});
      } catch { /* 上报失败只影响提示词语言，不影响面板 */ }
    };
    reportLang();
    try { ctx.locale.subscribe(() => reportLang()); } catch { /* 订阅不可用 */ }
    installPhotoToolview(ctx);
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "project-karen",
      order: 57,
      label: () => "ProjectKaren",
      locale: NS,
      inject: () => ({}),
    }, () => react.createElement(Panel)));
  }

  exports.name = name;
  exports.inject = inject;
  exports.apply = apply;
  return module.exports;
}});
