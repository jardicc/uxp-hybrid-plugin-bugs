# Bug 21: Broken Code Examples, Missing `await` on `require()`, and Threading Contradiction in `README.md`

## Severity
**Medium (Documentation Bugs That Produce Non-Compiling C++ and Failing JS Code)**

## Scope
**SDK Documentation Only (`README.md`)** — This bug is in the root `README.md` documentation examples and architectural description, not in the compiled SDK headers or sample binary. However, developers who copy-paste the `README.md` snippets into their own plugins will immediately hit runtime `TypeError`s in JS and compile errors in C++.

## Affected Files
- Original SDK `README.md` (lines 43, 108–111, 170–221) — since replaced by the bug-focused root [`README.md`](../README.md); line numbers refer to the file as of commit `dc21035` (`git show dc21035:README.md`)
- [`template/template-dev/src/module.cpp`](../template/template-dev/src/module.cpp) (lines 117–119)

## Problematic Code
1. Missing `await` on `require()` in `README.md` (lines 43 and 108–111):
```javascript
const addon = require("sample-uxp-addon.uxpaddon");
let functionResult = addon.first_function();
```

2. Broken C++ async example in `README.md` (lines 178–221):
```cpp
/// Native function invoked from JavaScript:
addon_value MyAsyncEcho(addon_env env, addon_callback_info info) {
    // extract arguments.
    addon_value = ...;

    // Values of type addon_value are transient and cannot be used past
    // returning from MyAsyncEcho
    // We therefore have to convert to standard types
    std::string myArg = ExtractString((env, addon_value);

    // Create a deferred value for the result. This will present as a promise in
    // JavaScript
    addon_deferred promiseValue = nullptr;
    addon_value deferred = nullptr;
    apis.uxp_addon_create_promise(env, &deferred, &promiseValue);

   // Schedule an operation on the main thread.
   // Make sure to store the env and the addon_deferred value in task
   // specific storage
   apis.uxp_addon_schedule_on_main_queue(env, MainThreadTask, ...);
   return deferred;
}
...
// Script Thread function
void ScriptThreadTask(...) {
    // Open a script result scope
    apis.uxp_addon_open_handle_scope(env, &scope);

    // resolve or reject the JavaScript promise
    addon_value resultValue = nullptr;
    apis.uxp_addon_resolve_deferred(env, deferred, resultValue);
    uxp_addon_close_handle_scope(env, scope);
}
```

3. Threading contradiction between `README.md` (line 170) and `module.cpp` (line 118):
- `README.md` line 170:
  > *"Initialization and termination routines are invoked on the host application's main thread... JavaScript handles (`addon_env`, `addon_value`, promises, handle scopes) are **only valid on the JavaScript scripting thread**. The main thread must not use them directly"*
- `module.cpp` lines 117–119:
  ```cpp
  /* Method invoked when the addon module is being requested by JavaScript
   * This method is invoked on the JavaScript thread.
   */
  addon_value Init(addon_env env, addon_value exports, const addon_apis& addonAPIs)
  ```

## Explanation
1. **Missing `await` before `require("*.uxpaddon")`**:
   In UXP, loading a `.uxpaddon` native module via `require()` is asynchronous and returns a `Promise` (as seen in `main.js` line 26: `const addon = await require("sample-uxp-addon.uxpaddon");`). Calling `const addon = require("sample-uxp-addon.uxpaddon"); addon.first_function();` without `await` fails at runtime with `TypeError: addon.first_function is not a function` because `addon` is a `Promise`.
2. **Swapped types for `deferred` and `promiseValue` in `uxp_addon_create_promise`**:
   The signature of `uxp_addon_create_promise` in [`UxpAddonShared.h`](../src/api/UxpAddonShared.h) is:
   ```cpp
   addon_status (*uxp_addon_create_promise)(addon_env env, addon_deferred* deferred, addon_value* promise);
   ```
   In `README.md`, `promiseValue` is declared as `addon_deferred` and `deferred` is declared as `addon_value`, and then passed as `apis.uxp_addon_create_promise(env, &deferred, &promiseValue);`! The types are inverted (`addon_value*` passed where `addon_deferred*` is required, and vice versa), which does not compile.
3. **Additional syntax errors in the `README.md` C++ snippet**:
   - `addon_value = ...;` uses the type name `addon_value` as a variable name.
   - `std::string myArg = ExtractString((env, addon_value);` has an unmatched opening parenthesis `((` and passes the type name `addon_value`.
   - `uxp_addon_close_handle_scope(env, scope);` on line 218 is missing the `apis.` struct prefix.
   - `ScriptThreadTask` passes `resultValue = nullptr` to `uxp_addon_resolve_deferred` without initializing `resultValue` to a valid `addon_value`.
4. **Contradictory documentation on which thread calls `Init`**:
   `README.md` states that initialization and termination routines are invoked on the **main thread** and that `addon_env` / `addon_value` must never be used on the main thread. Yet `Init` in `module.cpp` states it is invoked on the **JavaScript thread** and directly manipulates `addon_env` and `exports` (`addon_value`), and `UXP_ADDON_TERMINATE` calls `uxp_addon_throw_error(env, ...)` during termination.

## How to Reproduce

### JavaScript Reproduction (Direct — Broken `require()` Example in `README.md`)
Yes — executing the JavaScript example from `README.md` (lines 43 and 108–111) directly in a UXP plugin fails immediately at runtime:

```javascript
// From README.md (missing `await` before `require`):
const addon = require("sample-uxp-addon.uxpaddon");
let functionResult = addon.my_function();
// Throws: TypeError: addon.my_function is not a function (because `addon` is a Promise!)
```

### C++ Reproduction (Broken C++ Async Example in `README.md`)
Copy the `uxp_addon_create_promise` lines from `README.md` lines 189–191 into `module.cpp` and compile:
```cpp
addon_deferred promiseValue = nullptr;
addon_value deferred = nullptr;
UxpAddonApis.uxp_addon_create_promise(env, &deferred, &promiseValue);
```
- **Actual result**: Compiler error: cannot convert `addon_value*` to `addon_deferred*`.

## Suggested Fix
1. Update the JavaScript examples in `README.md` to use `const addon = await require("sample-uxp-addon.uxpaddon");`.
2. Fix the C++ pseudo-code in `README.md`:
   ```cpp
   addon_deferred deferred = nullptr;
   addon_value promise = nullptr;
   apis.uxp_addon_create_promise(env, &deferred, &promise);
   ...
   return promise;
   ```
3. Reconcile the threading documentation in `README.md` with `module.cpp` and `UXP_ADDON_TERMINATE`.
