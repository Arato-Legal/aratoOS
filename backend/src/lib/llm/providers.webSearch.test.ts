import { beforeEach, describe, expect, it, vi } from "vitest";

const { streamAiSdk } = vi.hoisted(() => ({ streamAiSdk: vi.fn() }));

vi.mock("./aiSdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./aiSdk")>()),
  streamAiSdk,
}));

import type { AiSdkAdapterConfig } from "./aiSdk";
import { streamWithProvider } from "./providers";
import type { StreamChatParams } from "./types";

const params = (overrides: Partial<StreamChatParams> = {}): StreamChatParams => ({
  model: "claude-opus-5-5",
  systemPrompt: "S",
  messages: [{ role: "user", content: "What changed?" }],
  apiKeys: { claude: "user-key" },
  providerWebSearch: { maxSearches: 5 },
  ...overrides,
});

const adapterOf = (index: number) =>
  streamAiSdk.mock.calls[index][1] as AiSdkAdapterConfig;
const paramsOf = (index: number) =>
  streamAiSdk.mock.calls[index][0] as StreamChatParams;

beforeEach(() => {
  streamAiSdk.mockReset();
});

describe("streamWithProvider with provider web search", () => {
  it("gives Claude Anthropic's search tool with the turn's limit", async () => {
    streamAiSdk.mockResolvedValue({ fullText: "ok" });

    await streamWithProvider(params());

    expect(adapterOf(0).webSearchTool?.({ maxUses: 3 })).toMatchObject({
      id: "anthropic.web_search_20250305",
      args: { maxUses: 3 },
    });
  });

  it("limits Claude's search to the allowed domains, and leaves it open otherwise", async () => {
    streamAiSdk.mockResolvedValue({ fullText: "ok" });

    await streamWithProvider(params());

    const tool = adapterOf(0).webSearchTool!;
    expect(tool({ maxUses: 3, allowedDomains: ["canlii.org", "gc.ca"] })).toMatchObject({
      args: { maxUses: 3, allowedDomains: ["canlii.org", "gc.ca"] },
    });
    expect(tool({ maxUses: 3, allowedDomains: [] }).args).not.toHaveProperty("allowedDomains");
    expect(tool({ maxUses: 3 }).args).not.toHaveProperty("allowedDomains");
  });

  it("limits OpenAI's search to the allowed domains, and leaves it open otherwise", async () => {
    streamAiSdk.mockResolvedValue({ fullText: "ok" });

    await streamWithProvider(
      params({ model: "gpt-5.5", apiKeys: { openai: "user-key" } }),
    );

    const tool = adapterOf(0).webSearchTool!;
    expect(tool({ maxUses: 3, allowedDomains: ["canlii.org"] }).args).toMatchObject({
      filters: { allowedDomains: ["canlii.org"] },
    });
    expect(tool({ maxUses: 3 }).args).not.toHaveProperty("filters");
  });

  it("runs the turn again without search, once, and says search was unavailable", async () => {
    streamAiSdk
      .mockRejectedValueOnce(
        Object.assign(new Error("Bad Request"), {
          statusCode: 400,
          responseBody: '{"error":{"message":"web_search is not enabled for this organization"}}',
        }),
      )
      .mockResolvedValueOnce({ fullText: "Answered without the web." });
    const onWebSearch = vi.fn();

    const result = await streamWithProvider(params({ callbacks: { onWebSearch } }));

    expect(result.fullText).toBe("Answered without the web.");
    expect(streamAiSdk).toHaveBeenCalledTimes(2);
    expect(paramsOf(1).providerWebSearch).toBeNull();
    expect(paramsOf(1).systemPrompt).toContain("Web search is unavailable");
    expect(onWebSearch).toHaveBeenCalledExactlyOnceWith({ kind: "unavailable" });
  });

  it("does not retry once the turn has streamed output", async () => {
    streamAiSdk.mockImplementationOnce(async (sent: StreamChatParams) => {
      sent.callbacks?.onContentDelta?.("Partial answer");
      throw new Error("web_search failed mid-stream");
    });

    await expect(
      streamWithProvider(params({ callbacks: { onContentDelta: vi.fn() } })),
    ).rejects.toThrow("web_search failed mid-stream");
    expect(streamAiSdk).toHaveBeenCalledTimes(1);
  });
});
