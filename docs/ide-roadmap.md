# IDE roadmap: legal-grade document editing

Plan only. Nothing here is built unless marked **Exists**. Written 2026-10-27.

## Goal

The IDE edits Word and Google Docs (and later XLSX and Google Sheets) to the
standard lawyers need for bylaws and contracts: legal numbering, tracked
changes, comments, cross-references (REF fields), full interoperability
between file types, PDF export to Drive, and an in-document assistant like the
Word assistants from Claude, Gavel, Legora and Litera.

## Where things stand

| Requirement | Status |
| --- | --- |
| Tracked changes (`w:ins`, `w:del`) | **Exists.** Suggesting mode in the EigenPal editor; accept/reject by revision ID. No change list panel. |
| Comments | **Exists.** Add, reply, edit (replace-and-delete), delete. Resolve not implemented. |
| Legal numbering | **Unverified.** No numbering-specific code found. |
| REF fields / cross-references | **Not found.** |
| Word <-> Google Docs | **Partial.** Google Doc exported to `.docx` and written back, only for files in a matter's Work in progress list. Doc comments and suggestions can be lost. |
| Save as PDF to Drive | Not built. PDF conversion and Drive upload both exist separately. |
| In-document assistant | Not built. Word add-in chat and assistant edit cards exist elsewhere. |
| Admin training, model choice | Not built. Playbooks and memory exist. |
| XLSX / Google Sheets | A spreadsheet view exists; editing unverified. |

Editor: `@docx-editor.dev/*` pinned at 2.21.1 (`docs/docx-preview-engines.md`).
Drive sync: `backend/src/modules/clients/clients.driveEdit.ts`.

## Decision gate (do first): fidelity spike

Everything after Phase 1 depends on whether the editor engine can do legal
numbering and REF fields. Spike before committing:

1. Collect 5 real files: two bylaws, two contracts, one with heavy
   cross-references. Remove client data first; this repo is public.
2. Round-trip each through the editor (open, edit one clause, save) and diff
   the OOXML: `numbering.xml`, `w:fldSimple` / `w:instrText` (REF, PAGEREF),
   bookmarks, `w:sdt`, styles, headers and footers.
3. Open the saved files in Word and check numbering, cross-reference updates,
   and tracked changes by eye.
4. Record pass/fail per feature.

Outcomes:

- **Engine passes:** proceed with the phases below.
- **Engine fails on numbering or fields:** choose between contributing the
  feature to the (Apache-2.0) core, patching around it by preserving
  unknown OOXML untouched, or replacing the engine. Preserve-untouched is the
  cheapest and should be tried first: edits must never destroy fields or
  numbering they do not understand.

## Phase 1: Drive plumbing

1. Per-connection Drive access mode (`file`, `full`, `readonly`) at connect
   time. **Built** (backend, API client and Settings picker; uncommitted).
2. `google_drive_import` chat tool: bring Drive files (docx, Google Doc, PDF)
   into a matter as Mike documents so compare, tabular review and workflows
   can run on them. Then `create_tabular_review` accepts the imported
   documents. Reuse the import path in `clients.driveEdit.ts`.
3. Library tabs: App library, Drive matter folder, Drive precedents/research
   folder. Matter and client folder links already exist; the
   precedents/research folder needs a new org- or user-level setting. Browse
   live with the viewer's own Google connection; "Add to Mike" imports.
4. Save as PDF to Drive from the editor, using the existing PDF conversion and
   Drive upload.
5. Allow "Edit in Mike" on any imported Drive file, not only Work in progress.

Done when: a user describes documents and a Drive location in chat, the
assistant imports them, and a tabular review runs without manual uploads.

## Phase 2: Fidelity (shaped by the spike)

- Legal numbering: multilevel lists (1., 1.1, (a), (i)), restart rules, styles
  linked to numbering, and insertion or deletion of a clause that renumbers
  correctly, including under tracked changes.
- REF fields and bookmarks: insert cross-reference to a numbered clause,
  update fields, survive edits, and keep working after Google Docs round trip
  where Google supports it.
- Comment resolution; a tracked-changes panel (list, filter by author,
  accept/reject all).
- Interoperability matrix, each tested both directions: Word -> Google Doc ->
  Word, with a written list of what Google Docs cannot hold (so the UI can
  warn before a lossy save).
- Unknown OOXML preserved byte-for-byte on save.

Done when: the five spike files survive edit, save and Word reopen with
numbering, fields and revisions intact.

## Phase 3: In-document assistant

- Side panel in the editor, scoped to the open document, selection and
  comments.
- Prompts produce inline recommendations. Each applies either as a tracked
  change or as plain text; the user chooses per edit and can apply all.
- Edits go through the editor's own command API so undo, authorship and
  autosave behave normally. Author shown as the assistant, not the user.
- Reuse the existing edit card UI and document-lock logic.
- Streaming, partial failure and conflict handling: a user edit during
  generation invalidates only the affected suggestions.

## Phase 4: Admin training and model choice

- Admin-managed instructions at org level: house style, defined terms,
  clause preferences, playbooks. Build on `docs/playbooks.md` and
  `docs/memory.md` rather than a new store.
- Model picker available to users; default is automatic selection on the
  backend by task (quick edit, clause rewrite, whole-document review). Selection
  rules live server-side and are admin-visible.
- Evaluation set from the spike files so instruction or model changes can be
  checked for regressions.

## Phase 5: Spreadsheets

- Audit what `SpreadsheetView` edits today.
- XLSX edit and save with formulas, formats and sheets preserved; Google
  Sheets through the same export/write-back approach as Docs; same Drive
  import and PDF export.

## Risks

- **Engine ceiling** on numbering and fields. Mitigated by the spike.
- **Google Docs fidelity:** export to `.docx` loses suggestions and some
  formatting. Native editing through the Docs API is a separate, much larger
  project and is not planned.
- **Whole-Drive scope** is a restricted Google scope; use an OAuth app
  internal to the Workspace domain or complete Google's verification.
- **Public repo:** test documents must be synthetic or scrubbed.

## Firm workflow (confirmed)

The firm works in both formats interchangeably. Drafts start as DOCX, then
are converted to Google Docs to share with clients. So:

- DOCX is the drafting source; the Google Doc is the client-facing copy.
- The conversion that matters most is DOCX -> Google Doc (what the client
  sees), then Google Doc -> DOCX (client suggestions and comments coming
  back). Both are tested, in that order, in Phase 2.
- Client suggestions and comments made in Google Docs must arrive in the
  DOCX as tracked changes and comments, with the client as author.
- Numbering and cross-references must still be correct after the trip out
  and back; a format that looks right only in Word is not enough.
- Needed in Phase 1/2: a "Share to Google Docs" action (convert and upload,
  remembering the link) and "Pull client changes" (reuses Update from Drive,
  imports as a new version so nothing is overwritten).

## Open questions

- Which templates carry the numbering styles that matter most?
- Should assistant edits require lawyer approval before saving, or only be
  marked as suggestions?
