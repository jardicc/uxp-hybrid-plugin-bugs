# Bug 14: Return Type and `__stdcall` Calling Convention Mismatches for `ADDON_INITIALIZER` and `ADDON_TERMINATE`

## Severity
**High (Function Signature Mismatch & 32-Bit Windows Compilation / Stack Corruption Bug)**

## Scope
**SDK Core (`src/api/UxpAddonShared.h`, `src/utilities/UxpAddon.h`)** — This bug is in the core SDK ABI headers and lifecycle macros (and duplicated into `template/template-dev/src/`).

## Affected Files
- [`src/api/UxpAddonShared.h`](../src/api/UxpAddonShared.h) (lines 42–43, 274–281)
- [`src/utilities/UxpAddon.h`](../src/utilities/UxpAddon.h) (lines 37–58)
- [`template/template-dev/src/api/UxpAddonShared.h`](../template/template-dev/src/api/UxpAddonShared.h) (lines 42–43, 274–281)
- [`template/template-dev/src/utilities/UxpAddon.h`](../template/template-dev/src/utilities/UxpAddon.h) (lines 37–58)

## Problematic Code
In `UxpAddonShared.h`:
```cpp
#ifdef _WIN32
#define UXP_EXTERN_API_STDCALL(type) __declspec(dllexport) type __stdcall
...
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

And in `UxpAddon.h`:
```cpp
#define UXP_ADDON_INIT(initAddonCallback)                                                       \
    addon_value ADDON_INITIALIZER(addon_env env, addon_value exports, addon_apis&& addonAPIs) { \
...
#define UXP_ADDON_TERMINATE(terminateAddonCallback)                              \
    void ADDON_TERMINATE(addon_env env) {                                        \
```

## Explanation
There are three inconsistencies between the function pointer typedefs, the forward declarations in `UxpAddonShared.h`, and the macro definitions in `UxpAddon.h`:

1. **`uxp_addon_terminate_func` has the wrong return type (`addon_value` instead of `void`)**:
   On line 275 of `UxpAddonShared.h`:
   ```cpp
   typedef addon_value (*uxp_addon_terminate_func)(addon_env env);
   ```
   Yet 5 lines below on line 280, `ADDON_TERMINATE` is declared as returning `void`:
   ```cpp
   UXP_EXTERN_API_STDCALL(void) ADDON_TERMINATE(addon_env env);
   ```
   And `UXP_ADDON_TERMINATE` in `UxpAddon.h` defines `void ADDON_TERMINATE(addon_env env)`. Taking `&ADDON_TERMINATE` and assigning it to `uxp_addon_terminate_func` fails to compile due to return type mismatch (`void (*)(addon_env)` vs `addon_value (*)(addon_env)`), and if cast and caller-inspected by the host, reads an uninitialized return register (`RAX`/`EAX`).

2. **`UXP_ADDON_INIT` and `UXP_ADDON_TERMINATE` omit `UXP_EXTERN_API_STDCALL` in their definitions**:
   In `UxpAddonShared.h`, `ADDON_INITIALIZER` and `ADDON_TERMINATE` are declared with `UXP_EXTERN_API_STDCALL(...)`, which expands to `__declspec(dllexport) <type> __stdcall` on `_WIN32`.
   In `UxpAddon.h`, `UXP_ADDON_INIT` and `UXP_ADDON_TERMINATE` define those functions **without** `UXP_EXTERN_API_STDCALL` (defaulting to `__cdecl`).
   This only happens to compile on 64-bit Windows (`_WIN64`) because the x64 ABI ignores `__stdcall`. On 32-bit Windows (`_WIN32` x86, which `UxpAddonShared.h` line 33 explicitly attempts to support), MSVC rejects the code with `error C2373: 'uxp_addon_init': redefinition; different type modifiers`.

3. **`uxp_addon_initialize_func` and `uxp_addon_terminate_func` omit `__stdcall` on Windows**:
   Neither typedef includes `__stdcall` on `_WIN32`, so their calling convention does not match the `UXP_EXTERN_API_STDCALL` declarations right below them.

## How to Reproduce

### JavaScript Triggerability
**C++-only bug (Header ABI / Compile-Time).** This is a C++ function signature and calling-convention mismatch in the SDK headers and cannot be triggered from JavaScript.

### C++ Reproduction
1. In C++, verify that `ADDON_INITIALIZER` / `ADDON_TERMINATE` match their typedefs in `UxpAddonShared.h`:
   ```cpp
   uxp_addon_initialize_func initFn = &ADDON_INITIALIZER;
   uxp_addon_terminate_func termFn = &ADDON_TERMINATE; // Compile error: void vs addon_value!
   ```
2. Or compile `module.cpp` with MSVC targeting 32-bit x86 (`cl /c template\template-dev\src\module.cpp`).
3. **Expected result**: Both entry points match their typedefs and compile cleanly.
4. **Actual result**: `termFn = &ADDON_TERMINATE` fails with a return type mismatch (`void` vs `addon_value`), and 32-bit Windows compilation fails with `C2373` (`__stdcall` vs `__cdecl`).

## Suggested Fix
1. Change `uxp_addon_terminate_func` return type from `addon_value` to `void` and include calling convention macros on the typedefs.
2. Use `UXP_EXTERN_API_STDCALL(addon_value)` and `UXP_EXTERN_API_STDCALL(void)` in the `UXP_ADDON_INIT` and `UXP_ADDON_TERMINATE` macros in `UxpAddon.h`.
