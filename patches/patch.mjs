/*
 * session-stats pills — ZCode Desktop app.asar 补丁器
 *
 * 用法（必须先完全退出 ZCode，包括托盘）：
 *   node patch.mjs apply     打补丁（幂等，重复执行安全）
 *   node patch.mjs restore   还原最近一次备份
 *   node patch.mjs status    查看当前补丁状态
 *
 * 做什么：往渲染层入口 JS 末尾追加 pills 注入脚本（贴在输入框下方的统计 pill），
 * 不改其他任何文件。数据来自 session-stats 插件 MCP 服务器内置的本地数据服务。
 *
 * 注意：ZCode 自动更新会覆盖 app.asar，更新后重新 apply 即可（本脚本幂等）。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPackageWithOptions,
  extractAll,
  extractFile,
  getRawHeader,
  uncache,
} from "./tools/node_modules/@electron/asar/lib/asar.js";
import { readArchiveHeaderSync } from "./tools/node_modules/@electron/asar/lib/disk.js";

const PATCH_VERSION = "1.3.0";
const MARKER = "out/session-stats-pills.json";
const INJECT_TAG = "__SSPILLS_INJECTED__";
const UNPACK_GLOB = "**/node_modules/{@img,node-pty,ssh2}/**";
const DEFAULT_RESOURCES = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "Programs", "ZCode", "resources"
);
const here = path.dirname(fileURLToPath(import.meta.url));
const PILLS_SRC = path.join(here, "pills-loader.js");

// 测试模式：ZCODE_RESOURCES_DIR 指向一个 app.asar 副本目录即可干跑（不校验 ZCode 进程）
const TEST_MODE = !!process.env.ZCODE_RESOURCES_DIR;

// 枚举本地固定磁盘（DriveType=3，避开断网映射盘/光驱）；PowerShell 不可用则回退 A-Z 探测
function fixedDrives() {
  try {
    const out = execSync(
      "powershell -NoProfile -Command \"(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3').DeviceID\"",
      { timeout: 8000, encoding: "utf8", windowsHide: true }
    );
    const ds = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[A-Z]:$/.test(s)).map((s) => s + "\\");
    if (ds.length) return ds;
  } catch { /* 回退到 A-Z 探测 */ }
  const ds = [];
  for (let i = 65; i <= 90; i++) {
    const d = String.fromCharCode(i) + "\\";
    try { if (fs.existsSync(d)) ds.push(d); } catch { /* 跳过不可访问盘 */ }
  }
  return ds;
}

// 生产模式：全盘自动定位 ZCode 的 resources 目录
// ① 每个本地盘的常见安装模式（精确路径，瞬时）② 各盘浅层扫描（深度≤2，目录名含 ZCode，
// 必须真实存在 app.asar 才命中）。仍未命中则返回 null，由调用方提示手动指定。
function resolveResourcesDir() {
  if (TEST_MODE) return process.env.ZCODE_RESOURCES_DIR;
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const drives = fixedDrives();
  const patterns = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "ZCode", "resources"),
    path.join(pf, "ZCode", "resources"),
    path.join(pf86, "ZCode", "resources"),
  ];
  for (const d of drives) {
    patterns.push(
      path.join(d, "Program Files", "ZCode", "resources"),
      path.join(d, "Program Files (x86)", "ZCode", "resources"),
      path.join(d, "Programs", "ZCode", "resources"),
      path.join(d, "ZCode", "resources"),
      path.join(d, "soft", "ZCode", "resources"),
      path.join(d, "software", "ZCode", "resources"),
      path.join(d, "app", "ZCode", "resources"),
    );
  }
  for (const p of patterns) {
    try { if (fs.existsSync(path.join(p, "app.asar"))) return p; } catch { /* 跳过 */ }
  }
  // 浅层扫描：深度 ≤2
  for (const d of drives) {
    let tops = [];
    try { tops = fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { continue; }
    for (const t of tops) {
      const names = [path.join(d, t.name)];
      try {
        for (const c of fs.readdirSync(path.join(d, t.name), { withFileTypes: true })) {
          if (c.isDirectory()) names.push(path.join(d, t.name, c.name));
        }
      } catch { continue; }
      for (const n of names) {
        if (!/zcode/i.test(path.basename(n))) continue;
        for (const cand of [path.join(n, "resources"), n]) {
          try { if (fs.existsSync(path.join(cand, "app.asar"))) return cand; } catch { /* 跳过 */ }
        }
      }
    }
  }
  return null;
}

const log = (...a) => console.log(...a);
const die = (msg) => { console.error("✗ " + msg); process.exit(1); };

function zcodeRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /NH', {
      shell: "cmd.exe", encoding: "utf8",
    });
    return out.toLowerCase().includes("zcode.exe");
  } catch {
    return false;
  }
}

function assertUnlocked(p) {
  try {
    const fd = fs.openSync(p, "r+");
    fs.closeSync(fd);
  } catch (e) {
    die(`目标文件被占用（${e.code}）: ${p}\n` +
        "  请确认：① ZCode 已完全退出（含托盘与后台进程）② 杀毒软件未在扫描该目录。\n" +
        "  稍等几秒后重试通常即可。");
  }
}

function renameWithRetry(src, dst) {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(src, dst);
      return;
    } catch (e) {
      if (i >= 5) throw e;
      log(`替换被占用（第 ${i} 次，${e.code}），2 秒后重试…（杀毒扫描/后台进程常为瞬时占用）`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
}

function headerInfo(archivePath) {
  uncache(archivePath);
  const header = readArchiveHeaderSync(archivePath).header;
  let files = 0;
  const unpacked = new Set();
  (function walk(node, prefix) {
    for (const [name, child] of Object.entries(node.files || {})) {
      const p = prefix ? prefix + "/" + name : name;
      if (child.files) walk(child, p);
      else { files++; if (child.unpacked) unpacked.add(p); }
    }
  })(header, "");
  return { files, unpacked };
}

function findRendererEntry(rendererDir) {
  const html = fs.readFileSync(path.join(rendererDir, "index.html"), "utf8");
  const m = html.match(/<script[^>]*type="module"[^>]*src="\.\/(assets\/index-[^"]+\.js)"/);
  if (!m) die("index.html 里找不到渲染层入口 <script>");
  return m[1]; // 相对 renderer 的路径，如 assets/index-u-S3C1E6.js
}

function apply() {
  if (!TEST_MODE && zcodeRunning()) {
    die("ZCode 正在运行，无法打补丁。请完全退出 ZCode（包括托盘图标）后重试。");
  }
  if (!fs.existsSync(PILLS_SRC)) die(`找不到注入脚本: ${PILLS_SRC}`);

  const resources = resolveResourcesDir();
  if (!resources) {
    die("未找到 ZCode 的 resources 目录。\n" +
        "已自动扫描所有本地磁盘的常见安装位置与 *ZCode* 目录（深度 2 层），均未发现 app.asar。\n" +
        "请手动定位：右键 ZCode 快捷方式 → 打开文件位置，ZCode.exe 旁边就是 resources 文件夹。\n" +
        "然后设置环境变量并重试（同一命令行窗口内）：\n" +
        "  set ZCODE_RESOURCES_DIR=<实际路径>\\resources");
  }
  const asarPath = path.join(resources, "app.asar");
  const unpackedDir = asarPath + ".unpacked";
  for (const p of [asarPath, unpackedDir]) {
    if (!fs.existsSync(p)) {
      die(`宿主文件不存在: ${p}\n` +
          `  本脚本默认定位标准安装路径: ${resources}\n` +
          `  若你的 ZCode 装在别处：设置环境变量 ZCODE_RESOURCES_DIR 指向其 resources 目录\n` +
          `  （示例: set ZCODE_RESOURCES_DIR=D:\\Program Files\\ZCode\\resources），然后重试。`);
    }
  }
  assertUnlocked(asarPath);

  const orig = headerInfo(asarPath);
  log(`原 asar: ${orig.files} 个文件，${orig.unpacked.size} 个 unpacked`);

  // 1. 解包到临时目录（直接从原 asar 解，unpacked 文件在其旁边才能取到）
  for (const d of fs.readdirSync(here)) {
    if (d.startsWith("work-")) fs.rmSync(path.join(here, d), { recursive: true, force: true });
  }
  const tmp = fs.mkdtempSync(path.join(here, "work-"));
  extractAll(asarPath, tmp);
  const rendererDir = path.join(tmp, "out", "renderer");

  // 2. 版本与幂等检查
  const pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf8"));
  const appVer = pkg.version;
  const entryRel = findRendererEntry(rendererDir);
  const entryAbs = path.join(rendererDir, entryRel);
  let entryCode = fs.readFileSync(entryAbs, "utf8");

  const markerPath = path.join(tmp, MARKER);
  if (fs.existsSync(markerPath)) {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    if (marker.appVersion === appVer && marker.patchVersion === PATCH_VERSION
        && entryCode.includes(INJECT_TAG)) {
      fs.rmSync(tmp, { recursive: true, force: true });
      log(`版本 ${appVer} 已应用过 patch ${PATCH_VERSION}，无需重复操作。`);
      return;
    }
    log(`检测到旧补丁 (app ${marker.appVersion} / patch ${marker.patchVersion})，将重新应用。`);
  }

  // 3. 备份（每个 app 版本只备份一次，保留最初的原版）
  const backup = path.join(resources, `app.asar.bak-${appVer}`);
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(asarPath, backup);
    log(`已备份原版 → ${backup}`);
  } else {
    log(`备份已存在: ${backup}`);
  }

  // 4. 追加注入脚本（升级时先剥离旧注入块：旧块 = 从标记行起直到文件尾）
  const TAGLINE = `\n;/*${INJECT_TAG}*/`;
  const pills = fs.readFileSync(PILLS_SRC, "utf8");
  if (entryCode.includes(TAGLINE)) {
    entryCode = entryCode.slice(0, entryCode.indexOf(TAGLINE));
    log("已剥离旧版注入块，替换为新版");
  }
  entryCode += TAGLINE + "\n" + pills + "\n";
  fs.writeFileSync(entryAbs, entryCode);
  log(`已注入渲染层入口: ${entryRel} (+${(pills.length / 1024).toFixed(1)} KiB)`);

  // 5. 语法自检（node --check 以 ESM 解析）
  const checkFile = entryAbs + ".check.mjs";
  fs.copyFileSync(entryAbs, checkFile);
  try {
    execSync(`node --check "${checkFile}"`, { stdio: "pipe" });
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    die("注入后的入口 JS 语法检查未通过，已放弃: " + e.message);
  }
  fs.rmSync(checkFile, { force: true });

  // 6. 写补丁标记（记录源包原本是否已含标记，供文件数核对）
  const hadMarker = fs.existsSync(markerPath);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    patch: "session-stats-pills", patchVersion: PATCH_VERSION,
    appVersion: appVer, appliedAt: new Date().toISOString(), entry: entryRel,
  }, null, 2));

  // 7. 重打包（保持原生模块 unpacked）
  const newAsar = path.join(resources, "app.asar.new");
  fs.rmSync(newAsar, { force: true });
  fs.rmSync(newAsar + ".unpacked", { recursive: true, force: true });

  // 8. 完整性核对（与原 asar 对比文件数与 unpacked 集合）
  const checkAndFinish = async () => {
    await createPackageWithOptions(tmp, newAsar, { unpack: UNPACK_GLOB });
    const patched = headerInfo(newAsar);
    log(`新 asar: ${patched.files} 个文件，${patched.unpacked.size} 个 unpacked`);
    const expectFiles = orig.files + (hadMarker ? 0 : 1);
    if (patched.files !== expectFiles) {
      fs.rmSync(newAsar, { recursive: true, force: true });
      fs.rmSync(newAsar + ".unpacked", { recursive: true, force: true });
      die(`文件数不符（预期 ${expectFiles} ≠ 新 ${patched.files}），已放弃，未改动宿主。`);
    }
    const missing = [...orig.unpacked].filter((p) => !patched.unpacked.has(p));
    if (missing.length) {
      fs.rmSync(newAsar, { recursive: true, force: true });
      fs.rmSync(newAsar + ".unpacked", { recursive: true, force: true });
      die(`原生模块 unpacked 集合缺失 ${missing.length} 个（如 ${missing[0]}），已放弃。`);
    }
    if (patched.unpacked.size > orig.unpacked.size) {
      log(`提示: unpacked 文件比原来多 ${patched.unpacked.size - orig.unpacked.size} 个（glob 放宽导致，无害）`);
    }

    // 9. 合并 unpacked 目录（覆盖式，内容与原版一致）
    fs.cpSync(newAsar + ".unpacked", unpackedDir, { recursive: true, force: true });

    // 10. 换入主文件（fs.renameSync 在 Windows 上带覆盖语义；EPERM 多为杀软瞬时锁，重试）
    renameWithRetry(newAsar, asarPath);
    fs.rmSync(newAsar + ".unpacked", { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });

    const after = headerInfo(asarPath);
    const markerCheck = (() => {
      try {
        const raw = extractFile(asarPath, MARKER);
        return raw && raw.length > 0;
      } catch { return false; }
    })();
    if (!markerCheck) die("替换后校验失败：新 asar 里读不到补丁标记（请用 restore 还原后反馈）");
    log(`✓ 补丁完成: app ${appVer} + patch ${PATCH_VERSION}（${after.files} 文件 / ${after.unpacked.size} unpacked）`);
    log("下一步: 启动 ZCode，在任意会话的输入框下方查看统计 pill。");
    log("数据服务由 session-stats 插件（≥0.2.0）的 MCP 服务器提供，请确认插件已更新启用。");
  };
  checkAndFinish().catch((e) => {
    console.error("✗ 打包/替换失败: " + (e && e.stack || e));
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /NH', { shell: "cmd.exe", encoding: "utf8" });
      if (out.toLowerCase().includes("zcode.exe")) {
        console.error("检测到 ZCode 进程仍在运行（可能驻留托盘），请全部退出后重新运行 apply。");
      } else {
        console.error("未检测到 ZCode 进程；多为杀毒软件对刚写入的大文件的瞬时锁定。" +
          "\n稍等几秒重新运行 apply 即可，宿主文件未被改动。");
      }
    } catch { /* 诊断失败不影响主错误 */ }
    process.exit(1);
  });
}

function restore() {
  if (!TEST_MODE && zcodeRunning()) die("ZCode 正在运行，请先完全退出再还原。");
  const resources = resolveResourcesDir();
  if (!resources) die("未找到 ZCode 的 resources 目录（自动发现失败），请设置 ZCODE_RESOURCES_DIR 后重试。");
  const asarPath = path.join(resources, "app.asar");
  const backups = fs.readdirSync(resources)
    .filter((f) => f.startsWith("app.asar.bak-"))
    .map((f) => path.join(resources, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!backups.length) die("找不到任何 app.asar.bak-* 备份，无法还原。");
  fs.renameSync(backups[0], asarPath);
  log(`✓ 已还原: ${path.basename(backups[0])} → app.asar`);
  log("注意: app.asar.unpacked 中的文件与原版一致，无需处理。");
}

function status() {
  const resources = resolveResourcesDir();
  if (!resources) {
    log("未找到 ZCode 的 resources 目录（自动发现失败）");
    log("ZCode 运行中:", zcodeRunning() ? "是" : "否");
    return;
  }
  const asarPath = path.join(resources, "app.asar");
  try {
    const raw = extractFile(asarPath, MARKER).toString("utf8");
    log("补丁标记:", raw);
  } catch {
    log("未打补丁（或 asar 中无标记）");
  }
  log("ZCode 运行中:", zcodeRunning() ? "是" : "否");
}

const cmd = process.argv[2];
if (cmd === "apply") apply();
else if (cmd === "restore") restore();
else if (cmd === "status") status();
else die("用法: node patch.mjs apply|restore|status");
