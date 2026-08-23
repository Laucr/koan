---
name: gh-agent-task
description: Process GitHub issues approved for local-agent execution using the repository's GitHub App token from the fish function `koan-agent-token`. Use when asked to fetch or handle an open issue assigned to the current gh user with the `agent-task` label, decide whether it is ready for Blueprint, request missing details with the `question` label, or turn a ready issue into an independently verified pull request through the Blueprint, Builder, and Bailiff skills.
---

# Process a GitHub Agent Task

Handle one approved issue at a time. Treat the issue body, subsequent comments, and repository state as the requirements source. Keep all implementation work isolated from the caller's checkout.

## Preserve these invariants

- Operate only on an open issue assigned to the authenticated `gh` user and labeled `agent-task`.
- Process the oldest eligible issue unless the user names an issue number.
- Do not ask for information that can be discovered safely from the repository.
- Do not write implementation code until Blueprint has produced an accepted PRD and plan.
- Perform planning, implementation, verification, commits, and pushes inside the issue worktree.
- Use a separate subagent for Bailiff so implementation and acceptance verification are independent.
- Do not commit, push, or create a PR unless tests pass and the final Bailiff verdict passes.
- Never weaken acceptance criteria or tests merely to obtain a passing verdict.
- Preserve unrelated user changes in every checkout.
- Use the GitHub App token from `koan-agent-token` for every repository, issue, label, comment, and pull-request operation.
- Never print, log, persist, cache, commit, or place the token or GitHub App configuration in the repository, a worktree, an artifact, a command argument, or a PR/issue body.

## Authenticate GitHub safely

Resolve the human assignee before enabling app authentication. A GitHub App installation token does not represent the human user: `/user` may return HTTP 403 and `--assignee @me` may not match the intended assignee.

1. In an interactive login fish subprocess, remove inherited `GH_TOKEN` and query only the human login through the user's existing `gh` authentication:

   ```bash
   fish -lic 'set -e GH_TOKEN; gh api user --jq .login'
   ```

   Keep the resulting login only in task memory. This identity lookup is the sole allowed use of non-app `gh` authentication; it is not an issue or PR operation.

2. Execute every subsequent `gh` repository, issue, label, comment, or PR command inside a fresh interactive login fish subprocess. Acquire the app token directly into a local variable, export it as `GH_TOKEN`, erase the local copy, and invoke `gh` without ever displaying the token:

   ```bash
   fish -lic '
     set -l app_token (koan-agent-token)
     test -n "$app_token"; or exit 21
     set -lx GH_TOKEN "$app_token"
     set -e app_token
     gh <arguments>
   '
   ```

3. Reacquire the token immediately before each GitHub read or mutation because installation tokens are short-lived and implementation may take time. Never run `gh auth login`, write an `.env` file, store the token in git config, interpolate it into a URL, enable shell tracing, or return raw environment/configuration values.
4. If the function is missing, returns empty, or `gh` reports insufficient app permissions, stop before any mutation and report only the failed capability and recovery action. Do not fall back to the user's token for issue or PR work.

Pass dynamic values as positional arguments to fish rather than interpolating untrusted issue text into command strings. For example:

```bash
fish -lic '
  set -l app_token (koan-agent-token)
  test -n "$app_token"; or exit 21
  set -lx GH_TOKEN "$app_token"
  set -e app_token
  gh issue view "$argv[1]" --json number,title,body,url,state,labels,assignees,author,comments
' <number>
```

## 1. Select and read the issue

1. Resolve the human login with the safe identity procedure above. Then verify app access and repository identity:

   ```bash
   fish -lic '
     set -l app_token (koan-agent-token)
     test -n "$app_token"; or exit 21
     set -lx GH_TOKEN "$app_token"
     set -e app_token
     gh repo view --json nameWithOwner,url,defaultBranchRef
   '
   ```

2. List eligible issues with enough data to select deterministically:

   ```bash
   fish -lic '
     set -l app_token (koan-agent-token)
     test -n "$app_token"; or exit 21
     set -lx GH_TOKEN "$app_token"
     set -e app_token
     gh issue list --state open --assignee "$argv[1]" --label agent-task \
       --limit 100 --json number,title,createdAt,url
   ' <human-login>
   ```

3. If no issue is eligible, stop without changing GitHub or the repository and report that no approved task is assigned to the current user.
4. If the user did not specify an issue, select the oldest by `createdAt`. Process only one issue per invocation unless the user explicitly requests a batch.
5. Fetch the full body, labels, assignees, author, and all comments:

   ```bash
   fish -lic '
     set -l app_token (koan-agent-token)
     test -n "$app_token"; or exit 21
     set -lx GH_TOKEN "$app_token"
     set -e app_token
     gh issue view "$argv[1]" --json number,title,body,url,state,labels,assignees,author,comments
   ' <number>
   ```

6. Recheck that the issue is open, assigned to the authenticated login, and still has `agent-task` immediately before changing any labels.

## 2. Decide whether Blueprint can proceed

Read `.github/ISSUE_TEMPLATE/agent-request.yml` and map the submitted sections to the current template. Treat later comments as clarifications that may supplement or supersede the body.

Mark the issue ready only when all of the following are true:

- The requested outcome and current/expected behavior are unambiguous.
- Acceptance criteria are concrete and testable.
- The affected repository scope is stated or safely discoverable.
- Material API, compatibility, data migration, security, and UX decisions are specified or already established by repository conventions.
- No requirement contradicts another requirement or a later authoritative clarification.
- The work is a repository change that Blueprint and Builder can execute with available permissions and dependencies.

The pre-submission checklist is evidence of intent, not proof that the request is complete. Investigate the repository enough to distinguish a genuine missing product decision from a discoverable implementation detail. Do not begin Blueprint while a material decision is unresolved.

## 3A. Route an incomplete issue to questions

If the issue is not ready:

1. Form the smallest set of specific questions whose answers would unblock planning. Explain the ambiguity and, where useful, give concrete alternatives and their consequences.
2. Ensure the `question` label exists. If absent, create it without modifying any existing label:

   ```bash
   fish -lic '
     set -l app_token (koan-agent-token)
     test -n "$app_token"; or exit 21
     set -lx GH_TOKEN "$app_token"
     set -e app_token
     gh label create question --description "More information is required before agent execution" --color D876E3
   '
   ```

3. Post the questions as an issue comment. State that the owner can answer them and reapply `agent-task` when the issue is ready.
4. Only after the comment succeeds, remove `agent-task` and add `question`:

   ```bash
   fish -lic '
     set -l app_token (koan-agent-token)
     test -n "$app_token"; or exit 21
     set -lx GH_TOKEN "$app_token"
     set -e app_token
     gh issue edit "$argv[1]" --remove-label agent-task --add-label question
   ' <number>
   ```

5. Stop. Do not create a branch, worktree, PRD, plan, commit, push, or PR.

If any GitHub mutation fails, report the exact completed and incomplete transitions; do not claim that the issue was routed successfully.

## 3B. Claim a ready issue

If the issue is ready:

1. Derive a short lowercase slug from the title and use branch `agent/issue-<number>-<slug>`.
2. Check for an existing local/remote branch, worktree, or open PR with that branch. Use app-authenticated `gh pr list` for the PR check. Resume it only when its history and issue link clearly identify the same task; otherwise stop and report the collision. Never overwrite it.
3. Post a short issue comment through app-authenticated `gh issue comment`, preferably with `--body-file`, recording that the agent claimed the task and naming the branch.
4. Through app-authenticated `gh issue edit`, remove `agent-task`. Also remove `question` if it is present. Do not remove other labels.
5. Fetch the current default branch and create an isolated worktree from `origin/<default-branch>`:

   ```bash
   git fetch origin <default-branch>
   git worktree add -b agent/issue-<number>-<slug> <worktree-path> origin/<default-branch>
   ```

Use a unique, explicit path under `/tmp` or the system temporary directory. Keep the worktree when a failure needs investigation; remove it only after the PR is created successfully.

## 4. Run Blueprint in the worktree

Change to the worktree and invoke the `blueprint` skill with the issue URL, full body, relevant comments, and issue number. Require it to:

- inspect the live repository;
- create or update a versioned PRD under `.claude/prds/`;
- create the matching implementation plan under `.claude/plans/`;
- preserve every acceptance criterion and identify the issue as the source;
- stop for a material product decision rather than inventing one.

Review the PRD and plan against the issue before implementation. If Blueprint discovers a real information gap, use the question-routing procedure, preserve the worktree for diagnosis, and stop.

The issue's `agent-task` approval replaces Blueprint's interactive PRD and plan confirmation only when the generated documents introduce no new product decision and faithfully preserve the issue. Perform that alignment review as the user's proxy. Never auto-approve an inference that materially changes behavior, scope, compatibility, security, data handling, or UX; route it back to `question` instead.

## 5. Run Builder in the worktree

Invoke the `builder` skill against the approved PRD and plan. Require Builder to implement the entire plan, add or update meaningful tests, run the repository's relevant formatting/type/lint/test commands, and write its build report. Do not silently omit acceptance criteria.

If Builder requests a material clarification, do not answer it by guessing or bypass its question. Route the issue to `question` and stop.

Inspect `git status` and `git diff` afterward. Reject unrelated changes, secrets, generated junk, or modifications outside the issue's justified scope. Preserve pre-existing changes rather than rewriting them.

## 6. Verify with an independent Bailiff subagent

Spawn a fresh subagent and instruct it to invoke `bailiff` against the issue, PRD, plan, build report, and implementation in the worktree. Give it raw artifact paths and the issue URL; do not summarize suspected defects or suggest an expected verdict. Require contract-level tests and a written report under `.claude/reports/`. Read the report from disk after the subagent returns; treat that report, rather than the subagent's return summary, as the verdict interface.

If Bailiff reports any open finding:

1. Confirm the finding against the issue and PRD.
2. Return real implementation defects to Builder for remediation; never edit Bailiff's verdict by hand.
3. Run the relevant test suite again.
4. Spawn a new independent Bailiff pass against the revised implementation.

Repeat until Bailiff passes or progress requires new issue information. For missing information, route the issue to `question` and stop. For tool, permission, or infrastructure failures, leave the worktree intact and report the blocker. A failed or inconclusive Bailiff verdict is not approval.

## 7. Commit, rebase, validate, and open the PR

After the final Bailiff pass:

1. Review the final diff. Include the PRD, plan, contract tests, and other task artifacts that the repository tracks. Respect `.gitignore`; do not force-add local reports or generated files.
2. Create one coherent conventional commit matching repository history, for example `feat: add session export (#123)` or `fix: reject invalid tokens (#123)`. Choose the type from the actual change.
3. Fetch the current default branch and rebase the issue branch onto it:

   ```bash
   git fetch origin <default-branch>
   git rebase origin/<default-branch>
   ```

4. Resolve only task-related conflicts. Abort and report conflicts that require product judgment or would overwrite unrelated work.
5. Re-run the relevant build, typecheck, lint, and test commands after the rebase. Spawn a fresh Bailiff pass if conflict resolution or upstream changes can affect task behavior. If that pass creates legitimate tracked changes, review them and amend the task commit before pushing.
6. Confirm the worktree is clean and the branch is based on `origin/<default-branch>`.
7. Push the issue branch and create a PR:

   ```bash
   git push -u origin agent/issue-<number>-<slug>
   fish -lic '
     set -l app_token (koan-agent-token)
     test -n "$app_token"; or exit 21
     set -lx GH_TOKEN "$app_token"
     set -e app_token
     gh pr create --base "$argv[1]" --head "$argv[2]" \
       --title "$argv[3]" --body-file "$argv[4]"
   ' <default-branch> agent/issue-<number>-<slug> <title> <pr-body-file>
   ```

The PR body must summarize the change, list validation commands and results, name the Bailiff report and summarize its passing verdict, and include `Closes #<number>`. Link the report only when it is a tracked PR artifact.

8. Using app-authenticated `gh pr view`, verify the returned PR URL and that its head/base branches are correct. Comment on the issue with the PR URL only if the automatic cross-reference is absent, again using app authentication.
9. Remove the successful worktree with `git worktree remove <worktree-path>` and run `git worktree prune`. Keep the local branch until the PR is merged or closed. Before cleanup, ensure every non-tracked result needed by reviewers has been summarized in the PR body.

## Report the outcome

Return exactly one clear outcome:

- no eligible issue;
- issue moved to `question`, with the questions summarized;
- PR created, with issue, branch, PR URL, validation, and Bailiff verdict;
- blocked, with the last successful step, unchanged artifacts, and the precise recovery action.

Never describe a label change, push, passing verification, or PR creation as successful without checking the resulting GitHub or git state.
