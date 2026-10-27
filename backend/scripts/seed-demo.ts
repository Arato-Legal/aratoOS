// Seeds a local stack with a fictional demo workspace: one demo user, clients,
// matters, and a spread of .docx / .xlsx / .pdf files (matter files and Library
// files). Everything goes through the public API as the demo user, so access
// rules, upload sealing, and processing behave exactly as for a real user.
//
//   npx tsx backend/scripts/seed-demo.ts
//
// Environment (defaults suit `docker compose up`):
//   API_URL           backend base URL           (http://localhost:3001)
//   SUPABASE_URL      Supabase gateway           (from backend/.env, else :54321)
//   SUPABASE_SECRET_KEY / SUPABASE_PUBLISHABLE_KEY   read from backend/.env
//   DEMO_EMAIL / DEMO_PASSWORD  (demo@arato.local / DemoPass123!)
//
// All names, numbers, and facts below are invented. Safe to re-run: it creates
// a fresh set each time, so use a throwaway local database.

import fs from "node:fs";
import path from "node:path";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import * as XLSX from "xlsx";

function envFile(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    const text = fs.readFileSync(path.join(__dirname, "..", ".env"), "utf8");
    let value: string | undefined;
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && m[1] === key) value = m[2].trim();
    }
    return value;
  } catch {
    return undefined;
  }
}

const API = process.env.API_URL ?? "http://localhost:3001";
const SUPABASE = envFile("SUPABASE_URL") ?? "http://localhost:54321";
const SECRET = envFile("SUPABASE_SECRET_KEY");
const ANON = envFile("SUPABASE_PUBLISHABLE_KEY");
const EMAIL = process.env.DEMO_EMAIL ?? "demo@arato.local";
const PASSWORD = process.env.DEMO_PASSWORD ?? "DemoPass123!";

if (!SECRET || !ANON) {
  throw new Error("SUPABASE_SECRET_KEY / SUPABASE_PUBLISHABLE_KEY not found in env or backend/.env");
}

// ---------------------------------------------------------------- file builders

async function docx(title: string, sections: Array<[string, string[]]>): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }),
  ];
  for (const [heading, paras] of sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(heading)] }));
    for (const p of paras) {
      children.push(new Paragraph({ spacing: { after: 160 }, children: [new TextRun(p)] }));
    }
  }
  return Packer.toBuffer(new Document({ sections: [{ children }] }));
}

function xlsx(sheets: Record<string, unknown[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

/** A minimal text-only PDF (Helvetica), enough for preview and extraction. */
function pdf(title: string, lines: string[]): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, "\\$&");
  const content = [
    "BT /F1 16 Tf 56 780 Td (" + esc(title) + ") Tj ET",
    ...lines.map((l, i) => `BT /F1 11 Tf 56 ${750 - i * 18} Td (${esc(l)}) Tj ET`),
  ].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

type SeedFile = { name: string; data: Buffer };

// ------------------------------------------------------------------ the demo data

async function buildMatters() {
  return [
    {
      client: { name: "Willow Creek Community Foundation", kind: "organization", status: "active", email: "ed@willowcreek.example", phone: "416-555-0142", notes: "Fictional demo client. Small public foundation; ED is Maya Okafor." },
      matter: { name: "Charitable registration", cm_number: "DEMO-0001", practice: "Charities" },
      files: [
        { name: "Schedule A - Statement of Charitable Activities.docx", data: await docx("Schedule A: Statement of Charitable Activities", [
          ["Purposes", ["Willow Creek Community Foundation (the \"Foundation\") is established to relieve poverty by providing food, shelter and essential services to persons in need in the Greater Toronto Area.", "The Foundation will advance education by funding bursaries and literacy programs for children and youth."]],
          ["Activities", ["1. Operate a weekly community food pantry staffed by volunteers.", "2. Fund bursaries to qualified students under a published, merit-neutral selection policy.", "3. Grant funds to qualified donees only, in accordance with s. 149.1 of the Income Tax Act."]],
          ["Resources", ["The Foundation will rely on donations, grants and volunteer time. No activity will be carried on outside Canada in the first two years."]],
        ]) },
        { name: "Articles of Incorporation (ONCA) - draft.docx", data: await docx("Articles of Incorporation", [
          ["1. Name", ["Willow Creek Community Foundation"]],
          ["2. Province", ["Ontario"]],
          ["3. Number of directors", ["Minimum three (3) and maximum eleven (11)."]],
          ["4. Restrictions", ["The corporation shall carry on its activities exclusively in furtherance of its charitable purposes and shall not distribute income to any member, director or officer."]],
        ]) },
        { name: "Draft budget FY1-FY2.xlsx", data: xlsx({ Budget: [["Line", "FY1", "FY2"], ["Donations", 85000, 120000], ["Grants", 40000, 60000], ["Food and supplies", 52000, 71000], ["Bursaries", 20000, 35000], ["Admin and professional fees", 18000, 22000], ["Net", "=SUM(B2:B3)-SUM(B4:B6)", "=SUM(C2:C3)-SUM(C4:C6)"]] }) },
        { name: "CRA deficiency letter - 2026-09-14.pdf", data: pdf("Canada Revenue Agency - Charities Directorate (fictional)", ["Re: Application for registration - Willow Creek Community Foundation", "We reviewed your application and require further information:", "1. Describe how volunteers are supervised at the food pantry.", "2. Provide the bursary selection criteria and who decides.", "3. Confirm that no private benefit accrues to directors.", "Please respond within 60 days of the date of this letter."]) },
      ],
    },
    {
      client: { name: "Northern Lights Arts Collective", kind: "organization", status: "active", email: "board@northernlights.example", phone: "613-555-0188", notes: "Fictional demo client. NPO moving from the Ontario Corporations Act to the ONCA." },
      matter: { name: "ONCA transition and bylaw update", cm_number: "DEMO-0002", practice: "Governance" },
      files: [
        { name: "Bylaw No. 1 (ONCA) - consolidated.docx", data: await docx("Bylaw No. 1", [
          ["Members", ["The corporation has one class of members. A person becomes a member by application to and acceptance by the board."]],
          ["Directors", ["The board consists of five to nine directors elected by the members for staggered two-year terms. No director may serve more than three consecutive terms."]],
          ["Meetings", ["Members' meetings may be held in person, by telephone or electronically. Quorum is ten percent of the members entitled to vote."]],
        ]) },
        { name: "Board resolution - approve bylaw and articles of amendment.docx", data: await docx("Resolution of the Board of Directors", [
          ["Resolved", ["THAT the directors approve the replacement of By-law No. 1 with the consolidated bylaw presented to this meeting;", "THAT the directors recommend to the members a special resolution authorizing articles of amendment to continue under the Ontario Not-for-Profit Corporations Act, 2010."]],
        ]) },
        { name: "ONCA transition checklist.xlsx", data: xlsx({ Checklist: [["Step", "Owner", "Status", "Due"], ["Review letters patent and old bylaws", "Counsel", "Done", "2026-09-30"], ["Draft new bylaw", "Counsel", "Done", "2026-10-10"], ["Board approval", "Board", "In progress", "2026-11-05"], ["Members' special resolution", "Members", "Not started", "2026-12-01"], ["File articles of amendment", "Counsel", "Not started", "2026-12-15"]] }) },
      ],
    },
    {
      client: { name: "Harbourfront Bakers Ltd.", kind: "organization", status: "active", email: "owner@harbourbakers.example", phone: "902-555-0173", notes: "Fictional demo client. Family-owned bakery planning a holdco reorganization." },
      matter: { name: "Holdco reorganization", cm_number: "DEMO-0003", practice: "Corporate" },
      files: [
        { name: "Share structure memo.docx", data: await docx("Memorandum: Proposed Share Structure", [
          ["Background", ["Harbourfront Bakers Ltd. (\"Opco\") is owned equally by Ibrahim and Claire Tremblay. They wish to interpose a holding corporation to receive Opco dividends tax-efficiently and to protect retained earnings from operating-company creditors."]],
          ["Recommendation", ["Incorporate a new OBCA holding corporation with common shares issuable to each shareholder, and transfer the Opco shares on a tax-deferred rollover under s. 85 of the Income Tax Act."]],
          ["Risks", ["The section 55 safe-income analysis must be completed before any intercorporate dividend. Valuation should be supported by a written opinion."]],
        ]) },
        { name: "Cap table - before and after.xlsx", data: xlsx({ "Before": [["Shareholder", "Class", "Shares", "%"], ["Ibrahim Tremblay", "Common", 50, "50%"], ["Claire Tremblay", "Common", 50, "50%"]], "After": [["Shareholder", "Class", "Shares", "%"], ["Tremblay Holdings Inc. (Holdco)", "Common", 100, "100%"]] }) },
        { name: "Engagement letter.pdf", data: pdf("Arato Legal - Engagement Letter (fictional)", ["Client: Harbourfront Bakers Ltd.", "Scope: advise on and implement a holding company reorganization.", "Fees: fixed fee of $6,500 plus disbursements and applicable taxes.", "This engagement does not include tax return preparation."]) },
      ],
    },
    {
      client: { name: "Dana Whitfield", kind: "individual", status: "lead", email: "dana@whitfield.example", phone: "587-555-0119", notes: "Fictional demo lead. Considering a non-profit for a community garden." },
      matter: { name: "Community garden - structure options", cm_number: "DEMO-0004", practice: "Charities" },
      files: [
        { name: "Intake notes.docx", data: await docx("Intake Notes", [
          ["Call summary", ["Dana and four neighbours run a community garden on city-leased land and want to accept donations and apply for grants.", "Unsure whether to incorporate, partner with an existing charity, or stay informal."]],
          ["Next steps", ["Send the intake form. Prepare a short options memo comparing an NPO, a charity and a fiscal-sponsor arrangement."]],
        ]) },
      ],
    },
  ];
}

async function buildLibrary(): Promise<SeedFile[]> {
  return [
    { name: "Precedent - Directors' consent to act.docx", data: await docx("Consent to Act as Director", [["Consent", ["I, [Name], consent to act as a director of [Corporation] and confirm that I am not disqualified under the applicable statute."]]]) },
    { name: "Precedent - Services agreement (short form).docx", data: await docx("Services Agreement", [["Parties", ["[Client] and [Service Provider]."]], ["Services and fees", ["The Service Provider will deliver the services described in Schedule A for the fees stated there."]], ["Governing law", ["The laws of Ontario and the federal laws of Canada applicable therein."]]]) },
    { name: "Disbursement quota worksheet.xlsx", data: xlsx({ DQ: [["Item", "Amount"], ["Property not used in charitable activities (prior year)", 400000], ["3.5% on first $1M", "=MIN(B2,1000000)*0.035"], ["Gifts to qualified donees", 15000], ["Charitable expenditures", 22000]] }) },
    { name: "Reference - CRA guidance index.pdf", data: pdf("Reference: CRA guidance index (fictional summary)", ["CG-002 Canadian registered charities carrying out activities outside Canada", "CG-004 Using an intermediary to carry out a charity's activities", "CG-032 Qualifying disbursements", "Use this index as a starting list, not as a substitute for the current guidance."]) },
  ];
}

// --------------------------------------------------------------------- HTTP

async function must<T = any>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? null : await res.json()) as T;
}

async function ensureUser(): Promise<string> {
  const res = await fetch(`${SUPABASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SECRET!, Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
  });
  if (!res.ok && !(await res.clone().text()).includes("already been registered")) {
    throw new Error(`create user failed: ${res.status} ${await res.text()}`);
  }
  const login = await must<{ access_token: string }>(
    await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: ANON! },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }),
    "sign in",
  );
  return login.access_token;
}

async function main() {
  const token = await ensureUser();
  const call = (method: string, p: string, body?: unknown) =>
    fetch(`${API}${p}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function upload(destination: object, files: SeedFile[]) {
    const created = await must<any>(
      await call("POST", "/upload-sessions", {
        purpose: "document_create",
        destination,
        files: files.map((f, i) => ({ client_id: `f${i}`, filename: f.name, size_bytes: f.data.length })),
      }),
      "create upload session",
    );
    for (const entry of created.files) {
      const file = files[Number(String(entry.client_id).slice(1))];
      const put = await fetch(entry.upload.url, { method: "PUT", headers: entry.upload.headers, body: new Uint8Array(file.data) });
      if (!put.ok) throw new Error(`PUT ${file.name} failed: ${put.status} ${await put.text()}`);
      await must(await call("POST", `/upload-sessions/${created.session.id}/files/${entry.id}/complete`, {}), `complete ${file.name}`);
    }
  }

  for (const m of await buildMatters()) {
    const client = await must<any>(await call("POST", "/clients", m.client), `client ${m.client.name}`);
    const project = await must<any>(await call("POST", "/projects", m.matter), `matter ${m.matter.name}`);
    await must(await call("PUT", `/clients/matters/${project.id}`, { client_id: client.id }), "attach matter to client");
    await upload({ scope: "project", project_id: project.id }, m.files);
    console.log(`seeded ${m.client.name}: ${m.matter.name} (${m.files.length} files)`);
  }

  const library = await buildLibrary();
  await upload({ scope: "library", library_kind: "file" }, library);
  console.log(`seeded Library: ${library.length} files`);
  console.log(`\nSign in at http://localhost:3000 as ${EMAIL}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
