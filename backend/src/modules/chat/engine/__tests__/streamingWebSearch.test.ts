import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamChatWithTools, runToolCalls, searchWeb } = vi.hoisted(() => ({
  streamChatWithTools: vi.fn(async (_params: StreamChatCall) => ({
    fullText: "",
  })),
  runToolCalls: vi.fn(async (_calls: { function: { name: string } }[]) => ({
    toolResults: [] as { tool_call_id: string; content: string }[],
    docsRead: [],
    docsFound: [],
    docsCreated: [],
    docsReplicated: [],
    workflowsApplied: [],
    docsEdited: [],
    askInputsEvents: [],
    courtlistenerEvents: [],
    caseCitationEvents: [],
    mcpEvents: [],
  })),
  searchWeb: vi.fn(),
}));

vi.mock("../../../../lib/llm", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/llm/models")),
  streamChatWithTools: (params: StreamChatCall) => streamChatWithTools(params),
}));

vi.mock("../../../../lib/mcpConnectors", () => ({
  buildUserMcpTools: vi.fn(async () => []),
}));

vi.mock("../tools/toolDispatcher", () => ({
  runToolCalls: (calls: { function: { name: string } }[]) =>
    runToolCalls(calls),
}));

vi.mock("../../../../lib/webSearch", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../../../lib/webSearch")),
  searchWeb,
}));

import { runLLMStream, sanitizeAssistantSseChunk } from "../streaming";

type StreamChatCall = {
  tools: { function: { name: string } }[];
  runTools?: (
    calls: { id: string; name: string; input: Record<string, unknown> }[],
  ) => Promise<{ tool_use_id: string; content: string }[]>;
  [key: string]: unknown;
};

const BRAVE = "brave" as const;
const PROVIDER = "provider" as const;

function baseParams() {
  return {
    model: "gemini-3.8-flash",
    apiMessages: [{ role: "user", content: "What changed in the act?" }],
    docStore: new Map(),
    docIndex: {},
    userId: "u1",
    db: {} as never,
    write: vi.fn(),
    nonce: "turnnonce",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  streamChatWithTools.mockResolvedValue({ fullText: "" });
  searchWeb.mockReset();
});

describe("runLLMStream web search", () => {
  it.each([
    ["no plan", null, false, false],
    ["the provider's search", PROVIDER, false, true],
    ["Brave Search", BRAVE, true, true],
  ] as const)(
    "with %s, advertises Mike's web_search %s and read_webpage %s",
    async (_, webSearch, search, read) => {
      await runLLMStream({ ...baseParams(), webSearch });

      const names = streamChatWithTools.mock.calls[0]![0].tools.map((t) => t.function.name);
      expect(names.includes("web_search")).toBe(search);
      expect(names.includes("read_webpage")).toBe(read);
    },
  );

  it("answers web calls itself and sends only the rest to the dispatcher", async () => {
    searchWeb.mockResolvedValue([{ url: "https://law.test/act", title: "The Act", snippet: "s" }]);
    let results: { tool_use_id: string; content: string }[] | undefined;
    streamChatWithTools.mockImplementationOnce(async (params) => {
      results = await params.runTools?.([
        { id: "search", name: "web_search", input: { query: "the act" } },
        { id: "doc", name: "read_document", input: { doc_id: "doc-0" } },
      ]);
      return { fullText: "Answer" };
    });

    const result = await runLLMStream({
      ...baseParams(),
      webSearch: "tavily",
      apiKeys: { brave: "brave-key", tavily: "tavily-key" },
    });

    expect(searchWeb).toHaveBeenCalledWith(
      "the act",
      expect.objectContaining({ account: { backend: "tavily", apiKey: "tavily-key" } }),
    );
    expect(runToolCalls.mock.calls[0]![0].map((c) => c.function.name)).toEqual([
      "read_document",
    ]);
    expect(results?.[0]).toMatchObject({ tool_use_id: "search" });
    expect(results?.[0].content).toContain('<untrusted-content nonce="turnnonce">');
    expect(result.events).toContainEqual({
      type: "web_search",
      search_id: "search",
      query: "the act",
      results: [{ url: "https://law.test/act", title: "The Act" }],
    });
  });

  describe("Canadian official sources only", () => {
    const CANADA_MARKER = "CANADIAN OFFICIAL SOURCES ONLY";
    const call = () => streamChatWithTools.mock.calls[0]![0] as StreamChatCall & {
      systemPrompt: string;
      providerWebSearch?: { maxSearches: number; allowedDomains?: string[] } | null;
    };

    it("adds the Canadian research rules to the prompt only in that mode", async () => {
      await runLLMStream({ ...baseParams(), webSearch: "tavily", webSources: "canada" });
      expect(call().systemPrompt).toContain(CANADA_MARKER);
      expect(call().systemPrompt).toContain("CanLII results show a title, link and snippet only");

      streamChatWithTools.mockClear();
      await runLLMStream({ ...baseParams(), webSearch: "tavily" });
      expect(call().systemPrompt).not.toContain(CANADA_MARKER);

      streamChatWithTools.mockClear();
      await runLLMStream({ ...baseParams(), webSearch: null, webSources: "canada" });
      expect(call().systemPrompt).not.toContain(CANADA_MARKER);
    });

    it("tells Mike's search to keep official Canadian sources only", async () => {
      searchWeb.mockResolvedValue([]);
      streamChatWithTools.mockImplementationOnce(async (params) => {
        await params.runTools?.([
          { id: "s", name: "web_search", input: { query: "duty to accommodate" } },
        ]);
        return { fullText: "" };
      });

      await runLLMStream({
        ...baseParams(),
        webSearch: "tavily",
        webSources: "canada",
        apiKeys: { tavily: "k" },
      });

      expect(searchWeb).toHaveBeenCalledWith(
        "duty to accommodate",
        expect.objectContaining({ sources: "canada" }),
      );
    });

    it("limits the provider's own search to the allowed domains", async () => {
      await runLLMStream({ ...baseParams(), webSearch: PROVIDER, webSources: "canada" });
      const domains = call().providerWebSearch?.allowedDomains;
      expect(domains?.[0]).toBe("canlii.org");
      expect(domains).toContain("scc-csc.ca");

      streamChatWithTools.mockClear();
      await runLLMStream({ ...baseParams(), webSearch: PROVIDER });
      expect(call().providerWebSearch).not.toHaveProperty("allowedDomains");
    });

    it("refuses to read a page the user linked that is not an official source", async () => {
      let content = "";
      streamChatWithTools.mockImplementationOnce(async (params) => {
        const [result] = (await params.runTools?.([
          { id: "r", name: "read_webpage", input: { url: "https://example.com/law" } },
        ])) ?? [];
        content = result?.content ?? "";
        return { fullText: "" };
      });

      await runLLMStream({
        ...baseParams(),
        apiMessages: [{ role: "user", content: "Summarise https://example.com/law" }],
        webSearch: PROVIDER,
        webSources: "canada",
      });

      expect(content).toMatch(/not on an official Canadian source/);
    });

    it("refuses to open CanLII even when the user links it", async () => {
      let content = "";
      streamChatWithTools.mockImplementationOnce(async (params) => {
        const [result] = (await params.runTools?.([
          { id: "r", name: "read_webpage", input: { url: "https://www.canlii.org/en/ca/scc/" } },
        ])) ?? [];
        content = result?.content ?? "";
        return { fullText: "" };
      });

      await runLLMStream({
        ...baseParams(),
        apiMessages: [{ role: "user", content: "Read https://www.canlii.org/en/ca/scc/" }],
        webSearch: PROVIDER,
        webSources: "canada",
      });

      expect(content).toMatch(/CanLII's terms do not allow/);
    });
  });

  it("rebuilds a web event's error from its code without the raw message", () => {
    const chunk = sanitizeAssistantSseChunk(
      `data: ${JSON.stringify({
        type: "web_search",
        error: "connect ECONNREFUSED 10.0.0.1:443",
        error_code: "rejected",
      })}\n\n`,
    );

    expect(chunk).toContain("the search service refused the request");
    expect(chunk).not.toContain("ECONNREFUSED");
  });
});
