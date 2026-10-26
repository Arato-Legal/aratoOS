import { describe, expect, it, vi } from "vitest";

import { createWebSearch } from "../search";

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });

const BRAVE_RESULTS = {
    web: {
        results: [
            {
                url: "https://www.legislation.gov.uk/ukpga/2006/46/section/172",
                title: "Companies Act 2006, s 172 &amp; s 174",
                description: "Duty to promote the &quot;success&quot; of the company.",
                extra_snippets: ["A director&#x27;s duty..."],
            },
            { url: "javascript:alert(1)", title: "Not a page" },
        ],
    },
};

const brave = { account: { backend: "brave", apiKey: "brave-key" } } as const;

function harness(responses: Response[]) {
    const fetch = vi.fn(async (_url: unknown, _init?: unknown) => responses.shift()!);
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
    const search = createWebSearch({ fetch: fetch as never, now: () => 1_000_000, sleep });
    return { search, fetch, sleep };
}

describe("Mike's web search", () => {
    it("needs a key", async () => {
        const { search, fetch } = harness([]);

        await expect(search("s172", { account: null })).rejects.toMatchObject({
            code: "not_configured",
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("searches Brave with its key, keeps only web pages and decodes entities", async () => {
        const { search, fetch } = harness([json(BRAVE_RESULTS)]);

        const results = await search("directors duties s172", brave);

        expect(results).toEqual([
            {
                url: "https://www.legislation.gov.uk/ukpga/2006/46/section/172",
                title: "Companies Act 2006, s 172 & s 174",
                snippet:
                    "Duty to promote the \"success\" of the company. … A director's duty...",
            },
        ]);
        const [url, init] = fetch.mock.calls[0] as [URL, RequestInit];
        expect(String(url)).toContain("https://api.search.brave.com/res/v1/web/search");
        expect(url.searchParams.get("q")).toBe("directors duties s172");
        expect(init.headers).toMatchObject({ "x-subscription-token": "brave-key" });
        expect(init.redirect).toBe("manual");
    });

    it.each([
        ["tavily", { results: [{ url: "https://law.test/a", title: "Act A", content: "About A." }] }],
        [
            "deepseek",
            {
                results: [
                    { url: "https://law.test/a", title: "Act A", snippet: "A.", summary: "About A." },
                ],
            },
        ],
    ] as const)("searches %s with a bearer key", async (backend, body) => {
        const { search, fetch } = harness([json(body)]);

        const results = await search("act a", { account: { backend, apiKey: "key" } });

        expect(results).toEqual([
            { url: "https://law.test/a", title: "Act A", snippet: "About A." },
        ]);
        const [, init] = fetch.mock.calls[0] as [string, RequestInit];
        expect(init.headers).toMatchObject({ authorization: "Bearer key" });
        expect(JSON.parse(String(init.body))).toMatchObject({ query: "act a" });
    });

    it.each([
        ["brave", 401, "rejected"],
        ["brave", 422, "rejected"],
        ["brave", 429, "failed"],
        ["tavily", 432, "rejected"],
        ["deepseek", 402, "rejected"],
    ] as const)("reports %s HTTP %s as %s", async (backend, status, code) => {
        const { search } = harness([json({}, status)]);

        await expect(
            search("q", { account: { backend, apiKey: "key" } }),
        ).rejects.toMatchObject({ code });
    });

    it("spaces out parallel requests made with the same key", async () => {
        const { search, fetch, sleep } = harness([
            json(BRAVE_RESULTS),
            json(BRAVE_RESULTS),
        ]);
        const signal = new AbortController().signal;

        await Promise.all([
            search("one", brave),
            search("two", { ...brave, signal }),
        ]);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledOnce();
        expect(sleep).toHaveBeenCalledWith(1_100, signal);
    });
});

describe("Canadian official sources only", () => {
    const MIXED = {
        web: {
            results: [
                { url: "https://www.canlii.org/en/on/onca/doc/2020/2020onca1/2020onca1.html", title: "R v X", description: "CanLII." },
                { url: "https://www.legislation.gov.uk/ukpga/2006/46/section/172", title: "UK Act", description: "Not Canadian." },
                { url: "https://canlii.org.evil.example/", title: "Lookalike", description: "Spoof." },
                { url: "http://laws-lois.justice.gc.ca/eng/acts/c-46/", title: "Insecure", description: "http." },
                { url: "https://laws-lois.justice.gc.ca/eng/acts/c-46/", title: "Criminal Code", description: "Official." },
            ],
        },
    };

    it("drops every result that is not on an official Canadian source", async () => {
        const { search } = harness([json(MIXED)]);

        const results = await search("criminal code", { ...brave, sources: "canada" });

        expect(results.map((r) => r.title)).toEqual(["R v X", "Criminal Code"]);
    });

    it("leaves results alone in the default mode", async () => {
        const { search } = harness([json(MIXED)]);

        expect(await search("criminal code", brave)).toHaveLength(5);
        const { search: web } = harness([json(MIXED)]);
        expect(await web("criminal code", { ...brave, sources: "web" })).toHaveLength(5);
    });

    it("scopes a Brave query by site within the query limit", async () => {
        const { search, fetch } = harness([json(MIXED)]);

        await search("duty to accommodate", { ...brave, sources: "canada" });

        const [url] = fetch.mock.calls[0] as [URL];
        const q = url.searchParams.get("q")!;
        expect(q.startsWith("duty to accommodate (site:canlii.org OR site:scc-csc.ca")).toBe(true);
        expect(q.length).toBeLessThanOrEqual(400);
    });

    it("keeps a long Brave query and its site scope within the limit", async () => {
        const { search, fetch } = harness([json(MIXED)]);

        await search("x".repeat(900), { ...brave, sources: "canada" });

        const [url] = fetch.mock.calls[0] as [URL];
        const q = url.searchParams.get("q")!;
        expect(q.length).toBeLessThanOrEqual(400);
        expect(q).toContain("(site:canlii.org");
        expect(q.endsWith(")")).toBe(true);
    });

    it("asks Tavily to include only the official domains", async () => {
        const { search, fetch } = harness([
            json({ results: [{ url: "https://laws-lois.justice.gc.ca/eng/acts/c-46/", title: "Code", content: "x" }] }),
        ]);

        await search("criminal code", {
            account: { backend: "tavily", apiKey: "k" },
            sources: "canada",
        });

        const [, init] = fetch.mock.calls[0] as [unknown, RequestInit];
        const body = JSON.parse(String(init.body));
        expect(body.include_domains[0]).toBe("canlii.org");
        expect(body.include_domains).toContain("laws-lois.justice.gc.ca");
    });

    it("does not scope Tavily in the default mode", async () => {
        const { search, fetch } = harness([json({ results: [] })]);

        await search("q", { account: { backend: "tavily", apiKey: "k" } });

        const [, init] = fetch.mock.calls[0] as [unknown, RequestInit];
        expect(JSON.parse(String(init.body))).not.toHaveProperty("include_domains");
    });

    it("filters DeepSeek's results too, since it cannot scope a query", async () => {
        const { search } = harness([
            json({ results: [
                { url: "https://www.canlii.org/en/ca/scc/", title: "SCC", summary: "s" },
                { url: "https://example.com/", title: "Other", summary: "o" },
            ] }),
        ]);

        const results = await search("q", { account: { backend: "deepseek", apiKey: "k" }, sources: "canada" });

        expect(results.map((r) => r.title)).toEqual(["SCC"]);
    });
});
