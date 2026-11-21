# Bug 08: `GetString` Truncates Strings Containing Embedded Null Characters (`\0`)

## Severity
**Medium (Silent Data Truncation)**

## Scope
**SDK Core (`src/utilities/UxpValue.cpp`)** — This bug is in the reusable C++ `GetString()` helper in the SDK itself (and duplicated into `template/template-dev/src/utilities/UxpValue.cpp`). Any hybrid plugin that uses `Value` to pass strings between JS and C++ will silently lose all characters after the first embedded `\0` byte.

## Affected Files
- [`src/utilities/UxpValue.cpp`](../src/utilities/UxpValue.cpp) (lines 40–56)
- [`template/template-dev/src/utilities/UxpValue.cpp`](../template/template-dev/src/utilities/UxpValue.cpp) (lines 40–56)

## Problematic Code
```cpp
std::string GetString(const addon_apis& apis, addon_env env, addon_value value) {
    size_t length = 0;
    Check(apis.uxp_addon_get_value_string_utf8(env, value, nullptr, 0, &length));

    std::string result;
    if (length > 0) {
        std::vector<char> buffer(length + 2);
        size_t actualLength = 0;
        Check(apis.uxp_addon_get_value_string_utf8(env, value, &buffer[0], length + 1, &actualLength));
        if (actualLength > 0) {
            // Make sure that we have a zero terminated string
            if (buffer[length] != 0)
                buffer[length] = 0;
            result = std::string(&buffer[0]);
        }
    }
    return result;
}
```

## Explanation
JavaScript strings and `std::string` are both length-delimited and can legally contain embedded NUL (`\0`) characters.

In `GetString()`:
1. The first call to `uxp_addon_get_value_string_utf8(env, value, nullptr, 0, &length)` retrieves the full UTF-8 byte count (excluding the trailing null terminator).
2. The second call copies all `actualLength` bytes into `buffer` and sets `actualLength` to the number of bytes copied.
3. However, line 52 constructs `result = std::string(&buffer[0]);` using the single-argument `std::string(const char*)` constructor instead of `std::string(buffer.data(), actualLength)`.
4. `std::string(const char*)` uses `strlen()` and stops at the **first** `\0` byte it encounters, silently discarding the rest of the string!

Notice that the reverse conversion in the same file (`Convert` at line 98) uses `value.size()`:
```cpp
Check(apis.uxp_addon_create_string_utf8(env, value.c_str(), value.size(), &result));
```
So `Convert` supports embedded null characters, while `GetString` silently truncates them. (Additionally, `buffer(length + 2)` allocates an unnecessary extra byte when `length + 1` is passed as `bufsize`.)

## How to Reproduce

### JavaScript Reproduction (Direct)
Yes — this bug can be triggered directly from JavaScript by passing a string containing an embedded `\0` character to `addon.my_echo` or `addon.my_echo_async`:

```javascript
const addon = await require("sample-uxp-addon.uxpaddon");

const input = "hello\0world";
const output = addon.my_echo(input);
console.log("Input length:", input.length, "Output length:", output.length, "Output:", JSON.stringify(output));
// Expected: Input length: 11, Output length: 11, Output: "hello\u0000world"
// Actual:   Input length: 11, Output length: 5,  Output: "hello"
```

- **Expected result**: `output` is `"hello\0world"` with `output.length === 11`.
- **Actual result**: `output` is truncated to `"hello"` with `output.length === 5`.

## Suggested Fix
Construct `std::string` directly with the exact `actualLength`:

```cpp
std::string GetString(const addon_apis& apis, addon_env env, addon_value value) {
    size_t length = 0;
    Check(apis.uxp_addon_get_value_string_utf8(env, value, nullptr, 0, &length));

    std::string result;
    if (length > 0) {
        result.resize(length);
        size_t actualLength = 0;
        Check(apis.uxp_addon_get_value_string_utf8(env, value, &result[0], length + 1, &actualLength));
        result.resize(actualLength);
    }
    return result;
}
```
