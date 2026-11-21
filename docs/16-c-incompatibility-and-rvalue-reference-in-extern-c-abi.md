# Bug 16: C Incompatibility in API Headers and C++ Rvalue Reference in `extern "C"` ABI

## Severity
**Medium (Broken C Header Compatibility & Non-Standard C++ Type in `extern "C"` Signature)**

## Scope
**SDK Core (`src/api/UxpAddonShared.h`, `src/api/UxpAddonTypes.h`)** — This bug is in the core SDK C/C++ ABI headers (and duplicated into `template/template-dev/src/api/`).

## Affected Files
- [`src/api/UxpAddonShared.h`](../src/api/UxpAddonShared.h) (lines 21–27, 81, 274–281)
- [`src/api/UxpAddonTypes.h`](../src/api/UxpAddonTypes.h) (lines 30–97)
- [`template/template-dev/src/api/UxpAddonShared.h`](../template/template-dev/src/api/UxpAddonShared.h) (lines 21–27, 81, 274–281)
- [`template/template-dev/src/api/UxpAddonTypes.h`](../template/template-dev/src/api/UxpAddonTypes.h) (lines 30–97)

## Problematic Code
In `UxpAddonShared.h`:
```c
#ifdef __cplusplus
#define EXTERN_C_START extern "C" {
#define EXTERN_C_END }
#else
#define EXTERN_C_START
#define EXTERN_C_END
#endif
...
typedef addon_value (*uxp_addon_initialize_func)(addon_env env, addon_value exports, addon_apis&& addonAPIs);
typedef addon_value (*uxp_addon_terminate_func)(addon_env env);

// Forward declare of the two required entry points for the addon
extern "C" {
UXP_EXTERN_API_STDCALL(addon_value) ADDON_INITIALIZER(addon_env env, addon_value exports, addon_apis&& addonAPIs);
UXP_EXTERN_API_STDCALL(void) ADDON_TERMINATE(addon_env env);
}
```

And in `UxpAddonTypes.h`:
```c
enum addon_property_attributes : unsigned int { ... };
enum addon_valuetype : unsigned int { ... };
enum addon_typedarray_type : unsigned int { ... };
enum addon_status : unsigned int { ... };
```

## Explanation
`UxpAddonShared.h` includes C standard headers (`<stdbool.h>`, `<stddef.h>`, `<stdint.h>`) and defines `EXTERN_C_START` and `EXTERN_C_END` on lines 21–27 specifically so the header can be included from both C and C++. However:

1. **`EXTERN_C_START` and `EXTERN_C_END` are never used**:
   Lines 278–281 hardcode `extern "C" { ... }` without `#ifdef __cplusplus`, instead of using `EXTERN_C_START` and `EXTERN_C_END`.
2. **C++ rvalue reference (`addon_apis&&`) inside an `extern "C"` declaration**:
   `ADDON_INITIALIZER` and `uxp_addon_initialize_func` take `addon_apis&& addonAPIs` (a C++11 rvalue reference).
   - Rvalue references do not exist in C.
   - Across an `extern "C"` dynamic library (`.dll` / `.dylib`) boundary, passing a C++ rvalue reference is non-standard ABI practice (when `const addon_apis*` is the standard C ABI equivalent), and `UXP_ADDON_INIT` does not even move from `addonAPIs`—it copies `addonAPIs` by const reference via `setAddonAPIs(const addon_apis&)` and passes it by value/const-ref to `initAddonCallback`.
3. **C++-only constructs in `UxpAddonTypes.h` and `UxpAddonShared.h`**:
   - `enum ... : unsigned int` (lines 30, 38, 53, 67 of `UxpAddonTypes.h`) is invalid in C99/C11/C17 (fixed underlying enum types were only added to C in C23; note that `project.pbxproj` sets `GCC_C_LANGUAGE_STANDARD = gnu11`).
   - `struct addon_property_descriptor`, `struct addon_extended_error_info`, and `struct addon_apis` have no `typedef`s, so referring to them without the `struct` keyword in `UxpAddonShared.h` fails in C.
   - `char16_t` is used on line 81 and line 103 of `UxpAddonShared.h` without including `<uchar.h>` in C mode.

## How to Reproduce

### JavaScript Triggerability
**C/C++-only bug (Header / ABI Compile-Time).** This issue only affects compiling the SDK headers in C mode or inspecting the `extern "C"` ABI signature and cannot be triggered from JavaScript.

### C/C++ Reproduction
Compile a `.c` file that includes `UxpAddonShared.h` using C11:
```bash
clang -x c -std=gnu11 -fsyntax-only src/api/UxpAddonShared.h
```
- **Expected result**: Header compiles cleanly or clearly documents C++-only support without dead `EXTERN_C_START` macros.
- **Actual result**: Compilation fails on `enum ... : unsigned int`, `char16_t`, missing `struct` keywords, raw `extern "C"`, and `addon_apis&&`.

## Suggested Fix
Use `EXTERN_C_START` and `EXTERN_C_END` on lines 278 and 281 of `UxpAddonShared.h` (or remove the unused `EXTERN_C_START` / `EXTERN_C_END` macros if the SDK headers are strictly C++-only).
