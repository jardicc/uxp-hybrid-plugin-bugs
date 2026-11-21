# Bug 17: Uninitialized `addon_value arg1` in `MyEcho` and `MyAsyncEcho` When Called With Zero Arguments

## Severity
**High (Undefined Behavior / Potential Crash on Missing JS Arguments)**

## Scope
**Template Addon Only (`template/template-dev/src/module.cpp`)** — This bug is **not** in the core SDK (`src/api/` or `src/utilities/`). It exists only in the sample C++ callback implementations (`MyEcho` and `MyAsyncEcho`) in `template/template-dev/src/module.cpp` (and the prebuilt `sample-uxp-addon.uxpaddon` compiled from it), which fail to initialize `addon_value arg1 = nullptr;` or check `if (argc < 1)`.

## Affected Files
- [`template/template-dev/src/module.cpp`](../template/template-dev/src/module.cpp) (lines 36–53, 62–72)

## Problematic Code
```cpp
addon_value MyEcho(addon_env env, addon_callback_info info) {
    try {
        // Allocate space for the first argument
        addon_value arg1;
        size_t argc = 1;
        Check(UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, &arg1, nullptr, nullptr));

        // Convert the first argument to a value that can be retained past the
        // return from this function. This is needed if you want to pass arguments
        // to an asynchronous/deferred task handler
        Value stdValue(env, arg1);

        return stdValue.Convert(env);
    } catch (...) {
        return CreateErrorFromException(env);
    }
}
```
The exact same pattern is repeated in `MyAsyncEcho` at lines 64–71:
```cpp
        // Allocate space for the first argument
        addon_value arg1;
        size_t argc = 1;
        Check(UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, &arg1, nullptr, nullptr));

        Value stdValue(env, arg1);
```

## Explanation
1. `addon_value arg1;` is declared on the stack **without initialization** (it is not initialized to `nullptr`, so it holds indeterminate stack garbage).
2. `uxp_addon_get_cb_info(env, info, &argc, &arg1, nullptr, nullptr)` is called with `argc = 1`.
3. After `uxp_addon_get_cb_info` returns, `argc` is updated to the actual number of arguments passed by the JavaScript caller. Neither `MyEcho` nor `MyAsyncEcho` checks whether `argc >= 1`.
4. If the host's implementation of `uxp_addon_get_cb_info` only writes `min(requested_argc, actual_argc)` elements into `argv` when `actual_argc == 0`, `arg1` remains an **uninitialized garbage pointer** on the stack! Passing that garbage pointer to `Value stdValue(env, arg1)` -> `uxp_addon_typeof(env, arg1, &type)` dereferences arbitrary memory and crashes the host process.

## How to Reproduce

### JavaScript Reproduction (Direct)
Yes — this bug can be triggered directly from JavaScript by calling `addon.my_echo()` or `addon.my_echo_async()` with **zero arguments**:

```javascript
const addon = await require("sample-uxp-addon.uxpaddon");

// Calling with 0 arguments leaves `addon_value arg1;` uninitialized on the C++ stack
// if uxp_addon_get_cb_info only writes `argc` (0) elements into the argv buffer:
addon.my_echo();
await addon.my_echo_async();
```

- **Expected result**: Either `arg1` is safely initialized and `argc < 1` is validated (throwing a descriptive argument error or defaulting to `undefined`), with no risk of reading uninitialized stack memory.
- **Actual result**: `arg1` is uninitialized before `uxp_addon_get_cb_info` and `argc` is never checked afterward, passing uninitialized stack memory into `uxp_addon_typeof(env, arg1, &type)`.

## Suggested Fix
Initialize `addon_value arg1 = nullptr;` and validate `argc` after `uxp_addon_get_cb_info`:

```cpp
        addon_value arg1 = nullptr;
        size_t argc = 1;
        Check(UxpAddonApis.uxp_addon_get_cb_info(env, info, &argc, &arg1, nullptr, nullptr));
        if (argc < 1 || arg1 == nullptr) {
            throw std::invalid_argument("Expected at least 1 argument");
        }
```
