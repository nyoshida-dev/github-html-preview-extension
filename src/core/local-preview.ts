// Builds a fully self-contained HTML document entirely on the client.
//
// This module MUST run in the github.com content-script context: fetches are
// then first-party to github.com, so the user's existing GitHub login cookies
// are sent automatically (no token, no third-party server). Every repo-relative
// asset (CSS / JS / images / fonts) is fetched with the same session and
// inlined, so the resulting document needs no further network access to GitHub
// and can be rendered in an isolated, sandboxed iframe.

const GITHUB_ORIGIN = "https://github.com";

// Resolve the canonical raw URL for the file currently being viewed.
// We deliberately normalise onto github.com/<owner>/<repo>/raw/... rather than
// raw.githubusercontent.com: the github.com path issues a fresh per-file access
// token on every request, which is required for private-repo assets.
export const getRawHtmlUrl = (): string | null => {
    const rawButton = document.querySelector('a[data-testid="raw-button"]') as HTMLAnchorElement | null;
    if (rawButton && rawButton.href) {
        try {
            const u = new URL(rawButton.href, location.href);
            if (u.hostname === "github.com" && u.pathname.includes("/raw/")) {
                return u.origin + u.pathname;
            }
        } catch (ignore) { /* fall through to derivation */ }
    }
    if (location.pathname.includes("/blob/")) {
        return GITHUB_ORIGIN + location.pathname.replace("/blob/", "/raw/");
    }
    return null;
};

// `same-origin` credentials are the key to making this work across the redirect:
//   1. github.com/.../raw/... is same-origin to this content script, so the
//      login cookie IS sent and authorizes private access (issuing a tokenized
//      redirect URL).
//   2. raw.githubusercontent.com is cross-origin, so cookies are omitted there.
//      That makes it a non-credentialed CORS request, so its
//      `Access-Control-Allow-Origin: *` is accepted and the body is readable.
//      Auth on that hop comes from the `?token=` already baked into the URL.
// Using `include` instead would break step 2 (wildcard ACAO + credentials).
const fetchWithSession = (url: string): Promise<Response> =>
    fetch(url, { credentials: "same-origin", redirect: "follow" });

const blobToDataUri = (blob: Blob): Promise<string> =>
    new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });

const isInlineable = (url: string): boolean =>
    !!url
    && !url.startsWith("data:")
    && !url.startsWith("#")
    && !url.startsWith("blob:")
    && !url.startsWith("javascript:")
    && !url.startsWith("mailto:");

const resolveUrl = (ref: string, base: string): string => {
    try { return new URL(ref, base).href; } catch (ignore) { return ref; }
};

// Fetch a binary asset and return it as a data: URI. On any failure the original
// URL is returned unchanged (best-effort degradation).
const toDataUri = async (url: string): Promise<string> => {
    try {
        const res = await fetchWithSession(url);
        if (!res.ok) return url;
        return await blobToDataUri(await res.blob());
    } catch (ignore) { return url; }
};

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
const CSS_IMPORT = /@import\s+(?:url\()?\s*(['"]?)([^'");]+)\1\s*\)?\s*;/g;

// Recursively inline @import targets and url() references inside a stylesheet.
const inlineCss = async (css: string, cssBase: string, depth = 0): Promise<string> => {
    if (depth > 5) return css;

    const imports: { match: string; resolved: string }[] = [];
    let m: RegExpExecArray | null;
    CSS_IMPORT.lastIndex = 0;
    while ((m = CSS_IMPORT.exec(css))) {
        if (isInlineable(m[2])) imports.push({ match: m[0], resolved: resolveUrl(m[2], cssBase) });
    }
    for (const imp of imports) {
        try {
            const res = await fetchWithSession(imp.resolved);
            if (res.ok) {
                const nested = await inlineCss(await res.text(), imp.resolved, depth + 1);
                css = css.split(imp.match).join(nested);
            }
        } catch (ignore) { /* leave the @import as-is */ }
    }

    const refs = new Set<string>();
    CSS_URL.lastIndex = 0;
    while ((m = CSS_URL.exec(css))) {
        if (isInlineable(m[2])) refs.add(m[2]);
    }
    for (const ref of refs) {
        const dataUri = await toDataUri(resolveUrl(ref, cssBase));
        if (dataUri.startsWith("data:")) css = css.split(ref).join(dataUri);
    }
    return css;
};

const inlineStylesheets = (doc: Document, base: string): Promise<void[]> =>
    Promise.all(Array.from(doc.querySelectorAll('link[rel~="stylesheet"][href]')).map(async (el) => {
        const href = el.getAttribute("href")!;
        if (!isInlineable(href)) return;
        try {
            const cssUrl = resolveUrl(href, base);
            const res = await fetchWithSession(cssUrl);
            if (!res.ok) return;
            const style = doc.createElement("style");
            style.textContent = await inlineCss(await res.text(), cssUrl);
            el.replaceWith(style);
        } catch (ignore) { /* leave the <link> as-is */ }
    }));

const inlineStyleBlocks = (doc: Document, base: string): Promise<void[]> =>
    Promise.all(Array.from(doc.querySelectorAll("style")).map(async (el) => {
        const css = el.textContent || "";
        if (!css.includes("url(") && !css.includes("@import")) return;
        el.textContent = await inlineCss(css, base);
    }));

const inlineScripts = (doc: Document, base: string): Promise<void[]> =>
    Promise.all(Array.from(doc.querySelectorAll("script[src]")).map(async (el) => {
        const src = el.getAttribute("src")!;
        if (!isInlineable(src)) return;
        try {
            const res = await fetchWithSession(resolveUrl(src, base));
            if (!res.ok) return;
            const inline = doc.createElement("script");
            const type = el.getAttribute("type");
            if (type) inline.setAttribute("type", type);
            inline.textContent = await res.text();
            el.replaceWith(inline);
        } catch (ignore) { /* leave the <script> as-is */ }
    }));

const inlineMedia = (doc: Document, base: string): Promise<void[]> =>
    Promise.all(Array.from(doc.querySelectorAll("img[src], source[src], video[src], audio[src], image")).map(async (el) => {
        const attr = el.hasAttribute("xlink:href") ? "xlink:href"
            : el.tagName.toLowerCase() === "image" ? "href"
            : "src";
        const ref = el.getAttribute(attr) || "";
        if (!isInlineable(ref)) return;
        const dataUri = await toDataUri(resolveUrl(ref, base));
        if (dataUri.startsWith("data:")) el.setAttribute(attr, dataUri);
    }));

const inlineSrcset = (doc: Document, base: string): Promise<void[]> =>
    Promise.all(Array.from(doc.querySelectorAll("[srcset]")).map(async (el) => {
        const parts = el.getAttribute("srcset")!.split(",").map(p => p.trim()).filter(Boolean);
        const rewritten = await Promise.all(parts.map(async (part) => {
            const segments = part.split(/\s+/);
            const url = segments[0];
            const descriptor = segments.slice(1).join(" ");
            if (!isInlineable(url)) return part;
            const dataUri = await toDataUri(resolveUrl(url, base));
            if (!dataUri.startsWith("data:")) return part;
            return descriptor ? `${dataUri} ${descriptor}` : dataUri;
        }));
        el.setAttribute("srcset", rewritten.join(", "));
    }));

const inlineIcons = (doc: Document, base: string): Promise<void[]> =>
    Promise.all(Array.from(doc.querySelectorAll('link[rel~="icon"][href], link[rel="apple-touch-icon"][href]')).map(async (el) => {
        const href = el.getAttribute("href")!;
        if (!isInlineable(href)) return;
        const dataUri = await toDataUri(resolveUrl(href, base));
        if (dataUri.startsWith("data:")) el.setAttribute("href", dataUri);
    }));

// Fetch the HTML file and inline every repo-relative asset it references.
export const buildSelfContainedHtml = async (rawHtmlUrl: string): Promise<string> => {
    const res = await fetchWithSession(rawHtmlUrl);
    if (!res.ok) {
        throw new Error(`Failed to fetch HTML (HTTP ${res.status}). Make sure you are signed in to GitHub.`);
    }
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");

    // Relative references are resolved against the github.com raw URL so that
    // each asset request gets its own access token (required for private repos).
    const base = rawHtmlUrl;
    doc.querySelectorAll("base").forEach(b => b.remove());

    await inlineStylesheets(doc, base);
    await inlineStyleBlocks(doc, base);
    await inlineScripts(doc, base);
    await inlineMedia(doc, base);
    await inlineSrcset(doc, base);
    await inlineIcons(doc, base);

    return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
};

export const runLocalPreview = async (): Promise<string> => {
    const rawUrl = getRawHtmlUrl();
    if (!rawUrl) throw new Error("Could not determine the raw URL for this page.");
    return buildSelfContainedHtml(rawUrl);
};
