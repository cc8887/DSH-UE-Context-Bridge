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

## 目录结构

```text
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
