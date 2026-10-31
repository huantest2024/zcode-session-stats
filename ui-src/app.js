import { App } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "session-stats", version: "0.1.0" }, {});

let scope = "current"; // current | today
let data = null;
let errText = null;
let openDetail = false;
let lastUpdated = null;

// handler 必须在 connect 之前注册
app.onhostcontextchanged = () => applyTheme();

await app.connect();
applyTheme();
refresh();
// 5 秒轮询；面板不可见时跳过，省 DB 查询
setInterval(() => { if (!document.hidden) refresh(); }, 5000);

function applyTheme() {
  const theme = app.getHostContext()?.theme ?? "dark";
  document.documentElement.dataset.theme = theme;
}

async function refresh() {
  try {
    const res = await app.callServerTool({ name: "get_stats", arguments: { scope } });
    if (res.isError) throw new Error(res.content?.[0]?.text || "工具返回错误");
    data = res.structuredContent ?? parseText(res);
    errText = null;
    lastUpdated = new Date();
  } catch (e) {
    errText = e?.message ?? String(e);
  }
  render();
}

function parseText(res) {
  try {
    return JSON.parse(res.content?.find((c) => c.type === "text")?.text ?? "null");
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- 格式化 ----

function fmtDur(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} 秒`;
  const m = Math.floor(s / 60);
  const rs = Math.round(s % 60);
  if (m < 60) return `${m} 分 ${rs} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 时 ${m % 60} 分 ${rs} 秒`;
}

function fmtTok(n) {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(1)}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

function fmtPct(v) {
  return v == null ? "—" : `${v}%`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ------------------------------------------------------------- 渲染 ----

function render() {
  const root = document.getElementById("root");
  if (errText) {
    root.innerHTML = `
      <div class="card err">
        <div class="err-title">统计不可用</div>
        <div class="err-body">${esc(errText)}</div>
        <div class="hint">5 秒后自动重试；若持续失败请检查插件 server 日志</div>
      </div>`;
    return;
  }
  if (!data) {
    root.innerHTML = `<div class="card muted">连接会话数据库…</div>`;
    return;
  }
  if (data.error) {
    root.innerHTML = `<div class="card err"><div class="err-title">无法解析会话</div><div class="err-body">${esc(data.error)}</div></div>`;
    return;
  }

  const t = data.tokens ?? {};
  const pills = `
    <div class="pills">
      <button class="pill" id="pill1">
        <span class="ico">⏱</span>
        <b>${data.turns ?? "—"} 轮 ${data.steps ?? 0} 步</b>
        <span class="sep">·</span>
        <span>${data.tps != null ? data.tps : "—"} tok/s</span>
      </button>
      <button class="pill" id="pill2">
        <span class="ico">Σ</span>
        <b>${fmtTok(t.total)} tok</b>
        <span class="sep">·</span>
        <span>缓存命中 ${fmtPct(data.cache_hit_pct)}</span>
      </button>
    </div>
    <div class="scopebar">
      <button class="tab ${scope === "current" ? "on" : ""}" data-scope="current">当前会话</button>
      <button class="tab ${scope === "today" ? "on" : ""}" data-scope="today">今日汇总</button>
      <span class="upd">${lastUpdated ? "更新于 " + lastUpdated.toLocaleTimeString("zh-CN", { hour12: false }) : ""}</span>
    </div>
    ${openDetail ? detailHtml(data) : ""}
  `;
  root.innerHTML = pills;

  document.getElementById("pill1").onclick = () => { openDetail = !openDetail; render(); };
  document.getElementById("pill2").onclick = () => { openDetail = !openDetail; render(); };
  root.querySelectorAll(".tab").forEach((el) => {
    el.onclick = () => {
      scope = el.dataset.scope;
      data = null;
      render();
      refresh();
    };
  });
}

function detailHtml(d) {
  const t = d.tokens ?? {};
  const rows = [
    ["模型用时", fmtDur(d.model_ms)],
    ["工具调用用时", fmtDur(d.tool_ms)],
    ["首 token 平均（TTFT）", fmtDur(d.ttft_ms_avg)],
    ["输出速度（TPS）", d.tps != null ? `${d.tps} tok/s` : "—"],
    ["输入（含缓存）", fmtTok(t.input)],
    ["输出", fmtTok(t.output)],
    ["— 推理", fmtTok(t.reasoning)],
    ["— 缓存读", fmtTok(t.cache_read)],
    ["— 缓存写", fmtTok(t.cache_write)],
    ["总 token", fmtTok(t.total)],
    ["缓存命中率", fmtPct(d.cache_hit_pct)],
  ];
  const scopeLine =
    d.scope === "today"
      ? `今日 ${d.sessions ?? "—"} 个会话`
      : `会话 ${esc(shortId(d.session_id))}${d.subagent_count ? ` · 含子代理 ${d.subagent_count} 个` : ""} · 数据源 ${esc(d.session_source ?? "—")}`;
  const models = (d.models ?? [])
    .map(
      (m) => `<tr><td class="mono">${esc(m.model_id ?? "—")}</td><td>${m.steps}</td><td>${fmtTok(m.t_in)}</td><td>${fmtTok(m.t_out)}</td><td>${m.tps != null ? m.tps : "—"}</td></tr>`
    )
    .join("");
  return `
    <div class="card detail">
      <div class="dtitle">会话统计</div>
      <table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td class="mono">${v}</td></tr>`).join("")}</table>
      ${models ? `<div class="dtitle small">模型分布</div>
      <table class="kv models">
        <tr class="head"><td>模型</td><td>步</td><td>输入</td><td>输出</td><td>tok/s</td></tr>
        ${models}
      </table>` : ""}
      <div class="hint">${scopeLine} · 5 秒自动刷新</div>
    </div>`;
}

function shortId(id) {
  if (!id) return "—";
  return id.length > 22 ? id.slice(0, 19) + "…" : id;
}
