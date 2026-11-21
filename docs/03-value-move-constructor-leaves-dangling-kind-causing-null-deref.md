# Bug 03: `Value` Move Constructor Leaves Moved-From Object with Non-Undefined `kind` and `nullptr` Pointer

## Severity
**High (Null Pointer Dereference / Crash)**

## Scope
**SDK Core (`src/utilities/UxpValue.cpp`)** — This bug is in the reusable C++ `Value::Value(Value&&)` move constructor in the SDK itself (and duplicated into `template/template-dev/src/utilities/UxpValue.cpp`). Any C++ hybrid addon that moves a `Value` object and later inspects or converts the moved-from instance is affected.

## Affected Files
- [`src/utilities/UxpValue.cpp`](../src/utilities/UxpValue.cpp) (lines 144–162)
- [`template/template-dev/src/utilities/UxpValue.cpp`](../template/template-dev/src/utilities/UxpValue.cpp) (lines 144–162)
- [`template/template-dev/src/module.cpp`](../template/template-dev/src/module.cpp) (line 96)

## Problematic Code
In `UxpValue.cpp`:
```cpp
Value::Value(Value&& value) : kind(value.kind) {
    switch (value.kind) {
    case Kind::undefined: break;
    case Kind::boolean: data.boolean = value.data.boolean; break;
    case Kind::number: data.number = value.data.number; break;
    case Kind::string:
        data.string = value.data.string;
        value.data.string = nullptr;
        break;
    case Kind::list:
        data.list = value.data.list;
        value.data.list = nullptr;
        break;
    case Kind::map:
        data.map = value.data.map;
        value.data.map = nullptr;
        break;
    }
}
```

And in `UxpValue.cpp` accessors / `ConvertValue`:
```cpp
std::string Value::GetString() const {
    RequireKind(Kind::string);
    return *(data.string);
}

const Value::ListType& Value::GetList() const {
    RequireKind(Kind::list);
    return *(data.list);
}

const Value::MapType& Value::GetMap() const {
    RequireKind(Kind::map);
    return *(data.map);
}
```

And in `template/template-dev/src/module.cpp` (lines 73–98):
```cpp
std::shared_ptr<Value> valuePtr(std::make_shared<Value>(std::move(stdValue)));
...
auto mainThreadHandler = [valuePtr, scriptThreadHandler](Task& task) {
    try {
        task.SetResult(std::move(*(valuePtr.get())), false);
        task.ScheduleOnScriptingThread(scriptThreadHandler);
    } catch (...) {
    }
};
```

## Explanation
When `Value::Value(Value&& value)` moves from a `Value` whose `kind` is `Kind::string`, `Kind::list`, or `Kind::map`, it sets `value.data.string = nullptr` (or `value.data.list = nullptr` / `value.data.map = nullptr`), **but it never resets `value.kind = Kind::undefined`**.

This breaks the class invariant of `Value`:
- `value.GetKind()` still returns `Kind::string`, `Kind::list`, or `Kind::map`.
- `RequireKind(Kind::string)` (or `list` / `map`) **succeeds** on the moved-from object.
- Immediately afterward, `GetString()`, `GetList()`, `GetMap()`, and `Value::ConvertValue()` dereference `*(data.string)`, `*(data.list)`, or `*(data.map)` without checking for `nullptr`, causing an immediate **null pointer dereference (segmentation fault / access violation)**!

Notice that `module.cpp` actually keeps a `std::shared_ptr<Value> valuePtr` alive across lambdas and moves out of `*valuePtr` via `std::move(*(valuePtr.get()))`, leaving both `stdValue` and `*valuePtr` in this broken state where `kind` claims a valid heap pointer exists while `data.*` is `nullptr`.

## How to Reproduce

### JavaScript Triggerability (Requires Reading Moved-From `Value` in C++)
In the unmodified sample addon (`module.cpp`), `MyAsyncEcho` moves out of `stdValue` and then moves out of `*(valuePtr.get())` once on the main thread, without reading the moved-from objects afterward. Therefore, calling `addon.my_echo_async("hello")` once from JavaScript does not crash unless C++ code accesses `stdValue` or `*valuePtr` after `std::move`:

```javascript
const addon = await require("sample-uxp-addon.uxpaddon");
// Triggers the move in MyAsyncEcho (`std::move(stdValue)` and `std::move(*(valuePtr.get()))`).
// If the C++ callback inspects or converts `stdValue` or `*valuePtr` a second time, the host crashes:
await addon.my_echo_async("hello");
```

### C++ Reproduction
In C++ (inside any addon function or unit test):
```cpp
Value original(std::string("hello"));
Value moved(std::move(original));

// original.GetKind() is still Value::Kind::string!
if (original.GetKind() == Value::Kind::string) {
    // RequireKind(Kind::string) passes, then *(data.string) dereferences nullptr!
    std::string s = original.GetString(); // CRASH (Access Violation / SIGSEGV)
}
```
Or call `original.Convert(env)` after moving from `original`.

- **Expected result**: After moving from `original`, `original.GetKind()` should be `Value::Kind::undefined`, and calling `original.GetString()` should throw (`RequireKind` failure) while `original.Convert(env)` safely returns JS `undefined`.
- **Actual result**: `original.GetKind()` remains `Value::Kind::string` with `original.data.string == nullptr`, crashing the host application with a null pointer dereference.

## Suggested Fix
Reset `value.kind = Kind::undefined;` in the move constructor after transferring ownership of `data`:

```cpp
Value::Value(Value&& value) noexcept : kind(value.kind) {
    switch (value.kind) {
    case Kind::undefined: break;
    case Kind::boolean: data.boolean = value.data.boolean; break;
    case Kind::number: data.number = value.data.number; break;
    case Kind::string:
        data.string = value.data.string;
        value.data.string = nullptr;
        break;
    case Kind::list:
        data.list = value.data.list;
        value.data.list = nullptr;
        break;
    case Kind::map:
        data.map = value.data.map;
        value.data.map = nullptr;
        break;
    }
    value.kind = Kind::undefined;
}
```
