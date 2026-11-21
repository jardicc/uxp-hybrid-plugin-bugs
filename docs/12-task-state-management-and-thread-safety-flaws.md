# Bug 12: Flawed State Management and Missing Thread Synchronization in `Task`

## Severity
**Medium-High (Race Conditions, Null `mEnv` / `mDeferred` Misuse, Broken Single-Use Guard)**

## Scope
**SDK Core (`src/utilities/UxpTask.h`, `src/utilities/UxpTask.cpp`)** — This bug is in the reusable C++ `Task` scheduler class in the SDK itself (and duplicated into `template/template-dev/src/utilities/`). Any hybrid plugin using `Task` for main-thread / scripting-thread scheduling inherits these state and thread-safety flaws.

## Affected Files
- [`src/utilities/UxpTask.h`](../src/utilities/UxpTask.h) (lines 25–57)
- [`src/utilities/UxpTask.cpp`](../src/utilities/UxpTask.cpp) (lines 45–101)
- [`template/template-dev/src/utilities/UxpTask.h`](../template/template-dev/src/utilities/UxpTask.h) (lines 25–57)
- [`template/template-dev/src/utilities/UxpTask.cpp`](../template/template-dev/src/utilities/UxpTask.cpp) (lines 45–101)

## Problematic Code
```cpp
addon_value Task::ScheduleOnMainThread(addon_env env, const Handler& handler) {
    if (mDeferred != nullptr)
        throw "Tasks can only be used to schedule one operation";

    this->mHandler = handler;

    addon_value promise = nullptr;
    Check(UxpAddonApis.uxp_addon_create_promise(env, &mDeferred, &promise));

    TaskWrapper* wrapper = new TaskWrapper;
    wrapper->task = shared_from_this();

    mEnv = env;

    UxpAddonApis.uxp_addon_schedule_on_main_queue(env, TaskWrapper::MainThreadThunk, wrapper, TaskWrapperDestructor);

    return promise;
}

void Task::ScheduleOnScriptingThread(const ResultHandler& resultHandler) {
    mResultHandler = resultHandler;

    TaskWrapper* wrapper = new TaskWrapper;
    wrapper->task = shared_from_this();

    UxpAddonApis.uxp_addon_schedule_on_javascript_queue(
        mEnv, TaskWrapper::ScriptingThreadThunk, wrapper, TaskWrapperDestructor);
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

## Explanation
`Task` is designed to coordinate work between the JavaScript scripting thread and the host application's main thread, but has several state management and concurrency flaws:

1. **Broken single-use guard (`if (mDeferred != nullptr)`)**:
   Line 46 checks `if (mDeferred != nullptr)` to enforce `"Tasks can only be used to schedule one operation"`.
   However, `InvokeScriptingThreadHandler()` (line 85) executes `std::swap(tmpDeferred, mDeferred);`, resetting `mDeferred` back to `nullptr`!
   - If a caller reuses a `Task` object after `InvokeScriptingThreadHandler` has run, `mDeferred` is `nullptr`, so the guard does **not** trigger even though `mResult` and `mIsError` still contain stale state from the first operation.
   - Conversely, if `ScheduleOnScriptingThread()` is called more than once for a single `Task`, the first `InvokeScriptingThreadHandler()` swaps `mDeferred` to `nullptr`, and the second invocation calls `tmpHandler(*this, mEnv, nullptr)` with a null `addon_deferred`!

2. **No validation in `ScheduleOnScriptingThread`**:
   If `ScheduleOnScriptingThread()` is called without first calling `ScheduleOnMainThread()`, `mEnv` is `nullptr` and `mDeferred` is `nullptr`. `ScheduleOnScriptingThread()` passes `mEnv = nullptr` directly into `UxpAddonApis.uxp_addon_schedule_on_javascript_queue(mEnv, ...)`, crashing the host or failing silently.

3. **Data races on `Task` member variables**:
   `Task` has no `std::mutex` or atomic state flag protecting `mHandler`, `mResultHandler`, `mDeferred`, `mResult`, `mIsError`, or `mEnv`. If the scripting thread reads or modifies `Task` state after calling `uxp_addon_schedule_on_main_queue`, or if `ScheduleOnScriptingThread` is called while a previous callback is still accessing `Task`, it causes a C++ data race (Undefined Behavior).

## How to Reproduce

### JavaScript Triggerability
**C++-only bug.** Each call to `addon.my_echo_async(...)` in the sample addon creates a fresh `Task::Create()` instance and schedules it once. Reusing a `Task` instance, calling `ScheduleOnScriptingThread` before `ScheduleOnMainThread`, or accessing `Task` concurrently across threads can only be triggered by C++ addon code.

### C++ Reproduction
#### Case 1: Calling `ScheduleOnScriptingThread` twice or before `ScheduleOnMainThread`
```cpp
auto task = Task::Create();
// mEnv is nullptr here!
task->ScheduleOnScriptingThread([](Task& t, addon_env env, addon_deferred deferred) {
    // env == nullptr, deferred == nullptr
});
```
#### Case 2: Reusing `Task` after completion
```cpp
// After first task completes on scripting thread, mDeferred is nullptr again,
// so calling task->ScheduleOnMainThread(env, handler) a second time bypasses
// the "Tasks can only be used to schedule one operation" check!
```

## Suggested Fix
1. Track task lifecycle state explicitly with an `std::atomic<State>` enum (`Created`, `ScheduledOnMain`, `ScheduledOnScripting`, `Completed`) instead of checking `mDeferred != nullptr`.
2. Verify in `ScheduleOnMainThread` that the state transitions atomically from `Created` -> `ScheduledOnMain`, and verify in `ScheduleOnScriptingThread` that `mEnv != nullptr` and the state transitions from `ScheduledOnMain` -> `ScheduledOnScripting`.
