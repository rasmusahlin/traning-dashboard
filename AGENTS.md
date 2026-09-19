# Training Dashboard – project instructions

## Purpose and must-not-break behavior

- Maintain a locally runnable personal training dashboard for running, strength training, and hiking.
- Preserve sign-in, activity/analysis views, FIT import, activity details, settings, and training-plan flows.
- Keep the static HTML/CSS/JavaScript architecture unless a smaller module boundary has a concrete security, testability, or maintenance benefit.
- Preserve browser-only FIT parsing and the existing Supabase REST contract.
- Deliver a stable local MVP. Deployment is out of scope without separate authority for an exact destination.

## Risk and data boundaries

- Treat the project as a normal product and classify each task from its actual effects.
- Treat authentication, session storage, RLS, imports, exports, and rendering of backend or file-derived values as critical security/data work.
- The app handles personal and health-like training data. Use synthetic data for automated tests and routine development.
- Real local training data may be used only when explicitly in task scope. Never expose, log, copy, or commit it.
- Never open secrets, credential stores, production exports, or raw production data.
- Do not change Supabase, GitHub Pages, or another remote environment without separate explicit authority. SQL migrations remain proposals until authorized for an exact environment.

## Repository authority

- This repository is `rasmusahlin/traning-dashboard`; `origin/main` is the detected remote default branch.
- Codex may create a scoped `codex/` branch, commit, push, and open a pull request for requested work after relevant checks.
- Preserve unrelated and untracked user work. Never hide or overwrite it.
- Merge, release, deploy, destructive Git actions, and production changes require separate explicit authority.

## Local commands

- No dependency install or build step is currently required.
- Serve from the repository root: `python3 -m http.server 8000`
- Open `http://localhost:8000/` for the local UI.
- Run the dependency-free automated suite: `node --test`
- Check standalone JavaScript syntax: `node --check js/security.js && node --check js/db.js && node --check js/fit-parser.js && node --check js/plan.js`
- For user-facing changes, smoke-test the affected flow locally at desktop and mobile widths without connecting to real remote data.

## Validation by task risk

- Low risk: run one focused check for documentation, isolated copy, or small CSS changes.
- Normal risk: run focused checks while working, then `node --test` and the relevant local UI smoke test.
- Critical risk: state the security/data invariant, add negative tests, run the full local suite and affected UI flow, and request one independent bounded review.
- Stop after at most two critical fix/review passes. Test observable trust boundaries and avoid dependencies or abstractions without concrete need.

## Model and collaboration routing

- Use Sol Medium for management and synthesis; reserve Sol High for difficult or high-consequence architecture or security decisions.
- Use Luna Xhigh for bounded implementation/tests, Luna Max for demanding sharply scoped work, and Luna High only for closed mechanics. Luna workers are leaf workers.
- Use Terra High for ambiguous, cross-cutting, or stubborn work. If a preferred model is unavailable, use the closest supported role-equivalent and report it.
- Handle simple work directly. When parallel work helps, create one bounded callback worker or leaf cohort with independent claims and disjoint file ownership.
- Wait once for workers, then remain inactive until a result, blocker, or decision callback; do not poll unchanged state.
- Rotate the manager after a major milestone/PR, three visible handoffs, or a safe post-compaction boundary. Send a repository-anchored handoff, then archive only inactive accepted or superseded tasks. Never delete tasks.

## Authoritative sources

- Current code, tests, schema migrations, and maintained `README.md` are authoritative, in that order when they disagree.
- Keep `README.md` and these commands synchronized with material workflow or architecture changes.
