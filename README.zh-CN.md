# DoneGauge

**Know what's done. See what's verified.**

DoneGauge 是面向 AI 辅助编程的本地验收工具，将明确的需求、Git 变更和真实测试证据关联起来。

> AI says it's done. DoneGauge shows the evidence.

[English](README.md) · [配置说明](docs/configuration.md) · [DSH 集成](docs/dsh.md) · [架构](docs/architecture.md) · [下一阶段详细方案](docs/next-steps.zh-CN.md)

## 功能与定位

- 采集相对 Git 基准的已暂存、未暂存和未跟踪变更，不修改历史或索引。
- 用一个 `donegauge.json` 声明任务、验收条件和检查命令，提供 Schema 校验。
- 显式授权后运行本地命令，处理超时、取消、启动异常和日志截断，不隐式拼接 Shell。
- 区分 PASS、FAIL、UNVERIFIED、ERROR；每个通过结论都有命令、时间、退出状态和日志证据。
- 输出终端、Markdown、JSON 报告，每次使用新目录保存。
- 通过 DSH 官方插件接口提供 `donegauge_check` 工具。

代码审查用于解释差异，测试工具用于执行断言，DoneGauge 将验收条件与这些结果对应，并明确显示证据缺口。它不会凭代码存在或模型描述判定通过，不计算“代码正确率”，也不会生成测试后自行认定通过。核心功能不需要 API Key 或付费模型。

## 安装

要求 Node.js 22+、npm 和 Git；Python 示例需要 Python 3。可选 DSH 适配器要求 Node.js 24.9+、DSH **0.2.2-rc.3**。

在项目源码目录执行：

```sh
git clone https://github.com/L8848-Li/DoneGauge.git
cd DoneGauge
npm ci --ignore-scripts
npm run build
node dist/src/cli.js --help
```

本轮交付为源码和可构建安装包，**尚未发布到 npm**。不要假定 `npx donegauge` 下载的是本项目。可以将本地安装包安装到自己的项目：

```sh
# DoneGauge 源码目录
npm pack

# 你的项目目录，替换实际安装包路径
npm install --save-dev /path/to/DoneGauge/donegauge-0.1.0.tgz
npx --no-install donegauge --version
```

无需全局安装。`npm run test:package` 会在临时项目中验证打包、安装、可执行命令和真实验收流程。

## 三分钟上手

在源码目录准备独立演示项目并运行真实测试：

```sh
node scripts/demo.mjs node-registration --run
```

脚本将示例复制到临时目录，仅在那里初始化 Git，不改变当前源码目录的 Git 状态。Node.js 示例实际验证重复邮箱拒绝、带独立盐值的 scrypt 密码存储、注册后登录，预期三项通过。它是小型测试示例，不是可直接部署的账户系统。

查看包含四种状态的示例：

```sh
node scripts/demo.mjs node-registration --mixed --run
```

此示例包含真实的登录回归错误、没有检查命令的验收条件，以及不存在的审计程序。预期每种状态各一项、退出码 2。这是有意保留的失败测试场景，验收结果仍来自实际执行。

独立 Python 示例只使用标准库 `unittest` 和 `Decimal`：

```sh
node scripts/demo.mjs python-cart --run
```

## 在自己的项目中使用

```sh
npx --no-install donegauge init
```

修改生成的文件。`init` 不覆盖已有配置，也不会自动批准检查命令。例如：

```json
{
  "version": 1,
  "task": "增加用户注册功能",
  "criteria": [
    {
      "id": "registration",
      "description": "注册流程的三条断言通过",
      "check": {
        "command": [
          "node",
          "--test",
          "--test-reporter=tap",
          "registration.test.mjs"
        ],
        "expect": { "stdoutIncludes": "# pass 3" }
      }
    },
    { "id": "audit", "description": "完成独立安全审查" }
  ]
}
```

```sh
npx --no-install donegauge check
npx --no-install donegauge check --allow-run
npx --no-install donegauge check --allow-run --base main --json
```

没有 `--allow-run` 时仅预览，结果为 UNVERIFIED。命令采用参数数组，不展开 `&&`、重定向、`$()` 或通配符。授权前请审阅命令及项目代码：它们以本地用户权限和环境运行。

## 阅读报告

混合示例的摘要如下；实际报告还包括运行编号、命令、日志和执行时间：

```text
[PASS] email: Duplicate email is rejected
[FAIL] login: User can log in with the regressed implementation
[UNVERIFIED] audit: Security audit completed (no check configured)
[ERROR] missing-tool: External audit command can execute

Summary: 1 verified, 1 failed, 1 unverified, 1 errors
Final status: REVIEW REQUIRED
```

| 状态       | 含义                                                     |
| ---------- | -------------------------------------------------------- |
| PASS       | 已执行命令满足配置的退出码与输出约定。                   |
| FAIL       | 正常完成的检查明确违背预期结果。                         |
| UNVERIFIED | 没有检查、没有执行，或必要输出可能因截断而丢失。         |
| ERROR      | 启动失败、超时、中断等执行异常，不能据此证明功能有缺陷。 |

报告保存在 `.donegauge/runs/<运行编号>/report.md` 和 `report.json`。建议在 `.gitignore` 中加入 `.donegauge/`。此保留目录不作为未跟踪代码变更采集，但其中已跟踪文件仍被检查。

退出码：0 为全部通过且工作区稳定；1 为需要复核；2 为执行或配置异常。`--json` 的标准输出只有 JSON，报告路径写入标准错误。报告保留原始日志，可能包含私有代码或敏感内容；只存本地，不自动上传或脱敏。

## DSH 集成

```sh
npx --no-install donegauge config-hash
```

按 [DSH 指南](docs/dsh.md) 创建本地 `--patch` 配置，绑定项目 Git 根目录与人工审阅的配置摘要，再主动要求 DSH 调用 `donegauge_check`，参数为 `{}`。模型不能传入任意命令、路径或批准标记；摘要不符时会拒绝执行，需重新审阅配置。

已使用 DSH **0.2.2-rc.3** 官方运行库和本机 Desktop 内置官方 CLI 验证插件加载、工具分发与真实测试。尚未手动验证实时模型在 Desktop/Web 对话中选择工具的 UI 流程，没有自定义卡片。项目不会自行修改已有 DSH 全局或 Desktop 配置。

## 已知限制

- 检查是否足以证明验收条件，由用户负责。退出码 0 仅证明命令约定满足；建议添加明确输出或测试数量预期，避免把空跑当作充分验证。
- 尚无框架结果解析、自动发现或生成测试、失败到源码定位和评分。
- 检查顺序执行；前后 Git 指纹不是原子快照或签名证明。忽略文件及子模块内部未提交内容不被完整追踪。
- 默认每条命令保留 64 KiB 输出，Git 差异展示上限 256 KiB；文件元数据超限会停止采集，不会静默漏掉文件。
- 重命名按删除和新增显示；不自动拉取远程仓库或选择任务基准。
- 已通过 GitHub CI 的 Ubuntu/macOS 检查；Windows 进程树终止及 `.cmd` 启动尚不完整，不作为 V0.1 已验证支持平台。
- DSH 仅声明精确版本兼容。命令在宿主用户权限中执行，不自动使用 DSH bash 工具的隔离机制。
- 尚无交互式初始化、上次报告浏览、后台、云账户、协作、自动修复，以及 Codex/Claude Code 适配器。

## 开发与路线图

```sh
npm run check
npm run test:package
npm run test:dsh-host  # 可选，需要已安装的兼容 DSH
```

[贡献指南](CONTRIBUTING.md) · [架构](docs/architecture.md) · [实际验证记录](docs/validation.md)

最优先的下一项功能是 **JUnit 结果检查器**：要求真正执行具体测试，将验收条件关联到测试名称，进一步识别空跑和跳过。后续保留 V0.2 Agent 适配器、V0.3 框架检查器、V0.4 证据追溯与质量门禁、V1.0 交付验收协议的空间，本轮不提前实现。

## 许可证

[MIT](LICENSE)。依赖许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
