# Bug 11: Unresolved Promise and `addon_deferred` Memory Leak When Async `Task` Handlers Fail

## Severity
**High (Resource Leak & Permanently Hanging JavaScript Promises)**

## Scope
**SDK Core (`src/utilities/UxpTask.cpp`) + Template Addon (`template/template-dev/src/module.cpp`)** — Both the SDK's `TaskWrapper::MainThreadThunk` / `ScriptingThreadThunk` (`src/utilities/UxpTask.cpp`) and the sample addon's `MyAsyncEcho` handler (`template/template-dev/src/module.cpp`) use empty `catch (...) {}` blocks that swallow exceptions without calling `uxp_addon_reject_deferred`.

## Affected Files
- [`src/utilities/UxpTask.cpp`](../src/utilities/UxpTask.cpp) (lines 27–39, 73–89)
- [`template/template-dev/src/utilities/UxpTask.cpp`](../template/template-dev/src/utilities/UxpTask.cpp) (lines 27–39, 73–89)
- [`template/template-dev/src/module.cpp`](../template/template-dev/src/module.cpp) (lines 75–102)

## Problematic Code
In `UxpTask.cpp`:
```cpp
void TaskWrapper::MainThreadThunk(addon_task_data data) {
    try {
        reinterpret_cast<TaskWrapper*>(data)->task->InvokeMainThreadHandler();
    } catch (...) {
    }
}

void TaskWrapper::ScriptingThreadThunk(addon_task_data data) {
    try {
        reinterpret_cast<TaskWrapper*>(data)->task->InvokeScriptingThreadHandler();
    } catch (...) {
    }
}

void Task::InvokeScriptingThreadHandler() {
    ResultHandler tmpHandler;
    std::swap(tmpHandler, mResultHandler);

    addon_deferred tmpDeferred = nullptr;
    std::swap(tmpDeferred, mDeferred);

    if (tmpHandler != nullptr)
        tmpHandler(*this, mEnv, tmpDeferred);
}
```

And in `template/template-dev/src/module.cpp`:
```cpp
        auto scriptThreadHandler = [](Task& task, addon_env env, addon_deferred deferred) {
            try {
                HandlerScope scope(env);
                bool isError = false;
                const Value& result = task.GetResult(isError);
                addon_value resultValue = result.Convert(env);

                if (isError)
                    Check(UxpAddonApis.uxp_addon_reject_deferred(env, deferred, resultValue));
                else
                    Check(UxpAddonApis.uxp_addon_resolve_deferred(env, deferred, resultValue));
            } catch (...) {
            }
        };

        auto mainThreadHandler = [valuePtr, scriptThreadHandler](Task& task) {
            try {
                task.SetResult(std::move(*(valuePtr.get())), false);
                task.ScheduleOnScriptingThread(scriptThreadHandler);
            } catch (...) {
            }
        };
```

## Explanation
When `Task::ScheduleOnMainThread` creates a promise with `uxp_addon_create_promise(env, &mDeferred, &promise)`, the host runtime allocates an internal `addon_deferred` object associated with the returned JavaScript `Promise`.

In Node-API / UXP Addon API, `addon_deferred` is only freed when either `uxp_addon_resolve_deferred` or `uxp_addon_reject_deferred` is called.

However, exceptions are silently swallowed by empty `catch (...) {}` blocks at multiple points without ever rejecting `mDeferred`:
1. **Failure in `mainThreadHandler`**:
   If any code inside `mainThreadHandler` throws an exception before `task.ScheduleOnScriptingThread(...)` is called (or if the user's handler doesn't wrap its body and `TaskWrapper::MainThreadThunk` catches the exception), `ScheduleOnScriptingThread` is never invoked. The `Task` is destroyed when `TaskWrapperDestructor` runs, while `mDeferred` was never resolved or rejected!
2. **Failure in `scriptThreadHandler` / `InvokeScriptingThreadHandler`**:
   In `InvokeScriptingThreadHandler()`, `std::swap(tmpDeferred, mDeferred)` clears `mDeferred`. Then `scriptThreadHandler` calls `task.GetResult(isError)` and `result.Convert(env)`.
   - If `SetResult` was not called on the main thread, `task.GetResult(isError)` throws `"No result was set"`.
   - If `result.Convert(env)` fails, `Check()` throws `"error"`.
   In both cases, execution jumps into `catch (...) {}` at line 91 of `module.cpp` (or line 37 of `UxpTask.cpp`) **before** `uxp_addon_reject_deferred` or `uxp_addon_resolve_deferred` is called!

As a result:
- The `addon_deferred` handle is **leaked** in the UXP runtime.
- Any JavaScript caller `await`ing the returned `Promise` **hangs forever** (the Promise never settles).

## How to Reproduce

### JavaScript Triggerability (Requires Async Handler Exception in C++)
In the unmodified sample addon, `mainThreadHandler` only moves a pre-constructed `Value` and schedules `scriptThreadHandler`, which rarely throws on its own unless `Value::Convert` fails or `mainThreadHandler` encounters an error. When any exception occurs inside `mainThreadHandler` or `scriptThreadHandler`, calling `await addon.my_echo_async(...)` from JavaScript hangs forever:

```javascript
const addon = await require("sample-uxp-addon.uxpaddon");

// If mainThreadHandler or scriptThreadHandler throws in C++, this Promise never settles (neither resolves nor rejects):
const result = await addon.my_echo_async(10);
console.log("Never reached:", result);
```

### C++ + JS Reproduction
1. In `module.cpp`'s `mainThreadHandler`, simulate an error by throwing an exception (or omitting `task.SetResult(...)` before `task.ScheduleOnScriptingThread(scriptThreadHandler)`):
   ```cpp
   auto mainThreadHandler = [valuePtr, scriptThreadHandler](Task& task) {
       try {
           // Simulate failure before SetResult:
           throw std::runtime_error("main thread operation failed");
           task.SetResult(std::move(*(valuePtr.get())), false);
           task.ScheduleOnScriptingThread(scriptThreadHandler);
       } catch (...) {
           // Swallowed! Or even if ScheduleOnScriptingThread is called without SetResult,
           // task.GetResult(isError) throws "No result was set" in scriptThreadHandler and is swallowed!
       }
   };
   ```
2. In JavaScript, run:
   ```javascript
   const addon = await require("sample-uxp-addon.uxpaddon");
   await addon.my_echo_async(10); // Hangs forever!
   ```
3. **Expected result**: The returned Promise rejects with the error (`"main thread operation failed"` or `"No result was set"`), and `addon_deferred` is cleaned up.
4. **Actual result**: The Promise never resolves or rejects, hanging the caller indefinitely and leaking `addon_deferred`.

## Suggested Fix
1. If an exception occurs on the main thread in `mainThreadHandler` (or `InvokeMainThreadHandler`), record the error via `task.SetResult(Value(std::string(err.what())), true)` and still schedule the scripting thread handler to reject the deferred promise.
2. In `scriptThreadHandler` (and `InvokeScriptingThreadHandler`), if an exception is caught while `deferred != nullptr`, create an error value and call `UxpAddonApis.uxp_addon_reject_deferred(env, deferred, errorVal)` inside the `catch` block so the Promise is always settled.
