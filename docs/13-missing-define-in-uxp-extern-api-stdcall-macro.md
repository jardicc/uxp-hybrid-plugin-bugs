# Bug 13: Missing `#define` in `#else` Branch of `UXP_EXTERN_API_STDCALL` Macro

## Severity
**High (Compilation Error on Non-Windows / Non-Apple Platforms)**

## Scope
**SDK Core (`src/api/UxpAddonShared.h`)** — This bug is in the core SDK C/C++ API header (and duplicated into `template/template-dev/src/api/UxpAddonShared.h`).

## Affected Files
- [`src/api/UxpAddonShared.h`](../src/api/UxpAddonShared.h) (lines 42–48)
- [`template/template-dev/src/api/UxpAddonShared.h`](../template/template-dev/src/api/UxpAddonShared.h) (lines 42–48)

## Problematic Code
```c
#ifdef _WIN32
#define UXP_EXTERN_API_STDCALL(type) __declspec(dllexport) type __stdcall
#elif __GNUC__ && defined(__APPLE__)
#define UXP_EXTERN_API_STDCALL(type) __attribute__((visibility("default"))) type
#else
UXP_EXTERN_API_STDCALL(type)
#endif
```

## Explanation
In the `#else` branch on line 47, the `#define` directive is completely missing. Instead of defining the macro `UXP_EXTERN_API_STDCALL(type)`, the file contains the bare text `UXP_EXTERN_API_STDCALL(type)`.

1. On any platform/compiler combination where `_WIN32` is not defined and `(__GNUC__ && defined(__APPLE__))` is false (such as Linux, Android, WebAssembly, or static analysis tools not spoofing Apple/Windows macros), the C/C++ compiler sees the bare token sequence `UXP_EXTERN_API_STDCALL(type)` at top level before any semicolon, causing an immediate syntax error (`error: unknown type name 'type'`).
2. Furthermore, because `UXP_EXTERN_API_STDCALL` is never `#define`d in that branch, lines 279–280 (`UXP_EXTERN_API_STDCALL(addon_value) ADDON_INITIALIZER(...)`) also fail to compile.
3. Additionally, line 44 uses `#elif __GNUC__ && defined(__APPLE__)` instead of `#elif defined(__GNUC__) && defined(__APPLE__)`, which triggers `-Wundef` warnings when `__GNUC__` is not defined.

## How to Reproduce

### JavaScript Triggerability
**C++-only bug (Preprocessor / Compile-Time).** This issue occurs when compiling the C/C++ header and cannot be triggered from JavaScript.

### C++ Reproduction
Compile any file that includes `UxpAddonShared.h` targeting Linux (or pass `-U_WIN32 -U__APPLE__` to Clang/GCC):
```bash
clang++ -fsyntax-only -U_WIN32 -U__APPLE__ src/api/UxpAddonShared.h
```
- **Expected result**: Header compiles cleanly across platforms.
- **Actual result**:
  ```text
  src/api/UxpAddonShared.h:47:24: error: a parameter list without types is only allowed in a function definition
  UXP_EXTERN_API_STDCALL(type)
                         ^
  ```

## Suggested Fix
Add `#define` and the replacement body in the `#else` branch, and guard `__GNUC__` with `defined(...)`:

```c
#if defined(_WIN32)
#define UXP_EXTERN_API_STDCALL(type) __declspec(dllexport) type __stdcall
#elif defined(__GNUC__) && defined(__APPLE__)
#define UXP_EXTERN_API_STDCALL(type) __attribute__((visibility("default"))) type
#else
#define UXP_EXTERN_API_STDCALL(type) type
#endif
```
