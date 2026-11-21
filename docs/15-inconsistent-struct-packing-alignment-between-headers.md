# Bug 15: Inconsistent `#pragma pack` Struct Alignment Between `UxpAddonTypes.h` and `UxpAddonShared.h`

## Severity
**Medium (Potential ABI Struct Layout Mismatch on Windows ARM64 and 32-bit x86)**

## Scope
**SDK Core (`src/api/UxpAddonTypes.h`, `src/api/UxpAddonShared.h`)** — This bug is in the core SDK C/C++ ABI headers (and duplicated into `template/template-dev/src/api/`).

## Affected Files
- [`src/api/UxpAddonTypes.h`](../src/api/UxpAddonTypes.h) (lines 14–16)
- [`src/api/UxpAddonShared.h`](../src/api/UxpAddonShared.h) (lines 32–40)
- [`template/template-dev/src/api/UxpAddonTypes.h`](../template/template-dev/src/api/UxpAddonTypes.h) (lines 14–16)
- [`template/template-dev/src/api/UxpAddonShared.h`](../template/template-dev/src/api/UxpAddonShared.h) (lines 32–40)

## Problematic Code
In `UxpAddonTypes.h` (lines 14–16):
```c
#ifdef _WIN32
#pragma pack(push, uxp_addon_components_settings, 16)
#endif
```

In `UxpAddonShared.h` (lines 32–40):
```c
#ifdef _WIN32
// 32 bit and ARM use a default alignment of 8. 64 bit intel use 16
#if defined(_M_ARM64) && _M_ARM64
#pragma pack(push, uxp_addon_components_settings, 8)
#elif defined(_WIN64)
#pragma pack(push, uxp_addon_components_settings, 16)
#else
#pragma pack(push, uxp_addon_components_settings, 8)
#endif
#endif
```

## Explanation
`UxpAddonShared.h` explicitly documents and implements platform-specific packing on Windows:
- 8-byte packing on Windows ARM64 (`_M_ARM64`) and 32-bit Windows (`_WIN32` without `_WIN64`)
- 16-byte packing on 64-bit Intel Windows (`_WIN64`)

However, `UxpAddonTypes.h` unconditionally sets `#pragma pack(push, uxp_addon_components_settings, 16)` for all `_WIN32` targets (note that in MSVC, `_WIN32` is defined on 32-bit x86, 64-bit x64, and 64-bit ARM64!).

Furthermore, in `UxpAddonShared.h` lines 17–19:
```c
// When used in torq, we don't want to include UxpAddonTypes.h . But when used in addon, we want to include it.
#ifndef UXP_SOURCE
#include "UxpAddonTypes.h"
#endif
```
When the host application (`torq` / `UXP_SOURCE`) compiles `UxpAddonShared.h`, it does not include this `UxpAddonTypes.h`, whereas the addon does—creating a risk of struct packing divergence on Windows ARM64 or 32-bit Windows for types defined in `UxpAddonTypes.h` (`addon_property_descriptor`, `addon_extended_error_info`).

## How to Reproduce

### JavaScript Triggerability
**C++-only bug (Header ABI / Struct Packing).** This is a compile-time `#pragma pack` discrepancy between the C/C++ headers on Windows ARM64 and 32-bit x86 and cannot be triggered from JavaScript alone.

### C++ Reproduction
Inspect the preprocessing/packing settings of `UxpAddonTypes.h` vs. `UxpAddonShared.h` when compiling with MSVC for `ARM64` (`_WIN32` and `_M_ARM64` defined):
- `UxpAddonTypes.h` pushes packing `16`.
- `UxpAddonShared.h` pushes packing `8`.

## Suggested Fix
Use the exact same conditional `#pragma pack` block in `UxpAddonTypes.h` as in `UxpAddonShared.h`:

```c
#ifdef _WIN32
// 32 bit and ARM use a default alignment of 8. 64 bit intel use 16
#if defined(_M_ARM64) && _M_ARM64
#pragma pack(push, uxp_addon_components_settings, 8)
#elif defined(_WIN64)
#pragma pack(push, uxp_addon_components_settings, 16)
#else
#pragma pack(push, uxp_addon_components_settings, 8)
#endif
#endif
```
