// ProjectKaren 设置面板：睡眠窗口 + 模糊区间 + 轰炸唤醒 + 自由动作 + 生图 + 会话状态。
window.__ModuleLoader__.load({ id: "project-karen", factory: (require) => {
  var module = { exports: {} };
  var exports = module.exports;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  const react = require("react");

  const NS = "project-karen";
  const name = "project-karen";
  const inject = ["slots"];
  const API = "/project-karen";
  const PHOTO_TOOL = "karen_photo";
  const h = react.createElement;

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
    if (m < 60) return m + " 分钟";
    return Math.floor(m / 60) + " 小时 " + (m % 60) + " 分";
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
    if (!("kind" in block)) return h("div", { style: st.card }, "拍照中… / taking a photo…");
    if (block.isError === true) return h("div", { style: st.warn }, "照片失败 / failed: " + (blockText(block) || "unknown"));
    const id = attachmentIdOf(block);
    if (!id) return h("div", { style: st.card }, blockText(block) || "照片已显示（缺少元数据）");
    const meta = block.meta && typeof block.meta === "object" ? block.meta : {};
    const src = API + "/raw/" + encodeURIComponent(id);
    return h("div", { style: st.photoRow },
      meta.caption ? h("div", { style: st.hint }, String(meta.caption)) : null,
      h("img", {
        src,
        alt: "照片",
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
      h("span", { style: a.phase === "asleep" ? st.badgeSleep : st.badgeAwake }, a.phase === "asleep" ? "😴 睡着" : "☀️ 醒着"),
      h("span", { style: st.sessionTitle }, a.title || a.sessionId.slice(-12)),
      a.skipped ? h("span", { style: st.badgeOff }, "此会话不生效") : null);
    const detail = "本次睡眠 " + (a.sleepLocal || "-") + " → " + (a.wakeLocal || "-") +
      "（" + clock(a.sleepAt) + " ~ " + clock(a.wakeAt) + "）" +
      (a.phase === "asleep" ? " · 还要睡 " + human(a.minutesToWake) : " · 距入睡 " + human(a.minutesToSleep)) +
      (a.awakeUntil ? " · 被吵醒至 " + clock(a.awakeUntil) : "") +
      " · 被吵醒 " + a.stirCount + " 次";
    const act = "自由动作：已做 " + a.actionCount + " 次 · 今天 " + (a.actionToday || 0) + " 次" +
      (a.nextActionAt ? " · 下次约 " + clock(a.nextActionAt) + "（" + human(a.minutesToAction) + " 后）" : "");
    const talk = a.talkEnabled
      ? "主动搭话：已开口 " + (a.talkCount || 0) + " 次 · 今天 " + (a.talkToday || 0) + " 次" +
        (a.quietNow ? " · 现在在静默时段" : (a.nextTalkAt ? " · 下次约 " + clock(a.nextTalkAt) + "（" + human(a.minutesToTalk) + " 后）" : ""))
      : "主动搭话：已关闭";
    const doing = a.actionLabel
      ? "正在：" + a.actionLabel + (a.actionMotive ? "（" + a.actionMotive + "）" : "") + " · 还剩 " + human(a.minutesToActionEnd)
      : "现在没在做别的事";
    const buttons = h("div", { style: st.row },
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("sleep-now", a.sessionId) }, "让它睡"),
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("wake-now", a.sessionId) }, "叫醒"),
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("stir-now", a.sessionId) }, "模拟吵醒"),
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("act-now", a.sessionId) }, "立刻动作一次"),
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("end-action", a.sessionId) }, "结束动作"),
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug(a.skipped ? "unskip" : "skip", a.sessionId) }, a.skipped ? "恢复生效" : "此会话不生效"),
      h("button", { style: st.buttonAlt, disabled: busy, onClick: () => debug("reset", a.sessionId) }, "重置"));
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
      if (keyDraft.trim()) payload.apiKey = keyDraft.trim();
      const r = await call("/config", { config: payload });
      setCfg(r.value); setKeyDraft(""); setDirty(false); setNote("已保存");
      await refresh(false);
    });
    const clearThing = (target) => guard(async () => {
      const r = await call("/clear", { target });
      if (target === "log") setNote("日志已清空（" + (r.removed || 0) + " 条）");
      else { setCfg((prev) => (prev ? { ...prev, apiKey: "" } : prev)); setKeyDraft(""); setNote("已清空生图 API Key"); }
      await refresh(false);
    });
    const debug = (action, sessionId) => guard(async () => {
      const r = await call("/debug", { action, sessionId });
      setNote(action + " → " + r.affected + " 个会话");
      await refresh(false);
    });

    if (!cfg) {
      return h("div", { style: st.card },
        h("p", { style: st.hint }, error ? "加载失败 / load failed: " + error : "加载中… / loading…"));
    }

    const agents = (status && status.agents) || [];
    const log = (status && status.log) || [];
    const num = (key) => h("input", {
      style: st.input, type: "number", value: cfg[key],
      onChange: (e) => set(key, Number(e.target.value)),
    });
    const text = (key, placeholder) => h("input", {
      style: st.input, value: cfg[key], placeholder: placeholder || "",
      onChange: (e) => set(key, e.target.value),
    });

    const group = (title, hint, children) => h("div", { style: st.group },
      h("div", { style: st.groupTitle }, title, hint ? h("span", { style: st.groupHint }, hint) : null),
      children);

    const sleepFields = group("睡眠 / 唤醒", "每个会话每天摇一次入睡与醒来时刻", h("div", { style: st.grid },
      h("label", { style: st.field }, h("span", { style: st.label }, "入睡基准 / sleep at"), text("sleepStart")),
      h("label", { style: st.field }, h("span", { style: st.label }, "入睡模糊 ±分钟"), num("sleepJitter")),
      h("label", { style: st.field }, h("span", { style: st.label }, "醒来基准 / wake at"), text("wakeStart")),
      h("label", { style: st.field }, h("span", { style: st.label }, "醒来模糊 ±分钟"), num("wakeJitter"))));

    const greetFields = group("问候", "早安 / 午安 / 晚安，各每天最多一次", h("div", { style: st.grid },
      h("label", { style: st.fieldFull }, h("span", { style: st.label }, "打招呼 · 睡醒时道早安、睡前道晚安"),
        h("input", { type: "checkbox", checked: cfg.greetEnabled, onChange: (e) => set("greetEnabled", e.target.checked) })),
      h("label", { style: st.field }, h("span", { style: st.label }, "问候最多迟到 / 分钟"), num("greetWindowMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, "睡前提前 / 分钟"), num("nightLeadMinutes")),
      h("label", { style: st.fieldFull }, h("span", { style: st.label }, "午安 · 中午主动打招呼"),
        h("input", { type: "checkbox", checked: cfg.greetNoonEnabled, onChange: (e) => set("greetNoonEnabled", e.target.checked) })),
      h("label", { style: st.field }, h("span", { style: st.label }, "中午基准 / noon at"), text("noonStart")),
      h("label", { style: st.field }, h("span", { style: st.label }, "中午模糊 ±分钟"), num("noonJitterMinutes"))));

    const barrageFields = group("吵醒", "短时间内连发多条消息 → 临时清醒", h("div", { style: st.grid },
      h("label", { style: st.field }, h("span", { style: st.label }, "吵醒阈值 / 条数"), num("barrageCount")),
      h("label", { style: st.field }, h("span", { style: st.label }, "统计窗口 / 分钟"), num("barrageWindowMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, "吵醒后清醒 / 分钟"), num("barrageAwakeMinutes"))));

    const talkFields = group("主动搭话", "沉默够久让她先开口；每天有上限，静默时段不打扰", h("div", { style: st.grid },
      h("label", { style: st.fieldFull }, h("span", { style: st.label }, "主动搭话 · 沉默久了主动找用户说话"),
        h("input", { type: "checkbox", checked: cfg.talkEnabled, onChange: (e) => set("talkEnabled", e.target.checked) })),
      h("label", { style: st.field }, h("span", { style: st.label }, "沉默多久后开口 / 分钟"), num("talkIntervalMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, "间隔模糊 ±分钟"), num("talkJitterMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, "每天最多 / 次（0 = 不限）"), num("talkDailyMax")),
      h("label", { style: st.fieldFull }, h("span", { style: st.label }, "静默时段 · 两个都留空 = 不设"),
        h("div", { style: st.row },
          h("input", { style: st.inputTime, value: cfg.talkQuietStart, placeholder: "23:30", onChange: (e) => set("talkQuietStart", e.target.value) }),
          h("span", { style: st.label }, "到"),
          h("input", { style: st.inputTime, value: cfg.talkQuietEnd, placeholder: "08:00", onChange: (e) => set("talkQuietEnd", e.target.value) })))));

    const debugFields = group("调试", "平时不用动", h("div", { style: st.grid },
      h("label", { style: st.field }, h("span", { style: st.label }, "时钟偏移 / 分钟"), num("offsetMinutes"))));

    const actionFields = group("自由动作", "没人说话时她自己找事做", h("div", { style: st.grid },
      h("label", { style: st.fieldFull }, h("span", { style: st.label }, "自由动作 · 醒着且没人说话时自己找事做"),
        h("input", { type: "checkbox", checked: cfg.actionEnabled, onChange: (e) => set("actionEnabled", e.target.checked) })),
      h("label", { style: st.field }, h("span", { style: st.label }, "动作间隔 / 分钟"), num("actionIntervalMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, "间隔模糊 ±分钟"), num("actionJitterMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, "静默多久才动 / 分钟"), num("actionIdleMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, "动作默认时长 / 分钟"), num("actionDefaultMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, "动作最短 / 分钟"), num("actionMinMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, "动作最长 / 分钟"), num("actionMaxMinutes")),
      h("label", { style: st.field }, h("span", { style: st.label }, "每天最多 / 次（0 = 不限）"), num("actionDailyMax"))));

    const photoFields = group("生图（karen_photo）", "仅为「出游」行动配套", h("div", null,
      h("p", { style: st.groupNote },
        "角色出游到名胜景点（或你明确要求）时才会拍照：\n" +
        "· 配了 API Key：按提示词调用生图接口，照片以卡片显示在她那一侧。\n" +
        "· 没配 API Key：她不会调用这个工具；到了该拍照的场景，改用模型自身的能力把眼前景象用文字描述出来。"),
      h("div", { style: st.grid },
      h("label", { style: st.field }, h("span", { style: st.label }, "API Base"), text("apiBase")),
      h("label", { style: st.field }, h("span", { style: st.label }, "路径 / path"), text("apiPath")),
      h("label", { style: st.field }, h("span", { style: st.label }, "模型 / model"), text("model")),
      h("label", { style: st.field }, h("span", { style: st.label }, "尺寸 / size"), text("size")),
      h("label", { style: st.fieldFull }, h("span", { style: st.label }, "API Key（当前 " + (cfg.apiKey || "未配置") + "）"),
        h("input", { style: st.input, type: "password", placeholder: "粘贴新 Key 后点保存（不改就别填）",
          value: keyDraft, onChange: (e) => { setKeyDraft(e.target.value); setDirty(true); setNote(""); } }),
        h("div", { style: st.row },
          h("button", { style: st.buttonAlt, disabled: busy, onClick: () => clearThing("apiKey") }, "清空已保存的 Key"))),
      h("label", { style: st.field }, h("span", { style: st.label }, "默认画面提示词"), text("photoPrompt")))));

    const sessions = agents.length === 0
      ? h("p", { style: st.hint }, "当前没有活跃会话；打开一个对话后这里会出现。")
      : h("div", null, agents.map((a) => sessionRow(a, busy, debug)));
    const recent = log.length === 0
      ? h("p", { style: st.hint }, "还没有动作记录。")
      : h("div", null, log.map(logRow));

    return h("div", { style: st.card },
      h("h3", { style: st.title }, "ProjectKaren"),
      h("p", { style: st.hint },
        "本插件仅提供模拟角色经由「时间」产生的一系列动作。生图功能仅为「出游」行动配套配置。" +
        "角色卡及注入相关问题烦请用户自行解决。"),
      error ? h("div", { style: st.warn }, "错误 / error: " + error) : null,
      note ? h("div", { style: st.ok }, note) : null,
      h("label", { style: st.fieldFull },
        h("span", { style: st.label }, "总开关"),
        h("input", { type: "checkbox", checked: cfg.enabled, onChange: (e) => set("enabled", e.target.checked) })),
      h("label", { style: st.fieldFull },
        h("span", { style: st.label }, "新会话默认静音 · 首次出现的会话需手动「恢复生效」"),
        h("input", { type: "checkbox", checked: cfg.defaultMuted, onChange: (e) => set("defaultMuted", e.target.checked) })),
      h("h4", { style: st.subtitle }, "角色行为"),
      sleepFields,
      greetFields,
      barrageFields,
      talkFields,
      actionFields,
      h("h4", { style: st.subtitle }, "能力"),
      photoFields,
      h("h4", { style: st.subtitle }, "调试"),
      debugFields,
      h("div", { style: st.row },
        h("button", { style: st.button, disabled: busy || !dirty, onClick: save }, dirty ? "保存配置" : "已保存")),
      h("p", { style: st.hint }, "配置文件：" + ((status && status.path) || "-")),
      h("h4", { style: st.subtitle }, "活跃会话 / live sessions"),
      sessions,
      h("div", { style: st.row },
        h("h4", { style: st.subtitleRow }, "最近动作 / recent"),
        h("button", { style: st.buttonAlt, disabled: busy, onClick: () => clearThing("log") }, "清空日志")),
      recent);
  }

  const st = {
    card: { padding: "16px", maxWidth: 880, color: "#e6edf3" },
    title: { margin: "0 0 6px", fontSize: 16, fontWeight: 600, color: "#f0f6fc" },
    subtitle: { margin: "18px 0 8px", fontSize: 14, fontWeight: 600, color: "#f0f6fc" },
    hint: { fontSize: 12, color: "#9da7b3", margin: "0 0 10px" },
    ok: { margin: "0 0 12px", padding: "6px 12px", borderRadius: 8, fontSize: 13, background: "#12291d", color: "#3fb950", border: "1px solid #238636" },
    warn: { margin: "0 0 12px", padding: "8px 12px", borderRadius: 8, fontSize: 13, background: "#2d2410", color: "#d29922", border: "1px solid #9e6a03" },
    grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10 },
    group: { border: "1px solid #21262d", borderRadius: 8, padding: "10px 12px", margin: "0 0 10px", background: "#0b0f14" },
    groupTitle: { fontSize: 13, fontWeight: 600, color: "#f0f6fc", margin: "0 0 4px" },
    groupHint: { fontSize: 11, fontWeight: 400, color: "#8b949e", marginLeft: 8 },
    groupNote: { fontSize: 12, color: "#9da7b3", margin: "0 0 10px", lineHeight: 1.6, whiteSpace: "pre-line" },
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
    logRow: { padding: "3px 0", fontSize: 11, display: "flex", gap: 6 },
    logText: { color: "#9da7b3" },
    mono: { fontSize: 11, fontFamily: "monospace", color: "#768390" },
    photoRow: { padding: "4px 0" },
  };

  function apply(ctx) {
    if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;
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
