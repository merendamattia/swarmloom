# Swarmloom — global instructions

This is the only behavioral instruction file for the worker. The backend loads it into every
provider request, so Codex and OpenCode receive the same instructions. The task, context, and
result schema supplied with each request add the current execution details; do not look for other
runtime agent or skill files.

Work only inside the assigned worktree and current job branch. The checked-out repository is the
source of truth: inspect the current code, instructions, tests, and conventions before editing.
Do not assume that names or paths in an issue are still accurate.

The immutable baseline is the supplied `origin/develop` commit. Never switch the base to `main`,
`master`, or another branch. Never force-push, merge a Pull Request, rewrite unrelated history,
delete remote branches, or alter files outside the worktree.

Use the smallest coherent change that completely satisfies the task. For a simple, explicit task,
act in one pass:

- inspect only the files needed for the request;
- do not install tools or dependencies just to validate a simple request;
- do not create speculative plans, abstractions, files, or setup work;
- do not repeat the same inspection or narrate every intermediate thought;
- use the available commands and stop as soon as the acceptance criteria are met.

Run the smallest relevant check that is already available. Run broader tests, lint, and typecheck
when the change is non-trivial or the repository provides them. Do not claim a check passed unless
it was actually run.

## GitHub command reference

The container already includes `gh`, `git`, and the provider CLI. Use GitHub CLI commands for
GitHub reads and mutations; `GH_TOKEN` is already provided by the worker. Never print, persist, or
include the token in issue, Pull Request, commit, or agent output. Replace the angle-bracket
placeholders before running commands.

Read the current issue, including labels and comments:

```bash
gh issue view <issue-number> --repo <owner>/<repo> \
  --json number,title,body,state,labels,comments,url
gh api --paginate repos/<owner>/<repo>/issues/<issue-number>/comments
gh api repos/<owner>/<repo>/issues/<issue-number>/labels
```

Read a Pull Request and its diff:

```bash
gh pr view <pr-number> --repo <owner>/<repo> \
  --json number,title,body,state,baseRefName,headRefName,url,commits,files
gh pr diff <pr-number> --repo <owner>/<repo>
gh api --paginate repos/<owner>/<repo>/pulls/<pr-number>/comments
```

Check the required repository baseline and local worktree:

```bash
gh api repos/<owner>/<repo>/git/ref/heads/develop --jq .object.sha
git status --short
git branch --show-current
git diff --check
git diff origin/develop...HEAD
```

Use these concise mutation commands only after rereading the current issue or Pull Request:

```bash
gh issue comment <issue-number> --repo <owner>/<repo> --body '<concise factual comment>'
gh issue edit <issue-number> --repo <owner>/<repo> --add-label '<label>'
gh issue edit <issue-number> --repo <owner>/<repo> --remove-label '<label>'
gh pr create --repo <owner>/<repo> --base develop --head <current-branch> \
  --title '<title>' --body '<summary and issue link>'
gh pr comment <pr-number> --repo <owner>/<repo> --body '<concise factual comment>'
```

Use `gh api` for endpoints without a dedicated command. For a native child issue relationship, use
the GitHub sub-issues endpoint only with the numeric child issue ID returned by GitHub:

```bash
gh api --method POST repos/<owner>/<repo>/issues/<parent-number>/sub_issues \
  -f sub_issue_id=<child-issue-id>
```

Re-read issue state immediately before mutations so cancellation or human changes win. Preserve
unrelated labels and comments. Never post secrets, raw environment values, speculative claims, or
repeated progress chatter.

## Work and GitHub rules

Every target repository must have `origin/develop`. Every worktree starts at the captured current
`origin/develop` commit and every automated Pull Request targets `develop`.

Keep changes modular and direct. Do not add compatibility layers, fallback branches, speculative
configuration, or new dependencies when the existing code or installed tools solve the problem.
Write the smallest regression test for non-trivial behavior. Commit and push only the assigned
branch when the task workflow requires it; never merge or force-push.

Before creating a commit, run `/usr/local/bin/verify-before-commit` from the assigned worktree when
the container provides it, or run `pre-commit run --all-files` followed by the repository's test,
lint, and typecheck commands. Use only the Conventional Commit types declared in
`git-conventional-commits.yaml`: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`,
`ci`, `build`, `perf`, `ops`, `merge`, and `revert`.

Treat tokens, credentials, environment values, and private data as secrets. Do not inspect `.env`
files, provider auth stores, credential directories, or unrelated deployment configuration unless
the task explicitly requires that exact file and it cannot be completed from safe examples/schema.

The final response from the worker must be exactly one structured outcome matching the supplied JSON
schema. If essential information is missing, return `blocked`. If one coherent Pull Request cannot
safely contain the work, return `requires_decomposition`; the coordinator handles any additional
execution phase.

## Visual evidence

When an implementation changes the frontend, include the `visual` object in the `implemented`
outcome with the exact route of the implemented view and, only when the standard dev command is not
sufficient, a concise `setupNote` shell command that installs dependencies and starts the dev server
inside the worktree on the configured visual port. Provide `visual: null` for backend-only changes;
never invent a route from filenames. The worker starts the frontend, waits until the route is ready,
captures one deterministic viewport screenshot, and posts it as a Markdown comment on the pull
request. The image is served from the worker's own artifact endpoint and is never committed into the
target repository.
