# Codex adapter material

The backend adapter owns Codex CLI arguments, model, reasoning effort, sandbox, auth home, and JSONL
normalization. Behavioral instructions remain canonical outside this directory. The shared result
schema is passed to `codex exec --output-schema` for each fresh session.
