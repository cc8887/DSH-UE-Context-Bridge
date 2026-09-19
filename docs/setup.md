# Setup

Verified end-to-end on this machine: dsh -> plugin -> gateway -> UE MCP -> editor.

## What was verified

- Editor: `UnrealEditor.exe` (ue6-main), MCP plugin listening on `127.0.0.1:8000`.
- `bEnableToolSearch=False` -> complete tool list: 12 tools from one `tools/list`.
- Gateway connects, indexes 12 tools, searches, describes and invokes.
- dsh profile `ue-bridge` registers `ue_find` / `ue_call` and really calls the editor.

```text
ue_find (summary, "crash")  -> 2 hits, coverage complete
ue_find (schema)            -> schemaRevision rev:88b4847d
ue_call (invoke)            -> execution succeeded, real crash data returned
```

## 1. Enable the UE MCP server

`ModelContextProtocol` is `EnabledByDefault: false`. Create
`<project>/Config/DefaultEditorPerProjectUserSettings.ini`:

```ini
[/Script/ModelContextProtocol.ModelContextProtocolSettings]
bAutoStartServer=True
ServerPortNumber=8000
bEnableToolSearch=False
```

`bAutoStartServer` defaults to **false** — without it nothing listens.
`bEnableToolSearch` defaults to **true**, which exposes only
`list_toolsets` / `describe_toolset` / `call_tool`. Turn it off to get the full
list, which is what the deferred catalog is built from.

Do **not** add a wildcard to the Origin allow-list: it is the DNS-rebinding
defense. localhost, 127.0.0.1 and [::1] are accepted by default.

Enable the plugin in the `.uproject`:

```json
{ "Name": "ModelContextProtocol", "Enabled": true }
```

## 2. Build and deploy the plugin

```bash
node scripts/build-plugin.mjs     # compile TS -> JS (Node cannot strip types in node_modules)
node scripts/deploy.mjs ue-bridge # install into the profile's node_modules
```

## 2b. Enable the Python preset (ue-python)

The editor exposes **no** built-in `python.execute`. The only MCP-visible
Python surface is whatever a `UToolsetDefinition` registers, so the python
preset needs a real registered toolset.

`ue-project/Plugins/DshPythonBridgeToolset` registers one, in pure Python (no
C++ module, no compile step):

```python
@unreal.uclass()
class DshPythonTools(unreal.ToolsetDefinition):
    @toolset_registry.tool_call(mode=unreal.ToolAccessMode.EXECUTE)
    @staticmethod
    def execute_python(code: str, description: str) -> str: ...
```

Enable it in the `.uproject`:

```json
{ "Name": "DshPythonBridgeToolset", "Enabled": true }
```

Gotchas found the hard way:

- `Registration` is **not** re-exported from the package root. Import it as
  `from toolset_registry.registration import Registration`, or startup fails
  with `AttributeError: module 'toolset_registry' has no attribute
  'Registration'`.
- Importing the module only defines the class. `Registration([cls]).register()`
  is what makes it visible over MCP.
- The editor log truncates tracebacks, so `init_unreal.py` also appends the
  full frame to `Content/debug.log` next to the plugin.

Confirm registration (expect 13 tools, one ending in `execute_python`):

```bash
node scripts/py-probe.mjs
```

Then set the preset:

```yaml
config:
  preset: ue-python
  approvalChannelAvailable: true
```

## 3. Create the dsh profile

```bash
dsh --profile ue-bridge --from-default-profile headless
```

Add the bundle to `~/.dsh/profiles/ue-bridge/package.json`:

```json
"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@ue-bridge/bundle"]
```

A **new** plugin entry must come from a bundle layer using `insert`. The profile
root `cordis.yml` is reset to `[]` on every boot, and a patch overlay can only
override rows that already exist — both will report
`patch: entry "ue-bridge" not found`.

`~/.dsh/profiles/ue-bridge/node_modules/@ue-bridge/bundle/cordis.patch.yml`:

```yaml
- insert:
  - id: ue-bridge
    name: '@ue-bridge/dsh-plugin'
    config:
      preset: ue-deferred
      gatewayCommand: node
      gatewayArgs: ['--experimental-strip-types', 'packages/gateway/src/main.ts']
      gatewayCwd: /path/to/dsh-ue-context-bridge
      mcpUrl: http://127.0.0.1:8000/mcp
      approvalChannelAvailable: false
```

The plugin must export `inject = ['tools', 'systemPrompt']`, or cordis fails
with `cannot get property "systemPrompt" without inject`.

## 4. Approval

`approvalChannelAvailable: false` denies high-privilege operations rather than
permitting them silently. With `false`:

```text
APPROVAL_REQUIRED: effect class "unknown" needs an approval channel
```

Set it to `true` only where a real approval channel exists.

## 5. Run

```bash
dsh --profile ue-bridge "use ue_find to look up crash tools"
```

```text
ue_python_execute (print + 6*7)  -> stdout "hello from dsh\n42\n", value "42"
ue_python_execute (raise)        -> ok:false + full traceback, editor stays up
ue_python_execute (no approval)  -> APPROVAL_REQUIRED, nothing executed
```

## Known deviations from the plan

- The gateway talks raw JSON-RPC, not the MCP SDK client: the UE server declares
  an output schema but returns only text content, which the SDK's
  structured-content validation rejects even for successful calls.
- Effect class is not yet derived from adapter rules, so every discovered tool is
  `unknown` and therefore requires approval. This is fail-closed by design.
- The python preset resolves its tool id from the live catalog at call time.
  The id is not stabilized by Epic, so it is looked up rather than hardcoded;
  without `DshPythonBridgeToolset` enabled the call fails with
  `EDITOR_UNAVAILABLE` and a hint instead of dispatching a bogus id.
