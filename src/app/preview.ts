// Privileged extension page: reads the self-contained HTML that the content
// script stashed in storage.local and hands it to the sandboxed renderer iframe
// via postMessage (no size limit, unlike a data: URL). The sandboxed page runs
// the HTML in an opaque origin, exempt from this page's CSP.

const id = new URLSearchParams(location.search).get("id");
const frame = document.getElementById("frame") as HTMLIFrameElement;

const showMessage = (text: string) => {
    frame.remove();
    const p = document.createElement("p");
    p.id = "message";
    p.textContent = text;
    document.body.appendChild(p);
};

let html: string | null = null;
let frameReady = false;

const tryRender = () => {
    if (frameReady && html !== null && frame.contentWindow) {
        frame.contentWindow.postMessage({ type: "render", html }, "*");
    }
};

// The sandbox iframe announces readiness once its script has loaded.
window.addEventListener("message", (event) => {
    if (event.source === frame.contentWindow && event.data && event.data.type === "ready") {
        frameReady = true;
        tryRender();
    }
});

if (!id) {
    showMessage("No preview id was provided.");
} else {
    // Note: we deliberately do NOT delete the entry here, so reloading this tab
    // still works. The background cleans it up when the preview tab is closed
    // (and sweeps any leftovers on browser startup).
    chrome.storage.local.get(id, (data) => {
        const value = data[id];
        if (typeof value === "string") {
            html = value;
            tryRender();
        } else {
            showMessage("Preview data not found (it may have already been opened).");
        }
    });
}
