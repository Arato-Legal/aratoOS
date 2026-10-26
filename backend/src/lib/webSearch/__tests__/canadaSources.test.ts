import { describe, expect, it } from "vitest";

import {
    CANADIAN_SOURCES,
    canadianDomains,
    extraCanadianDomains,
    isOfficialCanadianUrl,
    isReadableCanadianUrl,
    isWebSearchSources,
    siteScope,
} from "../canadaSources";

const NO_ENV = {} as NodeJS.ProcessEnv;

describe("official Canadian sources", () => {
    it.each([
        "https://www.canlii.org/en/on/onca/doc/2020/2020onca1/2020onca1.html",
        "https://decisions.scc-csc.ca/scc-csc/scc-csc/en/item/1/index.do",
        "https://laws-lois.justice.gc.ca/eng/acts/c-46/",
        "https://decisions.fct-cf.gc.ca/fc-cf/decisions/en/item/1/index.do",
        "https://www.ontario.ca/laws/statute/90b16",
        "https://www.bclaws.gov.bc.ca/civix/document/id/complete/statreg/00_96253_01",
        "https://www.legisquebec.gouv.qc.ca/en/document/cs/CCQ-1991",
        "https://www.canada.ca/en/revenue-agency.html",
        "https://WWW.Ontariocourts.CA/coa/en/",
    ])("accepts %s", (url) => {
        expect(isOfficialCanadianUrl(url, NO_ENV)).toBe(true);
    });

    it.each([
        // Lookalikes: the domain must be the host or a real parent of it.
        "https://evil-canlii.org/",
        "https://canlii.org.evil.example/",
        "https://example.com/?next=https://www.canlii.org/",
        "https://example.com/canlii.org",
        "https://gc.ca.evil.example/",
        "https://notgc.ca/",
        // Only https, and no credentials in the URL.
        "http://www.canlii.org/",
        "https://user:pass@www.canlii.org/",
        "javascript:alert(1)",
        "ftp://laws-lois.justice.gc.ca/",
        "not a url",
        "",
        // Not Canadian official sources.
        "https://www.legislation.gov.uk/ukpga/2006/46/section/172",
        "https://www.courtlistener.com/",
        "https://en.wikipedia.org/wiki/Supreme_Court_of_Canada",
    ])("rejects %s", (url) => {
        expect(isOfficialCanadianUrl(url, NO_ENV)).toBe(false);
    });

    it("treats a trailing dot on the host as the same host", () => {
        expect(isOfficialCanadianUrl("https://www.canlii.org./en/", NO_ENV)).toBe(true);
    });

    it("lets Mike read official pages but never CanLII's", () => {
        expect(isReadableCanadianUrl("https://laws-lois.justice.gc.ca/eng/acts/c-46/", NO_ENV)).toBe(true);
        expect(isReadableCanadianUrl("https://www.canlii.org/en/ca/scc/", NO_ENV)).toBe(false);
        expect(isReadableCanadianUrl("https://canlii.org/", NO_ENV)).toBe(false);
        expect(isReadableCanadianUrl("https://example.com/", NO_ENV)).toBe(false);
    });

    it("has only well-formed, unique, lower-case domains", () => {
        const domains = CANADIAN_SOURCES.map((s) => s.domain);
        expect(new Set(domains).size).toBe(domains.length);
        for (const d of domains) expect(d).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
        expect(CANADIAN_SOURCES.filter((s) => !s.readable).map((s) => s.domain)).toEqual(["canlii.org"]);
        // Provider search tools accept at most 100 domains.
        expect(canadianDomains(NO_ENV).length).toBeLessThanOrEqual(100);
    });

    it("lists CanLII first so a scoped query keeps it", () => {
        expect(canadianDomains(NO_ENV)[0]).toBe("canlii.org");
    });
});

describe("operator additions", () => {
    it("adds well-formed domains and drops the rest", () => {
        const env = {
            WEB_SEARCH_CANADA_EXTRA_DOMAINS:
                " Example.CA ,https://bad.example, not a domain,,x,law.example.org ",
        } as NodeJS.ProcessEnv;
        expect(extraCanadianDomains(env)).toEqual(["example.ca", "law.example.org"]);
        expect(isOfficialCanadianUrl("https://www.example.ca/a", env)).toBe(true);
        expect(isOfficialCanadianUrl("https://www.example.ca/a", NO_ENV)).toBe(false);
        expect(canadianDomains(env)).toContain("law.example.org");
    });

    it("does not duplicate a domain already listed", () => {
        const env = { WEB_SEARCH_CANADA_EXTRA_DOMAINS: "canlii.org" } as NodeJS.ProcessEnv;
        expect(canadianDomains(env).filter((d) => d === "canlii.org")).toHaveLength(1);
    });
});

describe("siteScope", () => {
    it("joins as many leading domains as fit", () => {
        expect(siteScope(["a.ca", "b.ca", "c.ca"], 1000)).toBe("(site:a.ca OR site:b.ca OR site:c.ca)");
        const scope = siteScope(["a.ca", "b.ca", "c.ca"], 24);
        expect(scope).toBe("(site:a.ca OR site:b.ca)");
        expect(scope.length).toBeLessThanOrEqual(24);
    });

    it("is empty when nothing fits", () => {
        expect(siteScope(["verylongdomain.example.ca"], 10)).toBe("");
        expect(siteScope([], 100)).toBe("");
    });
});

describe("isWebSearchSources", () => {
    it("accepts only the two modes", () => {
        expect(isWebSearchSources("web")).toBe(true);
        expect(isWebSearchSources("canada")).toBe(true);
        expect(isWebSearchSources("anything")).toBe(false);
        expect(isWebSearchSources(undefined)).toBe(false);
    });
});
