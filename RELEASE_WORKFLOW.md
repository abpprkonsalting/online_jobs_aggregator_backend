# Release and deployment workflow

This document describes the current single-maintainer workflow (version 1) and
the planned pull-request workflow for version 2. Production deployment is
authorized only by pushing an annotated `vMAJOR.MINOR.PATCH` release tag.

## Version 1: one maintainer, local feature branches

### What runs in GitHub Actions

| Event | Workflow | Result |
|---|---|---|
| Push to `master` | `.github/workflows/ci.yml` | Installs dependencies, runs tests, and builds. Does not deploy and does not use deployment secrets. |
| Push a `v*` tag | `.github/workflows/deploy.yml` | Tests and builds, verifies the annotated release tag identifies the checked-out commit, generates release metadata, then deploys to the VPS. |

Do not add `master` to the `push.branches` trigger in `deploy.yml`; doing so
would make every push to `master` a production deployment again. There is no
pre-push hook. Pushing `master` is the way to back up integrated work on GitHub;
it runs CI only.

### Develop a feature and integrate it locally

Start a feature branch from the current local `master`:

```bash
git switch master
git pull --ff-only github master
git switch -c feature/short-description
```

Make changes and commit them on the feature branch:

```bash
git add <files>
git commit -m "feat(scope): describe the change"
```

Integrate the feature branch into local `master`, run the checks, and push
`master` to GitHub. The push saves the commits centrally and runs CI only:

```bash
git switch master
git merge --no-ff feature/short-description
npm test
npm run build
git push github master
```

Use a Conventional Commit subject (`feat:`, `fix:`, or a breaking-change
marker) so the release planner can calculate a proposal. The release commands
must run from the clean local `master` containing the exact commit to release.

### Prepare and publish a release

Review the release proposal:

```bash
npm run release:plan
```

If it proposes the version you intend to deploy, approve that exact version.
For example, if the output says `Proposed version: v0.1.3`:

```bash
npm run release:tag -- --approve v0.1.3
```

The script prints the target commit and asks you to type the exact tag
(`v0.1.3`) before creating the annotated tag locally. Verify the tag and its
target, then push the tag to start the production workflow:

```bash
git show --no-patch --decorate v0.1.3
git push github v0.1.3
```

Replace `v0.1.3` in these commands with the version actually proposed and
approved. Do not move, delete, or recreate a tag that has already been pushed;
publish a new patch version to correct a release. The tag push does not update
`github/master`, so push `master` separately when you want to back up the
integrated branch. Pushing `master` does not deploy.

After the Actions run succeeds, verify the deployed release and commit:

```bash
curl -fsS https://jobs-agregator.abpprkonsalting.com/api/version
sudo journalctl -u map-rezi-api -u map-rezi-fetcher --since '10 minutes ago' -o cat --no-pager
```

The endpoint and both service startup entries should report the intended
`releaseTag`, `commitSha`, and `deploymentId`.

## Version 2: multiple developers using pull requests

The deployment workflow remains tag-only. Change the CI workflow so it tests
both pushes to `master` and pull requests targeting `master`. In
`.github/workflows/ci.yml`, replace its trigger block:

```yaml
on:
  push:
    branches: [master]
  pull_request:
    branches: [master]
```

No deployment step or production secret belongs in `ci.yml`. Keep
`.github/workflows/deploy.yml` triggered only by `push` tags matching `v*`.

In GitHub repository settings, add a branch ruleset for `master` that requires
pull requests and requires the `test-and-build` check to pass
before merging. Disable direct pushes or restrict them to maintainers as
appropriate. This makes CI enforcement server-side instead of relying on local
convention. Only authorized maintainers should publish release tags.

### Developer workflow in version 2

Each developer creates and pushes a feature branch:

```bash
git switch master
git pull --ff-only github master
git switch -c feature/short-description
# edit and commit changes
git add <files>
git commit -m "feat(scope): describe the change"
git push -u github feature/short-description
```

Open a pull request against `master` (using GitHub CLI):

```bash
gh pr create \
  --base master \
  --head feature/short-description \
  --title "feat(scope): describe the change" \
  --body "Explain the change and how it was tested."
```

Reviewers approve the PR after the required CI check passes. Merge it using
the repository's selected merge strategy. Merging updates `master` and runs
CI, but does not deploy production.

### Release from the approved `master`

After the desired changes are merged, a maintainer updates local `master`,
reviews the proposal, creates the approved annotated tag, and pushes that tag:

```bash
git switch master
git pull --ff-only github master
npm ci
npm test
npm run build
npm run release:plan
npm run release:tag -- --approve v2.0.0
git push github v2.0.0
```

The `v2.0.0` commands are examples: substitute the exact version printed by
`release:plan` in both places, then confirm that exact tag name when the
release script prompts. Only the final tag push deploys production; branch
and pull-request CI never deploy.
