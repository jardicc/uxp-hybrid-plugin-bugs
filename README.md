# UXP Hybrid plugin SDK – bug audit and demo

This repository is a fork of the Adobe UXP Hybrid plugin SDK that **documents and demonstrates bugs** found in the SDK headers and helpers ([src/](src)), in the sample templates ([template/](template)) and in the original SDK `README.md`.

For what a UXP Hybrid plugin is, how to build, package and load one, and the supported host applications, see the official Adobe documentation:

- [Photoshop Hybrid plugins](https://developer.adobe.com/photoshop/uxp/2022/guides/hybrid-plugins)
- [Premiere Hybrid plugins](https://developer.adobe.com/premiere-pro/uxp/plugins/hybrid-plugins/)
- [UXP Developer Tool (UDT)](https://www.adobe.com/download/uxp-developer-tools)

## Table of contents

- [Summary](#summary)
- [Bug reports](#bug-reports)
- [Demo plugin](#demo-plugin)
- [Crash log analysis](#crash-log-analysis)
- [Repository layout](#repository-layout)

## Summary

The audit found **21 bugs**:

- **15 in the reusable SDK core** (`src/api/`, `src/utilities/`) – every hybrid plugin that includes these files inherits them.
- **5 only in the sample template** (`template/`) – sample JavaScript, sample C++ addon and the Visual Studio project.
- **1 in the original SDK documentation** – broken code examples and a threading contradiction.

Eleven of them can be triggered directly from JavaScript, three partially (they need a specific C++ failure path), and seven cannot be triggered from JavaScript at all (headers, ABI, compile-time and build configuration).

## Bug reports

Each bug has its own report with the affected files, problematic code, root cause, reproduction steps and a suggested fix. The full overview table, the SDK-vs-template breakdown and the JS-vs-C++ reproducibility breakdown are in [docs/README.md](docs/README.md).

| #  | Severity    | Scope             | Bug                                                                                                                                          | JS repro |
| -- | ----------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 01 | High        | SDK core          | [JS Array misclassified as map in `UxpValue`](docs/01-js-array-misclassified-as-map-in-uxpvalue.md)                                          | Yes      |
| 02 | Critical    | Template (JS)     | [Undefined variable `result` in `main.js` async echo](docs/02-undefined-variable-result-in-main-js-async-echo.md)                            | Yes      |
| 03 | High        | SDK core          | [`Value` move constructor leaves dangling kind, causing null deref](docs/03-value-move-constructor-leaves-dangling-kind-causing-null-deref.md) | Partial  |
| 04 | Medium-High | SDK core          | [`Value` missing move assignment and copy operations](docs/04-value-missing-move-assignment-and-copy-operations.md)                          | No       |
| 05 | High        | SDK core          | [Memory leak in `Value` constructor on exception](docs/05-memory-leak-in-value-constructor-on-exception.md)                                  | Yes      |
| 06 | Medium-High | SDK core          | [JS `null` and other types unsupported in `UxpValue`](docs/06-js-null-and-other-types-unsupported-in-uxpvalue.md)                            | Yes      |
| 07 | Medium-High | SDK core          | [`GetMap` fails on numeric / non-string property keys](docs/07-getmap-fails-on-numeric-or-non-string-property-keys.md)                       | Yes      |
| 08 | Medium      | SDK core          | [`GetString` truncates strings with embedded null bytes](docs/08-getstring-truncates-strings-with-embedded-null-bytes.md)                    | Yes      |
| 09 | Critical    | SDK core          | [SDK throws C string literals not caught by `std::exception` handlers](docs/09-sdk-throws-c-string-literals-not-caught-by-std-exception-handlers.md) | Yes |
| 10 | High        | SDK core + addon  | [`CreateErrorFromException` returns an Error value instead of throwing](docs/10-createerrorfromexception-returns-error-value-instead-of-throwing-js-exception.md) | Yes |
| 11 | High        | SDK core + addon  | [Unresolved Promise and deferred leak on async task failure](docs/11-unresolved-promise-and-deferred-leak-on-async-task-failure.md)         | Partial  |
| 12 | Medium-High | SDK core          | [Task state management and thread-safety flaws](docs/12-task-state-management-and-thread-safety-flaws.md)                                    | No       |
| 13 | High        | SDK core          | [Missing `#define` in `UXP_EXTERN_API_STDCALL` macro](docs/13-missing-define-in-uxp-extern-api-stdcall-macro.md)                             | No       |
| 14 | High        | SDK core          | [`terminate` function typedef and `__stdcall` mismatch](docs/14-terminate-function-typedef-and-stdcall-calling-convention-mismatch.md)       | No       |
| 15 | Medium      | SDK core          | [Inconsistent struct packing between headers](docs/15-inconsistent-struct-packing-alignment-between-headers.md)                              | No       |
| 16 | Medium      | SDK core          | [C incompatibility and rvalue reference in `extern "C"` ABI](docs/16-c-incompatibility-and-rvalue-reference-in-extern-c-abi.md)              | No       |
| 17 | High        | Template (C++)    | [Uninitialized `arg1` in `MyEcho` / `MyAsyncEcho` with no args](docs/17-uninitialized-arg1-in-myecho-and-myasyncecho-when-called-with-no-args.md) | Yes |
| 18 | Medium      | Template (C++)    | [`Init` continues after error and overwrites exceptions](docs/18-init-in-module-cpp-continues-after-error-and-overwrites-exceptions.md)      | Partial  |
| 19 | Medium      | Template (JS)     | [DOM dialog `appendChild` and leak in `main.js`](docs/19-dom-dialog-appendchild-and-leak-in-main-js.md)                                      | Yes      |
| 20 | Medium      | Template (build)  | [`.vcxproj` wrong include paths and missing Release settings](docs/20-vcxproj-wrong-include-paths-and-missing-release-settings.md)          | No       |
| 21 | Medium      | Documentation     | [Original README: broken code examples and threading contradiction](docs/21-readme-broken-code-examples-and-threading-contradiction.md)     | Yes      |

## Demo plugin

[template/template-plugin](template/template-plugin) is the **UXP Hybrid SDK Bug Repro Suite** (`com.adobe.testPlugin`), a ready-to-load plugin with prebuilt `sample-uxp-addon.uxpaddon` binaries.

- Its panel ([main.js](template/template-plugin/main.js)) has one section per JavaScript-reproducible bug (#01, #02, #05–#10, #17, #19, #21).
- Most sections have a button for the **buggy behavior** and a button for the **expected behavior**, so the difference is visible side by side.
- A *run all safe repros* action runs the non-crashing repros in one go.
- Load the plugin in the [UXP Developer Tool](https://www.adobe.com/download/uxp-developer-tools) and pick a host application that supports hybrid plugins (see the Adobe documentation above).

> **Warning:** Some repros can exhaust memory (#05 leaks 512 MB per iteration, and it is part of *run all safe repros*) or crash the host application (the #09 sync/async crash buttons, which are not part of *run all safe repros*). Save your work before running them.

The addon itself is built from [template/template-dev](template/template-dev) (Visual Studio solution in `win/`, Xcode project in `mac/`), which contains a copy of the SDK sources from [src/](src).

## Crash log analysis

[docs/crashlog-analysis-and-sdk-parallels.md](docs/crashlog-analysis-and-sdk-parallels.md) analyses two Adobe Crash Reporter logs (InDesign `0xc0000005` in `dynamic-torqnative.dll`, Photoshop `0x80000003` in `libdynamic-napi.dll`) and compares them with the SDK bugs above.

## Repository layout

| Path                                                   | Content                                                              |
| ------------------------------------------------------ | -------------------------------------------------------------------- |
| [docs/](docs)                                          | Bug reports, overview and crash log analysis                         |
| [src/api/](src/api)                                    | C ABI headers of the SDK (bugs #13–#16)                              |
| [src/utilities/](src/utilities)                        | C++ helpers: `Value`, `Task`, addon macros (bugs #01, #03–#12)       |
| [template/template-dev/](template/template-dev)        | Sample addon sources and Visual Studio / Xcode projects              |
| [template/template-plugin/](template/template-plugin)  | The demo plugin (Bug Repro Suite) with prebuilt addon binaries       |
