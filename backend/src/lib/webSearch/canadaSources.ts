// "Canadian official sources only" mode for web research: CanLII and the
// official sites of Canada's courts, legislatures and governments.
//
// A page is in scope when its host is one of the domains below or a subdomain
// of one, over https. The list is deliberately short and curated; a domain
// that is not owned by the body it names would let an outside site pass as an
// official source, so each entry must be reviewed before it is added. An
// operator can extend it with WEB_SEARCH_CANADA_EXTRA_DOMAINS.
//
// CanLII is searchable but not readable: its terms limit automated access to
// its own API, so Mike shows a CanLII result's title, link and snippet and
// sends the reader to CanLII for the text, and never fetches its pages.

export type WebSearchSources = "web" | "canada";

export const WEB_SEARCH_SOURCES: readonly WebSearchSources[] = ["web", "canada"];

export const DEFAULT_WEB_SEARCH_SOURCES: WebSearchSources = "web";

export const isWebSearchSources = (value: unknown): value is WebSearchSources =>
    typeof value === "string" && (WEB_SEARCH_SOURCES as readonly string[]).includes(value);

export type CanadianSource = {
    domain: string;
    label: string;
    /** False when Mike must not fetch the site's pages itself. */
    readable: boolean;
};

// Ordered by usefulness for legal research: a search service that scopes a
// query by site takes the first few.
export const CANADIAN_SOURCES: readonly CanadianSource[] = [
    { domain: "canlii.org", label: "CanLII", readable: false },
    { domain: "scc-csc.ca", label: "Supreme Court of Canada", readable: true },
    { domain: "laws-lois.justice.gc.ca", label: "Justice Laws Website (federal)", readable: true },
    { domain: "gc.ca", label: "Government of Canada (federal courts, tribunals and departments)", readable: true },
    { domain: "canada.ca", label: "Government of Canada", readable: true },
    { domain: "ourcommons.ca", label: "House of Commons", readable: true },
    { domain: "sencanada.ca", label: "Senate of Canada", readable: true },
    { domain: "parl.ca", label: "Parliament of Canada", readable: true },
    { domain: "ontario.ca", label: "Government of Ontario (including e-Laws)", readable: true },
    { domain: "ontariocourts.ca", label: "Ontario Courts", readable: true },
    { domain: "tribunalsontario.ca", label: "Tribunals Ontario", readable: true },
    { domain: "ola.org", label: "Legislative Assembly of Ontario", readable: true },
    { domain: "gov.bc.ca", label: "Government of British Columbia (including BC Laws)", readable: true },
    { domain: "bccourts.ca", label: "BC Courts", readable: true },
    { domain: "alberta.ca", label: "Government of Alberta (including King's Printer)", readable: true },
    { domain: "albertacourts.ca", label: "Alberta Courts", readable: true },
    { domain: "assembly.ab.ca", label: "Legislative Assembly of Alberta", readable: true },
    { domain: "saskatchewan.ca", label: "Government of Saskatchewan", readable: true },
    { domain: "sasklawcourts.ca", label: "Saskatchewan Courts", readable: true },
    { domain: "gov.mb.ca", label: "Government of Manitoba", readable: true },
    { domain: "manitobacourts.mb.ca", label: "Manitoba Courts", readable: true },
    { domain: "quebec.ca", label: "Gouvernement du Québec", readable: true },
    { domain: "gouv.qc.ca", label: "Québec government (including LégisQuébec)", readable: true },
    { domain: "tribunaux.qc.ca", label: "Tribunaux du Québec", readable: true },
    { domain: "assnat.qc.ca", label: "Assemblée nationale du Québec", readable: true },
    { domain: "gnb.ca", label: "Government of New Brunswick", readable: true },
    { domain: "courtsnb-coursnb.ca", label: "New Brunswick Courts", readable: true },
    { domain: "novascotia.ca", label: "Government of Nova Scotia", readable: true },
    { domain: "courts.ns.ca", label: "Nova Scotia Courts", readable: true },
    { domain: "nslegislature.ca", label: "Nova Scotia Legislature", readable: true },
    { domain: "princeedwardisland.ca", label: "Government of Prince Edward Island", readable: true },
    { domain: "courts.pe.ca", label: "PEI Courts", readable: true },
    { domain: "gov.nl.ca", label: "Government of Newfoundland and Labrador", readable: true },
    { domain: "court.nl.ca", label: "Newfoundland and Labrador Courts", readable: true },
    { domain: "assembly.nl.ca", label: "House of Assembly of Newfoundland and Labrador", readable: true },
    { domain: "yukon.ca", label: "Government of Yukon", readable: true },
    { domain: "yukoncourts.ca", label: "Yukon Courts", readable: true },
    { domain: "gov.nt.ca", label: "Government of the Northwest Territories", readable: true },
    { domain: "nwtcourts.ca", label: "NWT Courts", readable: true },
    { domain: "gov.nu.ca", label: "Government of Nunavut", readable: true },
    { domain: "nucj.ca", label: "Nunavut Court of Justice", readable: true },
];

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** Operator additions, from a comma-separated list; malformed entries are dropped. */
export function extraCanadianDomains(
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    return (env.WEB_SEARCH_CANADA_EXTRA_DOMAINS ?? "")
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter((d) => DOMAIN_RE.test(d));
}

/** Every in-scope domain: the curated list, then the operator's. */
export function canadianDomains(env: NodeJS.ProcessEnv = process.env): string[] {
    return [...new Set([...CANADIAN_SOURCES.map((s) => s.domain), ...extraCanadianDomains(env)])];
}

function hostMatches(host: string, domain: string): boolean {
    return host === domain || host.endsWith(`.${domain}`);
}

function parseHttps(raw: string): URL | null {
    try {
        const url = new URL(raw);
        return url.protocol === "https:" && !url.username && !url.password ? url : null;
    } catch {
        return null;
    }
}

/** Whether a URL is on an official Canadian source (CanLII included). */
export function isOfficialCanadianUrl(
    raw: string,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    const url = parseHttps(raw);
    if (!url) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return canadianDomains(env).some((domain) => hostMatches(host, domain));
}

/** Whether Mike may fetch the page itself: official, and not CanLII. */
export function isReadableCanadianUrl(
    raw: string,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    if (!isOfficialCanadianUrl(raw, env)) return false;
    const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
    return !CANADIAN_SOURCES.some((s) => !s.readable && hostMatches(host, s.domain));
}

/**
 * `(site:a OR site:b …)` for as many leading domains as fit in `maxChars`, for
 * search services that scope a query by site. Empty when none fit.
 */
export function siteScope(domains: readonly string[], maxChars: number): string {
    const terms: string[] = [];
    let length = 2; // the parentheses
    for (const domain of domains) {
        const term = `site:${domain}`;
        const added = term.length + (terms.length ? 4 : 0); // " OR "
        if (length + added > maxChars) break;
        terms.push(term);
        length += added;
    }
    return terms.length ? `(${terms.join(" OR ")})` : "";
}

export const CANADA_SOURCES_PROMPT = `CANADIAN OFFICIAL SOURCES ONLY:
Web search is limited to CanLII and the official websites of Canadian courts, legislatures and governments (federal, provincial and territorial). Results from any other site are removed.
- Cite Canadian cases by neutral citation where one exists (for example 2024 SCC 12) and legislation by statute and section, each with a markdown link to the official page.
- CanLII results show a title, link and snippet only: read_webpage does not open CanLII, because CanLII's terms do not allow automated access. Say what the snippet shows, give the link, and tell the user to open the case on CanLII to confirm the text. Never state what a CanLII page says beyond its snippet.
- An official copy of a statute or decision is the authority; a snippet is not. Online legislation can be an unofficial or out-of-date consolidation, so name the version date when the page gives one and tell the user to confirm currency before relying on it.
- If the official sources do not answer the question, say so. Do not fill the gap from memory or from non-Canadian law, and do not search for the user's client names or facts.`;
