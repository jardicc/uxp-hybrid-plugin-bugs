# Bug 18: `Init` in `module.cpp` Continues Execution After Throwing Errors and Reuses Stale `fn` Pointer

## Severity
**Medium (Cascading API Calls While JS Exception Is Pending & Wrong Error Reported)**

## Scope
**Template Addon Only (`template/template-dev/src/module.cpp`)** — This bug is **not** in the core SDK (`src/`). It exists only in the sample `Init()` function in `template/template-dev/src/module.cpp`.

## Affected Files
- [`template/template-dev/src/module.cpp`](../template/template-dev/src/module.cpp) (lines 117–160)

## Problematic Code
```cpp
addon_value Init(addon_env env, addon_value exports, const addon_apis& addonAPIs) {
    addon_status status = addon_ok;
    addon_value fn = nullptr;

    // MyFunction
    {
        status = addonAPIs.uxp_addon_create_function(env, NULL, 0, MyFunction, NULL, &fn);
        if (status != addon_ok) {
            addonAPIs.uxp_addon_throw_error(env, NULL, "Unable to wrap native function");
        }

        status = addonAPIs.uxp_addon_set_named_property(env, exports, "my_function", fn);
        if (status != addon_ok) {
            addonAPIs.uxp_addon_throw_error(env, NULL, "Unable to populate exports");
        }
    }

    // MyEcho
    {
        status = addonAPIs.uxp_addon_create_function(env, NULL, 0, MyEcho, NULL, &fn);
        if (status != addon_ok) {
            addonAPIs.uxp_addon_throw_error(env, NULL, "Unable to wrap native function");
        }

        status = addonAPIs.uxp_addon_set_named_property(env, exports, "my_echo", fn);
        if (status != addon_ok) {
            addonAPIs.uxp_addon_throw_error(env, NULL, "Unable to populate exports");
        }
    }

    // MyAsyncEcho
    {
        status = addonAPIs.uxp_addon_create_function(env, NULL, 0, MyAsyncEcho, NULL, &fn);
        if (status != addon_ok) {
            addonAPIs.uxp_addon_throw_error(env, NULL, "Unable to wrap native function");
        }

        status = addonAPIs.uxp_addon_set_named_property(env, exports, "my_echo_async", fn);
        if (status != addon_ok) {
            addonAPIs.uxp_addon_throw_error(env, NULL, "Unable to populate exports");
        }
    }
    return exports;
}
```

## Explanation
1. **No early `return nullptr;` after `uxp_addon_throw_error`**:
   If `uxp_addon_create_function` fails (`status != addon_ok`), `Init` calls `uxp_addon_throw_error(env, NULL, "Unable to wrap native function")`, which sets a pending exception on `env`.
   Instead of returning `nullptr` immediately, `Init` proceeds to call `uxp_addon_set_named_property(env, exports, "my_function", fn)` while a JS exception is already pending and `fn` is invalid!
2. **Original exception is overwritten**:
   Because `uxp_addon_set_named_property` then fails (`addon_pending_exception` or `addon_invalid_arg`), the second `if (status != addon_ok)` triggers and calls `uxp_addon_throw_error(env, NULL, "Unable to populate exports")`, overwriting the real root-cause exception (`"Unable to wrap native function"`).
3. **`fn` is not reset to `nullptr` between blocks**:
   `fn` is declared once at the top of `Init`. If `MyFunction` succeeds (`fn` points to `MyFunction`), and then `uxp_addon_create_function` for `MyEcho` fails without overwriting `fn`, `fn` still holds `MyFunction` when `uxp_addon_set_named_property(env, exports, "my_echo", fn)` is called!

## How to Reproduce

### JavaScript Triggerability (Requires Failure During `Init` When Loading the Addon)
In normal operation, `await require("sample-uxp-addon.uxpaddon")` invokes `Init(env, exports, addonAPIs)`, and `uxp_addon_create_function` / `uxp_addon_set_named_property` succeed. This bug triggers during `await require("sample-uxp-addon.uxpaddon")` if any of those calls fail in C++:

```javascript
// Invokes Init() in module.cpp. If uxp_addon_create_function or uxp_addon_set_named_property fails,
// Init() continues executing with a pending JS exception, reuses stale `fn`, and overwrites the original error:
const addon = await require("sample-uxp-addon.uxpaddon");
```

### C++ Reproduction
Simulate `uxp_addon_create_function` failing on the first or second function registration (e.g., in a mock `addon_apis` table where `uxp_addon_create_function` returns `addon_generic_failure`).
- **Expected result**: `Init` throws `"Unable to wrap native function"` and immediately returns `nullptr` without calling `uxp_addon_set_named_property` or subsequent registrations.
- **Actual result**: `Init` calls all 6 API functions, calls `uxp_addon_throw_error` multiple times while an exception is already pending, overwrites the original error with `"Unable to populate exports"`, and still returns `exports`.

## Suggested Fix
Return `nullptr` immediately after calling `uxp_addon_throw_error` (or throw a `std::runtime_error` and let `UXP_ADDON_INIT` catch it and call `uxp_addon_throw_error`):

```cpp
addon_value Init(addon_env env, addon_value exports, const addon_apis& addonAPIs) {
    auto registerFn = [&](const char* name, addon_callback cb) -> bool {
        addon_value fn = nullptr;
        if (addonAPIs.uxp_addon_create_function(env, nullptr, 0, cb, nullptr, &fn) != addon_ok) {
            addonAPIs.uxp_addon_throw_error(env, nullptr, "Unable to wrap native function");
            return false;
        }
        if (addonAPIs.uxp_addon_set_named_property(env, exports, name, fn) != addon_ok) {
            addonAPIs.uxp_addon_throw_error(env, nullptr, "Unable to populate exports");
            return false;
        }
        return true;
    };

    if (!registerFn("my_function", MyFunction) ||
        !registerFn("my_echo", MyEcho) ||
        !registerFn("my_echo_async", MyAsyncEcho)) {
        return nullptr;
    }
    return exports;
}
```
