import { getData, getNowVersion } from '../shared/chrome';
import { MessageType, StorageType } from '../shared/type';
import { appendTagBefore, createHtmlPreviewButtonBox, createPreviewButtonErrorAlert, getHtmlPreview, getPreviewButtonErrorAlert } from '../core/tag-service';
import { runLocalPreview } from '../core/local-preview';

let previewing = false;

const toast = (message: string, isError = false) => {
    const el = document.createElement("div");
    el.textContent = message;
    el.style.cssText = `position:fixed;bottom:20px;right:20px;z-index:99999;max-width:420px;`
        + `padding:10px 16px;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;`
        + `font-size:13px;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25);`
        + `background:${isError ? "#cf222e" : "#1f883d"};`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), isError ? 6000 : 2000);
};

const doPreview = async () => {
    if (previewing) return;
    previewing = true;
    toast("Building preview…");
    try {
        const html = await runLocalPreview();
        console.log("[ghp] built self-contained HTML:", html.length, "bytes");
        // Large payloads travel through storage.local (unlimitedStorage), not the
        // message channel; only the id is messaged to the background.
        const id = `ghp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        await chrome.storage.local.set({ [id]: html });
        const res = await chrome.runtime.sendMessage({ action: MessageType.OPEN_PREVIEW, id });
        console.log("[ghp] background response:", res);
        if (!res || !res.ok) {
            await chrome.storage.local.remove(id);
            toast(res && res.error ? `Could not open preview: ${res.error}` : "Could not open preview (no response from the extension background).", true);
        }
    } catch (e: any) {
        console.error("[ghp] preview failed:", e);
        toast(e && e.message ? e.message : "Failed to build preview.", true);
    } finally {
        previewing = false;
    }
};

// The content script is (re)injected on every SPA navigation; bind the message
// listener only once per page so the keyboard command / context menu fires once.
if (!(window as any).__ghpPreviewBound) {
    (window as any).__ghpPreviewBound = true;
    chrome.runtime.onMessage.addListener((request) => {
        if (request && request.action === MessageType.DO_PREVIEW) doPreview();
    });
}

// Inject the "Preview" button next to GitHub's "Raw" button.
const htmlPreview = getHtmlPreview();
if (!htmlPreview) {
    try {
        const btnGroup = document.querySelector('a[data-testid="raw-button"]')?.parentElement?.parentElement;
        if (btnGroup) {
            for (const aTag of btnGroup.querySelectorAll("div > a")) {
                if (aTag.getAttribute("data-testid") === "raw-button") {
                    appendTagBefore(btnGroup.firstElementChild!, createHtmlPreviewButtonBox(aTag.getAttribute("class")!));
                }
            }
            getHtmlPreview()!.onclick = () => doPreview();
            getPreviewButtonErrorAlert()?.remove();
        }
    } catch (ignore) {}
}

if (location.href.split("/")[5] == "edit") {
    getPreviewButtonErrorAlert()?.remove();
}

const checkPreviewButton = () => {
    setTimeout(() => {
        const url = location.href;
        if (url.startsWith("https://github.com/") && url.endsWith(".html") && url.split("/")[5] == "blob" && !getHtmlPreview() && !getPreviewButtonErrorAlert()) {
            document.body.appendChild(createPreviewButtonErrorAlert());
        }
    }, 1000);
};

(async () => {
    const lastNonActivatedAlertVersion = (await getData([StorageType.LAST_NON_ACTIVATED_ALERT_VERSION]))[StorageType.LAST_NON_ACTIVATED_ALERT_VERSION];
    if (lastNonActivatedAlertVersion) {
        if (lastNonActivatedAlertVersion != getNowVersion()) checkPreviewButton();
    } else {
        checkPreviewButton();
    }
})();
