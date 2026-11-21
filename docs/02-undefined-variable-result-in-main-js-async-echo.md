# Bug 02: Undeclared Variable `result` and Broken Promise Flow in `testMyAsyncEcho`

## Severity
**Critical (Guaranteed Runtime `ReferenceError` in Sample Plugin)**

## Scope
**Template Plugin Only (`template/template-plugin/main.js`, `template/template-dev/src/main.js`)** — This bug is **not** in the core C++ SDK (`src/`). It exists only in the sample JavaScript code of the template plugin. The underlying C++ `addon.my_echo_async` function works when called with a valid primitive argument.

## Affected Files
- [`template/template-dev/src/main.js`](../template/template-dev/src/main.js) (lines 46–69)
- [`template/template-plugin/main.js`](../template/template-plugin/main.js) (lines 46–69)

## Problematic Code
```javascript
async function testMyAsyncEcho() {
    try {
        const addon = await require("sample-uxp-addon.uxpaddon");
        return new Promise((resolve, reject) => {
            const value = 10;
            const echoAsyncResult = addon.my_echo_async(value);
            console.log(`my_echo_async returned: echoAsyncResult = `, echoAsyncResult);
            echoAsyncResult
                .then((val) => {
                    console.log(`Promise resolved, echoAsyncResult = `, val);
                    messageDialog(`Promise resolved, echoAsyncResult = ${val}`);

                    resolve(val);
                })
                .catch((error) => {
                    console.log(error);
                    reject(error);
                });
            resolve(result);
        });
    } catch (err) {
        console.log("Execute as testMyAsyncEcho command failed", err);
    }
}
```

## Explanation
There are three compounding bugs in `testMyAsyncEcho()`:

1. **`ReferenceError: result is not defined` (line 64)**:
   At the end of the `new Promise` executor callback, `resolve(result);` is called synchronously. The identifier `result` is not declared anywhere in the file or function scope. Executing this line immediately throws `ReferenceError: result is not defined`.
2. **Premature synchronous resolution inside `Promise` executor**:
   Even if `result` were defined, calling `resolve(...)` synchronously at line 64 settles the outer `Promise` immediately before the asynchronous `echoAsyncResult` promise completes, rendering the `resolve(val)` and `reject(error)` calls inside `.then()` and `.catch()` no-ops.
3. **`return new Promise(...)` without `await` inside `try / catch` (Anti-pattern)**:
   Because `addon.my_echo_async(value)` already returns a `Promise`, wrapping it in `new Promise(...)` is an unnecessary Promise constructor anti-pattern. Furthermore, because `return new Promise(...)` is not `await`ed, the rejection caused by `ReferenceError: result is not defined` inside the Promise executor is **not** caught by `try { ... } catch (err) { ... }` in `testMyAsyncEcho()`, resulting in an unhandled promise rejection.

## How to Reproduce

### JavaScript Reproduction (Direct)
Yes — this is a pure JavaScript bug in `main.js` and triggers every time `testMyAsyncEcho` is invoked:

```javascript
// Either click "Test MyAsyncEcho function" in the Plugins menu, or call testMyAsyncEcho():
await testMyAsyncEcho();
// Immediately throws: Uncaught (in promise) ReferenceError: result is not defined
```

1. Load [`template/template-plugin/manifest.json`](../template/template-plugin/manifest.json) in UXP Developer Tool (UDT) with Photoshop running.
2. Trigger the **"test MyAsyncEcho"** command from the Plugins menu.
3. Observe the UDT Console / debugger.
4. **Expected result**: `testMyAsyncEcho()` awaits `addon.my_echo_async(10)` and resolves with `10` without throwing an error.
5. **Actual result**: The Promise executor immediately throws `ReferenceError: result is not defined` at line 64, and `testMyAsyncEcho()` returns a rejected Promise that bypasses the `catch (err)` block.

## Suggested Fix
Remove the redundant `new Promise` wrapper and `resolve(result);`, and `await` `addon.my_echo_async(value)` directly inside the `async` function:

```javascript
async function testMyAsyncEcho() {
    try {
        const addon = await require("sample-uxp-addon.uxpaddon");
        const value = 10;
        const echoAsyncResult = addon.my_echo_async(value);
        console.log(`my_echo_async returned: echoAsyncResult = `, echoAsyncResult);
        const val = await echoAsyncResult;
        console.log(`Promise resolved, echoAsyncResult = `, val);
        messageDialog(`Promise resolved, echoAsyncResult = ${val}`);
        return val;
    } catch (err) {
        console.log("Execute as testMyAsyncEcho command failed", err);
    }
}
```
