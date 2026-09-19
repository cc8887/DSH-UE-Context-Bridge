# P0 contract probes

Record real responses here before writing any general adapter. Each capture
needs its collection time and environment versions.

```text
fixtures/contracts/<engine-build>/
  01-handshake.json        protocol, capabilities, transport
  02-tools-list.json       raw tools/list response
  03-list-toolsets.json    raw list_toolsets response
  04-describe-toolset.json raw describe_toolset for candidate toolsets
  05-structured-read.json  a discovered read-only tool with real args/response
  06-python-minimal.json   schema, code output, exception response
  07-python-binding.json   native Toolset <-> Python call mapping
  08-lifecycle.json        reconnect, editor stop, restart, PIE state
  09-dsh-observation.json  visible tools, prompt section, usage
  collection-meta.json     capture time, engine build, DSH commit, project
```

## Pass criteria

- Handshake connects to the target editor.
- Top-level discovery establishes whether the current mode is meta-tools or full listing.
- A complete input definition and real identity can be extracted per tool.
- Transport success is distinguishable from business success.
- `import unreal` and a scalar read run under Python.
- The same read-only operation matches between the MCP path and the in-process binding.
- A cached catalog is never mistaken for an online editor.
- Actual model input is confirmed from observation, not from config files alone.

## Rule

No placeholder may be published as a compatibility statement. With no confirmed
Python Toolset binding, mark the binding unsupported rather than guessing a
name conversion.
