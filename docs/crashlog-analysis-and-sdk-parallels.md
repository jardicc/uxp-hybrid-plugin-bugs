# Crash Log Analysis & Architectural Parallels with UXP Hybrid Plugin SDK Bugs

## Executive Summary

This document analyzes two Adobe Crash Reporter logs from [`jardicc/vscode-uxp-debugger/tree/main/docs/crashes`](https://github.com/jardicc/vscode-uxp-debugger/tree/main/docs/crashes):

1. **`docs/crashes/indesign/crashlog.xml`** — Adobe InDesign 21.5.1.73 (`EXCEPTION_ACCESS_VIOLATION` / `0xc0000005` inside `adobe\dynamic-torqnative.dll`)
2. **`docs/crashes/photoshop/photoshop-e2e.xml`** — Adobe Photoshop 27.10.0.26 (`EXCEPTION_BREAKPOINT` / `0x80000003` inside `adobe\libdynamic-napi.dll`)

### Did either crash originate from `uxp-hybrid-plugin-sdk`?

**No.** Inspection of the `<binaryImageSet>` in both crash reports confirms that **no `.uxpaddon` native C++ hybrid plugin module is loaded** in the process address space of either crash. Every loaded module belongs to the host application (InDesign/Photoshop), Windows system DLLs, GPU drivers, or system utilities.

However, because the UXP Hybrid Plugin SDK (`uxp_addon_*` C APIs defined in [`src/api/UxpAddonShared.h`](../src/api/UxpAddonShared.h)) is a thin ABI wrapper over **Torq's sealed N-API layer** (`torq::seal_napi` in `dynamic-torqnative.dll`) and **Node-API / V8** (`libdynamic-napi.dll`), several bugs identified in this audit produce **the exact same crash mechanisms and top-of-stack signatures** inside `dynamic-torqnative.dll` and `libdynamic-napi.dll`.

---

## 1. Architecture: How `uxp-hybrid-plugin-sdk` Maps to Host Binaries

When a UXP Hybrid Plugin (`.uxpaddon`) executes in Photoshop or InDesign, calls flow through three layers:

```text
+-------------------------------------------------------------------+
| 1. Hybrid Addon (.uxpaddon) OR Host C++ Scripting Plugin (.RPLN)  |
|    Calls uxp_addon_* function table (UxpAddonApis)                |
+-------------------------------------------------------------------+
                                 |
                                 v
+-------------------------------------------------------------------+
| 2. UXP Runtime Bridge: adobe\dynamic-torqnative.dll               |
|    Implements torq::seal_napi::* (validates/unwraps Context &     |
|    opaque addon_env / addon_value handles)                        |
+-------------------------------------------------------------------+
                                 |
                                 v
+-------------------------------------------------------------------+
| 3. N-API & V8 Engine: adobe\libdynamic-napi.dll                   |
|    Implements napi_* functions and embeds the V8 JS engine        |
+-------------------------------------------------------------------+
```

> **Note on symbol names in Adobe Crash Logs:**
> Neither `dynamic-torqnative.dll` nor `libdynamic-napi.dll` ships with public PDB debug symbols. When Adobe Crash Reporter walks the stack without PDBs, it resolves each instruction address to the **nearest preceding exported DLL symbol**:
> - In `libdynamic-napi.dll`, internal V8 functions located after the N-API export table are reported as **`napi_unwrap`** or **`napi_release_env`**.
> - In `dynamic-torqnative.dll`, internal Torq functions are often reported as **`torq::seal_napi::Context::protect`**.
> - In InDesign `.RPLN` / `.APLN` plugins, internal C++ methods are reported as **`GetPlugIn`** (the single public entry point exported by InDesign plugins).

---

## 2. Detailed Breakdown of Crash Report 1 (`indesign/crashlog.xml`)

- **Application:** Adobe InDesign `21.5.1.73` (Windows x64)
- **Exception:** `EXCEPTION_ACCESS_VIOLATION` (`0xc0000005`) at `RIP = 0x00007FFFA9EA68C6` on Thread 0 (main thread)

### Call Stack Mapped to `<binaryImageSet>`

| Frame(s) | Instruction Address | Reported Export Symbol | Actual Binary Module (`<binaryImage>`) | Module Offset |
|----------|---------------------|------------------------|----------------------------------------|---------------|
| **0** | `0x00007FFFA9EA68C6` | `torq::seal_napi::Context::protect` | `adobe\dynamic-torqnative.dll` (`0x7FFFA9D40000`–`0x7FFFAD985000`) | `+0x1668C6` |
| **1–3** | `0x00007FFFA2F7233F`<br>`0x00007FFFA2F769C0`<br>`0x00007FFFA2F79224` | `GetPlugIn` | `adobe\SUPPORT FOR JAVASCRIPT.RPLN` (`0x7FFFA2F10000`–`0x7FFFA3047000`) | `+0x6233F`<br>`+0x669C0`<br>`+0x69224` |
| **4–5** | `0x00007FFFABB56507`<br>`0x00007FFFABB5C218` | `torq::seal_napi::Context::protect` | `adobe\dynamic-torqnative.dll` (`0x7FFFA9D40000`–`0x7FFFAD985000`) | `+0x1E16507`<br>`+0x1E1C218` |
| **6–16** | `0x00007FFFA7EE2092` ..<br>`0x00007FFFA88C722C` | `napi_unwrap` | `adobe\libdynamic-napi.dll` (`0x7FFFA7E40000`–`0x7FFFA9D3D000`) | `+0xA2092` ..<br>`+0xA8722C` |
| **17, 20, 26, 36** | `0x000001C3CF...` | `unknown` | V8 JIT-compiled JavaScript frames on the heap | N/A |
| **18** | `0x00007FFFA7E81272` | `napi_release_env` | `adobe\libdynamic-napi.dll` (`0x7FFFA7E40000`–`0x7FFFA9D3D000`) | `+0x41272` |

### Register State & Root Cause

```xml
<register name="RAX" value="0x69746163696C7070"/>
<register name="RBX" value="0x000001C32EEF3190"/>
<register name="RCX" value="0x000002C603F62699"/>
<register name="RDX" value="0x000000A6A04FB7D0"/>
<register name="RSI" value="0x0000000000000000"/>
<register name="RDI" value="0x0000000000000000"/>
<register name="RIP" value="0x00007FFFA9EA68C6"/>
```

- The value in **`RAX` (`0x69746163696C7070`)** decoded in little-endian ASCII is **`"pplicati"`** — bytes `1..8` of the ASCII string `"application"`.
- JavaScript code (or V8 Inspector variable evaluation during debugging) invoked a property/method on InDesign's scripting DOM (`SUPPORT FOR JAVASCRIPT.RPLN`, frames 1–3).
- `SUPPORT FOR JAVASCRIPT.RPLN` called back into `dynamic-torqnative.dll` (`+0x1668C6`, frame 0), passing a corrupted, uninitialized, or type-confused handle/pointer whose underlying memory contained the ASCII string `"application"` instead of a valid `napi_value` / C++ object pointer.
- When `dynamic-torqnative.dll` attempted to dereference `RAX` (`0x69746163696C7070`, a non-canonical x64 address), the CPU raised `EXCEPTION_ACCESS_VIOLATION` (`0xc0000005`).

---

## 3. Detailed Breakdown of Crash Report 2 (`photoshop/photoshop-e2e.xml`)

- **Application:** Adobe Photoshop `27.10.0.26` (Windows x64)
- **Exception:** `EXCEPTION_BREAKPOINT` (`0x80000003`) at `RIP = 0x00007FFA7192BCA4` on Thread 0 (main thread)

### Call Stack Mapped to `<binaryImageSet>`

| Frame(s) | Instruction Address | Reported Export Symbol | Actual Binary Module (`<binaryImage>`) | Module Offset |
|----------|---------------------|------------------------|----------------------------------------|---------------|
| **0–15** | `0x00007FFA7192BCA4` ..<br>`0x00007FFA724F1D65` | `napi_unwrap` | `adobe\libdynamic-napi.dll` (`0x7FFA71770000`–`0x7FFA73655000`) | `+0x1BBCA4` ..<br>`+0xD81D65` |
| **16–34** | `0x000001FF91CE373F` ..<br>`0x000001FF91C4D358` | `unknown` | V8 JIT-compiled JavaScript frames / V8 heap | N/A |

### Register State & Root Cause

```xml
<register name="RAX" value="0x0000000000000000"/>
<register name="RBX" value="0x0000000000000001"/>
<register name="RCX" value="0x0000000000000000"/>
<register name="RDX" value="0x000001FE1BC90400"/>
<register name="RSI" value="0x0000000000000001"/>
<register name="RDI" value="0x000001FF267C8EC8"/>
<register name="RIP" value="0x00007FFA7192BCA4"/>
```

- On Windows x64, `EXCEPTION_BREAKPOINT` (`0x80000003`, instruction `int 3` / `__debugbreak()`) inside `libdynamic-napi.dll` is V8's intentional fatal abort handler (`v8::base::OS::Abort()` / `V8_Fatal` / `CHECK` macro failure).
- V8 triggers this deliberate trap when an internal runtime invariant is violated — for example, an invalid V8 handle, a corrupted HandleScope, an unexpected pending exception state, or an Inspector/CDP state machine assertion during debugging.

---

## 4. Parallels with Audited Bugs in `uxp-hybrid-plugin-sdk`

Although neither crash report above was generated by a `.uxpaddon` binary, `SUPPORT FOR JAVASCRIPT.RPLN` and `.uxpaddon` modules interact with the exact same `torq::seal_napi` (`dynamic-torqnative.dll`) and `napi_*` (`libdynamic-napi.dll`) layers.

Below are the specific bugs from this audit that produce **the same classes of crashes** when a `.uxpaddon` plugin is loaded.

### Parallel A: Passing Uninitialized / Garbage Handles into `dynamic-torqnative.dll` (`0xc0000005` Access Violation)

In **Crash Report 1 (InDesign)**, a C++ plugin (`SUPPORT FOR JAVASCRIPT.RPLN`) passed a pointer containing leftover string data (`"pplicati"`, `0x69746163696C7070`) into `dynamic-torqnative.dll`, crashing inside `torq::seal_napi` with `EXCEPTION_ACCESS_VIOLATION`.

In `uxp-hybrid-plugin-sdk`, two bugs cause the exact same failure mode from `.uxpaddon` code:

1. **[Bug #17 — Uninitialized `arg1` in `MyEcho` and `MyAsyncEcho` When Called With No Arguments](./17-uninitialized-arg1-in-myecho-and-myasyncecho-when-called-with-no-args.md)**
   - In [`template/template-dev/src/module.cpp`](../template/template-dev/src/module.cpp), `addon_value arg1;` is declared uninitialized on the stack.
   - When JS calls `myEcho()` or `myAsyncEcho()` with 0 arguments, `uxp_addon_get_cb_info` leaves `arg1` untouched.
   - Whatever bytes were previously on the stack (such as an ASCII string or pointer from an earlier call frame, identical in nature to `0x69746163696C7070` in `RAX`) are passed as `addon_value` to `Value value(env, arg1)` -> `UxpAddonApis.uxp_addon_typeof(env, value, &valueType)`.
   - `dynamic-torqnative.dll` (`torq::seal_napi`) dereferences the bogus `addon_value` pointer and crashes with `EXCEPTION_ACCESS_VIOLATION` (`0xc0000005`).
   - **How the stack trace compares:** Frame 0 is `dynamic-torqnative.dll` (`torq::seal_napi::Context::protect`), and Frames 1–3 are `Sample-Uxp-Addon.uxpaddon` instead of `SUPPORT FOR JAVASCRIPT.RPLN`.

2. **[Bug #18 — `Init()` in `module.cpp` Continues After Error and Reuses Uninitialized/Stale `fn`](./18-init-in-module-cpp-continues-after-error-and-overwrites-exceptions.md)**
   - In [`template/template-dev/src/module.cpp`](../template/template-dev/src/module.cpp), `addon_value fn;` is uninitialized on the stack. If `uxp_addon_create_function` fails on the first function registration, `Init()` does not return early and continues to the next registration or passes an invalid `fn` handle into `uxp_addon_set_named_property(env, exports, ..., fn)`, causing `dynamic-torqnative.dll` to dereference an invalid handle.

3. **[Bug #03 — `Value` Move Constructor Leaves Dangling `kind`, Causing Null Pointer Dereference](./03-value-move-constructor-leaves-dangling-kind-causing-null-deref.md)**
   - Calling `Convert(env)` or `GetString()` on a moved-from `Value` dereferences `nullptr` (`0x0000000000000000`), raising `EXCEPTION_ACCESS_VIOLATION` (`0xc0000005`) directly inside the `.uxpaddon` frame before reaching `dynamic-torqnative.dll`.

---

### Parallel B: Violating V8 / N-API Invariants in `libdynamic-napi.dll` (`0x80000003` V8 Fatal / Breakpoint)

In **Crash Report 2 (Photoshop)**, V8 inside `libdynamic-napi.dll` executed a fatal `CHECK` / `Abort()` (`EXCEPTION_BREAKPOINT` `0x80000003`) because an internal V8 / N-API invariant was violated.

In `uxp-hybrid-plugin-sdk`, the following bugs violate N-API / V8 invariants and can trigger either a fatal abort (`0x80000003` / `std::terminate`) or host corruption:

1. **[Bug #09 — SDK Throws C-String Literals (`const char*`) Not Caught by `std::exception` Handlers](./09-sdk-throws-c-string-literals-not-caught-by-std-exception-handlers.md)**
   - `Check()` in [`src/utilities/UxpAddon.h`](../src/utilities/UxpAddon.h), `Value`, and `Task` all execute `throw "literal"`.
   - `UXP_ADDON_INIT` and `UXP_ADDON_TERMINATE` only catch `const std::exception&`. If an error occurs during initialization or termination, the `const char*` exception escapes across the `extern "C"` boundary into `dynamic-torqnative.dll` (or invokes `std::terminate()`), crashing the host process immediately.

2. **[Bug #10 — `CreateErrorFromException` Fails When Exception Is Pending and Calls `std::terminate` Outside `catch`](./10-createerrorfromexception-returns-error-value-instead-of-throwing-js-exception.md)** & **[Bug #18](./18-init-in-module-cpp-continues-after-error-and-overwrites-exceptions.md)**
   - In V8 / N-API, once a JS exception is pending on `addon_env`, calling further N-API functions that allocate or execute JS without clearing the pending exception violates N-API state rules (`addon_pending_exception`).
   - Furthermore, calling `CreateErrorFromException(env)` when no C++ exception is active executes bare `throw;`, which immediately invokes `std::terminate()` and aborts the host application.

3. **[Bug #12 — `Task` State Management and Thread-Safety Flaws](./12-task-state-management-and-thread-safety-flaws.md)** & **[Bug #21 — Threading Contradiction](./21-readme-broken-code-examples-and-threading-contradiction.md)**
   - `addon_env` (backed by a V8 `Isolate` and `v8::Context` in `libdynamic-napi.dll`) is strictly bound to the UXP scripting thread.
   - Accessing `addon_env` or N-API handles (`addon_value`, `addon_deferred`) from the wrong thread without scheduling via `uxp_addon_schedule_on_JavaScript_thread`, or invoking `ScheduleOnScriptingThread` when `mEnv` is `nullptr` / stale after environment teardown (`napi_release_env`), triggers a fatal V8 `CHECK` (`0x80000003`) or access violation (`0xc0000005`) inside `libdynamic-napi.dll` / `dynamic-torqnative.dll`.

---

## Summary Comparison Table

| Crash Report | Exception & Module | Actual Cause in Crash Log | Analogous Bug(s) in `uxp-hybrid-plugin-sdk` | How `.uxpaddon` Crash Would Differ in the Log |
|--------------|--------------------|---------------------------|---------------------------------------------|-----------------------------------------------|
| **`indesign/crashlog.xml`** | `0xc0000005` (`EXCEPTION_ACCESS_VIOLATION`) in `dynamic-torqnative.dll` (`torq::seal_napi`), `RAX = "pplicati"` | InDesign's `SUPPORT FOR JAVASCRIPT.RPLN` passed an invalid/corrupted handle containing ASCII string bytes into `torq::seal_napi`. | **[Bug #17](./17-uninitialized-arg1-in-myecho-and-myasyncecho-when-called-with-no-args.md)** (uninitialized `addon_value arg1` on stack), **[Bug #18](./18-init-in-module-cpp-continues-after-error-and-overwrites-exceptions.md)** (uninitialized `addon_value fn`), **[Bug #03](./03-value-move-constructor-leaves-dangling-kind-causing-null-deref.md)** (moved-from `Value` null deref). | `*.uxpaddon` would appear in `<binaryImageSet>` and in frames 1–3 of `<backtrace>` instead of `SUPPORT FOR JAVASCRIPT.RPLN`. |
| **`photoshop/photoshop-e2e.xml`** | `0x80000003` (`EXCEPTION_BREAKPOINT` / V8 `CHECK` abort) in `libdynamic-napi.dll` | V8 internal fatal check (`v8::base::OS::Abort()`) triggered during JS/Inspector execution in `libdynamic-napi.dll`. | **[Bug #09](./09-sdk-throws-c-string-literals-not-caught-by-std-exception-handlers.md)** (uncaught `const char*` across ABI), **[Bug #10](./10-createerrorfromexception-returns-error-value-instead-of-throwing-js-exception.md)** (`std::terminate` / pending exception state), **[Bug #12](./12-task-state-management-and-thread-safety-flaws.md)** (invalid/cross-thread `addon_env` access). | `*.uxpaddon` would appear in `<binaryImageSet>` and in the caller frames leading into `dynamic-torqnative.dll` / `libdynamic-napi.dll`. |
