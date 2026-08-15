# 08 — Performance patterns

[01](01-extern-economics.md) is the cost model. This file is how to spend a frame.

---

## Contents

- [1. The frame budget is spent by *activation*, not by early-out](#1-the-frame-budget-is-spent-by-activation-not-by-early-out)
- [2. Pull, don't push](#2-pull-dont-push)
- [3. Scheduling](#3-scheduling)
- [4. Compute once, at the cheapest moment](#4-compute-once-at-the-cheapest-moment)
- [5. Decompose *what changed*](#5-decompose-what-changed)
- [6. Lazy resolution done properly](#6-lazy-resolution-done-properly)
- [7. Micro-idioms that pay](#7-micro-idioms-that-pay)
- [8. Where the real wins are](#8-where-the-real-wins-are)

---

## 1. The frame budget is spent by *activation*, not by early-out

**Every `Update()` on every instance is an Udon program entry with real dispatch overhead even if the body
immediately returns.** So "compute in `Update`, expose a cached field" taxes every world that merely has
your prefab present.

> **Target: zero or one `Update()` in the whole runtime, however large it is.** A 4,000-line system can
> reach exactly one, in a small helper. If you have dozens, that is the first thing to fix.

The escalating ladder of ways to *stop being dispatched*:

| technique | removes | keeps working |
|---|---|---|
| `enabled = false` | `Update`/`LateUpdate` dispatch | public methods, `SendCustomEvent`, the whole graph |
| `gameObject.SetActive(false)` | the object and its children entirely | nothing — but re-activation is one call |
| `Destroy(this)` in `Start()` | the program's VM residency permanently | everything it configured, because that lives on the Renderer/transform, not on the behaviour |
| not declaring `Update()` at all | a hidden proxy `MonoBehaviour` that `ProcessEntryPoints` would otherwise attach | — |

- **`enabled = false` with setters that manually pump `Update()`** turns a polling loop into a push model with no dirty flag and no extra state: `Start()` ends with `this.enabled = false` when nothing is dynamic, and every mutating API method ends `if (!this.enabled) Update();`. An early-return guard does **not** do this: only `enabled = false` removes you from Unity's dispatch list. If you need several tick rates, ship one trivial subclass per timing with an empty `Start(){}` purely so the enabled checkbox appears.
- **`gameObject.SetActive` as the per-plugin frame-scheduling primitive**, refcounted by occupancy and by selection. Put each plugin on its own GameObject *specifically so* activation is per-plugin.
- **`Destroy(this)` in `Start()`** for any behaviour whose entire job is to push inspector values into a `MaterialPropertyBlock` once. Hundreds of such behaviours become zero programs. State the trade in the tooltip and make it opt-out: the transform still updates, but the properties can no longer be changed at runtime.
- **`gameObject.SetActive(false)` as a `FixedUpdate`-before-`Start` guard**: removes the VM entry entirely rather than adding a branch.
- **`enabled = <compile-time const>` in `Start`** removes a per-frame behaviour from the loop with no runtime decision at all.

---

## 2. Pull, don't push

**Pull-based frame memoisation** makes a library component cost *nothing* when nobody asks:

```csharp
public float _GetProximity() {
    if (lastFrame == Time.frameCount) return cached;
    lastFrame = Time.frameCount;
    …expensive…
    return cached;
}
```

N queries in one frame cost one computation; zero queries cost **nothing at all, not even a callback
registration**. The `Time.frameCount` stamp, rather than a dirty bool cleared in `LateUpdate`, is what
allows *no loop at all*. Frame-scoped memoisation keyed by playerId, invalidated by writing `-1`, is
the same idea with a key.

The trade is explicit: consumers who need a *change notification* get nothing, and two consumers in
different phases share whichever value was computed first.

---

## 3. Scheduling

- **Self-terminating delayed-event loops** are the default: zero cost when idle. See [03 §4](03-event-and-callback-architecture.md#4-coroutine-substitutes).
- **But "delayed events beat `Update`" is not a rule.** It is true when a behaviour is idle, false when it is active, and false again when several loops share state and ordering matters. Once you have three self-rescheduling chains that interact, replace them with two engine callbacks driving three independent rates off `now >= _next`: one dispatch point, and the "is my loop double-started" bug class disappears. Use `Time.timeSinceLevelLoadAsDouble`: `Time.time` loses resolution after hours and a 0.03 s tick would drift.
- **Split which callback by IK dependency**: work needing a bone position must run *after* IK, so it lives in `PostLateUpdate`; sync and cleanup do not.
- **Round-robin amortisation with one dispatcher index** converts "N behaviours each working every N frames" into "one behaviour doing one unit per frame", which removes the *periodic spike*, not just the average. One dispatcher can carry several rate classes.
- **Randomise the phase at `Start`** so N instances never spike together.
- **Amortise across frames with a resumable cursor**, and publish partial results only per completed unit: a six-face shadow bake renders `[cursor, +facesPerFrame)`, defers the blur until the cycle completes so no face is blurred against half-stale neighbours, and **restarts from 0 on any invalidating change rather than trying to patch**.
- **Wall-clock-budgeted chunking**: `Stopwatch` plus `SendCustomEventDelayedFrames`, with the continuation *and* the terminator chosen by one ternary inside a single scheduling call. Snapshot-and-clear the producer queue.
- **Time-sliced frame-resumable sort** with an explicit `int[300]` stack and all state in instance fields, and **sort the permutation**, so an interrupted sort leaves valid-but-unsorted data rather than corrupt data.
- **One axis per frame, alternating**, using the `Vector3` indexer so the write expression is not duplicated.
- **Reschedule first, then work.** Placing the re-arm at the top makes cancellation O(1) and race-free, and stops a cursor advancing wrongly after a removal.
- **Amortisation must propagate through the maths**: if a loop now runs every 5th frame, the coefficients change (`*.2f`). And once dispatch rate is variable, **frame-rate-exact IIR smoothing (`Mathf.Pow(k, dt)`) becomes mandatory**: a coupling that is rarely stated.

---

## 4. Compute once, at the cheapest moment

**Everything derived from an inspector value is computed once at init**: computed in `Start` and never again,
not cached lazily:

- angles → **dot-product thresholds** (`Vector3.Angle` is *several* externs);
- divisions → reciprocals;
- predicates → bools;
- layer masks → literals;
- `Transform`s, animator hashes, `PropertyToID` ints, `Networking.LocalPlayer`, array lengths;
- `Quaternion.Euler` → literal quaternion components, so no transcendental EXTERN runs at all.

**Push derivation further up than that where you can** (see [11](11-editor-time-tooling.md)):

- edit-time-computed inverse matrices, reciprocals, and even **the predicate that selects a shader branch**, shipped as a serialized bool;
- **elide a matrix row**: store rows 0 and 1 of an orthonormal rotation and let the shader rebuild row 2 as `cross(r0, r1)`, a third of the constants *and* a third of the upload, for one `cross()` per pixel. 
- **sort by mutability at bake time so the per-frame loop is a contiguous prefix**, with no test inside the loop. A data-layout decision made in the editor that deletes a branch from a hot loop, worth far more in Udon than in normal C#, because there are no filtering constructs and iteration is EXTERN-heavy;
- **normalise data at import time specifically to remove runtime EXTERNs**: any string the runtime will compare should be canonicalised by the editor;
- **stagger a per-instance constant at build time** (autoplay offsets), because a static scheduling problem needs no runtime coordination.

---

## 5. Decompose *what changed*

Two tiers, both necessary:

1. **Skip if unchanged.** `localToWorldMatrix.Equals(previous)`: exact `ValueType.Equals`, not `==`.
2. **Then decompose.** Compare the nine basis elements explicitly; if only the translation column changed *and* the object has no active shadow, write one `float4` and set one upload flag. `UploadChanges()` then uploads only the arrays whose flags are set.

That second tier is what makes a moving object nearly free. Translation-only motion is the common case, so
the decomposition preserves all the static data and skips the repeated cross-behaviour reads that would
otherwise rebuild it.

Companion techniques:

- **Cache the `Transform`, not the behaviour**, in a parallel array at rebuild time, so the per-frame loop never calls `instance.transform`, a cross-behaviour read *and* an extern.
- **A write-through mirror of another object's state, held by the writer**: push five settings through a `Configure` method that mirrors each locally and early-outs when nothing changed, and the steady-state loop performs **zero cross-behaviour writes**.
- **Early-out when the packed value is unchanged**, so a static entity costs nothing after the first frame.

---

## 6. Lazy resolution done properly

```csharp
private Service __svc = null;
private bool    __needSvc = true;
public void Entry() {
    if (__needSvc) {
        __svc = Locate();
        __needSvc = !Utilities.IsValid(__svc);      // derived from the RESULT
        if (__needSvc) { Debug.LogError("not found"); return; }
    }
    // hot path: one bool read
}
```

One bool serves as both "still needs resolving" and "resolution failed", because it is derived from the
validity of the result. The obvious `if (svc == null) svc = Find(...)` costs a
`UnityEngine.Object` null-comparison **EXTERN on every call forever**, cannot distinguish "not looked up
yet" from "genuinely absent", and retries the expensive lookup on every call while the service is missing.

---

## 7. Micro-idioms that pay

- **`foreach` over an array beats the hand-written `for`** (it hoists `.Length`).
- **`hasX` bool mirrors** of every inspector reference and every refcount, because `!= null` and `count > 0` are EXTERNs and a bool field read is a native jump.
- **Guard clauses** rather than nesting: exiting depth-*n* nesting costs *n* jumps.
- **`switch` over a chain of `if`s** when the values are dense: a real jump table, and a `switch` over an extern enum is rewritten to its underlying int deliberately.
- **Hoist hot-path locals to fields**: a local's initialiser is instructions on every call.
- **Precompute a safe loop length** (`Mathf.Min(params int[])`) so the hot loop needs no bounds check, and note an out-of-range index **halts the behaviour** with nothing to catch.
- **Ternary over array *fields*** is a pointer select, so `(a ? xs: ys)[i]` lets one loop body serve two modes.
- **Branchless mute via a `0/1` int multiplier**; a bool shader property toggled with `(v+1) % 2`.
- **Dirty flags at statement granularity** collapse several UI triggers into one traversal.
- **`GetComponent<TUdonSharpBehaviour>()` is expensive**: `GetComponents(typeof(UdonBehaviour))` plus a string-keyed heap probe and a boxed-long compare per component. Resolve at build time instead.
- **`component.name` allocates a managed string per get.** Cache it in hot loops.
- **A `const bool` deletes its branch entirely.**

---

## 8. Where the real wins are

Ranked by weight of evidence, largest first:

1. **Move the data somewhere Udon never iterates.** VRAM, a baked texture, a property block, a `sortingOrder` int, the transform child list. See [09](09-udon-gpu-bridges.md).
2. **Move the work to build time.** See [11](11-editor-time-tooling.md).
3. **Stop being dispatched** (§1).
4. **Reduce boundary crossings**, not instruction counts (§5, [01](01-extern-economics.md)).
5. **Then** micro-optimise, and mostly by installing UdonSharpOptimizer rather than by hand.
