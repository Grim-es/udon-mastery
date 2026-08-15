# 99 — Anti-patterns

Myths, traps, and failure modes seen in shipped code. Grouped by how they fail.

---

## Contents

- [1. Myths — things people avoid that actually work](#1-myths--things-people-avoid-that-actually-work)
- [2. Things that fail silently, and only in the uploaded world](#2-things-that-fail-silently-and-only-in-the-uploaded-world)
- [3. Traps in the Unity API, as seen from Udon](#3-traps-in-the-unity-api-as-seen-from-udon)
- [4. The one that eats your git history](#4-the-one-that-eats-your-git-history)
- [5. Design anti-patterns](#5-design-anti-patterns)
- [6. Failure modes seen in shipped code](#6-failure-modes-seen-in-shipped-code)
- [7. Discipline that prevents most of the above](#7-discipline-that-prevents-most-of-the-above)

---

## 1. Myths — things people avoid that actually work

The full corrected list with compiler evidence is in the
[README](README.md#constraint-corrections-read-this-before-anything-else). The point to internalise:

> **The circulated constraint list is wrong, and always in the same direction: it forbids more than the
> compiler does.**

Items commonly avoided that the compiler accepts: `partial class`, method overloading by arity *and* type,
`params`, `static` methods on a behaviour, static classes and extension methods, generic static helpers
(monomorphised per call site), default parameter values **including enum-typed**, `out`/`ref`, `using static`
and type aliases, `readonly` field initialisers, `[DefaultExecutionOrder]`, `Stopwatch`, `StringBuilder`,
`System.Type` as a runtime value, `BitConverter.SingleToInt32Bits`, `Buffer.BlockCopy`,
`Convert.To/FromBase64String`, `[System.Diagnostics.Conditional]`, `[OdinSerialize]`, and Unity/BCL **`struct`
types as mutable fields** (the restriction is on declaring new struct types, not on using existing ones).

Two widely-repeated claims are themselves wrong and are corrected here (**Worlds SDK 3.10.4**):

- *"Enum-typed default parameters are rejected"*: **false** (`ParameterSymbol.cs:32-45` has a dedicated `IsEnum` branch added to support them).
- *"`-2146483648` is an apparent typo"*: **false**. It is exactly `int.MinValue + 1000000`, the lowest legal execution order; `int.MinValue` itself is a hard compile error.

**A workaround you will meet in older code, obsolete on 3.10.4**: `if (cond) { } else { … }` with an empty
then-branch, written to dodge the EXTERN cost of `!`. The binder strips a top-level negation from an
`if` and swaps the branches, so it is redundant. Do not copy it, and delete it on sight.
(The peephole applies *only* to an `if` statement's condition: `while (!x)`, `bool y = !x;`, ternaries and
`!` inside an `&&` chain all still pay.)

---

## 2. Things that fail silently, and only in the uploaded world

The worst category, because the editor tells you nothing.

- **Editor code writing a U# proxy field is discarded at build.** The inspector shows the value; it is gone on the next domain reload or at upload. Use `publicVariables.TrySetVariableValue` (edit/build) or `SetProgramVariable` (play mode) on the **backing** `UdonBehaviour`.
- **A U# reference *is* an `UdonBehaviour`.** Injecting the proxy object produces a broken reference with **no error at build or at runtime**.
- **Plain `Undo.AddComponent` adds only the proxy.** The component exists, does nothing in a build, and nothing warns you. Use `UdonSharpUndo.AddComponent<T>`.
- **Three ways a U# component desynchronises from its backing**: missing backing, backing on a different GameObject, mismatched program type, plus orphans in the other direction. None produce an error.
- **Anything the runtime still needs from a field a build pass nulled** breaks only in the uploaded world.
- **A `#if`-guarded field changes the emitted program**, so a platform-specific bug is invisible until you switch build targets.
- **`GetProgramVariable` / `SendCustomEvent` on a name that does not exist is a silent no-op**: this is what makes string ABIs cheap, and what makes them unverifiable. Hence: **`nameof` across an assembly reference, or nothing**.
- **A `[NetworkCallable]` rate ceiling that is too low drops events silently.**
- **Serialization callbacks never fire when you are alone in the instance**: "works with a friend, does nothing solo".
- **Synced fields are not populated in `Start()`.**
- **A field renamed without updating an injection string** stops the injection with no compile error.
- **A typo in `defineConstraints` produces *no assembly* rather than an error**, and the symptom is "my component doesn't exist".
- **`Shader.Find` in a static initialiser** runs at domain reload, before shaders may be imported on a fresh project, a null there silently disables the feature.
- **Routing by asset-*name* substring** (`rt.name.Contains("Color")`) is cheap and silently unwires when someone renames an asset.

---

## 3. Traps in the Unity API, as seen from Udon

- **`renderer.material` clones the material** on first access: breaks batching, and in a world that never unloads the clone is permanent. Use `sharedMaterials` (a read-modify-write of the array; `sharedMaterial` only touches submesh 0) or a property block.
- **`SetPropertyBlock` clobbers wholesale.** Skipping `if (r.HasPropertyBlock()) r.GetPropertyBlock(block);` **silently destroys every other system's per-renderer overrides**.
- **Unity's built-in blit shader is half precision.** Float data in a RenderTexture ping-pong becomes subtly wrong with distance from the origin, and it reads as "jitter", not as precision loss.
- **`Vector3 ==` / `Quaternion ==` are approximate** (~1e-5). Compare components individually wherever the comparison gates an exact fast path, a false "equal" silently drops an update.
- **`Array.IndexOf(arr, null)` is a *reference* compare and cannot see Unity fake-nulls.** Null the reference yourself.
- **`Renderer.bounds` resets if the mesh is reassigned.**
- **`SetTriangles(..., calculateBounds: true)` silently overwrites bounds you just set.**
- **Dynamic batching bakes vertices to world space and resets `unity_ObjectToWorld` to identity**, destroying any shader that reads its own object transform. Set `"DisableBatching" = "True"`.
- **Static batching bakes world positions**, so build tooling that moves things must clear `isStatic`.
- **A CustomRenderTexture over a volume issues one draw call per depth slice.**
- **Global shader properties are process-wide and sticky**: they survive exiting play mode and leak between worlds. Reset with *neutral*, not zero, values from an editor hook.
- **A texture property with any default cannot be overridden by `SetGlobalTexture`**: declare `= "" {}`.
- **`SetPropertyModifications` wipes every `hideFlags` on the prefab instance.**
- **`Undo.DestroyObjectImmediate` on an inherited prefab component records a removed-component override** rather than breaking the connection, usually what you want, and worth knowing either way.
- **`DestroyImmediate` is illegal in `OnValidate`**, and U# needs `UdonSharpEditorUtility.DestroyImmediate` anyway.
- **`Resources.FindObjectsOfTypeAll` returns components inside loaded prefab *assets*** as well as scene objects.
- **`float3[]` in a constant buffer does not pack three-to-a-float4**: the 16-byte stride means it saves nothing.

---

## 4. The one that eats your git history

> **Udon writing to a serialized `Material` reference mutates the project asset.**

In a build it is harmless: the world bundle has a copy. **In ClientSim / play mode it permanently rewrites
the `.mat` file in your repository**, so every play session silently commits the last frame's animated
values into source control. The symptom is "git says my materials changed and I didn't touch them".

The naive fix ("instantiate a runtime copy in `Start()`") changes the world's behaviour and costs an
allocation per material. The correct fix is a snapshot/restore hook:

- on `ExitingEditMode`, untyped-walk every Udon behaviour for reachable `Material`s (plus `CustomRenderTexture.material`) and snapshot each with `Object.Instantiate` + `HideFlags.HideAndDontSave`;
- on `ExitingPlayMode`, restore with `EditorUtility.CopySerialized`: a full in-place serialized overwrite preserving the asset's GUID, where `CopyPropertiesFromMaterial` would miss non-shader state;
- **diff-log which properties were reverted**, so you learn what your world touched;
- and hook `OnWillSaveAssets` too, or Ctrl+S *during* play mode writes the dirty values straight to disk before the exit hook runs.

---

## 5. Design anti-patterns

- **Cross-behaviour state reset by N `SetProgramVariable` calls** where one `SendCustomEvent` would do. Strictly worse per call, and it turns field names into an untyped string API. Its one legitimate use is loose coupling to a behaviour whose program you do not compile against.
- **Unrolled `[UdonSynced]` scalars plus an `if (i == k)` ladder**: an anti-pattern with a *real cause* (there is no indirect field addressing), and the modern answer is one synced array under `Manual`.
- **Copy-paste inheritance as the mixin substitute.** The failure is always the same: one copy misses an update the others got (a missing `_dataNeedsSync = true`) and nothing detects it.
- **`if (debugLogging) Debug.Log($"…")`** does nothing for program size and still evaluates the interpolation. Use a scripting define or `[Conditional]`.
- **A runtime `bool` for a platform capability** ships both code paths and both sets of fields to both platforms. `#if` removes them.
- **A per-instance cache of shared-resource state.** Caching "the keywords I last set" on the *caller* is wrong when the material is shared; the cache belongs on whoever owns the resource, guarded by an identity comparison.
- **`SendCustomEventDelayedFrames` with no scheduling guard** queues N events for N calls, uncancellably.
- **Sorting an array of instances to take the top K**, where an insertion select over an index array never permutes the authoring order and degenerates to O(n).
- **An int-keyed "done" memo of instance IDs**: Unity recycles instance IDs after a scene unload, so it silently suppresses work for an unrelated component later. Store the object as the value and check `ReferenceEquals`.
- **Content-addressed dedup applied to mutable slots** collapses every constant-filled reservation into one. The opt-out must be a parallel flag, not a property of the content.
- **A migrator that guesses.** `Length != 1` should be fatal; prefab instances should be refused; blocked items should be reported, not repaired.
- **Deliberately non-antisymmetric `CompareTo`** so a sorted set does not dedupe.
- **`GameObject.Find(nameof(T))` as a singleton** is only safe if `OnValidate` renames the object back, and the cost belongs in the method name (`…_Expensive`).

---

## 6. Failure modes seen in shipped code

Each of these shipped. Check your own code against every one.

- **Parallel arrays that fall out of step**: an allocator that swaps every array except one, or a tombstone allocator with a fourth array that is never grown. The second desyncs clients, and the symptom appears nowhere near the allocator. *If you are shipping on ProTV, audit its tombstone allocator's parallel arrays before building on them.*
- **An evicted cache entry removed from the dictionary but never `Destroy`ed**: a permanent leak in a world that never unloads.
- **Self-recursive property getters** (`ConeLength => ConeLength`). In C# that is a stack overflow; under U#, recursion without `[RecursiveMethod]` reuses one frame's locals, so the failure is **corrupted locals rather than a clean crash**.
- **A key mismatch between writer and reader**: `"__getProfilerDataReader"` read where the field is `__profilerDataReader`. The unchecked-string failure mode, live and shipped.
- **`Vector4 → Vector3` truncation hidden by an arity overload.**
- **A `DataDictionary` added with a string key and removed with an int key**: `DataToken` types must match, so it never matches.
- **A `Distinct()` whose result is discarded**: duplicates survive, and it shows the pass was never run against the object under two roots.
- **`X = X++` is a no-op.**
- **A missing `break` in an N-nearest insertion.**
- **An inverted filter in a "broadcast a verb, act on what you own" handler.**
- **A `ReadDouble` ignoring its `startIndex`; an unreachable `0xFE` switch arm** in a hand-rolled serialiser. See [06 §3](06-network-event-dispatch.md#3-wire-format-if-you-are-writing-one) for the one you are most likely to vendor.
- **A busy-wait on the Package Manager** (`while (!listRequest.IsCompleted) { }`).
- **A wall-clock chunking budget left at 5000 ms**, which defeats the whole mechanism while looking like it works.
- **A capability check comparing a value to itself**, which therefore passes for everything.
- **A background-thread reflection scan whose split at the Unity-API boundary has a real race.**
- **A `_Register(Component)` maintained but never iterated**: either a forward-declared extension point or a dispatch site that does not exist.

Two of these, the parallel-array desync and the self-recursive getter, are *class* hazards rather than
one-off slips, and both come from idioms that mass-produce near-identical code (parallel-array allocators;
the "setter pushes to shader" accessor). **If you adopt those idioms, adopt a lint pass with them.**

---

## 7. Discipline that prevents most of the above

- **Make the critical section structurally return-free**, because there is no `finally`: hoist every validation above the mutation, make the restore idempotent, and call it *first* so previously-leaked state repairs itself. **The invariant is enforced by code shape, not by discipline.**
- **`default:` stacked onto a real `case`** for definite assignment without a `throw`: costs nothing and states the fallback policy where a language with exceptions would state the failure policy.
- **Guard by round-trip**: re-derive the input from the value you just computed and require exact equality before engaging.
- **Assert your budgets at `Start()`**: a bandwidth number derived from a designer-facing tick rate, logged loudly, is the substitute for the contract-checking Udon lacks.
- **Watchdog counters** where a loop bound came off the network.
- **Poll for corpses**: `UdonBehaviour.enabled` is the only fault signal.
- **`Try…` + `bool` + `out`, sentinels chosen so they are already correct under the consuming relation, and never ship an empty array.**
- **Treat the absence of exceptions as a design constraint that forces an explicit fallback policy at every branch point**, not as a loss. Decide what each branch does when its assumption fails, and write it down.
