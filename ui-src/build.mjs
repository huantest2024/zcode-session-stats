// 构建：打包 app.js → 内联进 panel.html（单文件，无外网依赖）
// 用法：node build.mjs
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "..", "plugins", "session-stats", "ui", "panel.html");

await build({
  entryPoints: [path.join(here, "app.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  minify: true,
  outfile: path.join(here, "bundle.js"),
  logLevel: "info",
});

let js = fs.readFileSync(path.join(here, "bundle.js"), "utf8");
// 内联到 <script> 里必须转义闭合标签（只会出现在字符串/正则字面量中）
js = js.replace(/<\/script/gi, "<\\/script");

const tpl = fs.readFileSync(path.join(here, "panel.template.html"), "utf8");
if (!tpl.includes("/*__BUNDLE__*/")) {
  throw new Error("模板缺少 /*__BUNDLE__*/ 占位符");
}
const html = tpl.replace("/*__BUNDLE__*/", () => js);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
const size = fs.statSync(OUT).size;
console.log(`panel.html 生成完毕: ${OUT} (${(size / 1024).toFixed(1)} KiB)`);
if (size > 4 * 1024 * 1024) {
  throw new Error("超过宿主 4MiB HTML 资源上限");
}
