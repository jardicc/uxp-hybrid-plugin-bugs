# Bug 19: `messageDialog` Appends `<dialog>` Directly to `document` Instead of `document.body`, Has No Close Action, and Leaks DOM Nodes

## Severity
**Medium (UI Bug / DOM Leak in Sample Plugin)**

## Scope
**Template Plugin Only (`template/template-plugin/main.js`, `template/template-dev/src/main.js`)** — This bug is **not** in the core C++ SDK (`src/`). It exists only in the sample JavaScript helper function `messageDialog()` in the template plugin.

## Affected Files
- [`template/template-dev/src/main.js`](../template/template-dev/src/main.js) (lines 71–78)
- [`template/template-plugin/main.js`](../template/template-plugin/main.js) (lines 71–78)

## Problematic Code
```javascript
function messageDialog(message) {
    let dialog = document.createElement("dialog");
    dialog.style.alignItems = "center";
    dialog.textContent = message;
    dialog.style.fontSize = 20;
    dialog.style.color = "yellow";
    document.appendChild(dialog).showModal();
}
```

## Explanation
1. **`document.appendChild(dialog)` instead of `document.body.appendChild(dialog)`**:
   In HTML DOM, `document` is the root `Document` node, which may only have a single document element (`<html>`, i.e., `document.documentElement`). Visual elements like `<dialog>` belong inside `document.body`.
2. **Invalid CSS unit on `fontSize`**:
   `dialog.style.fontSize = 20;` assigns a unitless number instead of a valid CSS length string such as `"20px"`.
3. **No close button / dismissal handler and DOM node leak**:
   The modal dialog contains only plain `textContent` with no button or event listener to close it (`dialog.close()`), and the `<dialog>` element is never removed from the DOM (`dialog.remove()`) after closing, accumulating orphaned `<dialog>` elements every time a command is run.

## How to Reproduce

### JavaScript Reproduction (Direct)
Yes — this is a pure JavaScript/DOM bug in `main.js` and triggers whenever `messageDialog(...)` is called (for example via `testMyFunction` or `testMyEcho`):

```javascript
// Running testMyFunction() or testMyEcho() in main.js executes:
// document.appendChild(dialog).showModal();
await testMyFunction();
await testMyEcho();
```

1. Load the template plugin in UDT and run **"test MyFunction"** or **"test MyEcho"**.
2. Inspect the DOM tree in UDT's Elements inspector.
3. **Expected result**: `<dialog>` is appended to `document.body` with `"20px"` font size, can be closed by the user, and is removed from the DOM when dismissed.
4. **Actual result**: `<dialog>` is appended directly to `document` (throwing `HierarchyRequestError` in standard DOM engines or attaching outside `<body>`), has no close button, and remains in the DOM indefinitely.

## Suggested Fix
Append the `<dialog>` to `document.body`, specify `"20px"` for `fontSize`, provide a close button or close handler, and remove the element from the DOM when closed:

```javascript
async function messageDialog(message) {
    const dialog = document.createElement("dialog");
    dialog.style.alignItems = "center";
    dialog.style.fontSize = "20px";
    dialog.style.color = "yellow";
    dialog.textContent = message;

    document.body.appendChild(dialog);
    try {
        await dialog.uxpShowModal({ title: "Result" });
    } finally {
        dialog.remove();
    }
}
```
