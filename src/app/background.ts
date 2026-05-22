import { MessageType } from '../shared/type';

const PREVIEW_PAGE = 'preview/preview.html';
const TAB_MAP_PREFIX = '__ghptab_'; // maps a preview tab id -> its storage key
const PREVIEW_PREFIX = 'ghp_';      // self-contained HTML payloads

const isPreviewablePage = (url?: string): boolean =>
    !!url
    && url.startsWith("https://github.com/")
    && url.split("?")[0].endsWith(".html")
    && url.split("/")[5] === "blob";

// Remove any preview payloads / tab mappings left over from a previous session.
const sweepStalePreviews = async () => {
    const all = await chrome.storage.local.get(null);
    const stale = Object.keys(all).filter(k => k.startsWith(PREVIEW_PREFIX) || k.startsWith(TAB_MAP_PREFIX));
    if (stale.length) await chrome.storage.local.remove(stale);
};

chrome.runtime.onStartup.addListener(sweepStalePreviews);

// (Re)inject the content script as the user navigates GitHub's SPA, and clean up
// the injected button when leaving an HTML file page.
chrome.tabs.onUpdated.addListener((tabId, _changeInfo, tab) => {
    const url = tab.url;
    if (!url) return;
    if (url.startsWith("https://github.com/") && url.split("?")[0].endsWith(".html")) {
        chrome.scripting.executeScript({ target: { tabId }, files: ["html-page-content.js"] }).catch(() => {});
    } else if (url.startsWith("https://github.com/")) {
        chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                document.getElementById("html-preview")?.parentElement?.remove();
                document.getElementById("preview-button-error-alert")?.remove();
            }
        }).catch(() => {});
    }
});

// Delete a preview's stored HTML once its tab is closed.
chrome.tabs.onRemoved.addListener(async (tabId) => {
    const mapKey = `${TAB_MAP_PREFIX}${tabId}`;
    const data = await chrome.storage.local.get(mapKey);
    const previewId = data[mapKey];
    if (typeof previewId === "string") await chrome.storage.local.remove([previewId, mapKey]);
});

chrome.runtime.onInstalled.addListener(() => {
    sweepStalePreviews();
    chrome.contextMenus.create({
        id: "preview",
        title: "Preview HTML",
        contexts: ["all"],
        documentUrlPatterns: ["https://github.com/**.html"]
    });
});

// The keyboard command and context menu both ask the content script to build the
// preview, because the fetch must run first-party (with the GitHub login cookie).
chrome.contextMenus.onClicked.addListener((_info, tab) => {
    if (tab && tab.id != null) chrome.tabs.sendMessage(tab.id, { action: MessageType.DO_PREVIEW });
});

chrome.commands.onCommand.addListener(async (command) => {
    if (command !== "preview") return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null && isPreviewablePage(tab.url)) {
        chrome.tabs.sendMessage(tab.id, { action: MessageType.DO_PREVIEW });
    }
});

// The content script has already written the (possibly large) self-contained
// HTML to storage.local under `id`; we only receive the id and open the isolated
// preview tab to render it.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request && request.action === MessageType.OPEN_PREVIEW && typeof request.id === "string") {
        (async () => {
            try {
                const opener = sender.tab;
                const tab = await chrome.tabs.create({
                    url: chrome.runtime.getURL(`${PREVIEW_PAGE}?id=${request.id}`),
                    ...(opener ? { index: opener.index + 1, openerTabId: opener.id } : {})
                });
                // Remember which payload belongs to this tab so we can clean it up
                // when the tab is closed.
                if (tab.id != null) await chrome.storage.local.set({ [`${TAB_MAP_PREFIX}${tab.id}`]: request.id });
                sendResponse({ ok: true });
            } catch (e) {
                console.error("[ghp] open preview failed:", e);
                sendResponse({ ok: false, error: String(e) });
            }
        })();
        return true; // keep the message channel open for the async response
    }
    return undefined;
});
