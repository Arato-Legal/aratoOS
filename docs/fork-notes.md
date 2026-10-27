# Arato fork notes

This repository is Arato Legal's fork of [Mike](https://github.com/open-legal-products/mike)
(`open-legal-products/mike`, AGPL-3.0). This page records what the fork adds and
how to pull in Mike's updates without losing it. Keep it current: each time a
change touches one of Mike's own files, add it to the list below.

The fork is public (a fork of a public repository cannot be made private), so
never commit client names, matter details, real emails, tokens or secrets, in
code, tests, docs or PR text.

## What the fork adds

Mostly new files, in new modules, so most upstream updates do not touch them.

| Feature | Where | Docs |
| --- | --- | --- |
| Clients, contacts, client and matter dashboards | `backend/src/modules/clients/`, `frontend/src/app/components/clients/`, pages under `(pages)/clients` and `(pages)/matters` | [clients.md](clients.md) |
| Matter Drive folder and Work in progress list | `clients.drive.ts`, Drive browse functions at the end of `lib/integrations/googleDrive.ts` | [clients.md](clients.md) |
| Edit Drive Word and Google Docs in Mike | `clients.driveEdit.ts`, `modules/documents/documents.import.ts` | [clients.md](clients.md) |
| Client-level assistant sessions, modes, shared-matter memory read-through | `lib/clientSharing.ts`, `lib/assistantModes.ts`, `lib/memory/prompt.ts`, `lib/memory/clientMemory.ts`, `modules/memory/memory.client*.ts`, `contextBuilders.ts`, `create_tabular_review` in `toolDispatcher.ts` | [clients.md](clients.md) |
| Hubflo inbound sync (webhook) | `backend/src/modules/crm-sync/`, `clients.sync.ts` | [clients.md](clients.md) |
| Canadian official sources only (web search) | `backend/src/lib/webSearch/canadaSources.ts` | [web-search.md](web-search.md) |
| Tasks, notifications, document review state, audit entries | `modules/tasks/`, `modules/notifications/`, `documents.review.ts`, `lib/mail/` (ported from [TaxOSS-1/mike](https://github.com/TaxOSS-1/mike)) | |
| Codespaces test environment | `.devcontainer/` | [codespaces.md](codespaces.md) |

Migrations the fork added, which must stay in this order after Mike's:
`20261025_01` to `_03` (ported from TaxOSS) and `20261026_01` to `_04`
(clients, matter Drive folder, document Drive links, CRM sync) `20261026_05`
(client Drive folder, per-matter client sharing) `20261026_06` (client numbers,
Hubflo links, workspace-wide Drive) `20261026_07` (client-level chats) and `20261026_08` (client memory).

## Mike's own files the fork changed

These are the places a Mike update can collide with the fork. Keep edits here
small and additive.

- **Shared lists that every feature appends to** (the most common conflict; the
  fix is always to keep both sides): `backend/schema.sql` (the migration ledger
  at the end and a few new tables), the `ROUTE_PARTS` word list in
  `backend/src/lib/observability/sentryPrivacy.ts` and
  `frontend/src/shared/lib/sentryPrivacy.ts`, `frontend/src/app/lib/mikeApi.ts`
  (API functions at the end), `frontend/src/app/components/shared/types.ts`.
- **Wiring:** `frontend/next.config.ts` (the `/matters` rewrites and `/projects` redirects), `backend/src/app.ts` (routers and rate limits),
  `backend/src/index.ts`, `backend/src/workerRuntime.ts`,
  `backend/src/jobs/registry.ts`, `backend/src/jobs/maintenance.ts`,
  `docker-compose.yml`, `backend/.env.example`.
- **Web search:** `lib/webSearch/*`, `lib/llm/{aiSdk,providers,types}.ts`,
  `chat.prepare.ts`, `chat.routes.ts`, `projectChat.routes.ts`,
  `projectChat.service.ts`, `engine/streaming.ts`,
  `engine/tools/webSearchTools.ts`, `user.webSearch.ts`,
  `WebSearchSection.tsx`.
- **Projects and documents:** `projects.access.ts`, `projects.crud.ts`,
  `projects.routes.ts`, `documents.routes.ts`, `documents.service.ts`,
  `documents.versions.ts`, `lib/orgs.ts`, `orgs.routes.ts`,
  `user.dataExport.ts`, `lib/auditExport.ts`, `lib/integrations/googleDrive.ts`.
- **Frontend screens:** `AppSidebar.tsx`, `ProjectWorkspace.tsx`,
  `ProjectPageParts.tsx`, `DocTable.tsx`, `settings/layout.tsx`,
  `history/auditPresentation.ts`.

- **"Matter" wording:** the UI says "Matter" while code, the database, the API
  and URLs keep `projects`, so upstream merges stay clean. Only user-visible
  strings changed (labels, headings, buttons, placeholders, toasts, aria-labels,
  error and notification text, and docs prose), across frontend components and
  pages, the Word add-in, backend error and notification messages, their tests,
  the e2e specs and the docs. Model prompts and tool descriptions still say
  "project". A merge conflict in such a string resolves to Mike's text with
  "project" changed to "matter".

Not taken from TaxOSS on purpose: its change that lets an operator trust private
network addresses for connector URLs. It loosens a security safeguard, so it
needs its own review.

## Pulling in Mike's updates

The `upstream` remote points at Mike. Do this roughly monthly, on a branch, never
directly on `main`.

```bash
git fetch upstream
git log --oneline main..upstream/main      # what is new; empty means up to date
git checkout -b chore/sync-upstream-YYYY-MM main
git merge upstream/main                    # a merge commit, never a rebase
```

1. **Resolve conflicts.** Expect the shared lists above. Keep both sides. Never
   drop a line that a fork feature added.
2. **Renumber a clashing migration.** If Mike adds a migration with the same
   date and number as one of ours, rename ours to the next free number and fix
   its entry in the `schema_migrations` list at the end of `schema.sql`. Never
   rename a migration that has been applied to a real database.
3. **Run the checks**: `npm test --prefix backend`,
   `npm run test:coverage --prefix frontend`, and both typechecks. The
   frontend coverage floor is strict: a new API function needs a test.
4. **Open a PR and merge it with a merge commit** once CI is green (the three
   `dependency-audit` jobs also fail on Mike's own `main`; ignore them until
   Mike fixes them).
5. **Update this page** if the update changed one of the files listed above.

Merge with a merge commit, not a squash, so the next sync can tell what has
already been brought in.

## Keeping updates easy

- Put new features in new files and modules; touch Mike's files only to wire
  them in.
- Keep edits to Mike's files small, and add them to the list above.
- Where a feature would help every Mike user (for example the Canadian sources
  setting), consider offering it to Mike as a pull request. Whatever Mike
  accepts is no longer ours to maintain.
- Licence: Mike is AGPL-3.0. If others use a modified version over a network,
  they must be offered its source. Decide who the users are before any
  deployment.
