# 03 — Event & callback architecture

No delegates, no `event`, no `Action`, no closures, no coroutines, and `SendCustomEvent` takes no
arguments. This file is the set of substitutes.

---

## Contents

- [1. The argument channel](#1-the-argument-channel)
- [2. Registration without delegates](#2-registration-without-delegates)
- [3. Continuations for callbacks with no user data](#3-continuations-for-callbacks-with-no-user-data)
- [4. Coroutine substitutes](#4-coroutine-substitutes)
- [5. Re-entrancy](#5-re-entrancy)
- [6. Reaching entry points U# doesn't expose](#6-reaching-entry-points-u-doesnt-expose)
- [7. Dispatch shapes worth stealing](#7-dispatch-shapes-worth-stealing)

---

## 1. The argument channel

There is exactly one, and everything else is a wrapper around it:

```csharp
target.SetProgramVariable("payloadField", value);   // the "argument"
target.SendCustomEvent("HandlerName");              // the "call"
```

Two facts make this worth internalising rather than avoiding:

1. **The friendly form compiles to exactly this.** `target.someField = x; target.SendCustomEvent(nameof(M));` and a typed call `target.M(a, b)` both lower to the same sequence. There is **no cheaper alternative hiding behind the nicer syntax**: what differs is only whether the callee is known at compile time.
2. **`Get/SetProgramVariable` with no receiver operate on the current behaviour's own heap.** So an injected or string-dispatched handler reads its "parameters" with `GetProgramVariable(key)` and needs no `this`, no component lookup and no reference.

`SetProgramVariable` can also write **a method's parameter slots**, not just fields. That is what makes a
general argument-passing serialiser possible at all; the hard part is recovering what those slots are
called (see [06](06-network-event-dispatch.md)).

**The failure mode is aliasing.** The payload field is a single mailbox: a second send before the first is
consumed clobbers it, and a *delayed* or *networked* event must latch its arguments before the send. Copy
what you need out of the mailbox immediately at the top of the handler.

`internal` fields are still reachable (Udon symbol lookup is name-based and ignores C# accessibility), so
wiring fields can be `[SerializeField, HideInInspector] internal` and stay out of the public API.
Do **not** point this at an auto-property: the compiler-generated backing field has a different name.

### Wrappers around it

- **A name-parameterised forwarder.** One tiny behaviour carrying baked strings for the field name, the method name and one target reference serves *every* logical event, because both names are properties of the scene rather than of the code. Drop N copies on N receiver objects, differing only in their strings, all landing on distinct handlers of one aggregating behaviour.
- **`[NonSerialized, FieldChangeCallback]` on an *unsynced* field** turns the write channel into a **command**: any `SetProgramVariable("_Foo", v)` runs the property setter. `_Foo` field / `Foo` property is the de-facto ABI for this.
- **`SetProgramVariable("activeFieldId", id)` immediately before the send** as a sender-ID multiplexer, with `-1` doubling as "unregistered".
- **The sender's loop induction variable declared as a public field IS the event argument**: arguments live on the sender and receivers pull, which keeps the sender completely type-agnostic.
- **Zero-arg ABI with a reset-to-inert sentinel**: write the `IN_` fields, call the 0-arg entry point, reset the fields to an inert value after consumption so a stale read is impossible.
- **Numbered no-arg trampolines**: one real implementation and N trivial adapters, no logic in the adapter.

---

## 2. Registration without delegates

**Assigning the dependency *is* the registration event.** A runtime-spawned object starts with a null
manager reference; whoever spawns it writes the reference, and `_onVarChange_<field>` fires the
registration. No polling, no spawn-time init call, and **no ordering requirement between the spawner and
the spawned object's `Start()`**. Setting the field is the whole contract.

That relies on the next technique, which is one of the most useful here:

### `_onVarChange_<Name>` — the raw field-change event

`[FieldChangeCallback(nameof(Prop))]` is implemented by the compiler emitting an exported entry point named
`_onVarChange_<field>` (`AssemblyInstruction.cs:108-131`, `FieldCallbackExportTag.WriteAssembly`,
**Worlds SDK 3.10.4**).
Declaring `public void _onVarChange_MyField()` yourself produces an export of the identical name, and
Udon's external-write dispatch finds it.

What that buys: a **plain `public bool IsDynamic;`** that keeps its name, stays inspector-editable, is
pokeable by `SetProgramVariable`, *and* fires a callback, where the attribute forces a shadowing property
and renames the field in the Udon symbol table.

```csharp
public Color Color = Color.white;
private Color _old_Color = Color.white;

public void _onVarChange_Color() {          // fired by SetProgramVariable("Color", …)
    if (_old_Color != Color) { _old_Color = Color; NotifyManager(); }
}
```

Constraints: it fires on **external** writes only (`SetProgramVariable`, graph writes, network
deserialization), never on assignment from C# inside the same behaviour, so every setter must update
`_old_` and notify by hand. It fires on *any* write, not only on a change, hence the `_old_` shadow. And
you cannot have both mechanisms on one field: two exports of the same name.

### Other registration shapes

- **Self-registration in `OnEnable`/`OnDisable`** so a consumer cannot forget, and call `_Notify` immediately on subscribe, so a late listener needs no separate initial-state path.
- **Store listeners as root `UdonSharpBehaviour[]`** even when you have a typed base, so UdonGraph and CyanTrigger behaviours can subscribe too.
- **`Component[]` as the storage type for a heterogeneous registry**: when the contract is a string, the container type is irrelevant.
- **Membership in a dispatch list is state.** Self-unsubscribing subscribers turn the update list into a *work queue* rather than a registry; tier demotion means correctness never depends on the fast tier running.
- **Build-time registration removes the problem entirely.** See [11](11-editor-time-tooling.md): two marker components and one scene pass produce a plain serialized reference with zero runtime cost.

---

## 3. Continuations for callbacks with no user data

`OnAsyncGpuReadbackComplete`, `OnPlayerRestored`, `OnStringLoadSuccess` and MIDI handlers are all single
virtuals with no token argument. Two valid answers; **choose by whether requests may overlap.**

**A. An enum field as continuation token *and* in-flight mutex.** Use when they may not.

```csharp
private ARBType _arbType = ARBType.None;
private void Request(ARBType t) {
    if (_arbType != ARBType.None) return;    // the mutex
    _arbType = t;  …
}
public override void OnAsyncGpuReadbackComplete(VRCAsyncGPUReadbackRequest r) {
    if (_arbType == ARBType.LateSync) …
    _arbType = ARBType.None;
}
```

Compact; one heap symbol. A bool per request type cannot express mutual exclusion; four behaviours
quadruple program size. Hazard: a request that never completes wedges the mutex, and there is no timeout.

**B. A purpose-built behaviour per continuation kind: the closure the language forbids.** Use when they
may overlap.

`VRCAsyncGPUReadback.Request(..., (IUdonEventReceiver)someOtherBehaviour)`: the receiver need not be
`this`. Its serialized fields are the captured variables, its single override is the callback body, and
**receiver identity carries the per-request context**, which is exactly what a lambda would have captured.
Removes the mutex at the cost of one program and GameObject each.

Do not make the manager the receiver and keep a side table to remember which request was which. That is the
naive port and it reintroduces the problem the receiver identity already solved. Generalises to every
VRChat API taking an `IUdonEventReceiver`: `SendCustomNetworkEvent`, `VRCStringDownloader.LoadUrl`,
`ImageDownloader`, MIDI.

Related API-shape observation worth carrying: **VRChat replaces generic return values with an out-parameter
array plus a bool** (`TryGetData(Color32[])` for `NativeArray<Color32>`), the same substitution family as
delegate → object + fixed method name. Recognising the family tells you what to look for when an SDK API
seems missing.

---

## 4. Coroutine substitutes

**The self-terminating delayed-event loop** is the real replacement. Four parts:

```csharp
public void UpdateProcess() {
    if (!isActiveAndEnabled) { _running = false; return; }     // liveness check first
    DoWork();
    bool keepGoing = AutoUpdate && HasWork;                     // explicit termination predicate
    if (keepGoing) SendCustomEventDelayedFrames(nameof(UpdateProcess), 1);
    else _running = false;
}
public void Schedule() { if (_running) return; _running = true; UpdateProcess(); }
```

- a **single-owner bool** so repeated schedule calls coalesce;
- an **explicit predicate re-evaluated every tick**, so the loop dies when there is nothing to do;
- a **liveness check at the top**;
- `OnDisable` clearing the flag, or the loop can never restart.

Zero per-frame cost when idle. If the same logic must also exist as a real coroutine in a non-Udon build,
write it as **one method body with the loop scaffolding `#if`'d around it** so the two forms cannot diverge.
The Udon side's braces will look unbalanced, and that is correct.

The **opposite idiom** also exists and is also correct: for a *finite* task, re-arm **inside** the work
predicate, so the loop terminates by running out of work rather than by a condition. Know which one
you are writing.

### The awkward properties of `SendCustomEventDelayed*`

It cannot be cancelled, cannot be de-duplicated, and takes no arguments. Each has a workaround:

- **Coalescing needs a scheduling guard *and* a parameter-merge slot.** A second field accumulates the *strongest* pending request, so a queued full rebuild is not downgraded by a later incremental one. Merging the strongest request into a field is how you emulate the argument you cannot send.
- **Cancellation is counting.** Generational counters: increment on schedule, act only when `count == 1`, decrement unconditionally. Self-healing, and you never learn which timer you are.
- **Or make it a polled deadline field** instead of a scheduled event, if you already have a loop.
- **Timer coalescing "longest wait wins"**, with the rate limit folded into the same deadline.
- **`SendCustomEventDelayedFrames(..., 0)`** means "again later this same frame". With `EventTiming.Update`/`LateUpdate` the **timing enum is the payload**, not the delay: a phase shift rather than a wait.
- **Delaying by frames is the right tool for "after everyone's `Start()`"**, where a time-based delay is a guess. Two frames = two `yield return null`s when you are waiting on someone else's code.
- **Delayed events with arguments**, if you really need them: a per-behaviour trampoline plus a stable priority queue, where **identity is implied by ordering**: pending fires equals queued events.

---

## 5. Re-entrancy

- **`SendCustomEvent` and `SetProgramVariable` are re-entrancy barriers.** The VM has no call stack, so locals alias. The **delayed and network variants are not**, which makes `DelayedFrames(..., 0)` the safe form when a method may re-enter.
- **`[RecursiveMethod]` protects locals, not shared flags.** A re-entrant broadcast must snapshot and clear its per-listener suppression flags before iterating.
- **The strictest form: make re-entering a bus abort the outer dispatch.** Every re-broadcast then becomes a one-frame thunk, and you end up with a family of one-line public methods existing purely as delayed-event targets.
- **A re-entrancy flag doubles as a call-context privilege check**: "am I being called from inside the dispatcher?" is often the security question you actually wanted.
- **`hasX` null-mirror bools double as re-entrancy latches.** Udon has no `SetValueWithoutNotify`, so borrow the null-check bool you already keep. Costs zero extra symbols and fails safe.
- Edit-time synchronisation has the same problem in different clothing: **the flush writes to the components whose change events it consumes**, so an `_isFlushing` guard is load-bearing or the updater feeds itself forever.

---

## 6. Reaching entry points U# doesn't expose

The `override` list is a **hand-curated convenience layer over Udon's string entry-point table**, and the
table is the authority. Declaring a public method named after a table entry works:

```csharp
public abstract void _onBecameVisible();   // called by UdonBehaviour.OnBecameVisible()
```

Also confirmed: `_onWillRenderObject`, `_onRenderObject`. Method: grep `UdonBehaviour.cs` for
`RunEvent("_...")`.

The cost side of the same table: declaring `_update`, `_onWillRenderObject`, `_onTriggerStay`,
`_onCollisionStay`, `_onAnimatorMove` or `_onAudioFilterRead` makes `ProcessEntryPoints` attach a hidden
proxy MonoBehaviour, so **not declaring `Update()` is a real optimisation**.

Related: **lifecycle handlers are ordinary callable methods, so call them.** Hand-invoking
`OnStationEntered`/`Exited` turns "swap two occupants" into "swap two seat *identities*" with three nested
save/restore brackets and no synced state. Calling another behaviour's `OnPickup()`/`OnDrop()` directly
treats them as named state transitions. Re-invoking a third-party `Awake()` from
`IProcessSceneWithReport` fixes an ordering bug you don't own: legitimate rather than a hack, because
scene processing runs *before* Unity's static batching.

---

## 7. Dispatch shapes worth stealing

- **The prefix encodes the audience.** `_L_`/`_O_`/`_G_`/`_P_` on every event name, so an extension reads its execution context off the name and contains almost no `if (IsOwner)`.
- **Ternary-selected event name.** `SendCustomEventDelayedFrames(cond ? nameof(A): nameof(B), 2)`: `nameof` is a compile-time string, so this is a zero-cost branch and the closest Udon offers to passing a method as a value.
- **Event-name rewriting to virtualise a scope.** `Replace("O_PilotEnter", "P_PassengerEnter")`: the routing key is data, so a sub-scope needs no parameter on any listener.
- **Priority as parallel arrays with a null-hole "skip" array**: reusing the null check that has to exist anyway.
- **Runtime overload selection** by probing the `__N_Name` mangling, or by comparing the argument's *type name* string.
- **Hex symbol names as the dispatch address space** (`_t18`/`_a03`), with readable names living only in an edit-time JSON side table.
- **State reconciliation by synthesising the event stream**: fill the `OUT_` fields by hand and call your own handlers, which only works because the ABI's payload channel is fields, not arguments.
- **Dispatch by *receiver object* rather than by branch** (§3B) is the same idea one level up.
- **A separate driver behaviour owns the schedule; the worker owns the mechanism.** With a write-through mirror of the pushed settings, steady state performs zero cross-behaviour writes and only the one call.
