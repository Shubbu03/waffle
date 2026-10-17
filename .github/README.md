# Repository workflow

Feature PRs target `staging`. Release PRs target `main` and must come from this repository's `staging` branch. Synchronize `main` back into `staging` through a PR after each release. Production releases use merge commits; staging PRs can use merge commits or squash merges.

Both branches require one approval, dismiss approvals after new commits, require resolved conversations, and block force pushes and deletion. The bypass list is empty. Keep `main` as the default branch, enable merge commits, and keep automatic head-branch deletion disabled so the release branch survives.

## Checks

`workflows/ci.yml` runs Lint, Typecheck, Tests, and Migrations on every PR targeting either branch, and on pushes to those branches. It installs the pinned Bun version with the frozen lockfile. Tests use fixtures and PGlite; they do not require production credentials or run database migrations against a deployed service.

`workflows/branch-policy.yml` runs the required Branch policy check using `pull_request_target`. Its workflow and validator come from the trusted default branch. It has read-only permissions, does not execute PR code, and never receives a privileged repository token from a secret. Do not change it to check out the PR head. The validator checks both the source repository and source branch, so a fork branch named `staging` cannot release to `main`.

All third-party actions are pinned to commit SHAs. Check names match the desired ruleset files exactly; changing a name also requires updating both rulesets.

## Bootstrap

The desired final configuration is in `rulesets/main.json` and `rulesets/staging.json`. These require all five checks from the GitHub Actions app, and require the PR branch to be up to date.

The initial review protections are active in [Protect main](https://github.com/Shubbu03/waffle/rules/25296245) and [Protect staging](https://github.com/Shubbu03/waffle/rules/25296252). CI and branch-source enforcement are pending the workflow bootstrap below.

Do not enable missing required checks before the workflows are installed. Initially, only the PR/review/deletion/force-push rules are active:

1. Publish these `.github/` files on a feature branch and open a PR into `staging`. A teammate reviews and approves it; CI runs on the proposed changes.
2. Merge into `staging`, then release that branch into `main` through another reviewed PR, using a merge commit. For this one-time bootstrap, manually verify that the release source is the same repository's `staging` branch. The trusted Branch policy workflow is not active until it exists on `main`.
3. Verify that the merged workflows exist on `main` and `staging`, and all four CI jobs passed. Synchronize `main` back to `staging` with a PR, using a merge commit.
4. Look up the existing ruleset IDs:

   ```sh
   gh api repos/Shubbu03/waffle/rulesets --jq '.[] | {id,name,enforcement}'
   ```

5. Apply each final ruleset using its existing ID (do not create duplicates):

   ```sh
   gh api --method PUT repos/Shubbu03/waffle/rulesets/MAIN_RULESET_ID --input .github/rulesets/main.json
   gh api --method PUT repos/Shubbu03/waffle/rulesets/STAGING_RULESET_ID --input .github/rulesets/staging.json
   ```

6. Verify active requirements using `gh api repos/Shubbu03/waffle/rules/branches/main` and the same endpoint for `staging`. A future feature PR into `main` must fail Branch policy; a same-repository `staging` release must pass.

Publishing workflow files requires an explicit commit and push; applying rulesets only changes GitHub repository settings.
