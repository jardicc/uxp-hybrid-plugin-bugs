# Bug 20: Incorrect Include Paths, Missing Release Settings in `Sample-Uxp-Addon.vcxproj`, and Out-of-Sync Duplicate SDK Files

## Severity
**Medium (Build Configuration Bugs & Code Duplication Drift)**

## Scope
**Template Build Configuration Only (`template/template-dev/win/Sample-Uxp-Addon.vcxproj` & `template/template-dev/src/`)** — This bug is in the sample Visual Studio project configuration and the duplicated `src/utilities/` files inside `template/template-dev/src/`.

## Affected Files
- [`template/template-dev/win/Sample-Uxp-Addon.vcxproj`](../template/template-dev/win/Sample-Uxp-Addon.vcxproj) (lines 50–86)
- [`template/template-dev/src/module.cpp`](../template/template-dev/src/module.cpp) (lines 15–17)
- [`template/template-dev/src/utilities/UxpAddon.h`](../template/template-dev/src/utilities/UxpAddon.h) vs. [`src/utilities/UxpAddon.h`](../src/utilities/UxpAddon.h)
- [`template/template-dev/src/utilities/UxpTask.h`](../template/template-dev/src/utilities/UxpTask.h) vs. [`src/utilities/UxpTask.h`](../src/utilities/UxpTask.h)
- [`template/template-dev/src/utilities/UxpValue.h`](../template/template-dev/src/utilities/UxpValue.h) vs. [`src/utilities/UxpValue.h`](../src/utilities/UxpValue.h)

## Problematic Code
In `template/template-dev/win/Sample-Uxp-Addon.vcxproj` (lines 50–86):
```xml
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Debug|x64'">
    <LinkIncremental>true</LinkIncremental>
    <TargetName>sample-uxp-addon</TargetName>
    <OutDir>$(SolutionDir)$(Platform)\$(Configuration)\</OutDir>
    <TargetExt>.uxpaddon</TargetExt>
  </PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'">
    <LinkIncremental>false</LinkIncremental>
    <TargetExt>.uxpaddon</TargetExt>
  </PropertyGroup>
...
      <AdditionalIncludeDirectories>..\..\..\..\src\api;..\..\..\..\src\utilities;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
...
      <PrecompiledHeader>NotUsing</PrecompiledHeader>
      <PrecompiledHeaderFile>pch.h</PrecompiledHeaderFile>
      <AdditionalIncludeDirectories>..\..\..\..\src\api;..\..\..\..\src\utilities;%(AdditionalIncludeDirectories)</AdditionalIncludeDirectories>
```

And in `template/template-dev/src/module.cpp` (lines 15–17):
```cpp
#include "../src/utilities/UxpAddon.h"
#include "../src/utilities/UxpTask.h"
#include "../src/utilities/UxpValue.h"
```

## Explanation
1. **`AdditionalIncludeDirectories` points outside the repository (4 levels up instead of 3)**:
   `Sample-Uxp-Addon.vcxproj` lives in `template/template-dev/win/` (3 levels below the repository root).
   The path `..\..\..\..\src\api` traverses **4** parent directories (`win` -> `template-dev` -> `template` -> `<repo-root>` -> `<parent-of-repo>`), pointing to a non-existent `<parent-of-repo>\src\api` directory outside the repository!
2. **Fragile `#include "../src/utilities/..."` in `module.cpp`**:
   `module.cpp` is already located inside `template/template-dev/src/`. Including `"../src/utilities/UxpAddon.h"` goes up to `template-dev` and back down into `src/`, which breaks if the `src` folder is ever renamed. It should simply be `"utilities/UxpAddon.h"` (or `"UxpAddon.h"` once `AdditionalIncludeDirectories` is fixed).
3. **Duplicated and out-of-sync SDK files under `template/template-dev/src/`**:
   `template/template-dev/src/api/` and `template/template-dev/src/utilities/` are full copies of `src/api/` and `src/utilities/`. The two copies have already drifted out of sync (`UxpAddon.h`, `UxpTask.h`, and `UxpValue.h` in `src/utilities/` have updated comments/typos fixed compared to `template/template-dev/src/utilities/`).
4. **Inconsistent `Release|x64` configuration in `Sample-Uxp-Addon.vcxproj`**:
   `Debug|x64` explicitly defines `<TargetName>sample-uxp-addon</TargetName>` and `<OutDir>$(SolutionDir)$(Platform)\$(Configuration)\</OutDir>`, whereas `Release|x64` omits both and includes a leftover `<PrecompiledHeaderFile>pch.h</PrecompiledHeaderFile>` even though `pch.h` does not exist in the project.

## How to Reproduce

### JavaScript Triggerability
**C++ / Build-Configuration-only bug.** This issue affects compiling and linking the Visual Studio project (`Sample-Uxp-Addon.vcxproj`) and cannot be triggered from JavaScript.

### Build / C++ Reproduction
1. In `template/template-dev/src/module.cpp`, change `#include "../src/utilities/UxpAddon.h"` to `#include "UxpAddon.h"` (relying on `AdditionalIncludeDirectories` in `Sample-Uxp-Addon.vcxproj`).
2. Build `Sample-Uxp-Addon.sln` in Visual Studio.
3. **Expected result**: `AdditionalIncludeDirectories` resolves `src/api` and `src/utilities` at the repository root (`..\..\..\src\api;..\..\..\src\utilities`).
4. **Actual result**: Compilation fails with `fatal error C1083: Cannot open include file: 'UxpAddon.h': No such file or directory` because `..\..\..\..\src\utilities` points one directory level above the repository root.

## Suggested Fix
1. Fix `AdditionalIncludeDirectories` in `Sample-Uxp-Addon.vcxproj` to `..\..\..\src\api;..\..\..\src\utilities` (3 levels up) or `..\src\api;..\src\utilities`.
2. Add `<TargetName>sample-uxp-addon</TargetName>` and `<OutDir>$(SolutionDir)$(Platform)\$(Configuration)\</OutDir>` to `Release|x64`, and remove `<PrecompiledHeaderFile>pch.h</PrecompiledHeaderFile>`.
3. In `module.cpp`, use `#include "utilities/UxpAddon.h"` (or reference the single canonical copy in `../../../src/`).
