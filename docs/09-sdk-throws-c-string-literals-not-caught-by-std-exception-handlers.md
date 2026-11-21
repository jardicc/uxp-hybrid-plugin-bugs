# Bug 09: SDK Throws Raw `const char*` String Literals That Are Not Caught by `std::exception` Handlers

## Severity
**Critical (Host Application Crash via Uncaught Exception Across `extern "C"` Boundary & Lost Error Messages)**

## Scope
**SDK Core (`src/utilities/UxpAddon.h`, `src/utilities/UxpAddon.cpp`, `src/utilities/UxpValue.cpp`, `src/utilities/UxpTask.cpp`)** — This bug is in the core SDK C++ utilities (and duplicated into `template/template-dev/src/utilities/`). Every `Check()` call and `Value`/`Task` throw statement in the SDK throws a raw `const char*` literal while the SDK's own `UXP_ADDON_INIT`, `UXP_ADDON_TERMINATE`, and `CreateErrorFromException` handlers only catch `std::exception&`.

## Affected Files
- [`src/utilities/UxpAddon.h`](../src/utilities/UxpAddon.h) (lines 37–63)
- [`src/utilities/UxpAddon.cpp`](../src/utilities/UxpAddon.cpp) (lines 15–24)
- [`src/utilities/UxpTask.cpp`](../src/utilities/UxpTask.cpp) (lines 47, 99)
- [`src/utilities/UxpValue.cpp`](../src/utilities/UxpValue.cpp) (lines 37, 141, 166)
- [`template/template-dev/src/utilities/UxpAddon.h`](../template/template-dev/src/utilities/UxpAddon.h) (lines 37–63)
- [`template/template-dev/src/utilities/UxpAddon.cpp`](../template/template-dev/src/utilities/UxpAddon.cpp) (lines 15–24)
- [`template/template-dev/src/utilities/UxpTask.cpp`](../template/template-dev/src/utilities/UxpTask.cpp) (lines 47, 99)
- [`template/template-dev/src/utilities/UxpValue.cpp`](../template/template-dev/src/utilities/UxpValue.cpp) (lines 37, 141, 166)

## Problematic Code
Every `throw` statement in the SDK throws a raw C-string literal (`const char*`), **not** a `std::exception`:
- `UxpAddon.h:62`: `throw "error";`
- `UxpValue.cpp:37`: `throw "unsupported type";`
- `UxpValue.cpp:141`: `throw "invalid kind";`
- `UxpValue.cpp:166`: `throw "Incorrect value kind";`
- `UxpTask.cpp:47`: `throw "Tasks can only be used to schedule one operation";`
- `UxpTask.cpp:99`: `throw "No result was set";`

Meanwhile, the exception handlers in `UxpAddon.h` and `UxpAddon.cpp` expect `std::exception`:
```cpp
#define UXP_ADDON_INIT(initAddonCallback)                                                       \
    addon_value ADDON_INITIALIZER(addon_env env, addon_value exports, addon_apis&& addonAPIs) { \
        SET_ADDON_APIS(addonAPIs);                                                              \
        addon_value updatedAddonExports = nullptr;                                              \
        try {                                                                                   \
            updatedAddonExports = initAddonCallback(env, exports, addonAPIs);                   \
        } catch (const std::exception& exc) {                                                   \
            std::string errorMessage("Error occured while addon initialize : ");                \
            errorMessage.append(exc.what());                                                    \
            UxpAddonApis.uxp_addon_throw_error(env, NULL, errorMessage.c_str());                \
        }                                                                                       \
        return updatedAddonExports;                                                             \
    }

#define UXP_ADDON_TERMINATE(terminateAddonCallback)                              \
    void ADDON_TERMINATE(addon_env env) {                                        \
        try {                                                                    \
            terminateAddonCallback(env);                                         \
        } catch (const std::exception& exc) {                                    \
            std::string errorMessage("Error occured while addon terminate : ");  \
            errorMessage.append(exc.what());                                     \
            UxpAddonApis.uxp_addon_throw_error(env, NULL, errorMessage.c_str()); \
        }                                                                        \
    }
```

And in `UxpAddon.cpp`:
```cpp
addon_value CreateErrorFromException(addon_env env) noexcept {
    std::string message;
    try {
        throw;
    } catch (std::exception& except) {
        message = except.what();
    } catch (...) {
        message = "unknown exception";
    }
```

## Explanation
In C++, a string literal (`const char*`) does **not** inherit from `std::exception`. This causes two severe bugs:

1. **Uncaught exception across `extern "C"` DLL boundary in `UXP_ADDON_INIT` and `UXP_ADDON_TERMINATE` (Host Crash)**:
   `UXP_ADDON_INIT` and `UXP_ADDON_TERMINATE` only have `catch (const std::exception& exc)` and have no `catch (const char*)` or `catch (...)`.
   If an addon's `Init` or `Terminate` callback uses `Check(...)`, `HandlerScope`, `Value`, or `Task`—and any check fails—a `const char*` exception is thrown. Because `catch (const std::exception&)` does not match `const char*`, the exception escapes the `extern "C"` entry point (`uxp_addon_init` / `uxp_addon_terminate`) into the host application (Photoshop / Premiere Pro), causing immediate undefined behavior / `std::terminate()` crash.

2. **All SDK error messages are lost in `CreateErrorFromException`**:
   When `Check()`, `Value`, or `Task` throws inside a callback wrapped with `try { ... } catch (...) { return CreateErrorFromException(env); }`, `CreateErrorFromException` rethrows the exception and only checks `catch (std::exception& except)`. Every `const char*` exception thrown by the SDK itself falls into `catch (...)` and is replaced with the generic string `"unknown exception"`, discarding diagnostic messages like `"unsupported type"`, `"Incorrect value kind"`, or `"No result was set"`, as well as discarding the `addon_status` code in `Check(addon_status)`.

## How to Reproduce

### Case 1: JavaScript Reproduction (Direct — Lost Error Message in `CreateErrorFromException`)
Yes — losing the SDK error message can be reproduced directly from JavaScript on the unmodified sample addon:

```javascript
const addon = await require("sample-uxp-addon.uxpaddon");

// Passing an unsupported type causes GetType() in C++ to execute `throw "unsupported type";` (const char*).
// Because CreateErrorFromException() only catches `std::exception&`, the string literal falls into `catch (...)`
// and is replaced with "unknown exception":
const err = addon.my_echo(Symbol("test"));
console.log(err.message);
// Expected: "unsupported type"
// Actual:   "unknown exception"
```

### Case 2: C++ + JS Reproduction (Host Crash in `UXP_ADDON_INIT` / `UXP_ADDON_TERMINATE`)
1. In `module.cpp`, use `Check(...)` inside `Init` (as the rest of the SDK does), or throw a `const char*` when an API call fails:
   ```cpp
   addon_value Init(addon_env env, addon_value exports, const addon_apis& addonAPIs) {
       Check(addon_invalid_arg); // throws const char* "error"
       return exports;
   }
   ```
2. Load the addon from JavaScript (`await require("sample-uxp-addon.uxpaddon")`).
3. **Expected result**: `UXP_ADDON_INIT` catches the exception, reports the error via `uxp_addon_throw_error`, and returns `nullptr` cleanly.
4. **Actual result**: `catch (const std::exception&)` does not catch `const char*`, crashing the host application.

## Suggested Fix
1. Change `Check()` and all `throw "..."` statements in `UxpAddon.h`, `UxpValue.cpp`, and `UxpTask.cpp` to throw `std::runtime_error(...)` (or a custom `UxpException : public std::runtime_error` that also stores `addon_status`).
2. Add `catch (const char* msg)` and `catch (...)` to both `UXP_ADDON_INIT`, `UXP_ADDON_TERMINATE`, and `CreateErrorFromException`.
