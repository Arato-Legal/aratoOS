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

## Planned

Mike for Mac reading the synced Drive folder, one editor for Word and Google
Docs files in the Work in progress folder,

manual links per matter, Hubflo sync (matter data is pushed from Hubflo),
AI write-in through an MCP server and scoped tokens, and matter-wide queries.
