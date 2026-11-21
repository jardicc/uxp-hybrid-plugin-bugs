# Bug 05: Memory Leak in `Value(addon_env, addon_value)` Constructor When Nested Conversion Throws

## Severity
**High (Memory Leak)**

## Scope
**SDK Core (`src/utilities/UxpValue.cpp`)** — This bug is in the reusable C++ `Value(addon_env, addon_value)` constructor in the SDK itself (and duplicated into `template/template-dev/src/utilities/UxpValue.cpp`). Every hybrid plugin that converts JS objects or arrays into `Value` is vulnerable to native C++ heap leaks (when nested properties fail conversion) and stack-overflow crashes (on cyclic object graphs).

## Affected Files
- [`src/utilities/UxpValue.cpp`](../src/utilities/UxpValue.cpp) (lines 169–185)
- [`template/template-dev/src/utilities/UxpValue.cpp`](../template/template-dev/src/utilities/UxpValue.cpp) (lines 169–185)

## Problematic Code
```cpp
Value::Value(addon_env env, addon_value value) {
    kind = GetType(UxpAddonApis, env, value);

    switch (kind) {
    case Kind::boolean: data.boolean = ::GetBoolean(UxpAddonApis, env, value); break;
    case Kind::number: data.number = ::GetNumber(UxpAddonApis, env, value); break;
    case Kind::string: data.string = new std::string(::GetString(UxpAddonApis, env, value)); break;
    case Kind::list: {
        data.list = new ListType;
        ::GetList(UxpAddonApis, *(data.list), env, value);
    } break;
    case Kind::map: {
        data.map = new MapType;
        ::GetMap(UxpAddonApis, *(data.map), env, value);
    } break;
    case Kind::undefined: break;
    }
}
```

## Explanation
In C++, if an exception is thrown inside a constructor before the constructor body finishes executing, **the object's destructor (`~Value()`) is not called**.

In `Value::Value(addon_env env, addon_value value)`:
1. For `Kind::list`, `data.list = new ListType;` allocates a `std::deque<Value>` on the heap using raw `new`.
2. Next, `::GetList(UxpAddonApis, *(data.list), env, value);` iterates over the JavaScript array elements and recursively constructs `Value(env, element)`.
3. For `Kind::map`, `data.map = new MapType;` allocates a `std::map<std::string, Value>` on the heap using raw `new`, and `::GetMap(...)` recursively constructs `Value(env, element)` for each property.
4. If **any** recursive element conversion or UXP API call throws an exception (for example, if an object contains a `null` property, a `function`/method, a `symbol`, a numeric key, or a getter that throws), the exception unwinds out of `Value::Value(addon_env, addon_value)`.
5. Because `data.list` and `data.map` are raw pointers (not `std::unique_ptr`), and `~Value()` is not invoked for the partially constructed `Value`, **`data.list` / `data.map` and all previously inserted child `Value` objects at every level of nesting are permanently leaked**.

## How to Reproduce

### JavaScript Reproduction (Direct)
Yes — this memory leak can be triggered directly from JavaScript by passing an Object containing valid properties alongside any unsupported property (`null`, `Symbol`, or a function) to `addon.my_echo` or `addon.my_echo_async`:

```javascript
const addon = await require("sample-uxp-addon.uxpaddon");

for (let i = 0; i < 10000; i++) {
    addon.my_echo({
        largeString: "x".repeat(1024 * 100),
        unsupported: null // or () => {} or Symbol()
    });
}
// Permanently leaks ~1 GB of native C++ heap memory in the host process!
```

1. `Value(env, arg1)` allocates `data.map = new MapType`, inserts `largeString` (100 KB `std::string`), and then throws `"unsupported type"` when processing `unsupported`.
2. **Expected result**: All memory allocated for `data.map` and `largeString` is freed during stack unwinding.
3. **Actual result**: `~Value()` is never called for the outer `Value`, leaking `data.map` and the 100 KB `largeString` on every call (~1 GB leaked across 10,000 calls).

## Suggested Fix
Use `std::unique_ptr` before assigning ownership to the raw pointer, so that any exception thrown by `::GetList` or `::GetMap` automatically cleans up the allocation:

```cpp
    case Kind::list: {
        auto list = std::make_unique<ListType>();
        ::GetList(UxpAddonApis, *list, env, value);
        data.list = list.release();
    } break;
    case Kind::map: {
        auto map = std::make_unique<MapType>();
        ::GetMap(UxpAddonApis, *map, env, value);
        data.map = map.release();
    } break;
```
