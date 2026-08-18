# OpenCode adapter material

The backend adapter owns OpenCode CLI arguments, model, automatic permission mode, auth/config
paths, and JSONL normalization. Behavioral instructions remain canonical outside this directory.
The shared result schema is included in each fresh session prompt and the agent writes its
structured outcome to the `Result file` path the worker reads after the run.
