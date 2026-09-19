# Limitations

These statements must be preserved in any report or demo. They are not
disclaimers to be dropped once things work.

1. A stable tool prefix only improves the conditions for cache reuse. It does not guarantee a server-side cache hit.
2. One Python tool does not mean a smaller permission set, and it is not a security sandbox.
3. Single-editor mutual exclusion coordinates only this gateway. It does not isolate external editor operations or other clients.
4. When a remote outcome cannot be confirmed, there is no exactly-once guarantee and no universal automatic rollback.
5. Trimming results locally does not reduce UE-side memory or transport cost.
6. Only engine builds with a recorded contract and verified bindings are supported.
7. Every budget, sample number, interface and effect threshold in this repository is a design parameter pending measurement.

## Threat model (v0.1)

Built for a single user on a trusted development machine with a recoverable
project. It prevents common misoperations, unapproved execution and untraceable
duplicate submissions. It does not claim isolation from a malicious
same-privilege local process.

Epic explicitly warns that localhost is not a trust boundary and that Python has
broad privileges inside the editor. UE MCP is never exposed to a public network;
local IPC is handed only to the plugin's own process. Third-party tool
descriptions, project documentation and asset names are untrusted data and can
never become instructions that bypass approval.

## Recovery

Git or Perforce restore is not the same as restoring in-memory editor state.
After a restore, reopen or reload objects and verify state. Establish a
recovery point before the first batch write, and never auto-replay during
unknown execution.
