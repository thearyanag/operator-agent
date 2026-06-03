# OSS Readiness Cleanup Checklist

Date: 2026-06-03

Scope: consolidated read-only audit from five agents covering repo hygiene, architecture, security/privacy, tests/tooling, and docs/onboarding.

Owner decisions recorded so far:

- [x] Keep Telegram access open by default.
- [x] Use the MIT license.
- [x] First-class deploy targets are Docker Compose for local and Render for hosted.
- [x] Keep Telegram Business automation default-on.
- [x] Make bundled Postgres/Datadog MCP connectors opt-in.

Baseline checked locally:

- [x] `bun run check` passes.
- [x] `bun test` passes: 47 tests.
- [x] `git diff --check` is clean.
- [ ] `bun audit` needs explicit network approval to re-run safely. One audit agent reported 24 vulnerabilities: 8 high, 15 moderate, 1 low. Treat this as actionable but re-verify before closing.

Current worktree note:

- [ ] Before public release, verify the current Operator MVP commit only contains intentional product, docs, Docker, and test changes.

## Priority Key

- `P0`: fix before exposing this repo or deploy templates publicly.
- `P1`: fix before a serious OSS launch.
- `P2`: polish that makes contributors and users more successful.

## P0 - Public Safety And Deployment Footguns

- [ ] Make open-by-default Telegram access explicit and safe to understand.
  - Evidence: `src/telegram/access.ts` allows all private DMs when no allowlist is configured, and team groups are allowed when `ALLOWED_GROUP_ID` is unset. `src/config.ts` defaults Telegram Business automation to enabled.
  - Decision: keep this open-by-default behavior.
  - Cleanup: document clearly that unset `ALLOWED_USER_IDS` and unset `ALLOWED_GROUP_ID` mean open access.
  - Cleanup: add startup logs/warnings that make the active access mode obvious.
  - Cleanup: document how to lock it down with `ALLOWED_USER_IDS` and `ALLOWED_GROUP_ID`.
  - Decision: keep Telegram Business automation default-on.
  - Cleanup: document the default-on behavior clearly, explain Telegram's user opt-in boundary, and strongly recommend `TELEGRAM_BUSINESS_ALLOWED_OWNER_IDS` for any shared or hosted deployment.
  - Cleanup: prevent accidental multi-owner data mixing under one `OPERATOR_OWNER_ID`.

- [ ] Fail closed for Mini App and `/api/*` auth.
  - Evidence: `src/operator/control-panel.ts` now requires either the configured control-panel token or verified Telegram init data from `ALLOWED_USER_IDS` / `OPERATOR_OWNER_TELEGRAM_IDS`.
  - Cleanup: keep coverage for the fail-closed path as the Mini App API grows.
  - Cleanup: if `PORT` is set without control auth, warn loudly or refuse startup.
  - Cleanup: validate `POST /api/conversations/:id/policy` request bodies before writing policy.
  - Cleanup: stop documenting query-string tokens for production; prefer `Authorization: Bearer ...` or Telegram init data headers.

- [ ] Harden or disable bundled MCP examples by default.
  - Evidence: `packages/postgres-mcp/index.ts` uses a keyword filter for "read-only" SQL, and `README.md` allows `DATABASE_URL` to point at the same DB as `OPERATOR_DATABASE_URL`.
  - Cleanup: use a dedicated read-only Postgres role, `default_transaction_read_only=on`, statement timeouts, schema/table allowlists, and stronger rejection for data-modifying CTEs/functions.
  - Cleanup: make Datadog MCP least-privilege with service/env allowlists, field redaction, smaller limits, and usage auditing.
  - Decision: move MCP connectors to opt-in docs instead of an eager default `.mcp.json.example`.

- [ ] Fix or remove the DigitalOcean one-click deploy path.
  - Evidence: `.do/deploy.template.yaml` declares `http_port: 8080` and `/healthz`, but does not set `PORT`; it also lacks current Operator envs such as `OPERATOR_DATABASE_URL`, `TELEGRAM_BOT_USERNAME`, and `OPERATOR_CONTROL_PANEL_TOKEN`.
  - Cleanup: add `PORT=8080` and the current required envs, or remove the DO button until validated.

- [ ] Add release hygiene for ignored local secrets and runtime data.
  - Evidence: `.env`, `.operator/`, `logs/`, and `artifacts/` are local runtime surfaces. They are ignored, but should never enter release packaging.
  - Cleanup: add a release checklist with secret scan, ignored-file audit, and runtime artifact cleanup.
  - Cleanup: rotate any local value that was ever pasted/shared externally.

- [ ] Re-verify and address dependency audit findings.
  - Evidence: one security audit agent reported 24 vulnerabilities, including high findings in transitive chains under `@mariozechner/pi-coding-agent` and `@modelcontextprotocol/sdk`.
  - Cleanup: rerun `bun audit` with explicit approval, then update dependencies or add targeted overrides.

## P1 - OSS Scaffolding, CI, And Contributor Workflow

- [ ] Add root OSS metadata.
  - Evidence: root `package.json` is `private: true` and lacks `version`, `description`, `license`, `repository`, `bugs`, `homepage`, `author`, and `keywords`.
  - Cleanup: add metadata even if the root remains non-publishable.
  - Decision: use MIT.
  - Cleanup: add root `LICENSE` and align workspace package licenses.

- [ ] Add community files.
  - Cleanup: add `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, issue templates, PR template, and `CHANGELOG.md`.

- [ ] Decide package publication boundaries.
  - Evidence: `packages/telegram-markdown-html` looks publishable but has no `prepack`/`prepare`, while root is private.
  - Cleanup: either mark the package private or add a real package release process.
  - Cleanup: import it through its workspace package export instead of package internals.

- [ ] Add one-command validation.
  - Evidence: root scripts have `check` but no `test`, `lint`, `format`, or `validate`.
  - Cleanup: add `test`, `test:unit`, `check:packages`, `lint`, `format`, and `validate`.
  - Cleanup: wire package tests into root validation.

- [ ] Add CI.
  - Cleanup: add `.github/workflows/ci.yml` running `bun install --frozen-lockfile`, `bun run validate`, package checks, and at least `docker compose config`.
  - Cleanup: decide whether Docker build and Postgres integration tests run on every PR or only nightly/opt-in.

- [ ] Add lint/format tooling.
  - Evidence: no ESLint, Prettier, or Biome config; `tsconfig.json` leaves unused checks disabled.
  - Cleanup: prefer Biome for a small Bun-first repo unless there is a strong reason to use ESLint plus Prettier.

- [ ] Tighten `.gitignore`.
  - Evidence: `.dockerignore` has safer `.env.*` handling than `.gitignore`.
  - Cleanup: mirror `.env.*` plus `!.env.example`; add `*.log`, `report.*.json`, `*.sqlite*`, `*.db`, `*.pem`, and `*.key`.

## P1 - Docs And Deploy Alignment

- [ ] Add `PORT` to `.env.example`.
  - Evidence: `index.ts` only serves `/healthz`, `/app`, and `/api/*` when `PORT` is set; README mentions `PORT`, but `.env.example` does not.
  - Cleanup: document `PORT` as required for the Mini App and health/API routes.

- [ ] Make deploy docs and templates consistent.
  - Evidence: README presents Render, Railway, and DO as equivalent; templates do not declare the same envs, volumes, or health behavior.
  - Decision: Docker Compose is first-class for local, Render is first-class for hosted.
  - Cleanup: remove or mark Railway/DO as unvalidated until tested.

- [ ] Update `docs/architecture.md` to current reality.
  - Evidence: it still centers SQLite as canonical runtime state and says Business automation is disabled unless enabled, while current config defaults it on.
  - Cleanup: document `src/operator/*`, Postgres as system of record, SQLite compatibility role, policy decisions, control panel, and current Business default.
  - Cleanup: keep the "only config reads env" rule accurate by moving `PORT` parsing into config or updating the rule.

- [ ] Fix README overclaims.
  - Evidence: README says summaries and memory are recorded, but current store exposes no summary/memory write APIs; tables exist but hardening is future work.
  - Cleanup: say current MVP records conversations, observations, policy decisions, runs, outputs, Telegram sessions, and audit events; memory/summaries are future hardening unless implemented.
  - Cleanup: distinguish context artifacts recorded in Postgres from delivered Telegram file attachments tracked through SQLite paths.

- [ ] Add API/control-panel docs.
  - Cleanup: document `/api/conversations`, `/api/outputs`, `/api/install-link`, and `POST /api/conversations/:id/policy`.
  - Cleanup: include auth modes, env prerequisites, status codes, and request/response examples.

- [ ] Split public docs into current implementation vs roadmap.
  - Evidence: `docs/operator-enable-plan.md` mixes implemented status, suggested schema, MVP notes, and future GBrain/memory work.
  - Cleanup: keep a "Current implementation" doc and move future behavior to "Roadmap/spec".

## P1 - Architecture And Maintainability

- [ ] Make state ownership explicit.
  - Evidence: README calls Postgres the system of record, but SQLite still owns cases, artifacts, evidence, Business connection cache, run lifecycle details, and audit compatibility.
  - Cleanup: define `OperatorRecordStore` for durable product state and `RuntimeStateStore` for local compatibility/session state.
  - Cleanup: decide whether cases/artifacts/evidence move to Postgres or remain explicitly local-only.

- [ ] Replace inline Postgres schema bootstrapping with migrations.
  - Evidence: `src/operator/postgres-store.ts` contains schema creation and all repository methods in one file.
  - Cleanup: move SQL into `src/operator/migrations`, add schema versioning, and keep repository methods separate.

- [ ] Add Postgres integration tests.
  - Cleanup: add a gated `OPERATOR_TEST_DATABASE_URL` test path, ideally backed by Docker Compose Postgres.
  - Cleanup: cover schema setup, conversation upsert, observation dedupe, policy update, output listing, and owner isolation.

- [ ] Split the Telegram handler module.
  - Evidence: `src/telegram/handlers.ts` is over 1,000 lines and owns update routing, commands, policy/orchestration, Pi calls, SQLite/Postgres writes, replies, attachments, and cases.
  - Cleanup: extract `telegram/commands.ts`, `telegram/run-orchestrator.ts`, `operator/envelope-service.ts`, and `operator/case-service.ts`.
  - Cleanup: keep grammY registration thin.

- [ ] Split Operator/Telegram tools out of `PiBridge`.
  - Evidence: `src/pi/bridge.ts` owns Pi sessions plus Operator context tools and Telegram attachment queueing.
  - Cleanup: keep `PiBridge` focused on sessions, queues, model config, and progress normalization.
  - Cleanup: inject tool factories from `operator/tools.ts` and `telegram/attachment-tool.ts`.

- [ ] Decouple policy from grammY `Context`.
  - Evidence: `src/operator/policy.ts` imports grammY and checks mention/reply state directly.
  - Cleanup: pass normalized trigger facts from Telegram normalization/context, then keep policy platform-domain focused.

- [ ] Handle single-owner vs multi-owner DB identity.
  - Evidence: conversation uniqueness currently does not include owner id.
  - Cleanup: if one database can contain multiple owners, include `owner_user_id` in the Telegram identity uniqueness model.

## P1 - Security, Privacy, And Runtime Safety

- [ ] Define and document data retention.
  - Evidence: prompts, responses, raw Telegram payloads, outputs, audit payloads, cases, and artifacts can be stored in plaintext across Postgres, SQLite, and files.
  - Cleanup: document data classes, retention defaults, deletion flow, and whether encryption at rest is expected from the host.
  - Cleanup: add redaction for common secrets in prompts/responses/audit payloads.

- [ ] Reduce ambient environment leakage to MCP subprocesses.
  - Evidence: MCP prewarm passes broad process env to child MCP servers before configured env overlay.
  - Cleanup: pass only explicit per-server env keys.

- [ ] Harden Telegram WebApp validation.
  - Cleanup: require numeric `auth_date`, reject old or future-skewed init data, and add tests for allowlist and stale auth.

- [ ] Harden Docker defaults.
  - Cleanup: pin base image digest, pin `pi-mcp-adapter`, run as non-root, avoid production-looking `dev-token` defaults, and avoid exposing Postgres by default outside local dev.

## P2 - Test Coverage And Developer Ergonomics

- [ ] Add focused handler/orchestration tests.
  - Cleanup: extract pure functions or use fake grammY contexts for team mention/reply, personal draft, assistant mode, and run lifecycle.

- [ ] Expand control-panel tests.
  - Cleanup: cover conversations/outputs/policy endpoints, token auth, Telegram init-data auth, stale `auth_date`, allowlist behavior, and invalid policy body handling.

- [ ] Add attachment safety tests.
  - Cleanup: cover traversal, symlink, root allowlist, size limit, kind inference, and filename sanitization.

- [ ] Add test fixtures.
  - Cleanup: create `tests/fixtures/telegram/*` and `tests/fixtures/operator/*` for realistic Telegram, Business, and Operator store cases.

- [ ] Expand `scripts/doctor.ts`.
  - Current behavior: SQLite integrity and running-run count only.
  - Cleanup: validate env, Postgres connectivity/schema, `.mcp.json`, writable state dirs, `TELEGRAM_BOT_USERNAME`, and optional Telegram `getMe`.

- [ ] Remove broad `// @ts-nocheck` from MCP packages.
  - Cleanup: type MCP inputs/results and replace broad `any` usage in `packages/postgres-mcp` and `packages/datadog-mcp`.

## P2 - Launch Polish

- [ ] Add demo assets.
  - Cleanup: add a quickstart transcript, sample group install flow, `/app` screenshot, and sample `.env` variants for local/hosted use.

- [ ] Add least-privilege connector docs.
  - Cleanup: document safe Postgres read-only role creation, Datadog scopes, example queries, and fields that should be redacted.

- [ ] Update contributor-specific guidance.
  - Evidence: `CLAUDE.md` says not to use `pg`, but current Operator Postgres store uses `pg`.
  - Cleanup: update or remove contradictory agent-specific guidance before publishing.

## Suggested PR Sequence

- [ ] PR 0: security defaults and deployment footguns.
  - Open-by-default Telegram access documented with clear startup warnings.
  - Control-panel auth hardened.
  - Business automation default-on documented with owner allowlist guidance.
  - MCP default hardening or opt-in docs.
  - DO template removed or fixed.

- [ ] PR 1: OSS scaffolding and validation.
  - License, package metadata, community files.
  - `validate` script, lint/format tooling, CI.
  - `.gitignore` tightening and release checklist.

- [ ] PR 2: docs and deploy alignment.
  - README claims corrected.
  - `.env.example` updated.
  - Architecture doc updated.
  - Deploy matrix reduced to tested targets.
  - API/control-panel docs added.

- [ ] PR 3: state and storage cleanup.
  - State ownership doc/interface split.
  - Postgres migrations.
  - Postgres integration tests.
  - Multi-owner uniqueness decision.

- [ ] PR 4: maintainability refactor.
  - Split `src/telegram/handlers.ts`.
  - Split Operator/Telegram tools out of `src/pi/bridge.ts`.
  - Decouple policy from grammY.

- [ ] PR 5: launch polish.
  - Demo screenshots/transcripts.
  - Connector least-privilege docs.
  - Doctor expansion.
  - MCP package typing cleanup.

## Owner Decisions Needed

- [x] Should OSS access defaults be open by default?
  - Decision: yes. Unset `ALLOWED_USER_IDS` and unset `ALLOWED_GROUP_ID` keep the bot open to users/groups that can reach it.
  - Follow-up: make this unmistakable in docs/startup logs and show the lockdown path.

- [x] Which license should the repo use?
  - Decision: MIT.

- [ ] Should Postgres be required for the default product?
  - Recommendation: yes; treat SQLite as local compatibility/runtime cache only.

- [x] Which deploy target is first-class?
  - Decision: Docker Compose locally and Render hosted; remove or downgrade Railway/DO until validated.

- [x] Should Telegram Business automation default on?
  - Decision: yes, keep it default-on.
  - Follow-up: still document the opt-in boundary and prevent multi-owner data mixing.

- [ ] Should control-panel auth accept query-string tokens?
  - Recommendation: local dev only. Production should be Bearer/header or Telegram init data from an owner allowlist.

- [x] Should Postgres/Datadog MCP connectors ship enabled in `.mcp.json.example`?
  - Decision: no, make them opt-in examples with least-privilege setup.

- [ ] Is `packages/telegram-markdown-html` intended to be public npm package?
  - Recommendation: mark private until a release process exists.

- [ ] CI scope: run Docker build and Postgres integration tests on every PR?
  - Recommendation: typecheck/unit/lint every PR; Docker build and Postgres integration at least nightly, or every PR if runtime stays small.

- [ ] What retention policy should apply to Telegram text, prompts, responses, audit payloads, and context artifacts?
  - Recommendation: start with documented local retention plus a deletion command before adding encryption/redaction depth.
