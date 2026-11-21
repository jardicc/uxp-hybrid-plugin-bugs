# Bug 06: JavaScript `null` (and Object Methods) Throw `"unsupported type"` in `Value`

## Severity
**Medium-High (Unhandled Standard JS Primitive Type)**

## Scope
**SDK Core (`src/utilities/UxpValue.h`, `src/utilities/UxpValue.cpp`)** — This bug is in the reusable C++ `Value` class in the SDK itself (and duplicated into `template/template-dev/src/utilities/`). Any hybrid plugin that uses `Value` cannot accept `null` or any object/array containing a `null` property.

## Affected Files
- [`src/utilities/UxpValue.h`](../src/utilities/UxpValue.h) (line 27)
- [`src/utilities/UxpValue.cpp`](../src/utilities/UxpValue.cpp) (lines 16–38, 76–94)
- [`template/template-dev/src/utilities/UxpValue.h`](../template/template-dev/src/utilities/UxpValue.h) (line 27)
- [`template/template-dev/src/utilities/UxpValue.cpp`](../template/template-dev/src/utilities/UxpValue.cpp) (lines 16–38, 76–94)

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
1. **`addon_null` is not handled**:
   Unlike JavaScript's `typeof null === "object"`, Node-API's `napi_typeof` and UXP's `uxp_addon_typeof` have a dedicated `addon_null` value in [`enum addon_valuetype`](../src/api/UxpAddonTypes.h).
   `GetType()` has no `case addon_null:` and `Value::Kind` has no `null` kind (nor does it map `addon_null` to `Kind::undefined`).
   As a result, passing `null`—or any JSON-like object or array containing `null` (e.g., `{ name: "layer", parent: null }`)—causes `GetType()` to fall through the `switch`, fail `uxp_addon_is_array`, and `throw "unsupported type"`.

2. **Enumerable functions/methods on objects or prototypes break `GetMap`**:
   In `GetMap()`, `uxp_addon_get_property_names()` returns all enumerable properties on the object and its prototype chain. If an object has any enumerable method (`addon_function`), `Value(env, element)` throws `"unsupported type"`, aborting conversion of the entire object.

## How to Reproduce

### JavaScript Reproduction (Direct)
Yes — this bug can be triggered directly from JavaScript by passing `null` (or any object containing `null` or a method) to `addon.my_echo` or `addon.my_echo_async`:

```javascript
const addon = await require("sample-uxp-addon.uxpaddon");

const res1 = addon.my_echo(null);
const res2 = addon.my_echo({ a: 1, b: null });
const res3 = addon.my_echo({ a: 1, fn() {} });
console.log(res1, res2, res3);
// Expected: null, { a: 1, b: null }, { a: 1 }
// Actual:   Error: unknown exception (for all three calls)
```

- **Expected result**: `null` is preserved as `null` (via `Value::Kind::null` and `uxp_addon_get_null`) or treated safely without failing the entire object conversion.
- **Actual result**: `GetType` throws `"unsupported type"`, and `my_echo` fails and returns an `Error("unknown exception")` object.

## Suggested Fix
Add `null` to `Value::Kind` (`enum class Kind { undefined, null, boolean, number, string, list, map };`), handle `case addon_null: return Value::Kind::null;` in `GetType()`, and convert `Value::Kind::null` back to JS `null` in `Value::ConvertValue()` using `UxpAddonApis.uxp_addon_get_null(env, &result)`.
