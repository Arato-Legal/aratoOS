import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "../../../lib/webSearch";
import {
    loadWebSearchSettings,
    saveWebSearchSettings,
    validateWebSearchPayload,
} from "../user.webSearch";

/** A client whose profile read and merge function both resolve to `result`. */
function db(result: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "select", "eq"]) {
        chain[method] = vi.fn(() => chain);
    }
    chain.maybeSingle = vi.fn(async () => result);
    chain.rpc = vi.fn(async () => result);
    return chain as never;
}

const rpcOf = (client: unknown) =>
    (client as { rpc: ReturnType<typeof vi.fn> }).rpc;

const missingFunction = {
    code: "PGRST202",
    message:
        "Could not find the function public.merge_user_web_search(p_patch, p_user_id) in the schema cache",
};

describe("validateWebSearchPayload", () => {
    it("accepts a known field and rejects unknown fields and bad values", () => {
        expect(validateWebSearchPayload({ claude: "brave" })).toEqual({
            ok: true,
            update: { claude: "brave" },
        });
        expect(validateWebSearchPayload({ engine: "google" })).toMatchObject({ ok: false });
        expect(validateWebSearchPayload({ enabled: "true" })).toMatchObject({ ok: false });
        expect(validateWebSearchPayload({ other: "provider" })).toMatchObject({ ok: false });
    });

    it("accepts the two source modes and nothing else", () => {
        expect(validateWebSearchPayload({ sources: "canada" })).toEqual({
            ok: true,
            update: { sources: "canada" },
        });
        expect(validateWebSearchPayload({ sources: "web", enabled: true })).toEqual({
            ok: true,
            update: { enabled: true, sources: "web" },
        });
        expect(validateWebSearchPayload({ sources: "everywhere" })).toMatchObject({
            ok: false,
            detail: "sources must be one of: web, canada",
        });
        expect(validateWebSearchPayload({ sources: true })).toMatchObject({ ok: false });
    });
});

describe("web search settings storage", () => {
    it("reads as the default when nothing is stored, else the stored choices", async () => {
        await expect(
            loadWebSearchSettings(db({ data: null, error: null }), "u"),
        ).resolves.toEqual(DEFAULT_WEB_SEARCH_SETTINGS);
        await expect(
            loadWebSearchSettings(
                db({ data: { web_search: { enabled: true, openai: "off" } }, error: null }),
                "u",
            ),
        ).resolves.toEqual({ ...DEFAULT_WEB_SEARCH_SETTINGS, enabled: true, openai: "off" });
    });

    it("reads the stored source mode, and falls back to the web for an unknown one", async () => {
        await expect(
            loadWebSearchSettings(db({ data: { web_search: { sources: "canada" } }, error: null }), "u"),
        ).resolves.toMatchObject({ sources: "canada" });
        await expect(
            loadWebSearchSettings(db({ data: { web_search: { sources: "mars" } }, error: null }), "u"),
        ).resolves.toMatchObject({ sources: "web" });
    });

    it("stores the Canadian mode, and removes the key when it goes back to the default", async () => {
        const on = db({ data: { sources: "canada" }, error: null });
        await saveWebSearchSettings(on, "u", { sources: "canada" });
        expect(rpcOf(on)).toHaveBeenCalledWith("merge_user_web_search", {
            p_user_id: "u",
            p_patch: { sources: "canada" },
        });
        const off = db({ data: {}, error: null });
        await saveWebSearchSettings(off, "u", { sources: "web" });
        expect(rpcOf(off)).toHaveBeenCalledWith("merge_user_web_search", {
            p_user_id: "u",
            p_patch: { sources: null },
        });
    });

    it("merges only the changed setting and returns the full settings", async () => {
        const client = db({ data: { enabled: true }, error: null });

        await expect(saveWebSearchSettings(client, "user-1", { enabled: true })).resolves.toEqual({
            ok: true,
            data: { ...DEFAULT_WEB_SEARCH_SETTINGS, enabled: true },
        });
        expect(rpcOf(client)).toHaveBeenCalledWith("merge_user_web_search", {
            p_user_id: "user-1",
            p_patch: { enabled: true },
        });
    });

    it("reports a save before the migration as unavailable", async () => {
        await expect(
            saveWebSearchSettings(db({ data: null, error: missingFunction }), "u", {
                enabled: true,
            }),
        ).resolves.toMatchObject({ ok: false, kind: "unavailable" });
    });
});
