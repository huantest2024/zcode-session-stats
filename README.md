# session-stats

[中文](./README.md) | 会话统计插件 for ZCode Desktop。

ZCode 会话统计插件：轮次/步数、模型/工具耗时、TTFT（首 token 平均延迟）、TPS（会话平均 +
最近请求）、token 用量、缓存命中率与模型分布。

- **零第三方依赖**：MCP 服务器为 Python 标准库实现（3.10+），无 pip 依赖
- **只读**：仅读取本机 ZCode 会话数据库，无网络访问、无凭证、无遥测

## 功能

| 组件 | 说明 |
|---|---|
| MCP 工具 `get_stats` | 当前会话（含子代理聚合）/ 今日汇总的完整统计 |
| MCP App 侧栏面板 | 统计卡片 + 明细弹窗，5 秒轮询，跟随会话切换与主题 |
| `/stats` 命令 | 文字版统计卡片 |
| SessionStart hook | 会话 id 交接，用于解析「当前会话」 |
| 输入框统计条（可选） | 输入框下方居中的常驻统计条，需宿主补丁（见下） |

## 安装

插件本体：ZCode Desktop → **Plugin Marketplace → Add** → 粘贴本仓库地址
（或下载 ZIP 后粘贴解压目录）→ **Install session-stats** → 重启 → `/stats`。

输入框统计条（可选）：额外需要 Node.js。完全退出 ZCode → 双击
`patches\apply-patch.cmd` → 重启。ZCode 自动更新后重跑一次；`restore-patch.cmd` 一键还原。

## 指标口径

对 ZCode 3.17.1 本地数据库实测定案（`~/.zcode/cli/db/db.sqlite`，只读打开）：

| 指标 | 定义 |
|---|---|
| 轮次 | 主会话 `model_usage.turn_id` 去重数 |
| 步数 | `logical_request_id` 去重数（重试不计步；失败/取消计步） |
| 模型/工具用时 | Σ `duration_ms` |
| TTFT 均值 | AVG(`time_to_first_token_ms`) |
| TPS | Σ output ÷ Σ(completed_at − first_token_at)；「实时」= 最近一次完成请求 |
| token | Σ input + Σ output（实测 `input_tokens` 已含缓存读） |
| 缓存命中率 | cache_read ÷ input |

子代理会话经 `session.parent_id` 聚合进当前会话口径。宿主数据库 schema 属实现细节
（非稳定 API），查询对缺列做了优雅降级。

## 副作用

- 只读打开本地会话数据库（SQLite `mode=ro` + `busy_timeout`）
- 本地回环 HTTP 服务 `127.0.0.1:31710`：向 ZCode 渲染层提供统计 JSON 与面板脚本，
  仅响应无跨域 Origin 的请求（应用自身页面），其余 403
- SessionStart hook 在插件数据目录写一个小文件（`current_session`）

## 开发

- 插件：`plugins/session-stats/`（manifest、MCP 服务器、面板资源、命令、hook）
- 面板源码：`ui-src/`（`node build.mjs` 构建，产物内联进 `plugins/session-stats/ui/panel.html`）
- 宿主补丁：`patches/`（解包 → 注入 loader → 重打包，幂等 + 按版本备份 + restore）
- 本地测试市场清单在 `plugins/marketplace.json`（不随仓库分发，发布用根目录清单）

## License

MIT
