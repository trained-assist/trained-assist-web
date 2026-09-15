# trained-assist-web

See `README.md` for product context.

## Git workflow — PR-first, enforced locally by hooks

**Never push directly to `main`.** All changes go through a feature branch + PR:

```bash
git checkout -b feature/my-change
# make changes, commit
git push -u origin feature/my-change
gh pr create --fill
```

This is enforced client-side via `.githooks/` (run `scripts/install-git-hooks.sh` once per clone — a fresh session should verify `git config core.hooksPath` is set to `.githooks` before doing anything else):
- **pre-commit** blocks any commit made directly on `main`/`master` — create a branch first.
- **pre-push** blocks pushing to `main`/`master`, and blocks pushing *again* to a branch that already has an OPEN pull request. **PRs are immutable**: once a branch is submitted as a PR, don't amend/force-push it — open a new branch and a new PR for further changes, even to fix CI. This is what keeps sessions from colliding on the same branch/PR.
- Both have a documented emergency override env var (`ALLOW_PROTECTED_COMMIT=1` / `ALLOW_PR_UPDATE=1`) for the rare intentional exception — always explain why in the commit/PR when used.
