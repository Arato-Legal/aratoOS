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

## Intake forms and the lead pipeline

A workspace member creates an intake form on `/clients/intake` and shares its
link (`/intake/<token>`). The link is the capability to submit: the token is
64 random hex characters, and a disabled or unknown token answers the same
404. The public page needs no sign-in and asks for a name, an email address or
phone number, and a message.

Submissions wait in a queue. **Create lead** makes a client with status
`lead` (source `Intake: <form name>`, the message as notes) and opens it;
**Dismiss** rejects it. Each submission is reviewed once.

Abuse controls on the public endpoint: a per-IP limit (default 10 per hour,
`RATE_LIMIT_INTAKE_MAX` / `RATE_LIMIT_INTAKE_WINDOW_HOURS`), a hidden
honeypot field, length limits, and a cap of 500 pending submissions per form.
There is no CAPTCHA or email notification yet. Submitted details are personal
information: keep the deployment's data residency and retention in mind.

| Route | Purpose |
| --- | --- |
| `GET/POST /intake/:token` | Public: form meta and submit |
| `GET/POST /intake-forms` | List and create forms |
| `PATCH/DELETE /intake-forms/:id` | Edit, close or delete a form |
| `GET /intake-forms/submissions?status=` | The queue |
| `POST /intake-forms/submissions/:id/approve` or `/reject` | Review |

The clients list filters by status (All, Leads, Active, Closed).
Existing deployments must also apply
`backend/migrations/20261026_02_intake_forms.sql`.

## Planned

Google Drive and manual links per matter, CRM sync adapters,
AI write-in through an MCP server and scoped tokens, and matter-wide queries.
