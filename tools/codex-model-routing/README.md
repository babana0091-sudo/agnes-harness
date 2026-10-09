# Codex model routing toggle / 模型路由开关

这是为 Windows 官方 CI 包生成的本地补丁工具，**不是官方功能，也不是新构建的 CI 包**。
不重新编译 EXE；备份并修改 `worker.mjs` 和 `daemon.mjs` 中的两个函数，添加一个本地辅助模块。
工具不联网、不读取登录令牌、不更改服务端地址、不新增日志字段。

## 行为

| 状态 | 页面选择 | 发给 Codex 的模型 | 会话记录的模型 |
| --- | --- | --- | --- |
| 原版 / 关闭 | `gpt-6-astra` | `gpt-6-astra` | `gpt-6-astra` |
| 开启 | `gpt-6-astra` | `gpt-6.1-sol` | `gpt-6-astra` |
| 开启 | `gpt-6-sol` | `gpt-6.1-sol` | `gpt-6-sol` |

适用范围为使用 ChatGPT / Codex 账号登录、走官方 `openai-codex-responses` 协议的模型调用。
其他服务商与 API-Key 路由保留原行为。网页模型列表和账户设置保留原版功能，不新增模型项。

日志中的 `model` 和服务器返回模型对应的 `response.model` 在开启时按所选模型别名记录。
记录没有新增 `actualModel` 等字段；关闭时恢复原版的响应模型记录行为。
这些开启状态下的模型字段表示页面选择的别名，不能作为服务端实际模型的证明。
真实请求 ID、时间、token、HTTP 状态、请求哈希和回答内容保留实际值，不改写旧对话。
`sent_hash` 在开启时会不同，因为它继续计算真正发送的请求字节。
页面仍按所选模型的目录元数据显示容量、功能、参考成本；这不保证两模型的能力或计价完全相同。

6.1 不支持的 `none` / `minimal` 思考请求映射到 `low`。
其余 `low`、`medium`、`high`、`xhigh`、`max` 保留，实际输出额度不超过 128000。
账户是否有 6.1 权限仍由 OpenAI 决定，脚本不能绕过权限或额度限制。

## 首次使用

1. 将工具 ZIP 中的两个 `.mjs`、两个 `.cmd` 文件放在 Agnes 解压目录，与 EXE 同级。
2. 等当前任务完成，关闭运行 `serve` 的窗口，再从该目录的 PowerShell 停止后台。
3. 开启补丁并重新启动。

```powershell
.\agnes-win32-x64.exe daemon stop
.\runtime\node.exe .\agnes-model-routing.mjs --on
.\agnes-win32-x64.exe serve
```

如果之前使用过“仅提供 6.1”的旧配置脚本，新工具会检查备份，并自动恢复原账户配置、原模型列表。
只有旧文件未被其他操作改变、备份哈希匹配时才自动恢复，不覆盖另外修改的配置。
默认查找 `%USERPROFILE%\.agh\profiles\local-dev`；设置过 `AGH_HOME` / `AGNES_HOME` / `AGNES_PROFILE`
时使用同一环境。也可以传 `--home "D:\AgnesData" --profile local-dev`。

## 日常开关

首次安装并重启后，可以双击：

- `开启6.1.cmd`：实际调用 6.1，日志记录页面选择。
- `关闭6.1.cmd`：按页面选择实际调用，日志恢复原版规则。

或在 PowerShell 执行：

```powershell
.\runtime\node.exe .\agnes-model-routing.mjs --on
.\runtime\node.exe .\agnes-model-routing.mjs --off
.\runtime\node.exe .\agnes-model-routing.mjs --status
```

开关保存在程序目录的 `agnes-model-routing.json`，只含 `version` 和 `enabled`。
已安装的工作进程在下一次调用时读取新值；已经发送的请求不改变，后续推理或重试读取新状态。
首次安装和卸载需要停止后台再启动，普通开关不需要重新编译或重启。
开关作用于同一程序目录下的 Codex 调用，不是单独某个会话的开关。

## 卸载与恢复

等任务结束、关闭 `serve` 后：

```powershell
.\agnes-win32-x64.exe daemon stop
.\runtime\node.exe .\agnes-model-routing.mjs --uninstall
.\agnes-win32-x64.exe serve
```

原始两个 JavaScript 文件按字节恢复，开关和安装记录移除。
若运行文件、辅助模块或备份被别人改过，工具拒绝自动覆盖，先核对变化。
安装目录需要可写，推荐在自己可写的解压目录使用，无需管理员权限。

## 来源与适用版本

仅接受以下官方 Windows CI 的原始文件哈希；其他版本会拒绝修改：

```text
CI run: 37262837798
Commit: c4efd170547a225890664c1c186a7347399b53e0
worker.mjs SHA256: d0b947cb5f18955bbc1048c6e159374e30f76c2d6b9d1494879a2f772015ac11
daemon.mjs SHA256: eada75c45461262be82234a2058ba9a3547ca6b845982991f594bde0c8c5bf5d
https://github.com/AgnesAI-Labs/agnes-harness/actions/runs/37262837798/artifacts/11326350996
```

改动点是 Agnes 自身的 `streamOverApi` 和 `translateEvent`，没有修改其第三方 API 实现或日志 schema。
程序 EXE、Node runtime、原生模块和 Web 静态资源均使用原 CI 文件。

## 对比日志与验证边界

ZIP 的 `对比日志` 文件夹包含三组原格式快照：原版 Astra、开启后实际 6.1、关闭后的 Astra。
请求头使用原 CI 的 Core `deriveRequest` 生成；模型事件经过原 CI 的 `PiAdapter`、日志转换函数和公开推理事件 facade。
HTTP、模型回答、上下文与文本解码边界使用固定的虚构数据；正常和错误事件、模型别名、发送哈希均作了断言。
固定输入下，请求头逐字节相同，公开模型事件只有真实发送哈希不同；实际发送内容的 `model` 在开启时为 6.1。
这证明所测日志结构和模型字段兼容，不表示真实模型的回答、token、时间、请求 ID 必然相同。

测试环境：Linux ARM64，Node 24.21.0，禁用网络；未调用真实账号。
**未运行完整 Windows 后台、未导出真实 SQLite 对话数据库，也未在用户电脑实测**。
需要实际运行后的完整对话导出时，应在用户自己的 Windows 上分别调用并导出，不能把这里的样例当成真实调用。

从源码复现（CI 包先解压到本地，Node 24.10 或更新版本）：

```powershell
$env:AGNES_ROUTING_CI_DIR = "D:\ci-package"
$env:AGNES_ROUTING_EVIDENCE_DIR = "D:\comparison-output"
node --test tools/codex-model-routing/routing.test.mjs
```

没有设置 CI 路径时，只执行辅助模块测试，集成测试会跳过；验证此交付必须提供原 CI 路径。

## English summary

This reversible, version-pinned local patch keeps Codex UI model selections and session model fields
as aliases while routing enabled official Codex calls to `gpt-6.1-sol`. It preserves schema, request
hash integrity, IDs, usage and message text. It does not rebuild or alter the executable, read
credentials, or change endpoints. It patches two functions in both CI sidecars, with original-byte
backups. `--on`, `--off`, `--status` and `--uninstall` manage a local switch. Initial installation and
uninstall require a backend restart; later switch changes apply on the next call. Other providers
are unaffected. The included comparisons are offline synthetic fixtures, not live account traces.
