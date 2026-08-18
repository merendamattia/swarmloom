# Codex adapter material

The backend adapter owns Codex CLI arguments, model, reasoning effort, sandbox, auth home, and JSONL
normalization. Behavioral instructions remain canonical outside this directory. Each session writes
its plain text response to the `Response file` path the worker reads verbatim after the run.
