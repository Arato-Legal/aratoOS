import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  checkClientAccess: vi.fn(),
  checkProjectAccess: vi.fn(),
  getClientMemory: vi.fn(),
  writeClientMemory: vi.fn(),
  stream: vi.fn(),
}));
vi.mock("../../../lib/dbq/enqueue", () => ({ enqueueDbJob: mocks.enqueue }));
vi.mock("../../../lib/clientSharing", () => ({ checkClientAccess: mocks.checkClientAccess }));
vi.mock("../../../lib/access", () => ({ checkProjectAccess: mocks.checkProjectAccess }));
vi.mock("../../../lib/memory/clientMemory", () => ({
  getClientMemory: mocks.getClientMemory,
  writeClientMemory: mocks.writeClientMemory,
}));
vi.mock("../../../lib/llm", () => ({ streamChatWithTools: mocks.stream }));
vi.mock("../../../lib/modelSelection", () => ({
  resolveEffectiveChatModel: async () => ({ ok: true, model: "m" }),
}));
vi.mock("../../user/user.service", () => ({
  getUserModelSettings: async () => ({ api_keys: {}, last_selected_chat_model: null, memory_curator_model: null }),
}));
vi.mock("../memory.curator", () => ({
  MEMORY_CURATOR_WRITE_TOOL: { type: "function", function: { name: "write_memory_file" } },
  memoryCuratorModelForChat: () => "m",
}));

import { DbJobDeferredError } from "../../../lib/dbq/types";
import {
  clientForChat,
  clientMemoryTranscript,
  handleClientMemory,
  scheduleClientMemory,
} from "../memory.clientCurator";

type Tables = Record<string, unknown>;
// Each table's single-row answer; list reads come from `lists`.
function fakeDb(tables: Tables, lists: Tables = {}) {
  const upserts: unknown[] = [];
  const db = {
    auth: { admin: { getUserById: async () => ({ data: { user: { email: "a@x.test" } }, error: null }) } },
    from(table: string) {
      const q: any = {
        select: () => q, eq: () => q, gt: () => q, order: () => q, limit: () => q,
        upsert: (v: unknown) => { upserts.push(v); return Promise.resolve({ error: null }); },
        maybeSingle: async () => ({ data: tables[table] ?? null, error: null }),
        then: (r: (v: unknown) => unknown) => r({ data: lists[table] ?? [], error: null }),
      };
      return q;
    },
  };
  return { db: db as never, upserts };
}

const job = { id: "job-1", payload: { chatId: "chat-1", actorUserId: "u" } } as never;
const longAgo = new Date(Date.now() - 3_600_000).toISOString();

beforeEach(() => {
  vi.resetAllMocks();
  mocks.checkClientAccess.mockResolvedValue({ ok: true, orgId: "org", name: "Acme" });
  mocks.getClientMemory.mockResolvedValue({ enabled: true, revision: 2, content: "old" });
});

describe("clientForChat (the firewall)", () => {
  it("takes a client-level chat", async () => {
    const { db } = fakeDb({ chats: { id: "c", client_id: "cl", project_id: null, model: "m" } });
    expect(await clientForChat(db, "c")).toMatchObject({ clientId: "cl", projectId: null });
  });

  it("takes a matter chat only while the matter shares with its client", async () => {
    const chat = { id: "c", client_id: null, project_id: "p", model: null };
    const on = fakeDb({ chats: chat, projects: { client_id: "cl", share_with_client: true } });
    expect(await clientForChat(on.db, "c")).toMatchObject({ clientId: "cl", projectId: "p" });
    const off = fakeDb({ chats: chat, projects: { client_id: "cl", share_with_client: false } });
    expect(await clientForChat(off.db, "c")).toBeNull();
    const none = fakeDb({ chats: chat, projects: { client_id: null, share_with_client: true } });
    expect(await clientForChat(none.db, "c")).toBeNull();
  });

  it("ignores a chat with neither", async () => {
    const { db } = fakeDb({ chats: { id: "c", client_id: null, project_id: null, model: null } });
    expect(await clientForChat(db, "c")).toBeNull();
  });
});

describe("scheduleClientMemory", () => {
  it("queues one deduped, delayed job for an eligible chat", async () => {
    const { db } = fakeDb({ chats: { id: "c", client_id: "cl", project_id: null, model: null } });
    await scheduleClientMemory(db, { chatId: "c", actorUserId: "u" });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "memory.client", dedupeKey: "memory.client:c", payload: { chatId: "c", actorUserId: "u" } }),
    );
  });

  it("queues nothing for a firewalled matter chat, and never throws", async () => {
    const off = fakeDb({
      chats: { id: "c", client_id: null, project_id: "p", model: null },
      projects: { client_id: "cl", share_with_client: false },
    });
    await scheduleClientMemory(off.db, { chatId: "c", actorUserId: "u" });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    mocks.enqueue.mockRejectedValue(new Error("boom"));
    const on = fakeDb({ chats: { id: "c", client_id: "cl", project_id: null, model: null } });
    await expect(scheduleClientMemory(on.db, { chatId: "c", actorUserId: "u" })).resolves.toBeUndefined();
  });
});

describe("handleClientMemory", () => {
  const chat = { id: "chat-1", client_id: "cl", project_id: null, model: "m" };

  it("defers while the chat is still active", async () => {
    const { db } = fakeDb({ chats: chat, chat_messages: { created_at: new Date().toISOString() } });
    await expect(handleClientMemory(db, job)).rejects.toBeInstanceOf(DbJobDeferredError);
    expect(mocks.stream).not.toHaveBeenCalled();
  });

  it("skips when the actor can no longer open the client", async () => {
    mocks.checkClientAccess.mockResolvedValue({ ok: false });
    const { db } = fakeDb({ chats: chat, chat_messages: { created_at: longAgo } });
    expect(await handleClientMemory(db, job)).toEqual({ skipped: "access_revoked" });
  });

  it("skips when client memory is off", async () => {
    mocks.getClientMemory.mockResolvedValue({ enabled: false, revision: 0, content: "" });
    const { db } = fakeDb({ chats: chat, chat_messages: { created_at: longAgo } });
    expect(await handleClientMemory(db, job)).toEqual({ skipped: "memory_off" });
  });

  it("skips when there is nothing new since the cursor", async () => {
    const { db } = fakeDb({ chats: chat, chat_messages: { created_at: longAgo } }, { chat_messages: [] });
    expect(await handleClientMemory(db, job)).toEqual({ skipped: "nothing_new" });
  });

  it("writes through the bound tool and advances the cursor", async () => {
    mocks.writeClientMemory.mockResolvedValue({ applied: true, memory: { revision: 3 } });
    mocks.stream.mockImplementation(async (args: any) => {
      await args.runTools([
        { id: "t", name: "write_memory_file", input: { markdown: "# Acme", expectedRevision: 2, changeSummary: "added" } },
      ]);
    });
    const { db, upserts } = fakeDb(
      { chats: chat, chat_messages: { created_at: longAgo } },
      { chat_messages: [{ role: "user", content: "Acme pays Net 30", created_at: longAgo }] },
    );
    const result = await handleClientMemory(db, job);
    expect(mocks.writeClientMemory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clientId: "cl", expectedRevision: 2, jobId: "job-1" }));
    expect(result).toMatchObject({ outcome: "updated" });
    expect(upserts).toEqual([{ client_id: "cl", chat_id: "chat-1", last_message_at: longAgo }]);
  });

  it("rejects a write for the wrong revision and does not advance the cursor on a conflict", async () => {
    mocks.stream.mockImplementation(async (args: any) => {
      await args.runTools([{ id: "t", name: "write_memory_file", input: { markdown: "x", expectedRevision: 99, changeSummary: "s" } }]);
    });
    const { db, upserts } = fakeDb(
      { chats: chat, chat_messages: { created_at: longAgo } },
      { chat_messages: [{ role: "user", content: "hi", created_at: longAgo }] },
    );
    const result = await handleClientMemory(db, job);
    expect(mocks.writeClientMemory).not.toHaveBeenCalled();
    expect(result).toMatchObject({ outcome: "no_change" });
    expect(upserts).toHaveLength(1);
  });

  it("requires edit access in the matter for a matter chat", async () => {
    mocks.checkProjectAccess.mockResolvedValue({ ok: true, projectRole: "viewer" });
    const matterChat = { id: "chat-1", client_id: null, project_id: "p", model: "m" };
    const { db } = fakeDb({
      chats: matterChat,
      projects: { client_id: "cl", share_with_client: true },
      chat_messages: { created_at: longAgo },
    });
    expect(await handleClientMemory(db, job)).toEqual({ skipped: "access_revoked" });
  });
});

describe("clientMemoryTranscript", () => {
  it("keeps human-readable text only, and the newest when truncated", () => {
    const text = clientMemoryTranscript([
      { role: "user", content: "Acme is a charity", created_at: "1" },
      { role: "assistant", content: [{ type: "doc_read", filename: "x" }, { type: "content", text: "Noted." }], created_at: "2" },
      { role: "system", content: "ignore", created_at: "3" },
    ]);
    expect(text).toBe("User: Acme is a charity\n\nAssistant: Noted.");
    const big = clientMemoryTranscript(
      Array.from({ length: 200 }, (_, i) => ({ role: "user", content: `${i} ${"x".repeat(1000)}`, created_at: String(i) })),
    );
    expect(big.length).toBeLessThanOrEqual(48_500);
    expect(big).toContain("199 ");
    expect(big).not.toContain("\n\n0 x");
  });
});
