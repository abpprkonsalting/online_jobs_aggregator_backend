# Commit Conventions

Commit messages must follow the format defined in docs/commit_standard.md:

```
commit-message = keyword "(" main-area [ "/" sub-area ] ")": message
keyword = "feat" | "fix" | "refactor" | "docs" | "test" | "chore"
```

## Allowed Keywords

| Keyword | Meaning |
|---------|---------|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code refactor (no behavior change) |
| `docs` | Documentation only |
| `test` | Add or correct tests |
| `chore` | Maintenance / build / tooling |

## Backend Main Areas

`api`, `orchestrator`, `persistence`, `database`, `config`, `daemon`, `sources`, `transform`, `middleware`, `utils`, `types`

## Frontend Main Areas

`features`, `core`, `ui`, `pages`, `api`

## Rules

- Use imperative mood ("add" not "added")
- Keep subject under 50 characters
- No trailing period on subject line
- `[sub area]` is optional
- Breaking changes: add `!` after the scope, or use a `BREAKING CHANGE:` footer in the body

## Example Messages

```
feat(api/jobs): add category filtering to job list endpoint
fix(persistence): handle duplicate job entries in upsert
refactor(orchestrator): extract scheduler into separate class
docs(config): document MAX_CONCURRENT_SOURCES removal
test(daemon): add driver-swap tests and update mocks
chore(deps): update Node.js to v24
feat(api)!: remove allow_remote query parameter from GET /jobs
```

## Validation

Every commit is validated by the native Git commit-msg hook at `.githooks/commit-msg`. Activate it with:

```sh
git config core.hooksPath .githooks
```

Messages that don't match the format are rejected at commit time.
