---
name: udonsharp
description: Use when writing, editing, reviewing or designing UdonSharp (U#) scripts or UdonSharpBehaviours for a VRChat world, deciding whether a C# feature compiles under Udon, choosing a sync mode, wiring networked or synced state, budgeting performance in VM instructions, driving shaders or GPU work from Udon, writing editor-time tooling, or diagnosing symptoms like "is not exposed to Udon", CE_UdonMethodNotExposed, CE_NodeNotSupported, a behaviour halting mid-run, SendCustomNetworkEvent silently doing nothing, RequestSerialization not reaching late joiners, or "works with a friend, does nothing solo". This is the compiler-boundary and cost-model layer. It does not cover scene setup, layers, lighting, the Build Panel, uploading, video players, web/image loading, UI toolkits, or the SDK API reference. Do not treat its silence on those as a constraint.
---

# UdonSharp

UdonSharp compiles C# to Udon, a **restricted VM**. Much of C# is unavailable; the rest maps to VRChat's
`VRC.SDKBase` / `VRC.SDK3.*` APIs. This skill is a reference, verified against the compiler source in
`Packages/com.vrchat.worlds/Integrations/UdonSharp/` in **Worlds SDK 3.10.4** (Unity 2022.3.22f1). UdonSharp
has no standalone version; it ships inside the Worlds SDK.

Two failure classes: (a) constructs the U# compiler explicitly rejects → a named compile error; (b) BCL calls
"not exposed to Udon" → `CE_UdonMethodNotExposed`.

**The unifying rule: anything Roslyn erases before UdonSharp sees the syntax tree survives.** `partial`
*classes*, overloading, `params`, default parameters, `using` aliases and `const` folding all work for that
reason; `partial` *methods*, which reach the tree intact, are rejected. When in doubt, ask whether the
construct still exists by the time the compiler binds a syntax tree.

## Scope of this skill

This is the **compiler-boundary and cost-model layer**: what survives the compile, what an operation costs
in VM instructions, how sync behaves as a network protocol, and the techniques that exist only because
Udon forbids the ordinary answer.

Out of scope: scene setup, layers, lighting, occlusion, the Build Panel, uploading, video players, web or
image loading, UI toolkits, and the SDK API reference. **Its silence on a topic is not a constraint**; for
those, use the SDK documentation.

## Going deeper — `references/`

The table below answers *"does this compile?"*. For everything above the language level, read the one file
that matches the task. Each is standalone; read one, not all.

| Doing this | Read |
|---|---|
| Anything, first time — how Udon executes, and how to falsify a constraint yourself | `references/00-mental-and-cost-model.md` |
| Optimising a hot path; counting instructions; deciding what a call really costs | `references/01-extern-economics.md` |
| Deciding one program or many; abstraction without interfaces; library/package shape | `references/02-project-architecture.md` |
| Dispatch without delegates; passing arguments to events; re-entrancy; coroutine substitutes | `references/03-event-and-callback-architecture.md` |
| Choosing a data structure; `DataList`/`DataDictionary` vs arrays; boxing; bit-packing | `references/04-data-structures-and-boxing.md` |
| Designing synced state; late joiners; ownership; bandwidth budget | `references/05-sync-architecture-and-late-joiners.md` |
| `[NetworkCallable]` vs `[UdonSynced]`; hand-rolled serialisers; addressing; replay defence | `references/06-network-event-dispatch.md` |
| **Hardening against a modified client** — what a hostile player can invoke, and how to lock it down | `references/06-network-event-dispatch.md` §8 |
| **A network event or sync silently does nothing** — the differential diagnosis | `references/99-anti-patterns.md` §2 |
| Player tags, network IDs, tracking data, stations, voice, per-player objects | `references/07-player-systems-and-identity.md` |
| Spending a frame budget; scheduling vs branching; amortisation | `references/08-performance-patterns.md` |
| Driving shaders from Udon — global arrays, property blocks, CRTs, GPU readback | `references/09-udon-gpu-bridges.md` |
| The shader side — depth, stereo, grab passes, versioned includes, batching traps | `references/10-vrc-shader-toolbox.md` |
| Build hooks, proxy-vs-backing behaviours, codegen, non-destructive mutation | `references/11-editor-time-tooling.md` |
| Profiling, fault detection, testing a VM that has no test framework | `references/12-debugging-and-introspection.md` |
| Closed-form math, coordinate frames, quaternion compression | `references/13-math-and-spatial.md` |
| `Interact()`, pickups, player triggers, object pools, master/owner, **persistence** (`PlayerData`) | `references/14-world-interaction.md` |
| Reviewing code; hunting a bug that only appears in the uploaded world | `references/99-anti-patterns.md` |
| Looking up a named technique `T-###`, or checking what is *contested* | `references/README.md` |

## Quick reference — what compiles

| Feature | Allowed? | Do this instead |
|---|---|---|
| `try`/`catch`/`finally`, `throw` | **No** | `if` + `Utilities.IsValid(...)`; return sentinels; make critical sections structurally return-free |
| Generic methods/classes **declared on a behaviour** | **No** (`CE_UdonSharpBehaviourGenericMethodsNotSupported`) | Concrete types; put generic helpers in a plain static class (see next row) |
| Generic **static / extension** methods in a non-behaviour class | **Yes** — monomorphised per call site | Works while `T` is inferable at the call site; fails if `T` needs an operator, a `new()` constraint, or is forwarded. Compare with `object.Equals(a, b)`, never `==` or `EqualityComparer<T>` |
| `List<T>`, `Dictionary`, any `System.Collections.Generic` | **No (not exposed)** | Arrays `T[]`, or `DataList`/`DataDictionary`/`DataToken` (`VRC.SDK3.Data`) |
| LINQ (`System.Linq`) at runtime | **No (not exposed)** | Manual `for`/`foreach`. (OK in Editor-only tools.) |
| Lambdas / delegates / `Action` / `Func` / `event` | **No** | `SendCustomEvent(nameof(M))` / `SendCustomNetworkEvent(target, nameof(M))`; or `SetProgramVariable` + `SendCustomEvent` as a two-instruction call with arguments |
| Coroutines / `IEnumerator`/`yield`, `async`/`await` | **No** | `SendCustomEventDelayedSeconds(nameof(M), t)` / `...DelayedFrames(nameof(M), n)`, self-terminating |
| Interfaces (declare/implement) | **No** | Abstract `UdonSharpBehaviour` base + virtual methods |
| `struct` (user-declared) | **No** | Plain class, or parallel arrays. **Unity/BCL struct *types* are fine as mutable fields** (`ParticleSystem.EmitParams`, `EmissionModule[]`) |
| Nullable value types (`int?`) | **No** | Sentinel (`-1`, `int.MaxValue`, `float.PositiveInfinity`) — pick one that is already correct under the relation that consumes it |
| Constructors on a `UdonSharpBehaviour` | **No** | Initialize in `Start()` / field initializers |
| `static` mutable **fields** | **No** (only `const`) | Instance field on a shared singleton behaviour; **static *methods* are allowed** |
| Multidimensional arrays `T[,]` | **No** (rejected at creation) | Jagged `T[][]`, or a flat `T[]` with index math (`row*w+col`) |
| Object/collection initializers (`new Foo { X = 1 }`) | **No** | Assign fields after construction. (**Array** initialisers `new[]{…}` are fine, and compile-time allocated) |
| `switch` **expression** (`x switch {…}`) | **No** | `switch` **statement** (allowed, and compiles to a jump table) |
| Local functions, nested type declarations | **No** | Top-level unique-named methods/types |
| `partial` **methods**; hiding a base member with `new` | **No** | Declare the method normally; use `override` |
| `typeof(userType)` | **No** | `GetUdonTypeID()` / `GetUdonTypeName()`. (`typeof` on a **Unity** type is fine: `GetType() == typeof(BoxCollider)`, exact match only) |
| `Instantiate` a non-GameObject | **No** | Only `Instantiate(gameObject)` |
| `foreach`, `switch` statement, `$"..."`, enums | **Yes** | `foreach` over an array beats a hand-written `for` (it hoists `.Length`) |
| Properties / auto-properties | **Yes** | — (drives `[FieldChangeCallback]`) |
| Class inheritance / abstract base classes | **Yes** | Preferred polymorphism path. Note every empty virtual is emitted into **every** subclass program |
| **`partial class`** | **Yes** | Split one program across files so its internal calls stay label jumps. Class attributes go on exactly one part |
| **Method overloading, by arity *and* type** | **Yes** (mangled `__<n>_<name>`) | Forbidden only on `[NetworkCallable]`. **Only a 0-arg method keeps its C# name** in the export table; anything with parameters is exported mangled. As a result, `SendCustomEvent`, `SendCustomNetworkEvent`, `SendCustomEventDelayed*` and a Button's `onClick` can address 0-arg methods only |
| **`params`** | **Yes** | Works at a *static* call site; cannot be fed a runtime array |
| **`static` methods on a behaviour** | **Yes** | Good shape for a package's `public static T Get(GameObject)` discovery entry point |
| **Static classes, extension methods, `using static`, `using X = N.T`** | **Yes** | Aliases are the zero-cost substitute for the adapter pattern (`using GlobalShader = VRC.SDKBase.VRCShader;`) |
| `out`/`ref`, default parameter values (**incl. enum-typed**) | **Yes**, except on `[NetworkCallable]` | A default the caller omits is one fewer heap write — defaults are an EXTERN reduction, not just ergonomics |
| **`readonly` field initialisers** (incl. arrays and builder chains) | **Yes** | The `static readonly` substitute (`static readonly` itself is banned) |
| **`const`** on a behaviour | **Yes** | `const` scalars fold with **no heap symbol**; a `const bool` deletes its branch entirely |
| **`[DefaultExecutionOrder]`** | **Yes** | Lowest legal value is `int.MinValue + 1000000`; `int.MinValue` is a compile error |
| **`[System.Diagnostics.Conditional]`, `[Obsolete]`, `[OdinSerialize]`** | **Yes** | `[Conditional]` elides the call *and its argument expressions* (void methods only) |
| **`Stopwatch`, `StringBuilder`, `DateTime`/`TimeSpan`, `System.Type`** | **Yes** | `System.Type` is a first-class runtime value — serializable, usable as `Type[]` for dispatch |
| **`BitConverter.SingleToInt32Bits`, `Buffer.BlockCopy`, `Convert.To/FromBase64String`** | **Yes** | The bit-packing and serialisation toolkit |
| **`Array.IndexOf` / `Copy` / `FindLastIndex`** | **Yes**, via the **non-generic** overload | `Array.IndexOf((Array)arr, item, 0, count)` — one EXTERN instead of an N-iteration loop. General trick: look for a pre-generics overload |
| Recursion | **Only** with `[RecursiveMethod]` on the method | ≈4N+3 externs per call (N = *all live locals*). Prefer an iterative version with an explicit `int[]` stack |

### The two defines

`UDONSHARP` = the package is installed. `COMPILER_UDONSHARP` = **this compilation is the Udon pass**.
`UNITY_EDITOR` is true *while U# compiles*, so `#if UNITY_EDITOR` alone hides nothing from the VM. The
correct gate is **`#if UNITY_EDITOR && !COMPILER_UDONSHARP`**, behind which unrestricted C# (generics,
`List<T>`, delegates, `struct`, LINQ, `try`/`catch`, reflection) is legal in the same file as Udon code.
Getting this wrong compiles in the editor and fails at upload. **Do not `#if` a field on a behaviour at
all**: adding or removing serialized fields per-compilation is documented as unsupported and shifts the
emitted program's symbol layout; guard the field's *uses* instead. Details:
`references/02-project-architecture.md` §5.

## Sync & networking

- **Class attribute:** `[UdonBehaviourSyncMode(BehaviourSyncMode.X)]`, `X` ∈ `None | Manual | Continuous | NoVariableSync | Any`.
  - `None` = nothing synced **and `SendCustomNetworkEvent` is disabled** on this behaviour.
  - `NoVariableSync` = no synced vars **but `SendCustomNetworkEvent` still works**.
  - **Synced array fields require `Manual`** (rejected under `Continuous`).
  - `Linear`/`Smooth` field interpolation cannot be used with `Manual`. `Manual` can't be on a GameObject that also has VRC Object/Position Sync.
- **Field attribute:** `[UdonSynced]` or `[UdonSynced(UdonSyncMode.None|Linear|Smooth)]`. Bare `[UdonSynced]` = no interpolation.
- **`RequestSerialization()`** only works on the **owner** of a `Manual`-sync behaviour. Take ownership first: `Networking.SetOwner(Networking.LocalPlayer, gameObject)`.
- **`[FieldChangeCallback(nameof(Prop))]`** on a `[UdonSynced]` field routes network deserialization (and `SetProgramVariable`) through the property setter: **the setter must assign the backing field itself**.
- **`[NetworkCallable]`** methods: `public`, ≤ 8 params, no return type; cannot be generic/static/virtual/abstract/override/async/operator/vararg, no `ref`/`out`/`params`/default values, no overloading of any kind, and cannot be a built-in Udon event.

### The remote-callable surface — assume a hostile client

**Any player in the instance can invoke your Udon methods by name.** A modified client sends an arbitrary
event name and there is no allow-list of who may call, so a `public` method is a remote endpoint.

**Who sent it, precisely:** a `[NetworkCallable]` handler can read `NetworkCalling.CallingPlayer` (the
receiving client sets that context before dispatch). A **legacy** `SendCustomNetworkEvent` handler gets
nothing: no sender is available at all. `CallingPlayer` is a real signal on the modern path and absent
on the old one; treat it as *routing* information rather than proof of authority, and re-derive anything
security-relevant from synced state (below).

The platform's mechanism for this is the **`_` prefix**:

- A legacy `SendCustomNetworkEvent(target, "Name")` naming a method that starts with `_` is **refused by the
  receiving client**: *"Events starting with an underscore may not be run remotely."* Enforcement is on the
  **receiver**, which is what makes it a real boundary: a hostile sender can transmit anything it likes, and
  every legitimate client still refuses to run it.
- **`[NetworkCallable]` overrides the underscore.** A `_`-prefixed method carrying that attribute *is*
  remotely callable. The prefix is a default, not a lock.
- **It is not access control.** `_` blocks *network* invocation only. Local `SendCustomEvent`,
  `SendCustomEventDelayedSeconds`, a UI Button's `onClick`, and a direct call from another behaviour all
  still reach it. The method stays `public` and stays in the symbol table.
- A behaviour whose sync mode is `None` refuses network events outright.
- **Legacy events fan out across the GameObject.** The legacy path runs the named event on *every*
  `UdonBehaviour` on the target GameObject that is not `BehaviourSyncMode.None`, not only the one you addressed. A
  method-name collision between two behaviours sharing a GameObject is remotely triggerable on both.

**The discipline that follows:** prefix every public method with `_` *unless* it is deliberately a network
entry point. That inverts the default from open to closed and leaves a short, auditable list of real
endpoints.

**Never rename a built-in VRChat event to add the prefix.** `Interact()`, `Start()`, `OnPlayerJoined`,
`OnDeserialization`, `OnPickup` and every other engine-called entry point must keep their exact names. The
prefix rule applies only to methods *you* named. Renaming one silently stops it firing.

For each endpoint that survives the prefix: validate arguments rather than trusting them, re-derive
authority from synced state instead of from the call, and make the handler idempotent; events can arrive
twice or out of order.
`OnOwnershipRequest` is the only authorization hook evaluated on the *defender's* client, so for anything
security-relevant it is the boundary.

The discipline has one failure mode of its own: **a method that had to be networked, quietly underscored.**
Its events are then refused at runtime while local testing still looks fine. Mark deliberate legacy
endpoints so intent is visible at the call site: `// udon-lint: network-entry` above the method, which this
plugin's lint hook also reads. Deeper: `references/06-network-event-dispatch.md`.

### Canonical networked-state pattern

```csharp
public bool ColorMode {
    get => colorMode;
    set { colorMode = value; SwitchColorMode(value); }  // reaction lives in the setter
}
[UdonSynced] [FieldChangeCallback(nameof(ColorMode))]
public bool colorMode;

// owner mutates, then serializes:
public void SetColor(bool state) { ColorMode = state; RequestSerialization(); }
```

For a synced value with **no** callback, react in `public override void OnDeserialization()` by comparing a
local counter against the synced one. Deeper: `references/05-sync-architecture-and-late-joiners.md` and
`references/06-network-event-dispatch.md`.

## Common mistakes

- Reaching for `List<T>`/LINQ/`Dictionary`: compiles in the IDE, fails U# compile ("not exposed to Udon"). Use arrays or `Data*`.
- `int[,]` board/grid → use a flat `int[9]` (index `r*cols+c`) or jagged `int[][]`.
- Syncing an array while on `Continuous` sync → switch the behaviour to `Manual`.
- **A `[UdonSynced]` array left null stops the *entire behaviour* syncing**, scalars included, with no error. Always initialise; `new T[0]` is enough.
- `[FieldChangeCallback]` setter that forgets to assign its own backing field → value never updates.
- `SendCustomNetworkEvent` silently doing nothing → the behaviour's sync mode is `None` (use `NoVariableSync` or `Manual`). Local `SendCustomEvent` **does** work under `None`.
- Naming a method the same as a built-in VRChat event with the wrong signature → hard compile error.
- **Avoiding a feature the compiler actually accepts.** `partial class`, overloading, `params`, `static` methods, generic static helpers and default parameters all compile; see the table. Test a constraint before designing around it.
- **`#if UNITY_EDITOR` does not hide code from Udon**, because U# compiles inside the editor. Use `#if UNITY_EDITOR && !COMPILER_UDONSHARP`.
- **Editor code writing a U# field** (`myBehaviour.field = x`) writes the C# *proxy* and is silently discarded at build. Use `publicVariables.TrySetVariableValue` (edit/build) or `SetProgramVariable` (play mode) on `UdonSharpEditorUtility.GetBackingUdonBehaviour(proxy)`; wrap U#-typed *values* in `GetBackingUdonBehaviour` too.
- **Global shader properties go through `VRCShader`, not `Shader`**, and the name **must start with `_Udon`** (only `_AudioTexture` is exempt). `VRCShader.SetGlobalVectorArray(VRCShader.PropertyToID("_UdonMyData"), buf)`. An unprefixed name is **silently ignored**, not an error. Per-material and per-renderer writes still use the normal Unity API.
- **`renderer.material` clones the material** (breaks batching, leaks permanently in a world that never unloads). Use `sharedMaterials` or a `MaterialPropertyBlock`, and `GetPropertyBlock` before `SetPropertyBlock` or you clobber other systems' overrides.
- **`Vector3 ==` is approximate (~1e-5)**: compare components individually where the test gates an exact fast path.
- **Serialization callbacks never fire when you are alone in the instance**: the classic "works with a friend, does nothing solo".
- **An out-of-range index halts the behaviour** and NaN crashes the client; there is nothing to catch. Precompute safe bounds and clamp inverse-trig arguments.

## Verifying a constraint yourself

**Every constraint claim here is verifiable directly against the compiler source; check there rather than
relying on this file.** The circulated U# constraint list forbids more than the compiler does, consistently.
Named rejections live in the Binder (`BinderSyntaxVisitor.cs`, `Binder/Symbols/*Symbol.cs`); "not exposed to
Udon" is a *whitelist*, dumpable by setting `UDONSHARP_DEBUG` and running the Node Definition Grabber. **On
any SDK other than 3.10.4, re-verify before designing around a constraint.** Method and full evidence trail:
`references/00-mental-and-cost-model.md` §3.

Full evidence trail with `file:line` for every claim: `references/README.md` and
`references/00-mental-and-cost-model.md`.

## Project conventions

This skill covers what the *compiler* allows. Naming, namespaces, folder layout, wiring style and sync-mode
defaults are per-project. Follow the host project's `CLAUDE.md` / `AGENTS.md` where it states them, and match
the surrounding code where it does not.
