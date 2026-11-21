# Bug 07: `GetMap` Property Enumeration Flaws (Prototype-Chain Pollution, Missing Key Coercion, and Key Collisions)

## Severity
**Medium-High (Runtime Failure on Prototype Methods / Silent Data Loss / Unordered Map)**

## Scope
**SDK Core (`src/utilities/UxpValue.cpp`)** — This bug is in the reusable C++ `GetMap()` implementation in the SDK itself (and duplicated into `template/template-dev/src/utilities/UxpValue.cpp`). Any hybrid plugin that uses `Value` to convert JS objects inherits prototype-chain traversal, `\0`-truncated key collisions, and alphabetical key reordering.

## Affected Files
- [`src/utilities/UxpValue.cpp`](../src/utilities/UxpValue.cpp) (lines 76–94)
- [`template/template-dev/src/utilities/UxpValue.cpp`](../template/template-dev/src/utilities/UxpValue.cpp) (lines 76–94)

## Problematic Code
```cpp
void GetMap(const addon_apis& apis, Value::MapType& map, addon_env env, addon_value value) {
    map.clear();

    addon_value napiKeys = nullptr;
    Check(apis.uxp_addon_get_property_names(env, value, &napiKeys));

    uint32_t keyCount = 0;
    Check(apis.uxp_addon_get_array_length(env, napiKeys, &keyCount));

    for (uint32_t index = 0; index < keyCount; ++index) {
        addon_value key = nullptr;
        Check(apis.uxp_addon_get_element(env, napiKeys, index, &key));

        std::string keyStr = GetString(apis, env, key);

        addon_value element = nullptr;
        Check(apis.uxp_addon_get_property(env, value, key, &element));

        map.emplace(std::make_pair(keyStr, Value(env, element)));
    }
}
```

## Explanation
`GetMap()` has three distinct flaws in how it enumerates and stores JavaScript object properties:

### 1. `uxp_addon_get_property_names` Includes the Entire Prototype Chain (`kIncludePrototypes`)
In Node-API (and in Photoshop's `libdynamic-napi.dll` at RVA `0xad1f0`), `napi_get_property_names` (`uxp_addon_get_property_names`) calls:
```cpp
v8::Object::GetPropertyNames(
    context,
    v8::KeyCollectionMode::kIncludePrototypes,
    static_cast<v8::PropertyFilter>(v8::ONLY_ENUMERABLE | v8::SKIP_SYMBOLS),
    v8::IndexFilter::kIncludeIndices,
    v8::KeyConversionMode::kConvertToString);
```
Unlike `Object.keys(obj)` or `JSON.stringify(obj)` (which only inspect **own** enumerable properties via `kOwnOnly`), `uxp_addon_get_property_names` walks the **entire prototype chain** (`kIncludePrototypes`):
- If an object is created from a prototype or helper object that has an enumerable method (`const proto = { describe() { return "RGB"; } }; const obj = Object.create(proto); obj.r = 255;`), `GetMap()` enumerates `"describe"`, fetches `obj.describe` (`addon_function`), and passes it to `Value(env, element)`, which throws `"unsupported type"` (and leaks `data.map` due to [Bug 05](./05-memory-leak-in-value-constructor-on-exception.md)).
- Even if the prototype only contains primitive values, `GetMap()` copies those inherited prototype properties into `std::map` and `ConvertValue()` materializes them as **own** properties on the returned object.

### 2. Silent Key Collisions & Alphabetical Reordering in `std::map<std::string, Value>`
- Because `GetMap()` extracts keys using `GetString(apis, env, key)` (which truncates at the first embedded `\0` byte; see [Bug 08](./08-getstring-truncates-strings-with-embedded-null-bytes.md)) and inserts into `std::map<std::string, Value>` via `map.emplace(...)`, any two distinct JS keys that share the same prefix before `\0` (such as `"layer\0_fg"` and `"layer\0_bg"`) both become `"layer"`. `std::map::emplace` **silently discards** the second key (`2 keys in -> 1 key out`).
- Because `Value::MapType` is `std::map<std::string, Value>`, all keys are sorted lexicographically in C++ (`{ z: 1, a: 2, m: 3 }` becomes `{ a: 2, m: 3, z: 1 }`, and for arrays misclassified as maps by [Bug 01](./01-js-array-misclassified-as-map-in-uxpvalue.md), index `"10"` is sorted before `"2"` in C++).

### 3. Missing `uxp_addon_coerce_to_string` for Non-String Property Keys
- In Photoshop's current `libdynamic-napi.dll` (Node-API v8), `napi_get_property_names` passes `v8::KeyConversionMode::kConvertToString` (`napi_key_numbers_to_strings`), so integer-indexed keys (`0`, `1`, `2`) are automatically converted to JS strings (`"0"`, `"1"`, `"2"`).
- However, in older Node-API implementations (prior to N-API v6, where `v8::Object::GetPropertyNames(context)` defaulted to `v8::KeyConversionMode::kKeepNumbers`) or when `napi_key_keep_numbers` is used, indexed property keys are returned as `addon_number`. Because `GetMap()` calls `GetString(apis, env, key)` directly without `uxp_addon_coerce_to_string`, any non-string key fails with `addon_string_expected`.

## How to Reproduce

### JavaScript Reproduction (Direct)
Yes — this bug can be triggered directly from JavaScript against the unmodified sample addon (`my_echo` or `my_echo_async`):

```javascript
const addon = await require("sample-uxp-addon.uxpaddon");

// Case A: Object whose prototype has an enumerable method fails with Error: unknown exception
// (whereas JSON.stringify(pixel) succeeds and returns '{"r":255,"g":128,"b":0}')
const PixelProto = {
    toCssString() {
        return `rgb(${this.r}, ${this.g}, ${this.b})`;
    }
};
const pixel = Object.create(PixelProto);
pixel.r = 255;
pixel.g = 128;
pixel.b = 0;

const resA = addon.my_echo(pixel);
console.log(resA);
// Expected: { r: 255, g: 128, b: 0 }
// Actual:   Error: unknown exception (GetMap() walks prototype, hits toCssString() function, and throws!)

// Case B: Distinct keys sharing a prefix before '\0' collide in std::map::emplace and silently drop data
const resB = addon.my_echo({
    "channel\0_red": "Red (255)",
    "channel\0_green": "Green (128)",
    "channel\0_blue": "Blue (0)"
});
console.log(Object.keys(resB).length, resB);
// Expected: 3 keys preserved
// Actual:   1 key ({ channel: "Red (255)" }) — 2 keys silently lost!
```

## Suggested Fix
1. Filter to own enumerable properties (or check `hasOwnProperty`), coerce keys via `uxp_addon_coerce_to_string`, and preserve full UTF-8 key length in `GetString`:

```cpp
    for (uint32_t index = 0; index < keyCount; ++index) {
        addon_value key = nullptr;
        Check(apis.uxp_addon_get_element(env, napiKeys, index, &key));

        bool hasOwn = false;
        Check(apis.uxp_addon_has_own_property(env, value, key, &hasOwn));
        if (!hasOwn)
            continue;

        addon_value keyStringVal = nullptr;
        Check(apis.uxp_addon_coerce_to_string(env, key, &keyStringVal));
        std::string keyStr = GetString(apis, env, keyStringVal);

        addon_value element = nullptr;
        Check(apis.uxp_addon_get_property(env, value, key, &element));

        map.emplace(std::move(keyStr), Value(env, element));
    }
```
