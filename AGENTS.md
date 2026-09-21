# AGENTS.md

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.

## 语言约定

- 所有与用户的对话、生成的文档（spec / PRD / CONTEXT.md / ADR / 调研报告）、issue 正文与评论，一律使用**简体中文**。
- 技术术语、GitHub issue 标签名（如 `ready-for-agent`、`needs-triage`）、代码标识符、CLI 命令保持英文原样。
- 任何 skill（grilling / research / to-spec / triage / wayfinder 等）在本项目中执行时，默认以简体中文进行，除非用户明确切换语言。

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage labels, used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## 可验证性契约（Verifiability Contracts）

> 目的：让本项目的 PR 能被**独立验收**——审阅方（Deployer）在合并前用真实数据验证，
> 而不是只能靠作者自带测试自证。规则按项目形态适用（Web UI / API 服务 / 消息通知 /
> 周期扫描 / 批处理）：不适用项可注明「不适用」跳过，但不得以"用不上"为由整体删除本节。

### V1 数据可寻址、可追溯（治"mock 全绿、真数据白屏"）
- 用户可见的数据须有**稳定、可机器校验的读取路径**：服务端渲染 HTML、JSON API、
  轮询端点皆可——外部审阅方能独立断言「页面呈现 == 真实数据」。禁止把运行时
  数据只放在客户端内存 / 组件私有状态、无任何可寻址出口。
- 外部世界数据（链上 / 官方 API / 行情源）的访问点须**可识别**：集中在一处、
  列入配置端点清单、或在文档中列明——审阅方能确定每个外部源并做真值对照与录制，
  无需逆向逐个文件。
- mock / fixture 必须镜像真实 schema：字段名、类型、缺省值逐一对齐。
  类型漂移（如数值被序列化成字符串）本身是 bug，验收按失败处理。

### V2 后台活动必须可观测（治"引擎停摆无人知"）
- 常驻循环 / 引擎 / 调度器暴露**心跳**：稳定读路径返回「最后活跃时间」并周期性推进。
- 每次扫描 / 任务 / 运行写入统一审计记录（可查询、可上展示页，不得只活在日志里）。
- 出站消息（通知 / 推送 / 回调）记录内容与去向，测试可断言「预期消息确已发出」。

### V3 应用必须可隔离运行（治"PR 没上 trunk 就没法验"）
- 端口 / DB 路径 / 日志路径 / 数据源 URL 全部可被 config 或环境变量覆盖，禁止硬编码。
- 提供隔离启动方式：或以参数注入替代真实后端（测试 DB / 关引擎），
  或文档写明如何起第二个实例互不干扰。
- 前端产物必须能从源码确定性构建（build 命令与依赖声明入库）。

### V4 决策逻辑必须可单测回放（治"报警误报/数值错算"）
- 报警 / 异常判定 / 推荐 / 打分等带业务语义的逻辑实现为**纯函数**（无副作用、可独立调用），
  不依赖 UI 即可运行。
- 关键纯函数配单元测试；验收可用**真实历史序列回放**验证判定正确性，而非只看 UI 呈现。

### V5 测试分层并声明数据真实性
- 测试分单元（纯逻辑）与 e2e（浏览器 / 进程级）两层；e2e 必须显式标注每类数据是
  **mock 还是真实**（fixture 命名 / conftest 注释），不允许混装不自知。
- 作者自带测试全绿 ≠ 可合并：独立验收（真实数据 / 真值对照）是合并前门禁，
  不把作者测试当作唯一证据。
