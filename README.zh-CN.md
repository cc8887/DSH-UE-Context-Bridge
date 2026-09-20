# UE Context Bridge

[English](./README.md)

让编码智能体用两三个固定工具驱动一个真实运行的 Unreal 编辑器，而不是把几百个工具塞进上下文。

编辑器的 MCP 插件暴露了庞大的工具库。全部加载进模型上下文既浪费，又与单次任务大多无关。本项目把工具库留在模型之外，只给它两个元工具：先检索需要的，再精确调用那一个。它以 DSH 插件形式运行，配一个本地网关子进程与编辑器通信，使审批、工具名与模式隔离始终掌握在宿主手中。

## 两种模式

模式在整个会话内固定，切换需开启新会话。

| 模式 | 模型可见工具 | 工作方式 |
| --- | --- | --- |
| `ue-deferred` | `ue_find`、`ue_call` | 由 toolset 描述构建本地关键词索引，检索相关工具后经统一入口分发 |
| `ue-python` | `ue_python_execute` | 检索、执行、过滤与摘要全部在编辑器内 Python 中完成 |

两种预设另外提供 `ue_env_check` 与 `ue_editor_status` / `ue_editor_start` / `ue_editor_stop`，用于解析引擎、驱动编辑器生命周期，而不靠猜测路径。

## 快速开始

需要 Node >= 20、启用 `ModelContextProtocol` 插件的 Unreal Engine，以及 DSH。

```bash
node scripts/build-plugin.mjs
node scripts/deploy.mjs ue-bridge
dsh --profile ue-bridge "use ue_find to look up crash tools"
```

完整步骤见 [docs/setup.md](docs/setup.md)，其中有两个不显然的关键配置：`bAutoStartServer=True`（不设置则无人监听）与 `bEnableToolSearch=False`（否则只暴露三个元工具）。

## 相比直接接 UE MCP 的优势

编辑器自带的 MCP 插件是合适的传输层，但它没有解决一个问题：把整个工具库一次性交到模型手里会发生什么。以下是本项目针对这一点所做的具体设计，每一条都对应仓库中的实际实现。

**工具面始终只有两三个。** 模型可见的工具结构在注册时冻结，不随目录内容、项目或引擎版本变化，因此客户端看到的工具前缀跨会话稳定。其余一切都留在 `ue_find` 之后。

**检索在本地、且是确定性的。** `ue_find` 在网关内为目录打分，权重依次是精确工具 id、方法名、toolset 名、关键词。没有 LLM 查询改写，每次检索不产生额外模型调用，因此检索本身只消耗查询与命中结果的 token。

**引擎与编辑器是解析出来的，不是猜出来的。** 一个项目用哪个引擎构建属于人的决定：按项目根目录询问一次并记住，绝不静默切换。高置信度的解析结果直接使用并告知，只有真正歧义时才再次询问。生命周期工具接收的是意图（让编辑器可用），而不是一个操作一个工具，因此"启动"可以是构建、拉起或两者，模型无需关心是哪种。

**审批与身份归宿主所有。** 网关是插件拥有的子进程、只做 UE MCP 客户端，而不是插在模型路径上的又一个 MCP server，因此工具名、返回结构与模式隔离始终由宿主控制。调用身份由宿主绑定，模型永远不提供可信身份字段。作用类别来自适配规则或人工复核，绝不来自工具名、模型的自述或未经验证的 MCP 注解。审批绑定到参数摘要、项目、编辑器 epoch 与适配器版本，因而无法被挪用于另一次操作；在缺少审批通道时，特权调用是被拒绝而不是默认放行。

**失败是一等答案。** 执行、验证与持久化作为三个独立事实上报，因此"调用返回了"绝不会被表述为"资源已保存"。每个错误都带明确的重试策略。落在未知状态的写入绝不自动重放，单编辑器写锁也不会仅因客户端超时而释放。

**大结果折叠，而不是灌进上下文。** 超预算的负载被收敛为携带字节数与 `result_id` 的小规范化值，完整内容通过 artifact store 用 cursor 读回。这是真正的分页而非截断文本尾巴，且截断状态始终上报。

**UE 侧零新增。** 上游 MCP 插件与引擎目录视为只读。python 模式通过引擎自带的 remote-execution 协议抵达编辑器，而不是新增插件，因此升级引擎或切换项目时没有补丁需要重新应用、也没有需要维护的派生插件。

上述每条都能在具体文件中核对，而不是仅凭说明采信：

| 优势 | 实现位置 |
| --- | --- |
| 模型可见结构冻结 | [model-tools.ts](packages/contracts/src/model-tools.ts) |
| 本地确定性打分 | [catalog.ts](packages/gateway/src/catalog/catalog.ts) |
| 引擎按项目决定一次 | [engine-selection.ts](packages/dsh-plugin/src/engine-selection.ts) |
| 宿主绑定身份、作用类别、审批摘要 | [approval.ts](packages/dsh-plugin/src/approval.ts) |
| 执行/验证/持久化分离与重试策略 | [model-tools.ts](packages/contracts/src/model-tools.ts) |
| 未知结果下保持写锁 | [ledger.ts](packages/gateway/src/execution/ledger.ts) |
| 字节预算与 cursor 分页 | [results.ts](packages/contracts/src/results.ts) |

以上每一条都有边界，这些边界写在 [docs/limitations.md](docs/limitations.md) 中并属于契约。稳定的前缀只是改善缓存复用的条件，并不保证服务端命中缓存。单个 Python 工具不等于更小的权限集，也不是沙箱。本地裁剪结果不会降低 UE 侧的内存或传输开销。

## 目录结构

```text
packages/bundle/      DSH profile bundle：声明 dsh.bundle.patch，通过 `dsh plugin add` 安装
packages/contracts/    共享的模型工具、IPC 与预算契约
packages/dsh-plugin/   DSH 插件：工具注册、预设、审批、生命周期
packages/gateway/      网关子进程：UE MCP 客户端、目录、调用账本
ue/Content/Python/uex/ 编辑器内辅助库
presets/               ue-deferred.yaml、ue-python.yaml 与 DSH profile bundle
fixtures/contracts/    按引擎版本录制的上下游响应
tests/unit/            单元测试
scripts/               构建、部署、探测与实机验证脚本
docs/                  setup、architecture、permissions、limitations
ue-project/            用于运行 bridge 的最小 UE 工程
```

## 设计约束

不改动 UE 侧。上游 MCP 插件与引擎目录视为只读：python 模式通过引擎自带的 remote-execution 协议抵达编辑器，而不是新增 UE 插件。deferred 索引必须由 toolset 描述构建，因为顶层工具列表只暴露元工具。

失败必须显式暴露。当远端结果无法确认、或工具的作用类别未知时，拒绝调用而不是凭猜测作答。

## 当前状态

早期阶段，已在单机（Windows、UE `ue6-main`）完成端到端验证。作用类别推断、预算调参与多编辑器协调仍未完成。[limitations](docs/limitations.md) 属于契约的一部分，不能因为功能跑通而删去。

## 许可证

[MIT](./LICENSE)
