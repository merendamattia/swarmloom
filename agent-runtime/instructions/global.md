# Swarmloom — global instructions

This is the only behavioral instruction file for the worker. The backend loads it into every
provider request, so Codex and OpenCode receive the same instructions. The task, context, and
response file path supplied with each request add the current execution details; do not look for
other runtime agent or skill files.

Work only inside the assigned worktree and current job branch. The checked-out repository is the
source of truth: inspect the current code, instructions, tests, and conventions before editing.
Do not assume that names or paths in an issue are still accurate.

Before doing anything else, read the full context to understand what has already been done. Read the
current issue with its labels and comments, and inspect every linked Pull Request with its reviews
and inline comments. The issue labels tell you what this run is for: keep every label until the work
finishes. When the issue carries the ready label, this is a fresh implementation: create a new branch
and open a new Pull Request. When it carries the review-requested label (or a Pull Request already
exists), the task is a review follow-up: continue the checked-out branch, address the requested
review changes, and push to that same branch so the already-open Pull Request updates. Never start a
follow-up on a new branch or open a second Pull Request for the same issue. Only redo work from
scratch when the context proves it is incomplete or invalid.

Every time the task involves an existing Pull Request — always during a review follow-up — check
whether the Pull Request is still mergeable. Because the work lives on a branch, a new update to
`develop` can land while the Pull Request is open and make it conflicted; GitHub reports this with
the mergeable state and the exact conflicting files. Read that state on every run, and when conflicts
exist, resolve them in the checked-out branch: update it onto the current `origin/develop`, fix each
reported conflict file, verify the result, and push so the Pull Request becomes mergeable again.
Never push or merge the Pull Request while conflicts are unresolved, and never treat a conflicted
Pull Request as done.

The immutable baseline is the supplied `origin/develop` commit. Never switch the base to `main`,
`master`, or another branch. Never force-push, merge a Pull Request, rewrite unrelated history,
delete remote branches, or alter files outside the worktree.

You must never push to `main` or `develop`, on any remote, for any reason, even as part of a longer
or combined shell command. Push only the current fix branch — or the already-existing Pull Request
branch in a review follow-up — to `origin`, and open the automated Pull Request against `develop`.
Before every push, verify the checked-out branch name and the target remote; if the push would touch
`main` or `develop`, abort it.

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

The repository's GitHub Actions CI workflow (`.github/workflows/ci.yaml` in the worktree) is the
definition of "everything works". Before creating a commit, run the same verification steps that
the CI workflow runs — pre-commit, typecheck, lint, tests, and build — directly in the worktree.
Fix every failure until the local run matches a green CI run. Do not rely on remote CI status:
your job must only produce a Pull Request whose verification suite already passed locally.

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
  --json number,title,body,state,baseRefName,headRefName,mergeable,mergeStateStatus,url,commits,files
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

Every target repository must have `origin/develop`. Every fresh worktree starts at the captured
current `origin/develop` commit and every new automated Pull Request targets `develop`. For a review
follow-up the worktree starts from the existing Pull Request branch; push fixes to that same branch
so the open Pull Request picks them up. The only push target is the assigned fix branch on `origin`;
`main` and `develop` are never push targets, and the Pull Request base is always `develop`.

Whenever a Pull Request is involved, verify it is not conflicted against the current `origin/develop`.
If GitHub reports a conflict, rebase or merge the checked-out branch onto `origin/develop`, resolve the
conflicting files, rerun the checks, and push the updated branch.

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

The final response must be a plain text file written to the path in the prompt's `Response file`
section. That file is authoritative and the worker reads it after the run; it lives outside the
worktree, so never commit it. The worker posts its content verbatim as the GitHub comment and stores
it in the platform, so write the complete, self-contained response exactly as it should be read.

The response file must begin with a single outcome line followed by the free-form response:

```
Outcome: implemented
PR: https://github.com/<owner>/<repo>/pull/<number>
# free-form response below; this full content is posted as the comment
```

For a review session, begin with `Review: pass` or `Review: changes_requested` instead of
`Outcome:`. Use `Outcome: implemented` (with the linked `PR:` line), `blocked`, `decomposed`, or
`requires_decomposition`. If one coherent Pull Request cannot safely contain the work, write
`requires_decomposition`; the coordinator handles any additional execution phase.
