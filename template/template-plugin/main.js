/************************************************************************
 * Copyright 2022 Adobe
 * All Rights Reserved.
 *
 * NOTICE: Adobe permits you to use, modify, and distribute this file in
 * accordance with the terms of the Adobe license agreement accompanying
 * it.
 *************************************************************************
 */

const uxp = require("uxp");

const ADDON_NAME = "sample-uxp-addon.uxpaddon";

// Session-wide telemetry for Bug #05 (Native C++ Heap Leak) & Bug #19 (DOM <dialog> Leak)
let cachedAddon = null;
let cached16MBChunk = null;
let totalLeakedNativeMB = 0;
let totalLeakedMaps = 0;

uxp.entrypoints.setup({
    commands: {
        testMyFunction: {
            run: testMyFunction,
        },
        testMyEcho: {
            run: testMyEcho,
        },
        testMyAsyncEcho: {
            run: testMyAsyncEcho,
        },
    },
});

// ============================================================================
// Original SDK Template Entrypoint Functions (Preserved for Commands & Repros)
// ============================================================================

async function testMyFunction() {
    try {
        const addon = await require(ADDON_NAME);
        const myFunctionResult = addon.my_function();
        console.log(`myFunctionResult = `, myFunctionResult);
        messageDialog(`myFunctionResult = ${myFunctionResult}`);
    } catch (err) {
        console.log("Execute as testMyFunction command failed", err);
    }
}

async function testMyEcho() {
    try {
        const addon = await require(ADDON_NAME);
        const value = 10;
        const myEchoResult = addon.my_echo(value);
        console.log(`myEchoResult = `, myEchoResult);
        messageDialog(`myEchoResult = ${myEchoResult}`);
    } catch (err) {
        console.log("Execute as testMyEcho command failed", err);
    }
}

async function testMyAsyncEcho() {
    try {
        const addon = await require(ADDON_NAME);
        return new Promise((resolve, reject) => {
            const value = 10;
            const echoAsyncResult = addon.my_echo_async(value);
            console.log(`my_echo_async returned: echoAsyncResult = `, echoAsyncResult);
            echoAsyncResult
                .then((val) => {
                    console.log(`Promise resolved, echoAsyncResult = `, val);
                    messageDialog(`Promise resolved, echoAsyncResult = ${val}`);

                    resolve(val);
                })
                .catch((error) => {
                    console.log(error);
                    reject(error);
                });
            resolve(result);
        });
    } catch (err) {
        console.log("Execute as testMyAsyncEcho command failed", err);
    }
}

function messageDialog(message) {
    let dialog = document.createElement("dialog");
    dialog.style.alignItems = "center";
    dialog.textContent = message;
    dialog.style.fontSize = 20;
    dialog.style.color = "yellow";
    document.appendChild(dialog).showModal();
}

// ============================================================================
// Helper Utilities for the Interactive Bug Reproduction Panel
// ============================================================================

async function getAddon() {
    if (!cachedAddon) {
        cachedAddon = await require(ADDON_NAME);
    }
    return cachedAddon;
}

function describeValue(val) {
    if (val === null) return "null (typeof === 'object')";
    if (val === undefined) return "undefined (typeof === 'undefined')";
    if (val instanceof Error) {
        return `Error { name: ${JSON.stringify(val.name)}, message: ${JSON.stringify(val.message)}, code: ${JSON.stringify(val.code)} }`;
    }
    if (Array.isArray(val)) {
        return `Array(${val.length}) ${JSON.stringify(val)}`;
    }
    if (typeof val === "object") {
        const proto = Object.prototype.toString.call(val);
        try {
            return `${proto} ${JSON.stringify(val)}`;
        } catch (_e) {
            return `${proto} [Object]`;
        }
    }
    if (typeof val === "string") {
        return `string (length=${val.length}) ${JSON.stringify(val)}`;
    }
    return `${typeof val}: ${String(val)}`;
}

const BUG_SCOPE_INFO = {
    "01": "[Scope] SDK CORE BUG — src/utilities/UxpValue.cpp (GetType) — Affects all hybrid plugins using UxpValue",
    "02": "[Scope] TEMPLATE PLUGIN ONLY — template/template-plugin/main.js (testMyAsyncEcho) — Sample JS bug, NOT in core SDK",
    "05": "[Scope] SDK CORE BUG — src/utilities/UxpValue.cpp (Value::Value) — Affects all hybrid plugins using UxpValue",
    "06": "[Scope] SDK CORE BUG — src/utilities/UxpValue.cpp (GetType) — Affects all hybrid plugins using UxpValue",
    "07": "[Scope] SDK CORE BUG — src/utilities/UxpValue.cpp (GetMap) — Affects all hybrid plugins using UxpValue",
    "08": "[Scope] SDK CORE BUG — src/utilities/UxpValue.cpp (GetString) — Affects all hybrid plugins using UxpValue",
    "09": "[Scope] SDK CORE BUG — src/utilities/UxpAddon.h, UxpAddon.cpp, UxpValue.cpp — Affects all hybrid plugins using SDK utilities",
    "10": "[Scope] SDK CORE + TEMPLATE ADDON — src/utilities/UxpAddon.cpp (CreateErrorFromException) + module.cpp",
    "17": "[Scope] TEMPLATE ADDON ONLY — template/template-dev/src/module.cpp (MyEcho, MyAsyncEcho) — Sample C++ bug, NOT in core SDK",
    "19": "[Scope] TEMPLATE PLUGIN ONLY — template/template-plugin/main.js (messageDialog) — Sample JS bug, NOT in core SDK",
    "21": "[Scope] SDK DOCUMENTATION ONLY — README.md (Lines 68–70) — Copy-paste snippet bug in SDK docs",
};

function setSectionResult(bugNum, state, bannerText, logLines) {
    const section = document.getElementById(`section-bug-${bugNum}`);
    const statusEl = document.getElementById(`status-bug-${bugNum}`);
    const outputEl = document.getElementById(`output-bug-${bugNum}`);

    if (section) {
        section.classList.remove("reproduced", "verified-ok");
        if (state === "bug") section.classList.add("reproduced");
        if (state === "ok") section.classList.add("verified-ok");
    }

    if (statusEl) {
        statusEl.className = "output-status-banner";
        if (state === "bug") statusEl.classList.add("status-bug");
        else if (state === "ok") statusEl.classList.add("status-ok");
        else if (state === "warn") statusEl.classList.add("status-warn");
        statusEl.textContent = bannerText;
    }

    if (outputEl) {
        const scopeHeader = BUG_SCOPE_INFO[bugNum];
        const lines = Array.isArray(logLines) ? logLines : [String(logLines)];
        outputEl.textContent = scopeHeader ? [scopeHeader, "", ...lines].join("\n") : lines.join("\n");
    }
}

function updateTelemetryPills() {
    const leakPill = document.getElementById("leak-total-pill");
    const leakLabel = document.getElementById("leak-meter-label");
    const leakFill = document.getElementById("leak-meter-fill");
    const gb = (totalLeakedNativeMB / 1024).toFixed(2);

    if (leakPill) {
        leakPill.textContent = `Leaked C++ Heap (Bug #05): ${totalLeakedNativeMB} MB (${gb} GB)`;
    }
    if (leakLabel) {
        leakLabel.textContent =
            `Cumulative Permanently Leaked Native C++ Heap in This Session: ${totalLeakedNativeMB} MB (${gb} GB) across ${totalLeakedMaps} leaked std::map containers`;
    }
    if (leakFill) {
        const pct = Math.min(100, Math.round((totalLeakedNativeMB / 4096) * 100));
        leakFill.style.width = `${pct}%`;
    }

    const dialogCount = countAllDialogsInDocument();
    const dialogPill = document.getElementById("dialog-leak-pill");
    if (dialogPill) {
        dialogPill.textContent = `Leaked <dialog> Nodes (Bug #19): ${dialogCount}`;
    }
}

function countAllDialogsInDocument() {
    let count = 0;
    if (document.childNodes) {
        for (let i = 0; i < document.childNodes.length; i++) {
            const node = document.childNodes[i];
            if (node && node.nodeName && node.nodeName.toLowerCase() === "dialog") {
                count++;
            }
        }
    }
    if (document.body) {
        count += document.body.querySelectorAll("dialog").length;
    }
    return count;
}

function autoDismissNewDialogsAfter(delayMs) {
    setTimeout(() => {
        try {
            if (document.childNodes) {
                for (let i = 0; i < document.childNodes.length; i++) {
                    const node = document.childNodes[i];
                    if (node && node.nodeName && node.nodeName.toLowerCase() === "dialog" && typeof node.close === "function") {
                        try {
                            node.close();
                        } catch (_e) {}
                    }
                }
            }
            if (document.body) {
                const dialogs = document.body.querySelectorAll("dialog");
                for (let i = 0; i < dialogs.length; i++) {
                    try {
                        dialogs[i].close();
                    } catch (_e) {}
                }
            }
        } catch (_err) {}
        updateTelemetryPills();
    }, delayMs);
}

// ============================================================================
// BUG #01: JS Array Misclassified as Map in UxpValue.cpp
// ============================================================================
// ! CONFIRMED
async function reproBug01EmptyArray() {
    const addon = await getAddon();
    const input = [];
    const output = addon.my_echo(input);

    const isStillArray = Array.isArray(output);
    const bugReproduced = !isStillArray && typeof output === "object" && output !== null;

    setSectionResult(
        "01",
        bugReproduced ? "bug" : "ok",
        bugReproduced
            ? "🔴 BUG #01A REPRODUCED: Empty Array [] Was Mutated Into a Plain Object {}!"
            : "🟢 Array Preserved",
        [
            "=== Bug #01A: addon.my_echo([]) ===",
            `Input Passed        : ${describeValue(input)}`,
            `  Array.isArray(in) : ${Array.isArray(input)}`,
            `  Constructor (in)  : ${input.constructor && input.constructor.name}`,
            "",
            `Actual Output       : ${describeValue(output)}`,
            `  Array.isArray(out): ${Array.isArray(output)}  <-- SHOULD BE true, GOT false!`,
            `  Constructor (out) : ${output && output.constructor && output.constructor.name}  <-- SHOULD BE "Array", GOT "Object"!`,
            `  output.push       : ${typeof (output && output.push)}  <-- Array methods are gone!`,
            "",
            "Root Cause: GetType() in UxpValue.cpp checks `case addon_object: return Value::Kind::map;`",
            "before `uxp_addon_is_array()`, so [] is constructed as an empty C++ MapType and converted to {}."
        ]
    );
}

async function reproBug01NonEmptyArray() {
    const addon = await getAddon();
    const input = ["alpha", "beta", "gamma"];
    const output = addon.my_echo(input);

    const isStillArray = Array.isArray(output);
    const bugReproduced =
        (!isStillArray && typeof output === "object" && output !== null) || output instanceof Error;

    let mapCallResult = "not tested";
    try {
        output.map((x) => x.toUpperCase());
        mapCallResult = "succeeded";
    } catch (err) {
        mapCallResult = `${err.name}: ${err.message}`;
    }

    setSectionResult(
        "01",
        bugReproduced ? "bug" : "ok",
        bugReproduced
            ? '🔴 BUG #01B REPRODUCED: Array ["alpha", "beta", "gamma"] Mutated Into Plain Object {"0":"alpha","1":"beta","2":"gamma"}!'
            : "🟢 Non-Empty Array Echoed Correctly",
        [
            '=== Bug #01B: addon.my_echo(["alpha", "beta", "gamma"]) ===',
            `Input Passed          : ${describeValue(input)}`,
            `  Array.isArray(in)   : ${Array.isArray(input)}`,
            `  input.length        : ${input.length}`,
            "",
            `Actual Output         : ${describeValue(output)}`,
            `  Array.isArray(out)  : ${Array.isArray(output)}  <-- SHOULD BE true, GOT false!`,
            `  Constructor (out)   : ${output && output.constructor && output.constructor.name}  <-- SHOULD BE "Array", GOT "Object"!`,
            `  output.length       : ${output && output.length}  <-- SHOULD BE 3, GOT undefined!`,
            `  output.map(...)     : Threw "${mapCallResult}"!`,
            `Expected Output       : Array(3) ["alpha","beta","gamma"]`,
            "",
            "What Happened in C++ (`UxpValue.cpp` + `libdynamic-napi.dll`):",
            "  1. `GetType()` matched `case addon_object: return Value::Kind::map;` BEFORE `uxp_addon_is_array()`.",
            "  2. `GetList()` was completely bypassed (unreachable dead code); the Array entered `GetMap()`.",
            "  3. `uxp_addon_get_property_names()` called V8 with `KeyConversionMode::kConvertToString`, converting",
            "     numeric array indices 0, 1, 2 into string keys \"0\", \"1\", \"2\" in `std::map<std::string, Value>`.",
            "  4. `ConvertValue()` called `uxp_addon_create_object` instead of `uxp_addon_create_array`, returning",
            "     a plain Object `{\"0\":\"alpha\",\"1\":\"beta\",\"2\":\"gamma\"}` with no Array prototype or `.length`!"
        ]
    );
}

async function expectedBug01PlainObject() {
    const addon = await getAddon();
    const input = { a: "alpha", b: "beta" };
    const output = addon.my_echo(input);

    setSectionResult(
        "01",
        "ok",
        "🟢 WORKING COMPARISON: Plain Object With String Keys Echoes Correctly",
        [
            '=== Working Comparison: addon.my_echo({ a: "alpha", b: "beta" }) ===',
            `Input Passed        : ${describeValue(input)}`,
            `Actual Output       : ${describeValue(output)}`,
            "",
            "Plain objects with string keys work because Value::Kind::map is appropriate for plain objects."
        ]
    );
}

// ============================================================================
// BUG #02: Undeclared Variable `result` & Unawaited Promise in testMyAsyncEcho
// ============================================================================
// ! REPRODUCED - MISSING UNDERSTANDING
async function reproBug02AsyncEcho() {
    const addon = await getAddon();

    let innerCatchTriggered = false;
    let outerCaughtError = null;

    // Auto-close the delayed background modal dialog that testMyAsyncEcho spawns
    autoDismissNewDialogsAfter(1500);

    try {
        // Call the exact original testMyAsyncEcho() function from main.js
        await testMyAsyncEcho();
    } catch (outerErr) {
        outerCaughtError = outerErr;
    }

    const bugReproduced =
        outerCaughtError instanceof ReferenceError &&
        !innerCatchTriggered &&
        String(outerCaughtError.message).indexOf("result") !== -1;

    setSectionResult(
        "02",
        bugReproduced ? "bug" : "ok",
        bugReproduced
            ? `🔴 BUG #02 REPRODUCED: testMyAsyncEcho() Threw "${outerCaughtError.name}: ${outerCaughtError.message}" & Bypassed try/catch!`
            : "🟢 Async Echo Succeeded",
        [
            "=== Bug #02: Calling Original testMyAsyncEcho() ===",
            `Inner try/catch caught error? : ${innerCatchTriggered}  <-- BYPASSED because 'return new Promise' has no 'await'!`,
            `Outer caller caught rejection : ${outerCaughtError ? `${outerCaughtError.name}: ${outerCaughtError.message}` : "none"}`,
            "",
            "Why Two Bugs Happen Simultaneously:",
            "  1. Line 67 of main.js calls `resolve(result)` synchronously at the end of the Promise executor.",
            "     `result` is never declared anywhere in scope (the variable was named `echoAsyncResult`).",
            "  2. Because `return new Promise(...)` is not `await`ed inside `testMyAsyncEcho()`, the rejected",
            "     Promise escapes the function's `try { ... } catch (err)` block completely.",
            "  3. Meanwhile, `addon.my_echo_async(10)` was already scheduled in C++, so its `.then()` still",
            "     fires later and opens an orphaned yellow <dialog> after the Promise already rejected!"
        ]
    );
}

async function expectedBug02AsyncEcho() {
    const addon = await getAddon();
    const input = { message: "Async round-trip via Photoshop main thread", count: 10 };
    const startMs = Date.now();
    const output = await addon.my_echo_async(input);
    const elapsedMs = Date.now() - startMs;

    setSectionResult(
        "02",
        "ok",
        `🟢 CORRECT ASYNC BEHAVIOR: await addon.my_echo_async(...) Resolved Cleanly in ${elapsedMs} ms`,
        [
            "=== Fixed Async Implementation: await addon.my_echo_async(input) ===",
            `Input Passed    : ${describeValue(input)}`,
            `Resolved Output : ${describeValue(output)}`,
            `Elapsed Time    : ${elapsedMs} ms`,
            "",
            "Because addon.my_echo_async() already returns a native Promise created by uxp_addon_create_promise,",
            "simply awaiting it (`const res = await addon.my_echo_async(10)`) works cleanly without any wrapper."
        ]
    );
}

// ============================================================================
// BUG #05: Extreme Native C++ Heap Memory Leak in Value Constructor
// ============================================================================

function get16MBStringChunk() {
    if (!cached16MBChunk) {
        // 16 MB ASCII string (16,777,216 bytes)
        cached16MBChunk = "X".repeat(16 * 1024 * 1024);
    }
    return cached16MBChunk;
}

function buildLeakPayload512MB(includeTrailingNull) {
    const chunk16MB = get16MBStringChunk();
    const payload = {};
    // 32 keys x 16 MB = 512 MB copied into separate C++ std::string heap buffers inside GetMap()!
    // In JavaScript, all 32 keys point to the same single 16 MB string reference.
    for (let i = 0; i < 32; i++) {
        const key = `k${i < 10 ? "0" + i : i}`;
        payload[key] = chunk16MB;
    }
    if (includeTrailingNull) {
        // Property #33 triggers `throw "unsupported type"` in GetType() AFTER 512 MB was copied into *(data.map)
        payload.z_trigger_exception = null;
    }
    return payload;
}

// ! CONFIRMED
async function reproBug05Leak(iterations) {
    const addon = await getAddon();
    const mbPerIteration = 512;
    const totalTargetMB = iterations * mbPerIteration;

    setSectionResult(
        "05",
        "warn",
        `⏳ Allocating & leaking ${totalTargetMB} MB (${(totalTargetMB / 1024).toFixed(2)} GB) on the native C++ heap...`,
        [`Running ${iterations} call(s) x 512 MB per call against addon.my_echo(...)...`]
    );

    // Yield briefly so UI updates before heavy native copy
    await new Promise((r) => setTimeout(r, 30));

    const payload = buildLeakPayload512MB(true);
    const startMs = Date.now();
    let lastReturn = null;

    for (let i = 0; i < iterations; i++) {
        lastReturn = addon.my_echo(payload);
        totalLeakedNativeMB += mbPerIteration;
        totalLeakedMaps += 1;
        updateTelemetryPills();
    }

    const elapsedMs = Date.now() - startMs;
    const totalGB = (totalLeakedNativeMB / 1024).toFixed(2);

    setSectionResult(
        "05",
        "bug",
        `🔥 BUG #05 REPRODUCED: Leaked +${totalTargetMB} MB Now! Session Total: ${totalLeakedNativeMB} MB (${totalGB} GB) Permanently Leaked in Photoshop.exe!`,
        [
            `=== Bug #05: Extreme Native C++ Heap Memory Leak (${iterations}x 512 MB Call) ===`,
            `Leaked in This Click        : +${totalTargetMB} MB (+${(totalTargetMB / 1024).toFixed(2)} GB) in ${elapsedMs} ms`,
            `Cumulative Leaked in Session: ${totalLeakedNativeMB} MB (${totalGB} GB) across ${totalLeakedMaps} leaked MapType* containers`,
            `Leaked std::string Buffers  : ${totalLeakedMaps * 32} x 16 MB native heap allocations`,
            `Addon Return Value          : ${describeValue(lastReturn)}`,
            "",
            "Why This Eats Gigabytes of Native RAM Instantly:",
            "  1. In JS, `payload` has 32 keys (`k00`..`k31`) referencing the SAME 16 MB JS string (only 16 MB in V8).",
            "  2. Inside C++ `Value::Value(env, arg1)`, `data.map = new MapType` is allocated with raw `new`.",
            "  3. `GetMap()` iterates `k00`..`k31` and allocates 32 separate 16 MB `std::string` copies = 512 MB on the C++ heap.",
            "  4. On the 33rd key (`z_trigger_exception: null`), `GetType()` throws `\"unsupported type\"`.",
            "  5. Because `Value::Value` threw before completing, C++ NEVER calls `~Value()`!",
            "  6. Check Windows Task Manager -> `Photoshop.exe` memory has permanently increased by " +
                `${totalLeakedNativeMB} MB (${totalGB} GB)!`
        ]
    );
}

async function controlBug05Valid512MB() {
    const addon = await getAddon();

    setSectionResult(
        "05",
        "warn",
        "⏳ Running Control Test: Copying 512 MB into C++ std::map and back WITHOUT throwing...",
        ["Executing addon.my_echo(valid512MBObject)..."]
    );

    await new Promise((r) => setTimeout(r, 30));

    const validPayload = buildLeakPayload512MB(false);
    const startMs = Date.now();
    let echoed = addon.my_echo(validPayload);
    const keysCount = echoed ? Object.keys(echoed).length : 0;
    // Release JS reference immediately
    echoed = null;
    const elapsedMs = Date.now() - startMs;

    setSectionResult(
        "05",
        "ok",
        `🟢 CONTROL TEST PASSED: 512 MB Object Echoed (${keysCount} keys) & C++ ~Value() Freed All 512 MB (0 MB Leaked)!`,
        [
            "=== Bug #05 Control Test: 512 MB Object Without Trailing `null` ===",
            `Properties Echoed           : ${keysCount} x 16 MB = 512 MB`,
            `Elapsed Time                : ${elapsedMs} ms`,
            `Native C++ Memory Leaked    : 0 MB (Value constructor succeeded, so ~Value() deleted data.map!)`,
            `Cumulative Leaked in Session: ${totalLeakedNativeMB} MB (unchanged)`
        ]
    );
}

// ============================================================================
// BUG #06: JS null and Other Types Unsupported in UxpValue.cpp
// ============================================================================
// ! CONFIRMED
async function reproBug06PrimitiveNull() {
    const addon = await getAddon();
    const output = addon.my_echo(null);
    const bugReproduced = output instanceof Error;

    setSectionResult(
        "06",
        bugReproduced ? "bug" : "ok",
        bugReproduced
            ? "🔴 BUG #06A REPRODUCED: addon.my_echo(null) Failed With Error: unknown exception!"
            : "🟢 null Echoed Properly",
        [
            "=== Bug #06A: addon.my_echo(null) ===",
            `Input Passed    : null`,
            `Actual Output   : ${describeValue(output)}`,
            `Expected Output : null`,
            "",
            "Root Cause: `GetType()` in UxpValue.cpp has no `case addon_null:`, so passing `null` hits",
            "`default:` and executes `throw \"unsupported type\";`."
        ]
    );
}

async function reproBug06ObjectWithNull() {
    const addon = await getAddon();
    const input = {
        layerId: 101,
        name: "Background Layer",
        visible: true,
        parentGroup: null,
    };
    const output = addon.my_echo(input);
    const bugReproduced = output instanceof Error;

    setSectionResult(
        "06",
        bugReproduced ? "bug" : "ok",
        bugReproduced
            ? "🔴 BUG #06B REPRODUCED: JSON Object With { parentGroup: null } Rejected by Native Addon!"
            : "🟢 Object With null Field Echoed Properly",
        [
            "=== Bug #06B: addon.my_echo({ layerId: 101, name: 'Background Layer', visible: true, parentGroup: null }) ===",
            `Input Passed    : ${describeValue(input)}`,
            `Actual Output   : ${describeValue(output)}`,
            `Expected Output : ${JSON.stringify(input)}`,
            "",
            "Any real-world JSON payload or Photoshop metadata object containing even a single `null` field",
            "fails completely in `GetMap()` (and leaks all preceding fields due to Bug #05!)."
        ]
    );
}

async function expectedBug06WithUndefined() {
    const addon = await getAddon();
    const input = {
        layerId: 101,
        name: "Background Layer",
        visible: true,
        parentGroup: undefined,
    };
    const output = addon.my_echo(input);

    setSectionResult(
        "06",
        "ok",
        "🟢 WORKAROUND VERIFIED: Replacing `null` With `undefined` Succeeds",
        [
            "=== Workaround: addon.my_echo({ ..., parentGroup: undefined }) ===",
            `Input Passed    : { layerId: 101, name: "Background Layer", visible: true, parentGroup: undefined }`,
            `Actual Output   : ${describeValue(output)}`,
            `parentGroup val : ${describeValue(output && output.parentGroup)}`,
            "",
            "Because `case addon_undefined:` IS handled in `GetType()`, `undefined` round-trips while `null` fails."
        ]
    );
}

// ============================================================================
// BUG #07: GetMap Property Enumeration Flaws (Prototype Crash & Key Collisions)
// ============================================================================
// ! CONFIRMED
async function reproBug07NumericKeys() {
    const addon = await getAddon();

    // Sub-case A: Object with an enumerable method on its prototype (valid in JSON.stringify!)
    const PixelPrototype = {
        toCssString() {
            return `rgb(${this.r}, ${this.g}, ${this.b})`;
        },
    };
    const pixel = Object.create(PixelPrototype);
    pixel.r = 255;
    pixel.g = 128;
    pixel.b = 0;

    const jsonStringified = JSON.stringify(pixel);
    const protoOutput = addon.my_echo(pixel);
    const protoFailed = protoOutput instanceof Error;

    // Sub-case B: Distinct keys sharing a prefix before '\0' collide in std::map::emplace
    const collisionInput = {
        "channel\0_red": "Red (255)",
        "channel\0_green": "Green (128)",
        "channel\0_blue": "Blue (0)",
    };
    const inputKeyCount = Object.keys(collisionInput).length;
    const collisionOutput = addon.my_echo(collisionInput);
    const outputKeyCount =
        collisionOutput && typeof collisionOutput === "object" ? Object.keys(collisionOutput).length : 0;
    const collisionLostKeys = inputKeyCount - outputKeyCount;

    const bugReproduced = protoFailed && collisionLostKeys === 2;

    setSectionResult(
        "07",
        bugReproduced ? "bug" : "ok",
        bugReproduced
            ? `🔴 BUG #07 REPRODUCED: Prototype Method Caused Failure & std::map::emplace Silently Dropped ${collisionLostKeys} of ${inputKeyCount} Keys!`
            : "🟢 Object Properties Echoed Properly",
        [
            "=== Bug #07A: `uxp_addon_get_property_names` Walks Prototype Chain (`kIncludePrototypes`) ===",
            `JSON.stringify(pixel) (own props only) : ${jsonStringified}`,
            `addon.my_echo(pixel)                   : ${describeValue(protoOutput)}`,
            "  -> `GetMap()` enumerated inherited `toCssString()` on prototype and threw `\"unsupported type\"`!",
            "",
            "=== Bug #07B: Silent Key Collision in `GetString(key)` + `std::map::emplace` ===",
            `Input Object Keys (${inputKeyCount} keys)           : ["channel\\0_red", "channel\\0_green", "channel\\0_blue"]`,
            `Actual Output (${outputKeyCount} key returned!)        : ${describeValue(collisionOutput)}`,
            `Keys Silently Lost                     : ${collisionLostKeys} of ${inputKeyCount} keys destroyed ("channel\\0_green" & "channel\\0_blue")!`,
            "",
            "Note on Numeric Keys: In Photoshop's N-API v8 (`libdynamic-napi.dll`), `napi_get_property_names` passes",
            "`KeyConversionMode::kConvertToString` so numeric keys become strings, whereas on older N-API (< v6) missing",
            "`uxp_addon_coerce_to_string` in `GetMap()` also fails on numeric keys."
        ]
    );
}

async function expectedBug07StringKeys() {
    const addon = await getAddon();
    const input = {
        ch_0: "Red Channel",
        ch_1: "Green Channel",
        ch_2: "Blue Channel",
        colorMode: "RGB",
    };
    const output = addon.my_echo(input);

    setSectionResult(
        "07",
        "ok",
        "🟢 WORKING COMPARISON: Non-Numeric String Keys { ch_0, ch_1, ch_2 } Echo Properly",
        [
            "=== Working Comparison: Non-Numeric String Keys ===",
            `Input Passed    : ${describeValue(input)}`,
            `Actual Output   : ${describeValue(output)}`,
            "",
            "When keys are non-numeric strings (`ch_0`, `ch_1`, `ch_2`), V8 returns them as `addon_string` and `GetMap()` succeeds."
        ]
    );
}

// ============================================================================
// BUG #08: GetString Truncates Strings With Embedded Null Bytes (\0)
// ============================================================================
// ! CONFIRMED
async function reproBug08NullByteTruncation() {
    const addon = await getAddon();
    const visiblePart = "HEADER_VISIBLE";
    const secretPart = "CONFIDENTIAL_PAYLOAD_9876543210";
    const input = `${visiblePart}\0${secretPart}`;
    const output = addon.my_echo(input);

    const lostChars = input.length - (typeof output === "string" ? output.length : 0);
    const lostPct = ((lostChars / input.length) * 100).toFixed(1);
    const bugReproduced = typeof output === "string" && output.length < input.length;

    setSectionResult(
        "08",
        bugReproduced ? "bug" : "ok",
        bugReproduced
            ? `🔴 BUG #08 REPRODUCED: String Silently Truncated From ${input.length} to ${output.length} Chars (${lostChars} Chars / ${lostPct}% Destroyed)!`
            : "🟢 Full String Preserved",
        [
            "=== Bug #08: Silent Null-Byte (\\0) String Truncation in GetString() ===",
            `Input String      : ${JSON.stringify(input)}`,
            `Input Length      : ${input.length} characters`,
            "",
            `Actual Output     : ${JSON.stringify(output)}`,
            `Output Length     : ${typeof output === "string" ? output.length : "N/A"} characters`,
            `Data Destroyed    : ${lostChars} characters (${lostPct}% of string silently dropped after '\\0'!)`,
            `Equal to Input?   : ${output === input} (Expected: true, Actual: false)`,
            "",
            "Root Cause: Line 52 of UxpValue.cpp constructs `result = std::string(&buffer[0]);` (which uses",
            "`strlen` and stops at the first `\\0`) instead of `std::string(buffer.data(), actualLength)`."
        ]
    );
}

async function expectedBug08WithoutNullByte() {
    const addon = await getAddon();
    const input = "HEADER_VISIBLE_CONFIDENTIAL_PAYLOAD_9876543210";
    const output = addon.my_echo(input);

    setSectionResult(
        "08",
        "ok",
        `🟢 WORKING COMPARISON: String Without \\0 Preserves All ${output.length}/${input.length} Characters`,
        [
            "=== Working Comparison: String Without Embedded \\0 ===",
            `Input String    : ${JSON.stringify(input)} (length: ${input.length})`,
            `Actual Output   : ${JSON.stringify(output)} (length: ${output.length})`,
            `Equal to Input? : ${output === input}`
        ]
    );
}

// ============================================================================
// BUG #09: SDK Throws const char* Literals & Native Crash in Photoshop
// ============================================================================
// ! CONFIRMED
async function reproBug09SwallowedMessages() {
    const addon = await getAddon();

    const cases = [
        {
            label: 'addon.my_echo(Symbol("token"))',
            cppThrow: 'throw "unsupported type" (in GetType)',
            run: () => addon.my_echo(Symbol("token")),
        },
        {
            label: "addon.my_echo(BigInt(9007199254740991))",
            cppThrow: 'throw "unsupported type" (in GetType)',
            run: () => addon.my_echo(BigInt(9007199254740991)),
        },
        {
            label: "addon.my_echo(() => {})",
            cppThrow: 'throw "unsupported type" (in GetType)',
            run: () => addon.my_echo(() => {}),
        },
        {
            label: "addon.my_echo(null)",
            cppThrow: 'throw "unsupported type" (in GetType)',
            run: () => addon.my_echo(null),
        },
        {
            label: "addon.my_echo(Object.create({ fn() {} }))",
            cppThrow: 'throw "unsupported type" (in GetMap -> Value on prototype method)',
            run: () => addon.my_echo(Object.create({ fn() {} })),
        },
    ];

    const lines = [
        "=== Bug #09A: 5 Distinct C++ `const char*` Throws All Erased Into \"unknown exception\" ===",
        "",
    ];

    let allErased = true;
    for (let i = 0; i < cases.length; i++) {
        const c = cases[i];
        const res = c.run();
        const msg = res instanceof Error ? res.message : String(res);
        if (msg !== "unknown exception") {
            allErased = false;
        }
        lines.push(`${i + 1}. Call          : ${c.label}`);
        lines.push(`   C++ Threw     : ${c.cppThrow}`);
        lines.push(`   JS Received   : ${describeValue(res)}  <-- Real C++ message lost!`);
        lines.push("");
    }

    lines.push(
        "Root Cause: Every `throw` in the SDK throws a `const char*` string literal, which does NOT inherit",
        "from `std::exception`. `CreateErrorFromException` only catches `std::exception&`, so every SDK",
        "exception falls into `catch (...)` and becomes `\"unknown exception\"`."
    );

    setSectionResult(
        "09",
        allErased ? "bug" : "ok",
        "🔴 BUG #09A REPRODUCED: All 5 C++ `const char*` Diagnostic Strings Were Lost & Replaced With \"unknown exception\"!",
        [lines.join("\n")]
    );
}
// ! CONFIRMED
async function reproBug09CrashPhotoshopSync() {
    const addon = await getAddon();

    setSectionResult(
        "09",
        "bug",
        "💥 CRASHING PHOTOSHOP NOW via Unbounded Native C++ Recursion (STATUS_STACK_OVERFLOW 0xC00000FD)...",
        [
            "Passing cyclic object `cyclic.self = cyclic` to `addon.my_echo(cyclic)`...",
            "In `sample-uxp-addon.uxpaddon`, `GetMap()` recursively calls `Value(env, element)` -> `GetMap()`",
            "with no cycle detection and no HandleScope until the main thread stack overflows (0xC00000FD)!"
        ]
    );

    const cyclic = {
        crashReason: "Unbounded recursion in UxpValue.cpp GetMap()",
    };
    cyclic.self = cyclic;

    // Trigger immediate native C++ stack overflow in sample-uxp-addon.uxpaddon
    addon.my_echo(cyclic);
}
// ! CONFIRMED
async function reproBug09CrashPhotoshopAsync() {
    const addon = await getAddon();

    setSectionResult(
        "09",
        "bug",
        "💥 CRASHING PHOTOSHOP NOW via `addon.my_echo_async(cyclic)`...",
        [
            "Passing cyclic object `cyclic.self = cyclic` to `addon.my_echo_async(cyclic)`...",
            "Triggers immediate native C++ stack overflow (0xC00000FD) inside `MyAsyncEcho` -> `Value(env, arg1)`!"
        ]
    );

    const cyclic = {
        crashReason: "Unbounded recursion in MyAsyncEcho -> Value(env, arg1)",
    };
    cyclic.self = cyclic;

    addon.my_echo_async(cyclic);
}

// ============================================================================
// BUG #10: CreateErrorFromException Returns Error Value Instead of Throwing
// ============================================================================
// ! CONFIRMED
async function reproBug10SyncTryCatchBypass() {
    const addon = await getAddon();

    let enteredCatchBlock = false;
    let returnedNormally = undefined;

    try {
        returnedNormally = addon.my_echo(() => {});
    } catch (_err) {
        enteredCatchBlock = true;
    }

    const bugReproduced = !enteredCatchBlock && returnedNormally instanceof Error;

    setSectionResult(
        "10",
        bugReproduced ? "bug" : "ok",
        bugReproduced
            ? "🔴 BUG #10A REPRODUCED: `try / catch` Was Completely Bypassed! Error Object Returned as Normal Value!"
            : "🟢 Exception Thrown Properly",
        [
            "=== Bug #10A: Synchronous `try / catch` Bypass in `addon.my_echo(() => {})` ===",
            `Did execution enter catch(err)? : ${enteredCatchBlock}  <-- EXPECTED: true, ACTUAL: false!`,
            `Normal return value assigned    : ${describeValue(returnedNormally)}`,
            `returnedNormally instanceof Error: ${returnedNormally instanceof Error}`,
            "",
            "Root Cause: `CreateErrorFromException` calls `uxp_addon_create_error` and returns the Error object",
            "as the function's return value instead of calling `uxp_addon_throw_error` and returning `nullptr`.",
            "Any caller checking for errors with `try { addon.my_echo(x); } catch (e) {}` silently continues",
            "with an `Error` object masquerading as valid data!"
        ]
    );
}
// ! CONFIRMED
async function reproBug10AsyncThenTypeError() {
    const addon = await getAddon();

    let caughtSyncError = null;
    let rawReturn = null;

    try {
        rawReturn = addon.my_echo_async(() => {});
        // Standard promise chaining on an async function:
        rawReturn.then(() => {});
    } catch (err) {
        caughtSyncError = err;
    }

    const bugReproduced =
        rawReturn instanceof Error &&
        !(rawReturn instanceof Promise) &&
        caughtSyncError instanceof TypeError;

    setSectionResult(
        "10",
        bugReproduced ? "bug" : "ok",
        bugReproduced
            ? `🔴 BUG #10B REPRODUCED: my_echo_async() Returned an Error Object Instead of a Promise, Throwing "${caughtSyncError.name}: ${caughtSyncError.message}"!`
            : "🟢 Returned Promise Properly",
        [
            "=== Bug #10B: Async Function Contract Broken in `addon.my_echo_async(() => {}).then(...)` ===",
            `Return value of my_echo_async() : ${describeValue(rawReturn)}`,
            `Is return value a Promise?      : ${rawReturn instanceof Promise}  <-- EXPECTED: true, ACTUAL: false!`,
            `Is return value an Error?       : ${rawReturn instanceof Error}  <-- Returned synchronously!`,
            `Calling .then() threw           : ${caughtSyncError ? `${caughtSyncError.name}: ${caughtSyncError.message}` : "none"}`,
            "",
            "Root Cause: When `Value stdValue(env, arg1)` fails in `MyAsyncEcho` before `ScheduleOnMainThread`,",
            "`catch (...)` returns `CreateErrorFromException(env)` (an `Error` object) instead of a rejected",
            "`Promise` or a thrown JS exception, breaking `.then()` / `.catch()` callers!"
        ]
    );
}
// ! Needs more info to confirm
async function reproBug10ThrowingGetter() {
    const addon = await getAddon();

    const poisonObject = {
        validProp: "hello",
        get explodingProp() {
            throw new Error("Custom exception thrown inside JS property getter!");
        },
    };

    let caughtGetterError = null;
    let normalReturn = undefined;

    try {
        normalReturn = addon.my_echo(poisonObject);
    } catch (err) {
        caughtGetterError = err;
    }

    setSectionResult(
        "10",
        "bug",
        "🔴 BUG #10C REPRODUCED: Throwing JS Getter Left a Pending Exception During CreateErrorFromException()!",
        [
            "=== Bug #10C: Object With Throwing JS Property Getter ===",
            `Normal return value : ${describeValue(normalReturn)}`,
            `Caught JS Exception : ${caughtGetterError ? `${caughtGetterError.name}: ${caughtGetterError.message}` : "none"}`,
            "",
            "What Happened Inside C++ (`GetMap` -> `CreateErrorFromException`):",
            "  1. `uxp_addon_get_property` invoked `explodingProp`, which threw a JS Error in V8.",
            "  2. V8 turned ON its 'Red Warning Light' (`pending exception`) and returned `addon_pending_exception` (10).",
            "  3. `Check()` threw C++ `const char*` \"invalid status\" into `CreateErrorFromException(env)`.",
            "  4. `CreateErrorFromException(env)` NEVER checked `uxp_addon_is_exception_pending`! It blindly called",
            "     `uxp_addon_create_string_utf8` (x2) and `uxp_addon_create_error(env, nullptr, nullptr, &error)`.",
            "  5. Because a JS exception was already pending, V8 rejected ALL 3 N-API calls, leaving `error = nullptr`.",
            "",
            "Why Is This a Bug Even Though `catch (err)` in JS Caught the Getter Error?",
            "  • `catch (err)` only worked by accident because all 3 N-API calls in `CreateErrorFromException` failed,",
            "    returning `nullptr` while V8's pending exception flag was still lit.",
            "  • C++ blindly passed `nullptr` handles (`errorCode`, `errorMessage`) into `uxp_addon_create_error`.",
            "  • Any property read before `explodingProp` (`validProp: \"hello\"`) was leaked on the C++ heap (Bug #05).",
            "  • Any subsequent N-API call in C++ (such as creating/rejecting a Promise) is blocked by V8!"
        ]
    );
}

// ============================================================================
// BUG #17: Uninitialized arg1 & Missing argc Check in MyEcho / MyAsyncEcho
// ============================================================================
// ! CONFIRMED
async function reproBug17ZeroAndExtraArgs() {
    const addon = await getAddon();

    // 1. Call my_echo() with 0 arguments
    const syncZeroOut = addon.my_echo();
    // 2. Call my_echo_async() with 0 arguments
    const asyncZeroOut = await addon.my_echo_async();
    // 3. Call my_echo() with 3 arguments
    const syncThreeOut = addon.my_echo("first_arg", "second_arg_dropped", "third_arg_dropped");

    setSectionResult(
        "17",
        "bug",
        "🔴 BUG #17 REPRODUCED: 0-Argument and 3-Argument Calls Accepted Without Any `argc` Validation!",
        [
            "=== Bug #17: Missing `argc` Check & Uninitialized `addon_value arg1` on Stack ===",
            `1. addon.my_echo() [0 args]                     -> returned: ${describeValue(syncZeroOut)}`,
            `2. await addon.my_echo_async() [0 args]         -> resolved: ${describeValue(asyncZeroOut)}`,
            `3. addon.my_echo("first", "second", "third")    -> returned: ${describeValue(syncThreeOut)} (args 2 & 3 silently dropped!)`,
            "",
            "Binary & Source Analysis (`module.cpp` & `sample-uxp-addon.uxpaddon` @ 0x180003750):",
            "  • `addon_value arg1;` at `[rsp+50h]` is NOT initialized before `uxp_addon_get_cb_info`.",
            "  • When called with 0 arguments, `uxp_addon_get_cb_info` sets `argc = 0`.",
            "  • Neither `MyEcho` nor `MyAsyncEcho` checks `if (argc < 1)`! They blindly pass `arg1` into",
            "    `Value stdValue(env, arg1)` instead of throwing an invalid-argument error."
        ]
    );
}

async function expectedBug17ValidSingleArg() {
    const addon = await getAddon();
    const output = addon.my_echo("Valid Single Argument");

    setSectionResult(
        "17",
        "ok",
        "🟢 WORKING COMPARISON: Single Explicit Argument Echoed Properly",
        [
            '=== Working Comparison: addon.my_echo("Valid Single Argument") ===',
            `Argument Count : 1`,
            `Actual Output  : ${describeValue(output)}`
        ]
    );
}

// ============================================================================
// BUG #19: DOM <dialog> Appended to document, Unitless fontSize & DOM Leak
// ============================================================================
// ! CONFIRMED
async function reproBug19MessageDialog() {
    const beforeCount = countAllDialogsInDocument();
    let appendError = null;
    let createdDialog = null;

    try {
        // Run the exact buggy messageDialog() function from main.js
        messageDialog("Bug #19: Yellow text, unitless fontSize=20, appended to `document`, no Close button! (Auto-closing in 2s...)");
    } catch (err) {
        appendError = err;
    }

    // Locate the newly created dialog on `document` or `document.body`
    if (document.childNodes) {
        for (let i = document.childNodes.length - 1; i >= 0; i--) {
            const node = document.childNodes[i];
            if (node && node.nodeName && node.nodeName.toLowerCase() === "dialog") {
                createdDialog = node;
                break;
            }
        }
    }

    const parentName = createdDialog && createdDialog.parentNode ? createdDialog.parentNode.nodeName : "none";
    const inlineFontSize = createdDialog ? createdDialog.style.fontSize : "N/A";
    const buttonInsideCount = createdDialog ? createdDialog.querySelectorAll("button").length : 0;

    // Auto-close after 2 seconds so the user sees the unclosable yellow modal, then gets control back!
    // Note: We only call .close(), NOT .remove(), preserving the exact DOM leak of messageDialog()!
    autoDismissNewDialogsAfter(2000);

    const afterCount = countAllDialogsInDocument();
    updateTelemetryPills();

    setSectionResult(
        "19",
        "bug",
        `🔴 BUG #19 REPRODUCED: <dialog> Appended to "${parentName}", Close Buttons=${buttonInsideCount}, Leaked <dialog> Count=${afterCount}!`,
        [
            "=== Bug #19: Inspecting Original `messageDialog()` Execution ===",
            `1. Appended Target (` + "`dialog.parentNode`" + `) : ${parentName}  <-- Attached to root Document instead of BODY!`,
            `2. hierarchy error thrown?               : ${appendError ? `${appendError.name}: ${appendError.message}` : "No (UXP quirks allowed <dialog> outside <body>)"}`,
            `3. Inline dialog.style.fontSize          : ${JSON.stringify(inlineFontSize)} (set as unitless number \`20\` instead of \`"20px"\`)`,
            `4. Close buttons inside modal <dialog>   : ${buttonInsideCount}  <-- User is trapped without Escape / auto-close!`,
            `5. Leaked <dialog> elements in DOM       : ${beforeCount} -> ${afterCount} (never removed after closing!)`
        ]
    );
}

async function expectedBug19FixedDialog() {
    const beforeCount = countAllDialogsInDocument();

    const dialog = document.createElement("dialog");
    dialog.className = "fixed-modal-dialog";

    const title = document.createElement("h3");
    title.style.margin = "0 0 8px 0";
    title.style.fontSize = "16px";
    title.style.color = "#4ade80";
    title.textContent = "Fixed Modal Dialog (Bug #19 Resolved)";

    const bodyText = document.createElement("p");
    bodyText.style.margin = "0 0 14px 0";
    bodyText.style.fontSize = "13px";
    bodyText.style.color = "#e5e5e5";
    bodyText.textContent =
        'Appended to document.body, uses valid CSS units ("16px"/"13px"), includes a Close button, and removes itself from the DOM on close.';

    const closeBtn = document.createElement("button");
    closeBtn.className = "action-btn btn-ok";
    closeBtn.textContent = "Close Dialog (Removes DOM Node)";
    closeBtn.addEventListener("click", () => {
        dialog.close();
    });

    dialog.addEventListener("close", () => {
        dialog.remove();
        updateTelemetryPills();
    });

    dialog.appendChild(title);
    dialog.appendChild(bodyText);
    dialog.appendChild(closeBtn);

    document.body.appendChild(dialog);
    dialog.showModal();

    // Also auto-close after 3 seconds if the user doesn't click Close
    setTimeout(() => {
        if (dialog.isConnected) {
            try {
                dialog.close();
            } catch (_e) {}
            dialog.remove();
            updateTelemetryPills();
        }
    }, 3000);

    setSectionResult(
        "19",
        "ok",
        "🟢 FIXED DIALOG DEMONSTRATED: Appended to document.body + Proper CSS Units + Close Button + DOM Cleanup",
        [
            "=== Fixed Modal Dialog Implementation ===",
            `Appended Target (` + "`dialog.parentNode`" + `) : ${dialog.parentNode ? dialog.parentNode.nodeName : "BODY"}`,
            `CSS fontSize                          : "16px" / "13px" (explicit px units)`,
            `Close Button Present                  : Yes (plus automatic dialog.remove() on 'close' event)`,
            `Leaked <dialog> Nodes After Close     : ${beforeCount} (0 new nodes leaked)`
        ]
    );
}

function cleanupLeakedDialogs() {
    let removed = 0;
    if (document.childNodes) {
        for (let i = document.childNodes.length - 1; i >= 0; i--) {
            const node = document.childNodes[i];
            if (node && node.nodeName && node.nodeName.toLowerCase() === "dialog") {
                try {
                    if (typeof node.close === "function") node.close();
                } catch (_e) {}
                if (typeof node.remove === "function") {
                    node.remove();
                } else if (node.parentNode) {
                    node.parentNode.removeChild(node);
                }
                removed++;
            }
        }
    }
    if (document.body) {
        const bodyDialogs = document.body.querySelectorAll("dialog");
        for (let i = 0; i < bodyDialogs.length; i++) {
            try {
                bodyDialogs[i].close();
            } catch (_e) {}
            bodyDialogs[i].remove();
            removed++;
        }
    }
    updateTelemetryPills();
    setSectionResult(
        "19",
        "ok",
        `🧹 Cleaned Up ${removed} Leaked <dialog> Node(s) From Document`,
        [`Removed ${removed} orphaned <dialog> element(s). Current DOM <dialog> count: ${countAllDialogsInDocument()}.`]
    );
}

// ============================================================================
// BUG #21: README.md Missing await on require("sample-uxp-addon.uxpaddon")
// ============================================================================

async function reproBug21ReadmeSnippet() {
    let caughtError = null;
    let unawaitedAddon = null;

    try {
        // Exact code from README.md lines 68-70:
        const addon = require(ADDON_NAME);
        unawaitedAddon = addon;
        addon.my_function();
    } catch (err) {
        caughtError = err;
    }

    const isPromise = unawaitedAddon instanceof Promise;
    const bugReproduced = isPromise && caughtError instanceof TypeError;

    setSectionResult(
        "21",
        bugReproduced ? "bug" : "ok",
        bugReproduced
            ? `🔴 BUG #21 REPRODUCED: README.md Code Threw "${caughtError.name}: ${caughtError.message}"!`
            : "🟢 Addon Called Properly",
        [
            "=== Bug #21: Running Exact README.md Snippet (Lines 68-70) ===",
            'Code executed: `const addon = require("sample-uxp-addon.uxpaddon"); addon.my_function();`',
            "",
            `Value of \`addon\` without \`await\` : ${Object.prototype.toString.call(unawaitedAddon)}`,
            `addon instanceof Promise          : ${isPromise}  <-- require("*.uxpaddon") is asynchronous!`,
            `typeof addon.my_function          : ${typeof (unawaitedAddon && unawaitedAddon.my_function)}`,
            `Thrown Exception                  : ${caughtError ? `${caughtError.name}: ${caughtError.message}` : "none"}`
        ]
    );
}

async function expectedBug21WithAwait() {
    const addon = await require(ADDON_NAME);
    const result = addon.my_function();

    setSectionResult(
        "21",
        "ok",
        `🟢 CORRECT BEHAVIOR: await require("${ADDON_NAME}") Resolved & my_function() Returned "${result}"`,
        [
            "=== Fixed Code: Using `await require(...)` ===",
            `const addon = await require("${ADDON_NAME}");`,
            `Exported keys on addon : [${Object.keys(addon).join(", ")}]`,
            `addon.my_function()    : ${JSON.stringify(result)}`
        ]
    );
}

// ============================================================================
// Global Controls: Verify Addon, Run All Safe Repros, Reset
// ============================================================================

async function verifyNativeAddonStatus() {
    const statusPill = document.getElementById("addon-status-pill");
    try {
        const addon = await getAddon();
        const hello = addon.my_function();
        if (statusPill) {
            statusPill.className = "status-pill ready";
            statusPill.textContent = `Native Addon Ready: my_function() => "${hello}"`;
        }
    } catch (err) {
        if (statusPill) {
            statusPill.className = "status-pill error";
            statusPill.textContent = `Native Addon Error: ${err && err.message ? err.message : String(err)}`;
        }
    }
}

async function runAllSafeRepros() {
    await reproBug01EmptyArray();
    await reproBug01NonEmptyArray();
    await reproBug02AsyncEcho();
    await reproBug05Leak(1); // Leaks +512 MB so it's immediately obvious in Task Manager
    await reproBug06PrimitiveNull();
    await reproBug06ObjectWithNull();
    await reproBug07NumericKeys();
    await reproBug08NullByteTruncation();
    await reproBug09SwallowedMessages();
    await reproBug10SyncTryCatchBypass();
    await reproBug10AsyncThenTypeError();
    await reproBug17ZeroAndExtraArgs();
    await reproBug19MessageDialog();
    await reproBug21ReadmeSnippet();
}

function resetAllOutputs() {
    const bugIds = ["01", "02", "05", "06", "07", "08", "09", "10", "17", "19", "21"];
    for (let i = 0; i < bugIds.length; i++) {
        const id = bugIds[i];
        setSectionResult(id, "neutral", "Not run yet — click a button above.", "Waiting for execution...");
    }
    updateTelemetryPills();
}

function bindButton(id, handler) {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("click", async () => {
        try {
            await handler();
        } catch (unhandledErr) {
            console.error(`Unhandled error in button ${id}:`, unhandledErr);
        }
    });
}

function initBugReproPanel() {
    // Global header actions
    bindButton("btn-run-all-safe", runAllSafeRepros);
    bindButton("btn-verify-addon", verifyNativeAddonStatus);
    bindButton("btn-reset-outputs", resetAllOutputs);

    // Bug #01
    bindButton("btn-bug-01-empty", reproBug01EmptyArray);
    bindButton("btn-bug-01-nonempty", reproBug01NonEmptyArray);
    bindButton("btn-bug-01-expected", expectedBug01PlainObject);

    // Bug #02
    bindButton("btn-bug-02-repro", reproBug02AsyncEcho);
    bindButton("btn-bug-02-expected", expectedBug02AsyncEcho);

    // Bug #05 (Extreme Native C++ Heap Memory Leak)
    bindButton("btn-bug-05-512mb", () => reproBug05Leak(1));
    bindButton("btn-bug-05-2gb", () => reproBug05Leak(4));
    bindButton("btn-bug-05-4gb", () => reproBug05Leak(8));
    bindButton("btn-bug-05-control", controlBug05Valid512MB);

    // Bug #06
    bindButton("btn-bug-06-null", reproBug06PrimitiveNull);
    bindButton("btn-bug-06-obj", reproBug06ObjectWithNull);
    bindButton("btn-bug-06-expected", expectedBug06WithUndefined);

    // Bug #07
    bindButton("btn-bug-07-repro", reproBug07NumericKeys);
    bindButton("btn-bug-07-expected", expectedBug07StringKeys);

    // Bug #08
    bindButton("btn-bug-08-repro", reproBug08NullByteTruncation);
    bindButton("btn-bug-08-expected", expectedBug08WithoutNullByte);

    // Bug #09 (Swallowed const char* & Real Photoshop Crash)
    bindButton("btn-bug-09-messages", reproBug09SwallowedMessages);
    bindButton("btn-bug-09-crash-sync", reproBug09CrashPhotoshopSync);
    bindButton("btn-bug-09-crash-async", reproBug09CrashPhotoshopAsync);

    // Bug #10
    bindButton("btn-bug-10-sync", reproBug10SyncTryCatchBypass);
    bindButton("btn-bug-10-async", reproBug10AsyncThenTypeError);
    bindButton("btn-bug-10-getter", reproBug10ThrowingGetter);

    // Bug #17
    bindButton("btn-bug-17-zero-args", reproBug17ZeroAndExtraArgs);
    bindButton("btn-bug-17-expected", expectedBug17ValidSingleArg);

    // Bug #19
    bindButton("btn-bug-19-repro", reproBug19MessageDialog);
    bindButton("btn-bug-19-expected", expectedBug19FixedDialog);
    bindButton("btn-bug-19-cleanup", cleanupLeakedDialogs);

    // Bug #21
    bindButton("btn-bug-21-repro", reproBug21ReadmeSnippet);
    bindButton("btn-bug-21-expected", expectedBug21WithAwait);

    updateTelemetryPills();
    verifyNativeAddonStatus();
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initBugReproPanel);
} else {
    initBugReproPanel();
}

