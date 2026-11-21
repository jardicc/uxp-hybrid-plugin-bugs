# Bug 04: `Value` Violates the Rule of Five (Missing Move Assignment and Copy Operations)

## Severity
**Medium-High (API Usability Bug / Compilation Failures on Standard Container Operations)**

## Scope
**SDK Core (`src/utilities/UxpValue.h`, `src/utilities/UxpValue.cpp`)** — This bug is in the core SDK `Value` class definition (and its copy in `template/template-dev/src/utilities/`). Any C++ hybrid addon using `Value` with standard STL container operations (`operator[]`, `std::swap`, reassignment) will hit this compile-time defect.

## Affected Files
- [`src/utilities/UxpValue.h`](../src/utilities/UxpValue.h) (lines 25–93)
- [`src/utilities/UxpValue.cpp`](../src/utilities/UxpValue.cpp) (lines 103–162)
- [`template/template-dev/src/utilities/UxpValue.h`](../template/template-dev/src/utilities/UxpValue.h) (lines 25–93)
- [`template/template-dev/src/utilities/UxpValue.cpp`](../template/template-dev/src/utilities/UxpValue.cpp) (lines 103–162)

## Problematic Code
```cpp
class Value {
 public:
    enum class Kind { undefined, boolean, number, string, list, map };

    using ListType = std::deque<Value>;
    using MapType = std::map<std::string, Value>;

    Value(Value&& value);

    // create undefined value
    Value();

    // type specific creators
    explicit Value(bool value);
    explicit Value(double value);
    explicit Value(std::string value);

    // used to create either a list or a map value
    explicit Value(Kind kind);

    ~Value();
    // No Value& operator=(Value&&)
    // No Value(const Value&)
    // No Value& operator=(const Value&)
```

## Explanation
`Value` manages raw heap pointers (`std::string*`, `ListType*`, `MapType*`) inside an untagged `union u` and declares a custom destructor `~Value()` and a move constructor `Value(Value&&)`.

Under C++ rules, declaring a custom move constructor and destructor **implicitly deletes**:
1. The **move assignment operator** `Value& operator=(Value&&)`
2. The **copy constructor** `Value(const Value&)`
3. The **copy assignment operator** `Value& operator=(const Value&)`

Because `Value& operator=(Value&&)` is deleted:
- You cannot reassign a `Value` variable (`val = Value(42.0);` fails to compile).
- You cannot use `std::swap(val1, val2)` on two `Value` objects.
- You cannot use `operator[]` on `Value::MapType` (`map.GetMap()["key"] = Value(true);` fails to compile because `std::map::operator[]` default-constructs a `Value` and then requires move assignment).
- You cannot call `list.GetList().erase(...)` or `list.GetList().insert(...)` on `Value::ListType` (`std::deque<Value>` requires `MoveAssignable` for middle insertion/erasure).
- You cannot pass or capture `Value` by value in lambdas (forcing workarounds like the `std::shared_ptr<Value>` heap allocation in `module.cpp` line 73).

Additionally, in `Value()` (`UxpValue.cpp` line 103):
```cpp
Value::Value() : kind(Kind::undefined) {
}
```
The union member `data` is left completely uninitialized (`union u { ... } data;`).

## How to Reproduce

### JavaScript Triggerability
**C++-only bug (Compile-Time).** This issue cannot be triggered from JavaScript at runtime because C++ code using move-assignment or copy operations on `Value` fails to compile.

### C++ Reproduction
Try to use standard C++ map/list mutators exposed by `Value::GetMap()` or `Value::GetList()`:
```cpp
Value mapVal(Value::Kind::map);
mapVal.GetMap()["count"] = Value(10.0); // Compile error: operator= is deleted!

Value listVal(Value::Kind::list);
listVal.GetList().emplace_back(1.0);
listVal.GetList().emplace_back(2.0);
listVal.GetList().erase(listVal.GetList().begin()); // Compile error: requires move assignment!
```
- **Expected result**: Standard C++ operations on `Value`, `Value::ListType`, and `Value::MapType` compile and manage memory safely.
- **Actual result**: Compilation fails with `error: Overload resolution selected deleted operator '='`.

## Suggested Fix
Implement the move assignment operator `Value& operator=(Value&&) noexcept` (and optionally copy constructor and copy assignment operator for deep copies), or replace the manual `Kind` + raw pointer `union` with `std::variant<std::monostate, bool, double, std::string, ListType, MapType>`:

```cpp
Value& operator=(Value&& value) noexcept {
    if (this != &value) {
        switch (kind) {
        case Kind::string: delete data.string; break;
        case Kind::list: delete data.list; break;
        case Kind::map: delete data.map; break;
        default: break;
        }
        kind = value.kind;
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
    return *this;
}
```
