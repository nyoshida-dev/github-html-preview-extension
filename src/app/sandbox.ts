// Runs inside the manifest-sandboxed page (opaque origin, no extension CSP).
// Receives the self-contained HTML from the parent preview page and writes it
// into this document, so the previewed page renders and runs its own scripts in
// full isolation. No chrome.* APIs are available here.

window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    if (data && data.type === "render" && typeof data.html === "string") {
        document.open();
        document.write(data.html);
        document.close();
    }
});

// Tell the parent we are ready to receive the payload.
if (window.parent) {
    window.parent.postMessage({ type: "ready" }, "*");
}
