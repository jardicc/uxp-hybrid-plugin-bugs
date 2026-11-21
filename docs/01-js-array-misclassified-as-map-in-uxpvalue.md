# Bug 01: JavaScript Arrays Are Misclassified as Maps (`Value::Kind::map`) due to Unreachable Array Check

## Severity
**High (Logic Error / Data Corruption / Dead Code)**

## Scope
**SDK Core (`src/utilities/UxpValue.cpp`)** — This bug is in the reusable C++ `Value` wrapper provided by the SDK itself (and duplicated into `template/template-dev/src/utilities/UxpValue.cpp`). Any UXP hybrid plugin that uses the SDK's `Value` class to marshal arguments or return values inherits this bug.

## Affected Files
- [`src/utilities/UxpValue.cpp`](../src/utilities/UxpValue.cpp) (lines 16–38)
- [`template/template-dev/src/utilities/UxpValue.cpp`](../template/template-dev/src/utilities/UxpValue.cpp) (lines 16–38)

## Problematic Code
```cpp
// Return the type of the V8 object
Value::Kind GetType(const addon_apis& apis, addon_env env, addon_value value) {
    addon_valuetype type = addon_undefined;
    Check(apis.uxp_addon_typeof(env, value, &type));
    switch (type) {
    case addon_undefined: return Value::Kind::undefined;
    case addon_boolean: return Value::Kind::boolean;
    case addon_number: return Value::Kind::number;
    case addon_string: return Value::Kind::string;
    case addon_object: return Value::Kind::map;
    default: break;
    }

    // explicit test for array
    bool isArray = false;
    Check(apis.uxp_addon_is_array(env, value, &isArray));
    if (isArray)
        return Value::Kind::list;

    throw "unsupported type";
}
```

## Explanation
In JavaScript (and in V8 / Node-API `napi_typeof` / `uxp_addon_typeof`), an `Array` is an exotic object—there is no `addon_array` enumerator in [`enum addon_valuetype`](../src/api/UxpAddonTypes.h). Calling `uxp_addon_typeof(env, value, &type)` on a JavaScript Array always sets `type = addon_object`.

Because `switch (type)` handles `case addon_object: return Value::Kind::map;` **before** checking `uxp_addon_is_array(env, value, &isArray)`:
1. Every JavaScript Array immediately matches `case addon_object:` on line 24 and returns `Value::Kind::map`.
2. The `uxp_addon_is_array` check on lines 30–35 is **completely unreachable dead code** for actual arrays (and for non-objects such as `addon_null`, `addon_function`, `addon_symbol`, or `addon_bigint`, `uxp_addon_is_array` always produces `false`). Likewise, `GetList()` and `case Value::Kind::list:` in `ConvertValue()` are unreachable when round-tripping JS values.
3. Consequently, `Value(addon_env, addon_value)` **never** constructs a `Value::Kind::list` from a JS Array:
   - In C++, calling `value.GetList()` on a `Value` constructed from a JS Array always throws `"Incorrect value kind"`.
   - Instead, the JS Array is routed into `GetMap()`, which calls `uxp_addon_get_property_names(env, value, &napiKeys)`.
   - In Photoshop's `libdynamic-napi.dll` (Node-API v8), `napi_get_property_names` calls `v8::Object::GetPropertyNames` with `v8::KeyConversionMode::kConvertToString` (`napi_key_numbers_to_strings`), which converts the array's numeric indices (`0`, `1`, `2`, ...) into string keys (`"0"`, `"1"`, `"2"`, ...) and stores them in C++ `std::map<std::string, Value>` (`Value::Kind::map`).
   - When `Value::ConvertValue()` converts that `Value` back to JavaScript, `case Value::Kind::map:` calls `uxp_addon_create_object` instead of `uxp_addon_create_array`. As a result, **every JavaScript `Array` (`[]` or `["alpha", "beta", "gamma"]`) is silently mutated into a plain `Object` (`{}` or `{"0": "alpha", "1": "beta", "2": "gamma"}`)** where `Array.isArray(res) === false`, `res.length === undefined`, and array methods (`.map`, `.push`, `.forEach`) do not exist!
   - Furthermore, because `Value::MapType` is `std::map<std::string, Value>`, C++ stores and iterates array indices in **lexicographical string order** (`"0"`, `"1"`, `"10"`, `"2"`, `"3"`, ...) whenever an array has 11 or more elements.
   - *(Note: On older Node-API implementations prior to N-API v6 where `napi_get_property_names` used `v8::KeyConversionMode::kKeepNumbers`, non-empty arrays fail in `GetMap()` with `addon_string_expected`; see [Bug 07](./07-getmap-fails-on-numeric-or-non-string-property-keys.md).)*

## How to Reproduce

### JavaScript Reproduction (Direct)
Yes — this bug can be triggered directly from JavaScript using the unmodified sample addon (`my_echo` or `my_echo_async`):

```javascript
const addon = await require("sample-uxp-addon.uxpaddon");

// Case 1: Empty array [] is misclassified as Value::Kind::map and returned as a plain Object {}
const emptyRes = addon.my_echo([]);
console.log("Is array?", Array.isArray(emptyRes), emptyRes);
// Expected: true, []
// Actual:   false, {}

// Case 2: Non-empty array ["alpha", "beta", "gamma"] is ALSO mutated into a plain Object
// with stringified index keys {"0": "alpha", "1": "beta", "2": "gamma"}!
const nonEmptyRes = addon.my_echo(["alpha", "beta", "gamma"]);
console.log("Is array?", Array.isArray(nonEmptyRes), "length:", nonEmptyRes.length, nonEmptyRes);
// Expected: true, length: 3, ["alpha", "beta", "gamma"]
// Actual:   false, length: undefined, { "0": "alpha", "1": "beta", "2": "gamma" }
// Calling nonEmptyRes.map(...) throws TypeError: nonEmptyRes.map is not a function!
```

### C++ Reproduction
Inside any addon callback:
```cpp
Value val(env, jsArrayArg);
// Expected: Value::Kind::list
// Actual:   Value::Kind::map
const auto& list = val.GetList(); // Throws "Incorrect value kind"
```

## Suggested Fix
Check `uxp_addon_is_array` **inside** `case addon_object:` (or before returning `Value::Kind::map`):

```cpp
Value::Kind GetType(const addon_apis& apis, addon_env env, addon_value value) {
    addon_valuetype type = addon_undefined;
    Check(apis.uxp_addon_typeof(env, value, &type));
    switch (type) {
    case addon_undefined: return Value::Kind::undefined;
    case addon_boolean: return Value::Kind::boolean;
    case addon_number: return Value::Kind::number;
    case addon_string: return Value::Kind::string;
    case addon_object: {
        bool isArray = false;
        Check(apis.uxp_addon_is_array(env, value, &isArray));
        return isArray ? Value::Kind::list : Value::Kind::map;
    }
    default: break;
    }

    throw std::runtime_error("unsupported type");
}
```
