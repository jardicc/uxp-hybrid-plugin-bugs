# Bug 10: `CreateErrorFromException` Returns an Error Value Instead of Throwing a JS Exception (and Can Call `std::terminate`)

## Severity
**High (Broken Error Propagation to JavaScript & Potential `std::terminate`)**

## Scope
**SDK Core (`src/utilities/UxpAddon.cpp`) + Template Addon (`template/template-dev/src/module.cpp`)** — Primarily an **SDK Core** bug in `CreateErrorFromException(addon_env)` (which creates and returns an `Error` value instead of calling `uxp_addon_throw_error`, fails to check `uxp_addon_is_exception_pending`, and calls `std::terminate()` if no exception is active), combined with the **Template Addon** (`module.cpp`) returning `CreateErrorFromException(env)` directly to JavaScript as a normal return value.

## Affected Files
- [`src/utilities/UxpAddon.cpp`](../src/utilities/UxpAddon.cpp) (lines 15–37)
- [`src/utilities/UxpAddon.h`](../src/utilities/UxpAddon.h) (lines 65–67)
- [`template/template-dev/src/utilities/UxpAddon.cpp`](../template/template-dev/src/utilities/UxpAddon.cpp) (lines 15–37)
- [`template/template-dev/src/module.cpp`](../template/template-dev/src/module.cpp) (lines 18–30, 36–53, 62–109)

## Problematic Code
In `UxpAddon.cpp`:
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

    // Don't throw from this function (ignore further errors)
    addon_value errorCode = nullptr;
    std::string code("-1");
    UxpAddonApis.uxp_addon_create_string_utf8(env, code.c_str(), code.size(), &errorCode);

    addon_value errorMessage = nullptr;
    UxpAddonApis.uxp_addon_create_string_utf8(env, message.c_str(), message.size(), &errorMessage);

    addon_value error = nullptr;
    UxpAddonApis.uxp_addon_create_error(env, errorCode, errorMessage, &error);
    return error;
}
```

And in `module.cpp`:
```cpp
/*
 * This function will echo the provided argument after converting to and from a
 * standard value type.
 * No entry point should throw an exception. The implementation must use try/catch
 * and return nullptr if an exception was caught.
 * This method is invoked on the JavaScript thread.
 */
addon_value MyEcho(addon_env env, addon_callback_info info) {
    try {
        ...
        return stdValue.Convert(env);
    } catch (...) {
        return CreateErrorFromException(env);
    }
}
```

## Explanation
There are four distinct issues in `CreateErrorFromException` and how `module.cpp` uses it:

1. **Returns an `Error` object as a normal return value instead of throwing a JS exception**:
   `uxp_addon_create_error` (like Node-API's `napi_create_error`) only **instantiates** a JS `Error` object; it does **not** throw a JavaScript exception in the VM.
   Notice the doc comment in `module.cpp`:
   > *"The implementation must use try/catch and return nullptr if an exception was caught."*
   Because `MyFunction`, `MyEcho`, and `MyAsyncEcho` do `return CreateErrorFromException(env);` without calling `uxp_addon_throw(env, error)` or `uxp_addon_throw_error(...)`:
   - In JavaScript, `const res = addon.my_echo(badInput);` **does not throw**! It succeeds normally and assigns the `Error` object to `res`, completely bypassing `try { ... } catch (err) { ... }` in `main.js`.
   - In `MyAsyncEcho`, if `Value stdValue(env, arg1)` throws synchronously (e.g. unsupported input type), `addon.my_echo_async(badInput)` returns an `Error` instance instead of a `Promise`. Calling `echoAsyncResult.then(...)` in `main.js` then fails with `TypeError: echoAsyncResult.then is not a function`.

2. **Blindly calls N-API creation functions while a JS exception is already pending (`addon_pending_exception`)**:
   Think of V8 / N-API as having a **"Red Warning Light" (`pending exception`)** stored on `addon_env`. A fundamental rule of N-API is: **while a JS exception is pending on `env`, the C++ addon must not call N-API functions that allocate or execute JS values** (such as `uxp_addon_create_string_utf8`, `uxp_addon_create_error`, or `uxp_addon_create_promise`). If it tries, V8 immediately rejects the call with `addon_pending_exception` (status `10` / `0xA`).

   **Step-by-step of what happens when a JS property getter throws inside `GetMap()`:**
   1. A JS object with a throwing getter (`{ validProp: "hello", get explodingProp() { throw new Error("..."); } }`) is passed to `addon.my_echo(...)` or `addon.my_echo_async(...)`.
   2. `GetMap()` calls `uxp_addon_get_property(env, value, key, &element)` on `explodingProp`, which executes the JS getter. The getter throws `new Error(...)`, turning **ON** the V8 `pending exception` flag on `env` and returning `addon_pending_exception`.
   3. `Check()` sees `status != addon_ok` and throws a C++ `const char*` exception (`"invalid status"`), jumping into `CreateErrorFromException(env)`.
   4. `CreateErrorFromException(env)` **never checks `uxp_addon_is_exception_pending(env, &isPending)`**! Instead, it blindly calls:
      - `uxp_addon_create_string_utf8(env, "-1", ...)` $\rightarrow$ **FAILS** (`addon_pending_exception`), leaving `errorCode = nullptr`.
      - `uxp_addon_create_string_utf8(env, "unknown exception", ...)` $\rightarrow$ **FAILS** (`addon_pending_exception`), leaving `errorMessage = nullptr`.
      - `uxp_addon_create_error(env, nullptr, nullptr, &error)` $\rightarrow$ **FAILS** (`addon_invalid_arg` / `addon_pending_exception`), leaving `error = nullptr`.

   **Why is this a serious bug even if `try / catch` in JS catches the getter's error in `my_echo`?**
   In synchronous `addon.my_echo(poisonObject)`, a JS `try / catch` block catches the original getter error **only by sheer accident**—because all three N-API calls in `CreateErrorFromException` silently failed, `error` remained `nullptr` (`0x0`), and returning `nullptr` back to V8 while the "Red Warning Light" (`pending exception`) was still lit allowed V8 to surface the original JS exception. However, this is broken and dangerous for three reasons:
   - **Blind `nullptr` propagation**: `CreateErrorFromException` ignores return statuses and passes invalid `nullptr` handles (`errorCode = nullptr`, `errorMessage = nullptr`) into `uxp_addon_create_error`.
   - **Native C++ memory leak (combined with [Bug 05](./05-memory-leak-in-value-constructor-on-exception.md))**: Every property read into `data.map` *before* the throwing getter (e.g., `validProp: "hello"`) is permanently leaked on the C++ heap because `Value::Value` threw before constructor completion.
   - **Breaks any subsequent N-API error-recovery logic in C++**: If C++ tries to do anything else with N-API in its `catch` block—for example, creating or rejecting a Promise (`uxp_addon_create_promise` / `uxp_addon_reject_deferred`) or constructing a custom fallback object—V8 rejects every N-API call because the pending exception was neither checked nor cleared via `uxp_addon_get_and_clear_last_exception`.

3. **Calls `std::terminate()` if invoked outside an active `catch` block**:
   `CreateErrorFromException` is marked `noexcept` and executes `throw;` inside a `try` block. In C++, executing `throw;` when `std::current_exception() == nullptr` does **not** throw an exception that `catch (...)` can catch—it directly invokes `std::terminate()`, crashing the host application.

## How to Reproduce

### JavaScript Reproduction (Direct)
Yes — this bug can be reproduced directly from JavaScript by calling `addon.my_echo` or `addon.my_echo_async` with any unsupported type (such as `null`, `Symbol`, or a function):

```javascript
const addon = await require("sample-uxp-addon.uxpaddon");

// 1. Synchronous call returns an Error object as a normal return value instead of throwing:
try {
    const res = addon.my_echo(() => {});
    console.log("Did NOT throw! Returned value is:", res, "instanceof Error:", res instanceof Error);
} catch (err) {
    // Execution NEVER reaches this catch block!
    console.log("Caught error:", err);
}

// 2. Async call synchronously returns an Error object instead of a Promise, breaking .then():
addon.my_echo_async(() => {}).then(console.log);
// Throws: TypeError: addon.my_echo_async(...).then is not a function

// 3. Object with a throwing getter turns ON V8's "pending exception" flag:
// Inside CreateErrorFromException(env), all 3 N-API calls (create_string_utf8 x2 + create_error)
// fail with addon_pending_exception (passing nullptr into create_error) and return nullptr (0x0).
// Even though JS catch(err) receives the getter's Error when C++ returns nullptr, all preceding
// properties in data.map are leaked in C++ RAM (Bug 05) and any further N-API calls in C++ fail!
const badObj = {
    validProp: "leaked in C++ heap before getter throws",
    get explodingProp() { throw new Error("JS getter failed"); }
};
try {
    addon.my_echo(badObj);
} catch (err) {
    console.log("Caught getter error after CreateErrorFromException failed 3x in C++:", err);
}
```

- **Expected result**: `addon.my_echo(() => {})` throws a JavaScript `Error` that is caught by the `catch (err)` block.
- **Actual result**: `Did NOT throw! Returned value is: Error: unknown exception instanceof Error: true`. And for `addon.my_echo_async(() => {}).then(...)`, it throws `TypeError: addon.my_echo_async(...).then is not a function`.

## Suggested Fix
Check `std::current_exception()` before `throw;`, check whether a JS exception is already pending via `uxp_addon_is_exception_pending`, and throw the error into the JS VM using `uxp_addon_throw(env, error)` (or `uxp_addon_throw_error`):

```cpp
addon_value CreateErrorFromException(addon_env env) noexcept {
    bool isPending = false;
    if (UxpAddonApis.uxp_addon_is_exception_pending(env, &isPending) == addon_ok && isPending) {
        return nullptr;
    }

    std::string message = "unknown exception";
    if (std::current_exception()) {
        try {
            throw;
        } catch (const std::exception& except) {
            message = except.what();
        } catch (const char* msg) {
            if (msg) message = msg;
        } catch (...) {
        }
    }

    UxpAddonApis.uxp_addon_throw_error(env, "-1", message.c_str());
    return nullptr;
}
```
