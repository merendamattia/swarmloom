# OpenCode adapter material

The backend adapter owns OpenCode CLI arguments, model, automatic permission mode, auth/config
paths, and JSONL normalization. Behavioral instructions remain canonical outside this directory.
Each session writes its plain text response to the `Response file` path the worker reads verbatim
after the run.
