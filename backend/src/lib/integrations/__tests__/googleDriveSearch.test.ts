import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptString } from "../../mcp/client";
import { driveDb } from "./googleDriveDb";
import {
  driveSearchTerms,
  GOOGLE_DRIVE_FULL_SCOPE,
  searchDriveFiles,
} from "../googleDrive";
import { personalConnectorOwner } from "../../connectorOwner";

const queries: string[] = [];

function store(scope = GOOGLE_DRIVE_FULL_SCOPE) {
  const token = encryptString("synthetic-token");
  return driveDb({
    tokenRow: {
      user_id: "user-1",
      grant_id: "grant-1",
      scope,
      encrypted_access_token: token.encrypted,
      access_token_iv: token.iv,
      access_token_tag: token.tag,
      expires_at: "2099-01-01T00:00:00Z",
      enabled: true,
      require_write_approval: false,
      disabled_tools: [],
    },
  });
}

beforeEach(() => {
  vi.stubEnv("MCP_CONNECTORS_ENCRYPTION_SECRET", "synthetic-secret");
  queries.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const q = new URL(input).searchParams.get("q") ?? "";
      queries.push(q);
      if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
        return Response.json({
          files: q.includes("'root-folder' in parents")
            ? [{ id: "sub-folder", name: "Leases", mimeType: "application/vnd.google-apps.folder" }]
            : [],
        });
      }
      return Response.json({
        files: [
          { id: "f-old", name: "Notes", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-01-01T00:00:00Z" },
          { id: "f-best", name: "Acme lease amendment.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", modifiedTime: "2025-01-01T00:00:00Z" },
        ],
      });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("driveSearchTerms", () => {
  it("keeps distinctive words, deduplicated and bounded", () => {
    expect(driveSearchTerms("The Acme lease, acme  a amendment")).toEqual(["the", "acme", "lease", "amendment"]);
    expect(driveSearchTerms("a b c")).toEqual([]);
    expect(driveSearchTerms("one two three four five six seven eight")).toHaveLength(6);
  });
});

describe("searchDriveFiles", () => {
  it("ranks name matches first and searches Word and Google Docs only", async () => {
    const hits = await searchDriveFiles(personalConnectorOwner("user-1"), store().db as never, {
      query: "acme lease",
    });
    expect(hits.map((h) => h.id)).toEqual(["f-best", "f-old"]);
    expect(queries[0]).toContain("vnd.google-apps.document");
    expect(queries[0]).toContain("fullText contains 'acme'");
    expect(queries[0]).not.toContain("in parents");
  });

  it("limits a folder search to the folder and its subfolders", async () => {
    await searchDriveFiles(personalConnectorOwner("user-1"), store().db as never, {
      query: "lease",
      rootFolderId: "root-folder",
    });
    const fileQuery = queries.find((q) => q.includes("fullText"))!;
    expect(fileQuery).toContain("'root-folder' in parents");
    expect(fileQuery).toContain("'sub-folder' in parents");
  });

  it("refuses an empty description, a bad folder id and a per-file connection", async () => {
    const owner = personalConnectorOwner("user-1");
    await expect(searchDriveFiles(owner, store().db as never, { query: "a" })).rejects.toThrow(/Describe/);
    await expect(
      searchDriveFiles(owner, store().db as never, { query: "lease", rootFolderId: "x'y" }),
    ).rejects.toThrow(/not valid/);
    await expect(
      searchDriveFiles(owner, store("https://www.googleapis.com/auth/drive.file").db as never, { query: "lease" }),
    ).rejects.toThrow();
  });
});
