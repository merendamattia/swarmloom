# Codex adapter material

The backend adapter owns Codex CLI arguments, model, reasoning effort, sandbox, auth home, and JSONL
normalization. Behavioral instructions remain canonical outside this directory. The shared result
schema is included in each fresh session prompt and the agent writes its structured outcome to the
`Result file` path the worker reads after the run.
