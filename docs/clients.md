# Clients and matter dashboards

Mike keeps basic client data itself. A **client** has contact details, a
status (lead, active, closed), notes, custom fields and a list of contacts.
A **matter** is a project attached to a client through `projects.client_id`.

## Access

- A personal client (no organization) belongs to its creator.
- An organization client is open to every current member of that
  organization. Only its creator or an organization admin can delete it.
- Matters keep their own project access. A client page lists only the
  matters the caller may open, and a matter dashboard shows its client only
  when the caller may open that client too.
- A matter and its client must be in the same workspace, and attaching needs
  the project owner role.

## API (`/clients`)

| Route | Purpose |
| --- | --- |
| `GET /clients?workspace=&status=&q=` | List clients |
| `POST /clients?workspace=` | Create a client |
| `GET/PATCH/DELETE /clients/:id` | Client dashboard data |
| `POST/PATCH/DELETE /clients/:id/contacts[/:contactId]` | Contacts |
| `GET /clients/matters/:projectId` | Matter dashboard data |
| `PUT /clients/matters/:projectId` | Attach or detach (`client_id: null`) |

## Pages

`/clients` lists clients, `/clients/:id` is the client dashboard and
`/matters/:projectId` is the matter dashboard. Existing deployments must
apply `backend/migrations/20261026_01_clients.sql`.

## Matter Drive workspace

A matter can be linked to its Google Drive **matter folder**. The matter
dashboard then lists that folder's **Work in progress** subfolder (matched
without regard to case), where drafts and research live, and labels each file
Word, Google Doc or file with an Open in Drive link.

- Drive is always read with the viewer's own Google connection in the matter's
  workspace. A lawyer sees only what their Google account may already open,
  and linking a folder never grants anyone access to it. Linking checks the
  folder through the linker's own Drive, and needs edit access to the matter.
- Browsing folders Mike did not create needs whole-Drive access, so a
  per-file (`drive.file`) connection answers `google_drive_scope_insufficient`
  and the page says to reconnect. Set `GOOGLE_DRIVE_SCOPE_MODE=full` in
  `backend/.env` so new connections request whole-Drive access. Existing
  connections keep their scope until the user reconnects. Whole-Drive is a
  restricted Google scope: use an OAuth app that is internal to your Google
  Workspace domain, or complete Google's verification.
- Existing deployments must apply `backend/migrations/20261026_02_matter_drive_folder.sql`.

| Route | Purpose |
| --- | --- |
| `GET /clients/drive/folders?parent=&workspace=` | Browse folders for the picker |
| `GET /clients/matters/:projectId/workspace` | Linked folder and Work in progress files |
| `PUT /clients/matters/:projectId/drive-folder` | Link or unlink (`folder_id`) |

## Editing Word and Google Docs files in Mike

Each Word file or Google Doc in the Work in progress list has **Edit in Mike**.
It pulls the Drive file into the matter's project as a `.docx` document (a
Google Doc is exported to Word) and opens it at
`/matters/:projectId/edit/:documentId`, in the same editor as every other Mike
document, with autosave and version history. The link is remembered, so
opening the same Drive file again reuses the document.

- **Save to Drive** writes the current version back to the same Drive file, so
  its id, link and sharing stay put. It is refused when the file changed in
  Drive after the last sync; the page then offers an explicit overwrite.
- **Update from Drive** brings Drive's content in as a new Mike version, so
  nothing in Mike is overwritten. The previous version stays in the version
  menu.
- The page shows whether the file is in sync, edited in Mike, changed in Drive,
  or changed in both.
- A Google Doc is edited as Word and written back by converting that Word file,
  so comments, suggestions and some formatting in the Doc may not carry over.
  Drive keeps its own version history. Saving needs write access on the
  Google connection and is refused when the connector is set to read-only.
- Everything uses the editor's own Google connection and needs edit access to
  the matter. Existing deployments must apply
  `backend/migrations/20261026_03_document_drive_links.sql`.

| Route | Purpose |
| --- | --- |
| `POST /clients/matters/:projectId/drive-files/:fileId/edit` | Import (or reopen) a Drive file as a document |
| `GET /clients/documents/:documentId/drive` | Sync state |
| `POST /clients/documents/:documentId/drive/save` | Write back (`overwrite` to force) |
| `POST /clients/documents/:documentId/drive/pull` | Update from Drive as a new version |

## Hubflo sync (inbound webhook)

Matter data is pushed from Hubflo rather than typed into Mike. An organization
admin (or the owner of a personal workspace) creates an **endpoint** at
`/clients/sync`. It has a secret URL and a bearer secret; the secret is shown
once and stored only as a hash. Anything that can send an authenticated JSON
POST, such as a Hubflo automation, can push to it. Hubflo's own webhook format
is not assumed: Mike defines the payload below, and an adapter can translate a
native format later.

```
POST <app origin>/api/webhooks/crm/<token>
Authorization: Bearer <secret>

{ "events": [ { "type": "client.upsert", "data": { ... } },
              { "type": "matter.upsert", "data": { ... } } ] }
```

A single `{ "type", "data" }` event is accepted too. Up to 100 events per
request, body up to 512 kB.

| Event | `data` fields |
| --- | --- |
| `client.upsert` | `external_id` (required), `name` (required to create), `kind`, `status`, `email`, `phone`, `address`, `source`, `notes`, `custom_fields`, `contacts` (each with its own `external_id`), `updated_at` |
| `matter.upsert` | `external_id` (required), `name` (required to create), `cm_number`, `practice`, `client_external_id` (null unlinks), `archived`, `updated_at` |

- Rows are matched by the endpoint's provider and `external_id` inside its
  workspace, so repeated pushes are safe and race-tolerant.
- Fields sent overwrite Mike's; fields left out are untouched; null clears.
  Contacts and matters not mentioned are kept: a push never deletes anything.
- A push whose `updated_at` is older than the last one applied is reported
  `stale` and ignored, so out-of-order delivery cannot roll data back.
- Clients are applied before matters within a request, so a matter can name a
  client from the same push. A matter naming an unknown client is rejected with
  `client_not_found`.
- The response is 200 with a result per event (`created`, `updated`,
  `unchanged`, `stale`, or `rejected` with an `error_code`). A bad envelope is
  400. Any authentication failure (unknown token, paused endpoint, wrong
  secret) is the same 401.
- New matters are created as the person who made the endpoint, and are private
  to them unless the endpoint is set to make matters organization-wide. They can
  then be shared like any matter. If that person leaves the organization the
  endpoint answers `endpoint_owner_unavailable` until it is recreated.
- Activity (outcome and ids only, never the data) is kept for 30 days and shown
  under Recent activity. **Replace secret** invalidates the old one at once.
- The webhook is rate limited per IP (`RATE_LIMIT_CRM_WEBHOOK_MAX`, default 300
  per 15 minutes). Existing deployments must apply
  `backend/migrations/20261026_04_crm_sync.sql`.

| Route | Purpose |
| --- | --- |
| `POST /webhooks/crm/:token` | Receive a push |
| `GET/POST /crm-sync/endpoints` | List and create endpoints (admins) |
| `PATCH/DELETE /crm-sync/endpoints/:id` | Pause, rename, change matter visibility, delete |
| `POST /crm-sync/endpoints/:id/rotate-secret` | Replace the secret |
| `GET /crm-sync/endpoints/:id/events` | Recent activity |

## Sharing across a client's matters

Each matter has a **Share with client's other matters** switch
(`projects.share_with_client`, on by default, including for existing matters).
When it is on, the client's other matters can read this matter's documents,
chats, tasks and tabular reviews, read-only:

- A matter's page lists them under **Client files**, labelled by source matter.
- Mike's chat in a sibling matter can use the shared documents, labelled
  "Shared from matter: ...".
- Reading goes through a matter the reader can already open. Sharing never
  grants access to the shared matter's own page, never crosses workspaces, and
  never lets a sibling write. Only a matter owner can change the switch, and
  switching it off takes effect at once (nothing is copied).

## Drive folders

A client can link a Google Drive folder (client page, **Drive folder**). A
matter's **Create Drive folder** button makes a matter subfolder inside it,
with a "Work in progress" folder in that, using the caller's own Google
connection, and links it. If the client has no folder yet, one is created in the
caller's My Drive first. It needs whole-Drive write access (see above) and is
refused when the matter already has a folder. Existing deployments must apply
`backend/migrations/20261026_05_client_matter_sharing.sql`.

| Route | Purpose |
| --- | --- |
| `PUT /clients/matters/:projectId/sharing` | Turn sharing on or off (`share_with_client`) |
| `GET /clients/matters/:projectId/client-files` | What sibling matters share with this one |
| `POST /clients/matters/:projectId/drive-folder/create` | Create and link the matter's Drive folder |
| `PUT /clients/:clientId/drive-folder` | Link or unlink the client's Drive folder (`folder_id`) |

## URLs

Matter pages are served at `/matters/:id` (dashboard), `/matters/:id/documents`,
`/assistant`, `/tabular-reviews`, `/tasks` and `/folders`. The page files stay
under `app/(pages)/projects/` so upstream merges stay clean; `next.config.ts`
rewrites `/matters/*` to them and redirects the old `/projects/*` URLs.
The backend API paths are still `/projects/...`.

## Planned

Mike for Mac reading the synced Drive folder, manual links per matter, AI
write-in through an MCP server and scoped tokens, and matter-wide queries.
