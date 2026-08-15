# Udon Mastery

A reference on advanced UdonSharp engineering: 16 topic files and a 252-entry technique catalog, read out
of the UdonSharp compiler itself and out of the VRChat world and avatar packages that push Udon hardest.

The audience is a developer about to write (or rewrite) a VRChat world's Udon layer, who already knows C#
and Unity. There is no tutorial material here, and no "what is a GameObject".

**This is a depth reference, not a survey of Udon.** It is deliberately silent on scene setup, layers,
lighting, occlusion, the Build Panel, uploading, video players, web and image loading, and UI toolkits,
and it does not catalogue the SDK's API surface. Silence here means *out of scope*, never *unsupported*.
Check the SDK documentation before reading an omission as a constraint.

---

## How to read this

Start with **[00 — Mental & cost model](00-mental-and-cost-model.md)**. Almost every technique in the rest
of the document is a consequence of two facts established there: *the unit of cost is the VM instruction,
not the arithmetic operation*, and *anything Roslyn erases before UdonSharp sees the tree survives*.

Then read by need:

| | file | what is in it |
|---|---|---|
| **00** | [Mental & cost model](00-mental-and-cost-model.md) | how Udon actually executes; the Roslyn-erasure rule; the corrected constraint list; how to falsify a constraint yourself |
| **01** | [EXTERN economics](01-extern-economics.md) | byte-exact instruction costs, heap-symbol accounting, what the emitter never reuses, the cross-behaviour call price |
| **02** | [Project architecture](02-project-architecture.md) | one program or many; abstraction without interfaces; the `COMPILER_UDONSHARP` seam; library and package shapes |
| **03** | [Event & callback architecture](03-event-and-callback-architecture.md) | dispatch without delegates; argument channels; registration; re-entrancy; the coroutine substitutes |
| **04** | [Data structures & boxing](04-data-structures-and-boxing.md) | parallel arrays, slot handles, sentinels, `DataList`/`DataDictionary` and when not to use them, packing |
| **05** | [Sync architecture & late joiners](05-sync-architecture-and-late-joiners.md) | manual sync as a protocol, ownership, idempotency, retained state as a cache, bandwidth budgets |
| **06** | [Network event dispatch](06-network-event-dispatch.md) | `[NetworkCallable]` vs `[UdonSynced]`, hand-rolled serialisers, addressing, coalescing, replay defence |
| **07** | [Player systems & identity](07-player-systems-and-identity.md) | player tags, network IDs, tracking data, stations, voice, per-player objects |
| **08** | [Performance patterns](08-performance-patterns.md) | how to spend a frame; scheduling vs branching; amortisation; the "off state costs nothing" discipline |
| **09** | [Udon↔GPU bridges](09-udon-gpu-bridges.md) | global arrays, property blocks, CustomRenderTextures, readback, rasterising your data |
| **10** | [VRC shader toolbox](10-vrc-shader-toolbox.md) | the shader-side half of the contract: depth, stereo, grab passes, versioned includes, batching traps |
| **11** | [Editor-time tooling](11-editor-time-tooling.md) | build hooks, proxy-vs-backing, injection, codegen, non-destructive mutation — **with adopt/skip verdicts** |
| **12** | [Debugging & introspection](12-debugging-and-introspection.md) | the heap as a namespace, profiling, fault detection, exfiltration, testing a VM with no tests |
| **13** | [Math & spatial](13-math-and-spatial.md) | when to call out instead of computing; closed forms; coordinate frames; quaternion compression |
| **14** | [World interaction & persistence](14-world-interaction.md) | `Interact()`, pickups, player triggers, `VRCObjectPool`, master vs owner, `PlayerData` and PlayerObjects |
| **99** | [Anti-patterns](99-anti-patterns.md) | myths, traps, failure modes seen in shipped code, and things that only fail in the uploaded world |

### How to check a claim

Citations of the form `MethodSymbol.cs:155` or `CompilationContext.cs:414` are relative to
`Packages/com.vrchat.worlds/Integrations/UdonSharp/Editor/` and resolve in **any** project with **Worlds
SDK 3.10.4** installed, including yours. Every constraint claim here can therefore be falsified against
your own copy of the compiler in about thirty seconds. Run that check rather than trusting this document,
and on any other SDK version run it *first*.

Line numbers drift by a few lines between UdonSharp versions. **The stable half of a citation is the
symbol it names**, not the number. If `FieldSymbol.cs:93` does not land on `IsStatic && !IsConst`, grep
the file for the symbol rather than concluding the claim is wrong.

Where a claim is inferred rather than read from source, or where two sources disagree, it says so at the
point of use instead of averaging them away; see [Known limits](#known-limits). Claims about *runtime
speed* are the weak spot and are marked as such throughout.

---

## Constraint corrections (read this before anything else)

**The constraint list commonly circulated for UdonSharp forbids more than the compiler does, and consistently
in that direction.** Every item below was verified against the compiler source shipped in **Worlds SDK
3.10.4** (`Packages/com.vrchat.worlds/Integrations/UdonSharp/Editor/Compiler/`), corroborated by shipping
packages that depend on it, and executed under ClientSim.

### Actually allowed

| Feature | Evidence |
|---|---|
| **`partial class`** | Zero occurrences of `IsPartial` in the whole U# editor tree — Roslyn merges partials before U# sees a type. Proven in production on classes split across 13, 7 and 4 files. |
| **Method overloading by arity *and* type** | `CompilationContext.BuildMethodLayout` (≈`:414`) mangles every method with parameters to `__<n>_<name>`, so overloads coexist; `EmitContext.GetMostDerivedMethod` (≈`:848`) resolves by parameter count. The Binder has no rejection path for overloads, unlike partial methods and generic behaviour methods, which throw. The mangling guard is `Parameters.Length > 0`, so **a 0-arg method keeps its C# name and every other method is exported mangled** — only 0-arg methods are addressable by name (`SendCustomEvent`, `SendCustomNetworkEvent`, `onClick`), and `[NetworkCallable]`, which dispatches by name, is the one place overloading is forbidden. |
| **`params`** | Full expansion in `BinderSyntaxVisitor.cs:418-510`. Forbidden only on `[NetworkCallable]`. Note it works at a *static call site* and cannot be fed a runtime array. |
| **`static` methods** on a `UdonSharpBehaviour` | `UdonSharpBehaviourTypeSymbol.cs:34` routes `IsStatic` to `ImportedUdonSharpMethodSymbol`. Only static **mutable fields** are rejected (`FieldSymbol.cs:93`). |
| **Static classes and extension methods** | Widely used. Extension methods are reduced to their static form at `TypeSymbol.cs:196-205`. |
| **Generic static / generic extension methods** in a non-behaviour class | `MethodSymbol.cs:84-99`: an *open* generic definition is never bound or emitted; only constructed instantiations are. **Generics are monomorphised per call site.** Generic methods *on a behaviour* remain a hard error (`CE_UdonSharpBehaviourGenericMethodsNotSupported`). |
| **Default parameter values, including enum-typed** | `ParameterSymbol.cs:32-45` has a dedicated `Type.IsEnum` branch using `Enum.ToObject`, added deliberately. Works on virtuals and on `SendCustomEvent` targets. Forbidden on `[NetworkCallable]`. |
| **`out` / `ref`** | Including `ref T[]` and `this T[]` receivers. Forbidden on `[NetworkCallable]`. |
| **`using static` and `using X = N.T` aliases** | Erased by Roslyn. The cleanest substitute for the adapter pattern Udon forbids — see [T-030](#t-030). |
| **`readonly` field initialisers**, including array initialisers and whole builder chains | U# lowers initialisers into the init path. |
| **`const`** on a behaviour; `const bool` folds dead branches away entirely | Proven in the wild by a `#pragma warning disable CS0162` that only exists because the fold happens. |
| **`[DefaultExecutionOrder]`** | `EmitContext.cs:92-98` reads the attribute and writes `Module.ExecutionOrder`. The lowest legal value is `int.MinValue + 1000000`; `int.MinValue` itself is a hard compile error. |
| **BCL surface far wider than the commonly circulated list suggests** | `System.Diagnostics.Stopwatch`, `StringBuilder`, `DateTime`/`TimeSpan`, `System.Type` (a first-class runtime value, serializable, usable as `Type[]`), `BitConverter.SingleToInt32Bits`, `Buffer.BlockCopy`, `Convert.To/FromBase64String`, `Array.IndexOf`/`Copy`/`FindLastIndex`, `Enum.TryParse`, `Enum.GetName`, `System.Diagnostics.Conditional`, `[Obsolete]`, `[OdinSerialize]`. |
| **Unity/BCL `struct` *types*** as mutable behaviour fields, mutated member-by-member | e.g. `ParticleSystem.EmitParams`, `ParticleSystem.EmissionModule[]`. The restriction is on declaring new struct types, not on using existing ones. |
| **`private protected`**, `sealed override`, `virtual` with a default body | — |

### Genuinely still forbidden

`try`/`catch`/`finally`/`throw`; interfaces (declaring or implementing); user-declared `struct`; nullable
value types; constructors on a behaviour; **static mutable fields** (`const` only); lambdas / delegates /
`Action` / `Func` / `event`; coroutines / `async` / `yield`; `System.Collections.Generic` and runtime LINQ;
nested type declarations; local functions; object/collection initialisers; `switch` *expressions*;
multidimensional arrays (**rejected at creation** — the element-access check is commented out, but you
cannot make one); `typeof` on a user type; `Instantiate` of anything but a `GameObject`; generic methods on
a behaviour; **partial *methods*** (`MethodSymbol.cs:155` — the sharpest illustration of the erasure rule:
partial *classes* are erased by Roslyn, partial *methods* survive into the tree and are rejected); and
**base-member hiding with `new`** (`MethodSymbol.CheckHiddenMethods`).

Recursion requires `[RecursiveMethod]`, which is expensive; see [T-014](#t-014).

**Two claims in circulation are themselves wrong** and are corrected in place: *"enum-typed default
parameters are rejected"* is false for 3.10.4 (`ParameterSymbol.cs:32-45` has a dedicated `IsEnum` branch),
and *"`-2146483648` in a profiler marker is an apparent typo"* is false: it is exactly
`int.MinValue + 1000000`, the lowest legal execution order.

---

## Known limits

What this reference is *not* sure about. Stated plainly so you can weigh it, rather than smoothed away.

**No runtime timing is measured anywhere in this document.** The instruction-byte and heap-symbol tables in
[01](01-extern-economics.md) are exact — they are read out of the emitter and confirmed against emitted
assembly. Every *"therefore this is faster"* built on top of them is an inference. Where a decision actually
matters for your frame budget, profile it.

**One direct contradiction between sources, unresolved.** pema99's shader notes recommend **cbuffer aliasing
with `packoffset`** to break the 1023-element constant-array limit. cnlohr's shadertrixx README (attributed
to lox9973) **explicitly retracts it**: *"slower than reading from a texture if doing intensive reads… if
you need to read from like 100 of these, move it into a texture"*, replacing it with a texture staged in
**Morton/Z-order** so sequential logical reads hit adjacent cache lines. Neither side is measured.
**Decision rule: choose on read count, not write cost.** Under ~100 reads per invocation the cbuffer trick
is fine; past that, stage to a texture and Z-order it. Both positions are recorded in
[09](09-udon-gpu-bridges.md) and [10](10-vrc-shader-toolbox.md).

**Load-bearing claims that are inferred, not verified** — do not let these harden into fact:

- **Per-synced-variable serializer overhead**, which is the entire premise of LightSync's bandwidth-tier ladder.
- **Whether `BehaviourSyncMode.None` may legally share a GameObject with a `Manual`-synced behaviour.** VRCFury asserts it and patches out UdonSharp's enforcement, but no upload test confirms it. If true it removes a real structural tax.
- **Whether delayed events fire on deactivated GameObjects** — asserted by two independent packages, tested by neither.
- **NaN / denormal survival through VRChat's serializer** — the highest-risk assumption underneath any bit-packing scheme.
- **`String.GetHashCode()` stability across runtimes** — one shipped package relies on it three times, including for a security check.
- **Whether `SendCustomNetworkEvent` can re-enter synchronously.** Absence from a curated whitelist is weak evidence.
- **`OnPostRender` still being delivered to an `UdonSharpBehaviour`** — load-bearing for the whole camera-readback technique, and superseded in practice by `VRCAsyncGPUReadback`.
- **Enum *relational* comparison** (`>` on enums, UdonSharp issue #68). Not statically decidable from the emitter; ProTV's advice to cast both sides to `int` stays defensive rather than proven.
- **`VRCShader.SetGlobalVectorArray` sizing the constant buffer for the whole process lifetime** — the justification for always uploading at max length. An author's comment only, but the failure it describes (corrupting *other worlds*) makes it cheap insurance either way.
- **`float3[]` constant-array padding to 16 bytes** — standard HLSL, relied on by shipped code, unverified on GLES3/Quest.

---

## Sources

Almost nothing here was invented. It was read out of the UdonSharp compiler and out of the public packages
below: people who solved these problems first, in the open, and shipped the result to strangers. No code
from any of them is reproduced or redistributed here; what is recorded is technique.

Each entry points to the original work rather than replacing it; the source is worth reading directly.

| | |
|---|---|
| **The UdonSharp compiler** | VRChat Worlds SDK — the ground truth for every constraint claim |
| **UdonSharpOptimizer** | BlueAmulet — the instruction and heap-symbol cost model |
| **ProTV** | ArchiTechAnon — manual sync and a plugin ABI at product scale |
| **LightSync** | MMMaellon — a general-purpose sync engine and its bandwidth ladder |
| **SaccFlight** | Sacchan — a large system with *zero* `[UdonSynced]` fields |
| **AudioLink** | llealloo — [github.com/llealloo/audiolink](https://github.com/llealloo/audiolink) — CRT-as-state-machine, version ladders, the Udon↔GPU contract |
| **LTCGI** | PiMaker — [github.com/PiMaker/ltcgi](https://github.com/PiMaker/ltcgi) — build-time `#define` rewriting, material-tag registration |
| **VRC Light Volumes** | REDSIM — [github.com/REDSIM/VRCLightVolumes](https://github.com/REDSIM/VRCLightVolumes) — the `COMPILER_UDONSHARP` seam and the `[PostProcessScene]` injection pipeline |
| **VRSL** | AcChosen — Udon as an address bus; one `Update()` in a 4,000-line runtime |
| **VRCFury** | non-destructive build-time mutation, and generic static extension methods proven in an Udon assembly |
| **shadertrixx** | cnlohr — *"But, Udon makes this faster"*, and the cost model it reframes |
| **shader-knowledge** | pema99 — the shader-side half of the contract |
| **UdonPortals** | aurycat — the undocumented `_onVarChange_<field>` hook |
| **ClusteredBIRP · VRCMarker · Udonity · OpenNID · RVC · ParaDraw · VRRefAssist · VRWorldToolkit · UdonSharp Profiler** | rasterised data channels, runtime reflection without runtime cost, in-world drawing, and editor tooling |
| **miner28 · ngenesis** | the networked-argument serialiser and `__refl_*` symbol scraping |

Links are given where the canonical repository is unambiguous; the rest are findable by name. Any error in
attribution here is mine. Corrections are welcome.

---

# Technique catalog

Each `T-###` is one technique, stated once. The **where** column points at the topic file that explains it
in full.

## Cost model and language boundary (T-001 – T-024)

| | technique | one line | where |
|---|---|---|---|
| <a id="t-001"></a>T-001 | **The unit of cost is the VM instruction** | Optimise toward the *largest* built-in that does the job: `quat * mirror` (one EXTERN) beats four swizzle+negate VM ops. The single most important cost-model fact here. | [00] |
| T-002 | **Moving data costs more than computing it** | `COPY` is 20 bytes, `EXTERN` is 8. Prefer fewer distinct named values over fewer operations. | [00] |
| T-003 | **The instruction-byte table** | PUSH 8, COPY 20, RET 20, EXTERN 8, JUMP 8, JUMP_IF_FALSE 16, Comment/Tags 0. | [01] |
| T-004 | **Heap size = values + *unique extern signatures*** | Call count is free; API **breadth** is not. All `UnityEngine.Object`-derived arrays collapse to one signature pair. | [01] |
| T-005 | **The emitter never reuses a temporary** | One permanent heap symbol per expression temp, forever. Block-scope coalescing recovers thousands. | [01] |
| T-006 | **Duplicated `__this`** | One heap symbol per *use site* of the behaviour's own reference. | [01] |
| T-007 | **Cross-behaviour call price** | `SetProgramVariable`×args + `SendCustomEvent` + `GetProgramVariable` ≈ 120 bytes / 4 externs, versus 0 externs for an intra-behaviour call (a label jump). Merge chatty behaviours. | [01] |
| T-008 | **Only 0-parameter methods keep their source name** | Everything else is mangled `__<n>_<name>`. The stable public entry point is the 0-arg method; `[NetworkCallable]` is the only stable *named* entry with parameters. | [01] |
| T-009 | **Duplicate literals are free** | Global constant dedup. `const` hoisting is noise; type-mixed literals are not free. | [01] |
| T-010 | **Array literals are compile-time allocated into one shared global** | Free allocation — **and an aliasing hazard**. Disabled inside `[RecursiveMethod]`. | [01] |
| T-011 | **`foreach` over an array beats the hand-written `for`** | It hoists the `.Length` extern above the loop. Also special-cased: `string`, and `foreach (Transform c in transform)` → childCount+GetChild. | [08] |
| T-012 | **String interpolation cliff at >3 holes** | 1 extern becomes holes+1 externs plus a permanent `object[]`. | [01] |
| T-013 | **`switch` becomes a heap-resident `uint[]` jump table** | O(1), but every arm becomes a jump target and therefore an optimisation barrier. A `switch` over an *extern* enum is rewritten to its underlying int deliberately, "to allow easy jump table optimizations". | [08] |
| <a id="t-014"></a>T-014 | **`[RecursiveMethod]` costs ≈ 4N+3 externs per call** | N = **all live locals**, not parameters. Hoist scratch into fields, or write the iterative version with an explicit `int[]` stack. | [01] |
| T-015 | **Guard-clause style is measurably shorter** | Jump-chain flattening: depth-*n* nesting costs *n* jumps on exit. | [08] |
| T-016 | **`&&`/`||` are a de-optimisation barrier** | They lower to `JUMP_IF_FALSE`/`JUMP` with no negation extern — but each costs a permanent internal heap symbol and calls `DirtyAllValues()`, invalidating every COW-cached value in scope. | [01] |
| T-017 | **`!` is a real EXTERN — except in an `if` condition** | The binder strips a top-level `op_LogicalNot` from an `if` and swaps the branches (in a `while` loop, so `!!x` collapses too). `while (!x)`, `bool y = !x;`, ternaries and `!` inside an `&&` chain all still pay. | [01] |
| T-018 | **Assignment-scope destination forwarding** | `x = Extern();` writes direct; any cast, nesting or conversion costs a temp plus 20 bytes. | [01] |
| T-019 | **Hoist hot-path locals to fields** | A local's *initialiser* is emitted as instructions on every call, and Udon has no dead-store elimination. | [01] |
| T-020 | **`const` scalars fold into the instruction stream with no heap symbol** | A `static readonly` would not — and is banned anyway. Use `readonly` *instance* fields as the `static readonly` substitute. | [01] |
| T-021 | **`const bool` platform constants delete dead branches entirely** | Confirmed in the wild by a `#pragma warning disable CS0162` that only exists because the fold happens. | [08] |
| T-022 | **`#if` changes the emitted program, not just the source** | U# compiles per active build target, so a `#if`-guarded *field* changes the serialized program asset's heap-symbol count and size. Guard the field's *uses*, not the field, if you want a stable ABI. | [00] |
| T-023 | **`UDONSHARP` ≠ `COMPILER_UDONSHARP`** | `UDONSHARP` = the package is installed; `COMPILER_UDONSHARP` = *this compilation is the Udon pass*. `UNITY_EDITOR` is true while U# compiles, so `#if UNITY_EDITOR` alone hides nothing. Using the wrong one is the single most common way to break dual-compiled code. | [00] |
| T-024 | **Copy the reference implementation when the BCL method isn't whitelisted** | A blocked surface is almost always a thin wrapper over exposed primitives (`ColorUtility.ToHtmlStringRGB` inlined verbatim). | [00] |

## Project architecture (T-025 – T-049)

| | technique | one line | where |
|---|---|---|---|
| T-025 | **`partial class` keeps N modules inside one program** | 13 files, one per shape family, each with its own `StartX`/`UpdateX`/`OnDestroyX` that the root fans out to — module structure with label-jump call costs instead of `SendCustomEvent` pairs. Class attributes must sit on exactly one part. | [02] |
| T-026 | **The `COMPILER_UDONSHARP` seam** | One source tree compiling four ways (Udon build, Udon editor-proxy, standalone `MonoBehaviour`, editor-only C#), with `#if` on class-declaration lines, `try`/`finally` brace lines, individual fields and `using` aliases. Unrestricted C# lives beside Udon code and never reaches the VM. | [02] |
| T-027 | **Fork the class declaration line itself** | `#if UDONSHARP …: UdonSharpBehaviour #else …: MonoBehaviour #endif`, leaving one unmatched brace on each side. The obvious factorings fail because *the base type* is what differs. | [02] |
| T-028 | **A no-op attribute shim deletes every `#if` around a field** | Supply a 3-line `UdonSyncedAttribute`/`FieldChangeCallbackAttribute` under the inverse guard; attributes are name-resolved and can be inert. | [02] |
| T-029 | **Editor-only members are genuinely absent from the emitted program** | `#if UNITY_EDITOR && !COMPILER_UDONSHARP` is a program-size tool as well as a compile fix — and it lets you attach *editor-only views of private runtime state* with no new field. | [02] |
| <a id="t-030"></a>T-030 | **`using` aliases as a zero-cost API-swap layer** | `using GlobalShader = VRC.SDKBase.VRCShader;` vs `= UnityEngine.Shader;` — swap the *import*, not the call. A wrapper method per API costs a call plus heap symbols on per-frame paths; an alias is erased by Roslyn. Unifies calls with identical signatures **and nothing else**. | [02] |
| T-031 | **The abstract base *is* the ABI** | Base-class-first symbol layout plus inherited symbol counters is what makes cross-program virtual dispatch work. Virtual dispatch is strictly better than `SendCustomEvent` where it applies: typed parameters, compile-checked. | [02] |
| T-032 | **Base-class granularity is a program-size decision** | ~40 empty virtuals are emitted into *every* subclass program. Ship several differently-sized bases off one publisher (40 / 5 / 2 / 1 members) instead of one fat base. | [02] |
| T-033 | **An empty abstract behaviour as a pure type tag** | Cost-free interface semantics — no members to dispatch — usable for `[CustomEditor(typeof(T), true)]` or as a `GetComponent<T>` filter. | [02] |
| T-034 | **Duck typing by symbol probing** | `GetProgramVariableType(name) == null` is an existence test; `GetUdonTypeName().Split('.')` is runtime type identity; `SendCustomEvent` on an unexported name is a **silent no-op**, so participation costs zero declaration. | [02] |
| T-035 | **Names are the type system, and nothing checks them** | A prefixed event bus (`SFEXT_*`), `IN_`/`OUT_` payload fields, 32 duplicated method names across three product families — with the directory tree as the only compatibility documentation. Defensible only with `nameof` across an assembly reference. | [02] |
| T-036 | **The event-name prefix encodes the audience** | `_L_` local / `_O_` owner / `_G_` global / `_P_` passenger — so an extension reads its execution context off the event name and contains almost no `if (IsOwner)`. | [03] |
| T-037 | **Copy-paste inheritance as the mixin substitute — and the drift it causes** | The failure is always the same: one copy misses an update the others got (a missing `_dataNeedsSync = true`), and nothing detects it. | [99] |
| T-038 | **A library must be a behaviour, so make its API coarse** | One call draws a whole shape, not twelve; the library does its own type dispatch internally; **default arguments are an EXTERN reduction, not just ergonomics** — an argument not passed is one fewer heap write. | [01] |
| T-039 | **`public static T Get(GameObject)` as a package's discovery ABI** | Better than telling consumers to `GetComponent`: it centralises future fallback and version-shim logic inside the package, which is the only real versioning lever a type-referenced Udon ABI has. | [02] |
| T-040 | **Four visibility tiers = four ABIs** | `public` (serialized + exported + network-callable), `[NonSerialized] public` (the correct default for runtime state), `internal`/`private`, and properties (deliberately invisible to the string ABI). `internal` fields are **still reachable by `SetProgramVariable`** — name-based lookup ignores C# accessibility. | [02] |
| T-041 | **`_`-prefixed public methods are not network-callable** | VRChat refuses to dispatch network events to them — unless the method also carries `[NetworkCallable]`, which overrides the prefix. Never rename a built-in event to add it. | [06] |
| T-042 | **Split the sync surface across two behaviours to get two sync frequencies** | Udon serialises a behaviour's whole synced set atomically, so update frequency is a *type* decision unless you split. | [02] |
| T-043 | **Authority granularity is the GameObject** | Each plugin on its own object gives N independent ownership domains in one prefab — and `gameObject.SetActive` then becomes per-plugin frame scheduling. | [02] |
| T-044 | **Public API as a facade with value-pinned mirrored enums** | `Hole = Internal.AddLight.Hole` pins the public enum's values to the internal ones by the compiler, so an internal reordering becomes a compile-time event in the public API file. | [02] |
| T-045 | **Ship Udon assemblies inside a non-worlds package** | `defineConstraints` fed by a `versionDefines` entry with an **empty expression** ("any version") self-gates an assembly on package presence; `overrideReferences` + a `precompiledReferences` allowlist turns "must stay Udon-compilable" into a csc-enforced build constraint. | [02] |
| T-046 | **`[assembly: InternalsVisibleTo("Assembly-CSharp-Editor")]`** | Serialized fields stay `internal`: editor write access, Unity serialization, no runtime API surface. | [02] |
| T-047 | **Optional dependency gated down to the field, not the file** | Guard the foreign-typed field and the implementation; leave the class, its settings and its enums outside — so scene references and serialized settings survive an install/uninstall of the optional package. | [02] |
| T-048 | **asmdef `versionDefines` do not reach the U# pass** | Rebuild them yourself under `COMPILER_UDONSHARP`. | [02] |
| T-049 | **Not declaring `Update()` is a real optimisation** | Declaring `_update`/`_onWillRenderObject`/`_onTriggerStay`/`_onCollisionStay`/`_onAnimatorMove`/`_onAudioFilterRead` adds a hidden proxy MonoBehaviour (`UdonBehaviour.ProcessEntryPoints`). | [08] |

## Events, callbacks and control flow (T-050 – T-079)

| | technique | one line | where |
|---|---|---|---|
| T-050 | **The universal argument channel: write the slot, then invoke** | `SetProgramVariable(name, value)` immediately before `SendCustomEvent(method)`. The friendly `target.field = x; target.SendCustomEvent(...)` compiles to exactly this — **there is no cheaper alternative hiding behind the nicer syntax**. | [03] |
| T-051 | **`Get/SetProgramVariable` on `this`** | Called with no receiver they operate on the current behaviour's own heap — which is how an injected or string-dispatched handler reads its "parameters". | [03] |
| T-052 | **`SetProgramVariable` can write a *method's parameter slots*** | Not just fields. The whole difficulty of a general argument serialiser is "what are those slots called?", recoverable at build time in three places. | [06] |
| T-053 | **A name-parameterised forwarder collapses N event types into one program** | Four baked strings + one target reference; three forwarders on three receivers all landing on distinct handlers of one aggregating behaviour. | [03] |
| T-054 | **`[NonSerialized, FieldChangeCallback]` on an *unsynced* field** | = a property setter callable across behaviours via `SetProgramVariable`. Turns Udon's only cross-behaviour write channel from a data poke into a **command**. The `_Foo` field / `Foo` property naming is the de-facto ABI. | [03] |
| T-055 | **`_onVarChange_<Name>` — the raw event `[FieldChangeCallback]` is built on** | Declare `public void _onVarChange_Field()` by hand and a **plain public field** keeps its name, stays inspector-editable, is pokeable by `SetProgramVariable`, *and* fires a callback. Verified: `AssemblyInstruction.cs:108-131` emits `.export _onVarChange_<field>`. Fires on external writes only, so pair with `_old_` shadows to debounce; you cannot have both mechanisms on one field. | [03] |
| T-056 | **Assigning the dependency *is* the registration event** | A runtime-spawned object starts with a null manager reference; whoever spawns it writes the reference, and that write triggers registration. No polling, no init call, no ordering requirement against `Start()`. | [03] |
| T-057 | **Self-registration in `OnEnable`/`OnDisable`** | A consumer cannot forget to register; call `_Notify` immediately on subscribe so a late listener needs no separate initial-state path. | [03] |
| T-058 | **A purpose-built behaviour *is* the closure** | `VRCAsyncGPUReadback.Request(..., (IUdonEventReceiver)someOtherBehaviour)` — its serialized fields are the captured variables, its single override is the callback body, and **receiver identity carries the per-request context**. Removes the in-flight mutex at the cost of one program per continuation kind. | [03] |
| T-059 | **An enum field as continuation token *and* in-flight mutex** | The compact alternative to T-058 when concurrency is not needed. Generalises to every VRChat callback with no user-data parameter (`OnPlayerRestored`, `OnStringLoadSuccess`, MIDI). | [03] |
| T-060 | **Delayed events with arguments = a per-behaviour trampoline + a stable priority queue** | Identity is implied by *ordering*: pending fires == queued events. | [03] |
| T-061 | **Numbered no-arg trampolines** | One real implementation, N trivial adapters, no logic in the adapter. | [03] |
| T-062 | **Ternary-selected event name** | `SendCustomEventDelayedFrames(cond ? nameof(A): nameof(B), 2)` — `nameof` is a compile-time string, so this is a zero-cost branch and the closest Udon offers to passing a method as a value. | [03] |
| T-063 | **Event-name rewriting to virtualise a scope** | `Replace("O_PilotEnter", "P_PassengerEnter")` — the routing key is data, so a sub-scope needs no parameter on any listener. | [03] |
| T-064 | **Self-terminating delayed-event loop — the real coroutine substitute** | Single-owner bool + an explicit `keepUpdating` predicate re-evaluated each tick + a liveness check at the top + `OnDisable` clearing the flag. Zero per-frame cost when idle. Write it as one method body with the loop scaffolding `#if`'d around it so the U# and coroutine forms cannot diverge. | [03] |
| T-065 | **The opposite idiom: re-arm *inside* the work predicate** | For a finite task, so the loop terminates by running out of work rather than by a predicate. Both idioms are correct; know which you are writing. | [03] |
| T-066 | **One-shot coalescing needs a scheduling guard *and* a parameter-merge slot** | You cannot cancel or de-duplicate a queued delayed event and cannot pass it arguments — so a second field accumulates the *strongest* pending request. | [03] |
| T-067 | **Generational counters cancel an uncancellable delayed event** | Count outstanding schedules, act only when `count == 1`, decrement unconditionally. Self-healing; you never learn which timer you are. | [03] |
| T-068 | **Cancellable deferred work as a polled deadline field** | The other answer to the same problem, when you have a loop to poll from. | [03] |
| T-069 | **`SendCustomEventDelayedFrames(..., 0)` = "again later this same frame"** | And with `EventTiming.Update`/`LateUpdate` the *timing enum is the payload*, not the delay — a phase shift, not a delay. | [03] |
| T-070 | **`SendCustomEvent`/`SetProgramVariable` are re-entrancy barriers** | The VM has no call stack, so locals alias. The *delayed* and *network* variants are not barriers ⇒ prefer `DelayedFrames(..., 0)` when a method may re-enter. | [03] |
| T-071 | **`[RecursiveMethod]` protects locals, not shared flags** | A re-entrant broadcast must snapshot and clear per-listener suppression flags first. | [03] |
| T-072 | **A re-entrancy flag doubling as a call-context privilege check** | "Am I being called from inside the dispatcher?" is often the security question you actually wanted. | [03] |
| T-073 | **Wall-clock-budgeted chunking** | `Stopwatch` + `SendCustomEventDelayedFrames`, with the continuation *and* the terminator chosen by one ternary inside a single scheduling call; snapshot-and-clear the producer queue. | [08] |
| T-074 | **Time-sliced frame-resumable sort** | Explicit `int[300]` stack, all state in instance fields, budget in ms/frame — and **sort the permutation**, so an interrupted sort leaves valid-but-unsorted data. | [08] |
| T-075 | **Manual `now >= _next` timers in one `Update`** | The received wisdom "delayed events beat `Update`" is true when idle, false when active, and false again when several loops must be coordinated and share state. Use `Time.timeSinceLevelLoadAsDouble` — `Time.time` drifts after hours. | [08] |
| T-076 | **Pull-based frame memoisation instead of `Update()`** | `if (lastFrame == Time.frameCount) return cached;` — a library component that costs *nothing* when nobody asks, where "compute in Update, cache in a field" taxes every world that merely has the prefab present. | [08] |
| T-077 | **Lifecycle handlers are ordinary callable methods** | Hand-invoking `OnStationEntered`/`OnPickup`/`Awake` is legitimate — and `IProcessSceneWithReport` runs *before* Unity's static batching, which is the only window in which some `Awake` work can still be corrected. | [03] |
| T-078 | **`Start()` re-declared public and idempotent as an "ensure init" barrier** | Callable cross-behaviour (`queue.Start();`) so initialisation ordering stops mattering. | [02] |
| T-079 | **`enabled = false` as a sleep switch, with setters manually pumping `Update()`** | Suppresses `Update`/`LateUpdate` while the object stays fully callable — a *free* removal from the per-frame dispatch list, turning a polling loop into a push model with no dirty flag. An early-return guard does **not** do this. | [08] |

## Data structures (T-080 – T-104)

| | technique | one line | where |
|---|---|---|---|
| T-080 | **Parallel arrays indexed by an integer are the struct** | The near-universal answer to "no structs, no tuples, no handles". Large production codebases ship with **zero** `DataList`/`DataDictionary`. | [04] |
| T-081 | **Slot-stable free list: grow to high water, null out to free, *never compact*** | Deliberately leaking the hole is what buys a stable handle, which is what makes parallel arrays safe. Converges to zero steady-state allocation under unbounded churn. Growth by +1, not doubling, when the high-water mark is small. | [04] |
| T-082 | **Swap-with-last compacting pool** | The opposite trade, when index stability is not needed: one `int` is the entire allocator, the live set is always a dense prefix. The `while` loop must **not** `i++` after a removal. | [04] |
| T-083 | **Tombstone slot allocator over parallel arrays** | Tri-state tombstones (`-1` empty / `0` orphaned / `>0` id) with an explicit logical length: compaction and serialization become the same operation. Audit the allocator against the field list every time you add an array — a fourth parallel array left ungrown desyncs clients, and the symptom appears nowhere near the allocator. | [04] |
| T-084 | **Sentinels chosen so they are already correct under the ordering relation** | `int.MaxValue` as "unregistered" sorts last with no guard; `float.PositiveInfinity` as "nothing in range" makes `if (d < threshold)` correct by default where `0` would invert it. | [04] |
| T-085 | **The `+1` bias makes zero signable** | Partition a float's value space into {absent, payload, command codes} — the offset is the whole trick, because Udon has no nullables. | [04] |
| T-086 | **A field that exists for another purpose as an O(1) index hint** | Speculatively index, validate by *reference identity*, fall back to a scan. A self-validating cache with **no invalidation protocol at all**. Same shape works for instance-ID memoisation (Unity recycles instance IDs — store the object as the value). | [04] |
| T-087 | **`Array.IndexOf` via a `(Array)` upcast** | `System.Array`'s pre-generics API is not generic and *is* exposed. One EXTERN replacing an interpreted loop, and one fewer duplicated body per element type. General lesson: **look for a pre-generics non-generic overload.** | [04] |
| T-088 | **Jagged `T[][]` + count-then-fill** | The sanctioned `T[,]` substitute; save the *prior* state so your mask composes with other systems; restore backwards so nested roots unwind in order. | [04] |
| T-089 | **Flat array with stride, sliced into a reused scratch buffer** | `SetFloatArray` copies its input, so one scratch allocation serves N consumers. | [04] |
| T-090 | **Two logical lists in one fixed buffer, partitioned by an uploaded boundary scalar** | N sets need N−1 boundary scalars. Achieved by two filtered passes over the index list — zero swaps, no comparator. | [04] |
| T-091 | **Bounded top-K insertion select instead of sorting** | Never permutes the authoring array; degenerates to O(n) when most candidates lose. | [04] |
| T-092 | **`object[]`-as-struct, with the field name in a comment at every index** | The honest Udon-legal downgrade of an OO design, annotated line by line. The XML comment is the schema. | [04] |
| T-093 | **`out` parameters as the tuple substitute** | Re-entrant and free, where the reflexive `_outA`/`_outB` field pair is neither. Illegal on `[NetworkCallable]`. | [04] |
| T-094 | **Unity's implicit `operator bool` as the failure channel** | `if (!meshFilter) return;` catches null, fake-null (destroyed) *and* "allocation refused" in one test — and `Array.IndexOf(arr, null)` is a *reference* compare that cannot see fake-nulls. | [04] |
| T-095 | **`hasX` bool mirrors of every inspector reference** | Unity's `!= null` is an EXTERN; branching a bool field is a native jump. The same bools double as re-entrancy latches and array-allocation gates. Refcount `int` + mirror `bool` is the same idea for counters. | [01] |
| T-096 | **`DataDictionary` keyed on `GetInstanceID()`** | `DataToken` will not key on a `UnityEngine.Object`; the int instance ID is the legal stand-in. Store *indices* into a fixed array, not the objects, so eviction needs no reverse index. | [04] |
| T-097 | **The `DataToken` key-type trap** | Added with a string key and removed with an int key never matches, and never errors. Pin the key type at the declaration. `TryGetValue(key, TokenType.X, out t)` is the exception-free downcast. | [99] |
| T-098 | **Prebuilt `DataDictionary` template + `ShallowClone()`** | 6 `Add` EXTERNs become 2 indexer writes. A `readonly` field initialiser can run a whole builder chain. | [04] |
| T-099 | **`[OdinSerialize]` persists `DataList`/`DataDictionary`** | `VRC.Udon.Serialization.OdinSerializer` serializes what Unity cannot. | [04] |
| T-100 | **A free list as a sparse set derived locally from one synced bool per object** | O(1) random pick and O(1) remove, zero sync bytes, idempotent membership guards. | [04] |
| T-101 | **Base64-of-raw-floats inside a `VRCJson` envelope** | `Buffer.BlockCopy` reinterprets `float[]` as `byte[]` in one EXTERN with no loop. 5.33 bytes/float instead of 11–16, exact bit-for-bit round-trip, and **zero loops** — versus `float.ToString("R")` joined with `+=`, which in Udon is O(n²) in copied bytes. | [04] |
| T-102 | **Reused-buffer discipline** | `if (arr.Length != required) arr = new T[required];` is the allocation-discipline signature; `RaycastNonAlloc` with a length-1 buffer; `GetPlayers(buffer)`; a `Color32[1]` for `TryGetData`. | [09] |
| T-103 | **Two upload array sizes for two traffic shapes** | `SetFloatArray` uploads the *whole* array, so a bulk-sized buffer moves 4 KB to carry 12 bytes on the live path. Splitting also separates the *semantics* (live needs timestamps, bulk must appear instantly). | [09] |
| T-104 | **Content-addressed dedup must be opt-out for anything mutable** | And the opt-out has to be a parallel flag array carried alongside the data, not a property of the content. | [04] |

## Sync and networking (T-105 – T-129)

| | technique | one line | where |
|---|---|---|---|
| T-105 | **Split the sync model by *retention semantics*** | Deltas ride `[NetworkCallable]` events (transient, typed arguments including arrays, no ownership, no ack, no `Manual` mode — **anyone can act simultaneously**); the snapshot rides `[UdonSynced]` in a *separate behaviour* (retained, replayed to joiners). Deletes ~80 lines of ring-buffer/ack protocol whose only purpose was making a retained variable behave like a stream. | [05] |
| T-106 | **The synced variable *is* the late-join latch** | VRChat replays the last serialized state of a Manual-sync behaviour to every future joiner, so one empty `Full` packet converts an O(players) event stream into O(1) traffic. | [05] |
| T-107 | **…and therefore retained state is a cache needing a coherency protocol** | `Ignore` as a **tombstone**: any mutation overwrites the published snapshot once, sets `_isDirty`, and the real snapshot is rebuilt lazily only when a joiner appears. A write-invalidate cache, in Udon. | [05] |
| T-108 | **Reliable manual sync: monotonic revision + server-time pair** | Retry on `!result.success`, drop stale, and hook `_DeserializationOutOfDate` — forward it when the payload is idempotent, no-op only when old state can regress something. | [05] |
| T-109 | **Advance the tail only on ack** | A ring buffer with three cursors plus an in-use latch (a second `RequestSerialization` before `OnPostSerialization` **silently replaces the payload**) plus `Networking.IsClogged` turns fire-and-forget into a reliable stream **with no acknowledgement traffic**. | [05] |
| T-110 | **Sync the epoch, not the value** | One `_videoStartNetworkTime`; every client derives position; seek = move the epoch. Steady-state traffic zero, late joiner correct on first deserialize. Same idea: teleport as a **wrapping counter difference**, not a bool — idempotent, replay-safe, and a late joiner snaps to spawn by construction. | [05] |
| T-111 | **Counters, not booleans, for events** | A bool cannot express "it happened twice"; a counter is idempotent and replay-safe. A synced `int` hash works as a generation token that needs no counter. | [05] |
| T-112 | **Broadcast a verb; each client self-selects** | Addressing one player = broadcast + a target id in the payload. Attachment handoff is **pulled**: the packet names the intended owner and exactly one client self-selects. | [06] |
| T-113 | **Ownership by derivation, not by handshake** | Orphan = `(synced held) AND NOT (locally held)`; a *snatch* emits a semantically different event so message order stops mattering; asymmetric backoff ("I took it" transmits now, "it fell to me" waits ≥0.2 s + jitter). | [05] |
| T-114 | **Deterministic ownership handoff on collision** | Faster object wins, with an asymmetric `<` so a tie gives it to nobody. | [05] |
| T-115 | **`OnOwnershipRequest` is the actual security boundary** | The only hook computed by a non-attacker's client — and most implementations omit the `requestingPlayer == requestedOwner` clause. | [05] |
| T-116 | **Ownership acquisition and the mutation it enables belong in separate invocations** | `takeOwnership()` returning bool used as the branch condition. | [05] |
| T-117 | **`Owner = local; RequestSerialization();` as a *prologue*** | `RequestSerialization` is "mark dirty", not "send now", so the prologue form is robust against early returns. | [05] |
| T-118 | **Out-of-order rejection with rollback** | A 4-bit sequence + half-window compare + a shadow copy: Udon has *already overwritten your fields* by the time you decide, so rejecting means undoing. | [05] |
| T-119 | **Three stacked replay defences** | `isFromStorage`, empty-buffer, and a monotonic sequence number — plus a coalescing window and a self-rescheduling drain. | [06] |
| T-120 | **Eventual consistency by intent re-assertion** | Local intent is authoritative; the synced array is a cache to be repaired; every disagreement schedules an idempotent retry. The reverse trade from reliable sync: here the *payload* is unreliable and the *intent* is durable. | [05] |
| T-121 | **Self-healing desync repair at zero traffic** | Replay the message you already have, on a jittered delay scaled by measured latency, cancelled if newer data arrived. Repair on a fixed *global* budget (one message per 50 ms world-wide) so it converges by time rather than by rate. | [05] |
| T-122 | **`OnPreSerialization`/`OnDeserialization` as codec hooks** | `[UdonSynced] byte _flags` is the wire format, plain bools are the model, packing happens at one choke point that cannot be forgotten. Also the projection hook for un-syncable reference types (`Gradient` → a `Color[]` shadow — and you must **reassign** `colorKeys`, because the property returns a copy). | [05] |
| T-123 | **Calling your own `OnDeserialization()` manually** | Turns an unreliable push channel into a reliable pull one. Design obligation: it must be idempotent and must not read "previous" state. | [05] |
| T-124 | **Synced fields are NOT populated in `Start()`** | `Start()` may only set "I am waiting" flags; all state application belongs in `OnDeserialization` with a one-shot snap branch for the first arrival. Add a start-up **grace window** because Udon has no "initial sync received" callback. | [05] |
| T-125 | **Serialization callbacks never fire when you are alone in the instance** | The single most common "works with a friend, does nothing solo" bug. | [99] |
| T-126 | **Late-joiner state with zero packets** | Run the marshaller *in the editor* and bake the payload into the scene; or broadcast a **delta from the prefab default** with `NetworkEventTarget.All` so the correction is idempotent on the sender too. | [05] |
| T-127 | **Randomised self-scheduling as decentralised admission control** | The substitute for the static coordinator Udon forbids — and make the *width* of the random window proportional to payload size, so the expected inter-arrival gap scales with transmission cost. | [05] |
| T-128 | **`SerializationResult.byteCount`** | The one-line instrument that makes every sync-byte decision measurable. Pair it with an asserted bandwidth budget derived from your tick rate at `Start()` — the substitute for the contract-checking Udon lacks. | [05] |
| T-129 | **Per-player `VRCPlayerObject` sender** | Designs ownership contention out of existence, and makes sender identity unforgeable (it *is* `GetOwner`). | [05] |

## Editor-time and build-time (T-130 – T-159)

| | technique | one line | where |
|---|---|---|---|
| T-130 | **`SetProgramVariable` vs `publicVariables.TrySetVariableValue`** | The single most load-bearing fact for editor tooling. Editor code setting a field on a proxy is **not** what runs in a build. `if (Application.isPlaying) ub.SetProgramVariable(...) else ub.publicVariables.TrySetVariableValue(...)`, reached via `UdonSharpEditorUtility.GetBackingUdonBehaviour`. | [11] |
| T-131 | **A U# reference *is* an `UdonBehaviour`** | Convert with `GetBackingUdonBehaviour` before injecting, or you silently produce a broken reference with no error at build *or* runtime. The typed C# view is a compile-time fiction — which is why cross-behaviour access is priced the way it is. | [11] |
| T-132 | **`[PostProcessScene]` / `IProcessSceneWithReport` operate on a throwaway copy** | So you may destructively canonicalize it. Guard with `if (Application.isPlaying) return;` — **it also fires on play-mode entry** and will otherwise double-run. | [11] |
| T-133 | **Run the *runtime* at build time rather than writing a second implementation** | Then null the authoring references — **serialized references are what pull assets into the build**, so nulling them post-bake is how a baked-atlas system stops shipping its source textures. | [11] |
| T-134 | **A scene is a legal place to put an asset you want to mutate** | Instantiate referenced prefabs into an inactive holder inside the throwaway scene; Unity's own cleanup is the teardown. No temp folders, no restore path. | [11] |
| T-135 | **Non-destructive by construction, not by cleanup** | Work only where Unity already throws things away: the build-scene copy, play mode, `HideFlags.HideAndDontSave`, `Library/`, a generated temp package. | [11] |
| T-136 | **The scene stores intent; the build stores the resolved value** | The general cure for "my tooling keeps dirtying the scene". Expect to need several hooks whose only job is stopping something *else* persisting derived state. | [11] |
| T-137 | **Build-time DI: the field's declared type is the query** | Two string-carrying marker components + one scene pass. `T[]` means "inject all matches" — a subscriber list with no generics, no `List<T>` and no registration protocol. Zero runtime cost. | [11] |
| T-138 | **Convention-based DI by scanning the compiled symbol table** | `SerializedProgramAsset.RetrieveProgram().SymbolTable.GetExportedSymbols()`, match a name, write via `publicVariables`. Name a field `audioLink` and the editor sweep wires it. | [11] |
| T-139 | **`[Singleton]` on the manager *type*, zero annotation at the use site** | Keyed off the field's declared type, so marking one class retroactively wires every existing reference — and duplicate instances become a build error, an invariant a runtime singleton cannot enforce in Udon. | [11] |
| <a id="t-140"></a>T-140 | **Hijack Unity's own lightmapper as a general GI service** | `Experimental.Lightmapping.SetAdditionalBakedProbes(id, positions)` under a **namespaced, never-reused** ID, then `GetAdditionalBakedProbes` for SH plus a validity channel. A bespoke volumetric GI format with none of the GI written. | [11] |
| T-141 | **One implementation, three execution environments, joined by the global uniform namespace** | The bake compute shader `#include`s the same header as the world's fragment shaders and is driven with **the same global names the Udon runtime uploads**. What the baker computed and what the world renders cannot disagree by construction. | [11] |
| T-142 | **Design every runtime routine with an injectable "do it all now" configuration** | The editor bake *is* the runtime behaviour with its frame-amortisation knob turned to maximum and its activity guards defeated, restored in a `finally`. That is a constraint you accept up front, not retrofit. | [11] |
| T-143 | **…and the reverse: the editor *reads* the runtime's own packed buffers** | Rather than reimplementing the packing math. Both directions exist to keep exactly one implementation. | [11] |
| T-144 | **`IVRCSDKBuildRequestedCallback` returning `false` aborts the upload** | The veto point. `callbackOrder` matters: `-1` runs before U# bakes proxy fields; `90` runs immediately before U# compiles; `-1000` runs before essentially everything. Unlike `IProcessSceneWithReport`, its edits **persist**, so the scene is still authorable and the edits undoable. | [11] |
| T-145 | **Register on *both* build hooks — no single hook fires on every path** | `IVRCSDKBuildRequestedCallback` + `IProcessSceneWithReport`, or + `playModeStateChanged`. And play mode skips `IVRCSDKBuildRequestedCallback` entirely, so fire it yourself with a one-frame latch shared between two unrelated callback interfaces. | [11] |
| T-146 | **`FullSetDirty`** | `SetDirty` alone loses injected values on prefab instances — pair it with `PrefabUtility.RecordPrefabInstancePropertyModifications`. The two lines that stop bakes evaporating. | [11] |
| T-147 | **`EditorJsonUtility.ToJson` as a before/after fingerprint** | Only `SetDirty` when something actually changed, exactly, with no per-field discipline to rot. | [11] |
| T-148 | **`ObjectChangeEvents.changesPublished` as the edit-time sync driver** | The typed change stream gives exactly the events proxy synchronisation needs — including reparenting and prefab-instance updates, which `OnValidate` cannot see. **Re-entrancy is the hard part**: the flush writes to the components whose changes it consumes. | [11] |
| T-149 | **Every editor hook is a hint, never a fact** | Idempotent per-*phase* flags (not per-event handlers), `delayCall` re-queued until the host's own state agrees, a busy predicate that re-queues rather than drops, `beforeAssemblyReload` unwinding everything, and a pre-render flush for anything that must be seen before rendering. | [11] |
| T-150 | **An `AssetPostprocessor` as an *invalidation source*** | Ignore the argument arrays entirely: any `AssetDatabase` refresh can silently restore a U# proxy's serialized values, with no event and no user action to blame. | [11] [99] |
| T-151 | **Retype a component in place by rewriting `m_Script`** | Keeps the fileID, so every inbound reference survives; `[FormerlySerializedAs]` carries the data across. | [11] |
| T-152 | **Reading the scene's raw YAML to recover fields the class no longer declares** | Unity **drops serialized values whose field is gone**, and `SerializedObject` reflects the current type — only the `.unity` text still has them. Match components with `GlobalObjectId`. Gate on `!scene.isDirty` so unsaved edits are never overwritten. | [11] |
| T-153 | **A migrator that guesses is worse than one that stops** | `Length != 1` treated as fatal everywhere; prefab instances refused outright; physical co-location beats serialized links; all-or-nothing creation with an explicit rollback justified by a preflight invariant. | [11] |
| T-154 | **`ReflectionHelper`: every reflection target as a `static readonly` field of a nested manifest class** | `IsReady<Reflection>()` degrades a broken feature to *absent*, never to a crash, and one global pass emits **one aggregated warning naming the exact fields that broke** instead of N runtime exceptions later. | [11] |
| T-155 | **Every invasive mechanism gets three guards** | A menu kill switch, a viability check, and a backstop that catches what the primary misses — plus an uninstaller. That is the licence that makes the rest defensible. | [11] |
| T-156 | **Untyped serialized-property walks beat knowing the schema** | Iterate all properties looking only at `ObjectReference`. A pass that knows not a single field name is exactly the one that works on third-party Udon programs. | [11] |
| T-157 | **`TypeCache` over `AppDomain.GetAssemblies()`** | And match by **simple type name** to suppress or discover packages you do not reference; `method.Name.Split('.').Last()` handles explicit interface implementations, which a naive `GetMethod` cannot see. | [11] |
| T-158 | **One `[InitializeOnLoadMethod]` dispatcher replacing thirty** | Deterministic order, per-hook isolation with `TargetInvocationException` unwrapped, and an opt-in timing table that turns "why is domain reload slow" into a measurement. | [11] |
| T-159 | **Editor-driven codegen from a single schema** | Generate both sides of a contract from one header; or rewrite a checked-in `.cginc`'s `#define`s in place from scene analysis, so the generated state stays reviewable in a diff and user edits survive. | [11] |

## GPU bridges and shaders (T-160 – T-189)

| | technique | one line | where |
|---|---|---|---|
| T-160 | **Udon is an address bus, not a data bus** | Publish an *index* at `Start()` via an instanced `MaterialPropertyBlock`, and let the shader do all addressing against a global texture. Entity count becomes free in Udon terms. | [09] |
| T-161 | **Rasterise your data instead of marshalling it** | Put per-entity data in a property block, point a camera at the entities — **the transform arrives on the GPU for free because the renderer already uploads its object-to-world matrix**. Uncaps the fixed-array limit. Total per-frame Udon cost for a whole lighting system: one `SetGlobalVector`. | [09] |
| T-162 | **`Renderer.sortingOrder` as the GPU buffer index** | A serialized field with no inspector UI, assigned at build time; indexing, ordering *and* priority all handled by machinery that already exists. `includeInactive: true` is what makes indices stable. | [09] |
| T-163 | **The global-shader-array contract** | Resolve every `PropertyToID` once; upload **every array at full capacity once** to fix its shader-side length; then refill in place and communicate liveness via *count* scalars. Disable by zeroing counts, never by clearing arrays. Zero allocation, zero string hashing per update. | [09] |
| T-164 | **Global arrays must ALWAYS be uploaded at max length or you corrupt other worlds** | `SetGlobalVectorArray` sizes the constant buffer on **first** upload for the *process* lifetime, VRChat keeps one process across world loads, and avatar shaders read these globals. The "obvious" memory saving is a cross-world correctness bug. | [09] |
| T-165 | **1023 is the D3D constant-register limit** | `float _S[1023]` pads each element to a full float4 register; 4×1023 = 4092, just under 4096. The entire CPU-side transport shape is derived from a GPU register rule. Stage through a `float[1023]` **field** and `Array.Copy` into it — one EXTERN versus ~1023 VM iterations. | [09] |
| T-166 | ***Contested*: `packoffset` cbuffer aliasing to break the 1023 limit** | Recommended by one source, **explicitly retracted** by another as slower than a texture past ~100 reads, with Morton/Z-order texture staging as the replacement. Neither measured. Choose on read count, not write cost. | [09] [10] |
| T-167 | **The CustomRenderTexture is the universal Udon-accessible memory** | And `updateMode` (`Realtime` ↔ `OnDemand`) is the universal on/off switch: one enum write arms or disarms an entire GPU subsystem at zero per-frame Udon cost. | [09] |
| T-168 | **Retype the CRT to `Texture2D<uint4>` by vendoring `UnityCustomRenderTexture.cginc`** | One changed declaration turns a float, filtered, sRGB-hostile CRT into exact 128-bit-per-texel integer RAM, with the CRT's own double-buffering as free read-modify-write. Replacing the *include* rather than the shader is the minimal intervention. | [09] |
| T-169 | **The CRT as the system's entire mutable state** | 12 passes, each owning a disjoint rectangle, each reading the previous frame via `_SelfTexture2D[xy]`. Udon pushes raw inputs and never reads state back. Even a fractional frames-to-roll accumulator lives in a texture pixel. | [09] |
| T-170 | **Blit-pass index as an opcode table** | Udon cannot dispatch compute, so a multi-pass blit material becomes the instruction set and `enum BlitPass` is the opcode enum. | [09] |
| T-171 | **The GPU render texture *is* the data structure** | 65 536 points in an `ARGBFloat` RT and **three EXTERNs per point regardless of n**, with zero Udon heap growth. | [09] |
| T-172 | **Geometrically growing GPU buffer with copy-on-resize** | `List<T>` for VRAM: power-of-two square (so index↔xy is shifts and `GenerateMips` stays legal), seeded with a **sentinel** rather than zero, old contents blitted in. `VRCRenderTexture.GetTemporary` derived from `_rt.descriptor` is what makes scratch surfaces track the growing buffer. | [09] |
| T-173 | **GPU stream compaction via Z-order curve + `GenerateMips`** | The mip chain of an occupancy mask **is** a hierarchical sum — free prefix-scan machinery from fixed-function hardware — and Z-order makes the pyramid descent local. Count returns as a **1-float readback**. | [09] |
| T-174 | **Let the GPU reduce; read one texel** | A 64×32 mipped RT plus a readback of `mipmapCount - 1` gives the hardware box-filtered average of an entire live video frame for a 4-byte transfer. | [09] [12] |
| T-175 | **GPU readback into Udon: `VRCAsyncGPUReadback` + `(IUdonEventReceiver)`** | The modern, non-stalling channel. The legacy one — a manually pulsed camera plus `OnPostRender` on a behaviour **placed on the camera GameObject** — is still the only way to read an arbitrary render target on older SDKs, and pulsing `enabled` turns it into a rate-limited DMA. | [09] |
| T-176 | **A shader pass whose only job is to be readable by Udon** | Udon only ever sees `Color` (four normalized floats). Don't make it decode a hostile format — spend one fullscreen pass re-laying-out the data into the shape the CPU API can express. **The translation is a rendering problem, not an Udon problem.** | [09] |
| T-177 | **Byte-exact int reconstruction: `*255.0f + 0.5f` on both sides** | The `+0.5` turns C#'s truncating cast into round-to-nearest; without it ~half of all values are off by one, and the bug looks like memory corruption. Requires linear, point-filtered, uncompressed 8-bit, mip 0 — **and never use the alpha channel as a data lane**. | [09] |
| T-178 | **Deliberately over-encode anything crossing the boundary** | 18 bytes to carry 16; 256 texels to carry one DMX channel decoded as `LinearRgbToLuminance` rather than `.r`. Buys immunity from sRGB, filtering, mip selection, alpha premultiplication and video-codec chroma subsampling. | [09] |
| T-179 | **Strings to the GPU as denormal floats** | A bit pattern whose *mantissa is the codepoint*, four per `Vector4`, decoded free with `asuint`. | [09] |
| T-180 | **Bit-pack a flags word into the unused `.w` lane** | `BitConverter.SingleToInt32Bits`/`Int32BitsToSingle` are exposed. Storing an integer *as* a float wastes a whole lane and loses precision above 2²⁴; bit-reinterpretation packs 23+ bits at zero precision cost. Keep the exponent field normal — some drivers canonicalise NaN/denormal patterns. | [09] |
| T-181 | **Choose a packing radix that stays exactly representable** | `x + y*256 + code*65536` is deliberately under 2²⁴ so the shader's `floor`/`fmod` unpack has no rounding slop. Stack sentinel + sign + integer + fraction in one float — with the `+1` bias so zero is signable. | [09] |
| T-182 | **Accessor-function indirection: one shader, two backing stores** | The shader calls `_Vertices_get(i)`, defined either as a constant-array index or a `Texture2D` load. **Putting the switch at the accessor means zero `#ifdef`s in the 500 lines of math that consume it** — and the baked path works with no Udon program present at all. | [09] [10] |
| T-183 | **A runtime-uploaded float as a two-way version handshake** | Your consumers are third-party shaders compiled long ago by other people, so a keyword cannot work. Gate on `_Version >= MIN_SUPPORTED` — **and because an absent runtime leaves the global at `0`, "not present" and "too old" are the same branch for free**. Clamp loop counts on both sides: each side distrusts the other's bounds. | [10] |
| T-184 | **Version by freezing a channel forever** | Pin the original discriminator (red = 3.02f in perpetuity) and move the live version to unused channels — the three-tier ladder works because each tier's discriminator lives in a different place. | [10] |
| T-185 | **`MaterialPropertyBlock`, always — and *merge*, never replace** | `renderer.material` clones the material, breaks batching and leaks a Unity object per renderer in a world that never unloads. And `SetPropertyBlock` clobbers wholesale, so `if (r.HasPropertyBlock()) r.GetPropertyBlock(block);` first, or you silently destroy every other system's overrides. | [09] |
| T-186 | **`[PerRendererData]` marks exactly the properties Udon writes** | Zero runtime effect; the only *machine-readable* statement of which string keys Udon is allowed to set, and it hides them from the material inspector so nobody authors a value that will be overwritten. | [09] [10] |
| T-187 | **Per-consumer loop bounds and inverted mask polarity, baked at edit time** | Ship each renderer the index of its last visible source as its loop bound. **Choose a flag's polarity so the padding/default value is the safe one** — that is a real design decision. | [10] |
| T-188 | **Feature detection by texture dimensions** | An unbound global resolves to Unity's tiny default, so `GetDimensions(w,h); return w > 16;` is a presence test — the *size of the fallback* is the sentinel. Texture dimensions also work as an in-band signal (16×16 = no video). | [10] |
| T-189 | **A texture property with any default cannot be overridden by `SetGlobalTexture`** | Declare `= "" {}`, not `= "white" {}`. | [09] |

## Shader-side technique (T-190 – T-204)

| | technique | one line | where |
|---|---|---|---|
| T-190 | **Two passes of the same program, differing only in render state** | `ZTest Always, ZWrite Off` (faint ghost, first) then `ZTest LEqual, ZWrite On` — x-ray debug visibility with **zero Udon-side occlusion logic**. | [10] |
| T-191 | **Billboard against the *averaged* stereo camera position** | `(unity_StereoWorldSpaceCameraPos[0]+[1])*0.5` — per-eye billboarding refuses to fuse in VR. Force world-up or the label rolls with the player's head. And **`"DisableBatching"="True"` is mandatory**: dynamic batching bakes vertices to world space and resets `unity_ObjectToWorld` to identity, silently destroying any shader that reads its own object transform. | [10] |
| T-192 | **`SV_VertexID % 3` as free barycentrics** | No geometry shader, no extra vertex stream — and "split the triangles" and "give each triplet sequential IDs" turn out to be **the same operation**. Note `SV_VertexID` is not dependable on every API; `uv0` carrying a duplicated per-primitive index is the portable variant. | [10] |
| T-193 | **Kill a primitive by writing `w = -1`** | The whole triangle fails clipping before rasterisation: no `discard`, no branch, the cheapest possible cull. Pair with absurd `mesh.bounds` to defeat Unity's culling and re-implement it in the shader, which has the per-instance information Unity does not. | [09] |
| T-194 | **A baked degenerate-quad mesh as the particle buffer** | Four vertices at an identical random position (position *is* the seed) plus two triangles, expanded in the vertex shader. Zero runtime allocation, streams like any mesh, and Udon's entire role is uploading matrices. | [09] |
| T-195 | **Geometry shaders as the random-access write path** | Clip-space position *is* the write address, so a degenerate one-pixel quad is a store instruction. Also the way to get post-skinning vertex data out. | [09] |
| T-196 | **The fixed-function blender as a shift register** | `Blend DstAlpha Zero` is a data-dependent shift — read-modify-write with no UAVs. | [09] |
| T-197 | **Named `GrabPass` as a global texture channel** | Reachable by *avatar* shaders; `GetDimensions` is the missing null check. | [10] |
| T-198 | **Point lights as a positional data bus** | With an **empty `ForwardAdd` pass** added purely to change Unity's light-classification decision, and light alpha as an identity tag. | [10] |
| T-199 | **The four preconditions for depth-texture participation — and the "depth light" hack** | Directly relevant to any fully-baked world, which has zero realtime lights and therefore no depth texture. | [10] |
| T-200 | **A stencil bit as a carrier for a depth-test result** | Into a pass that has depth testing disabled — avoids needing `_CameraDepthTexture` at all. | [10] |
| T-201 | **Reconstruct `GL.GetGPUProjectionMatrix` inside the shader** | It is not exposed to Udon: push the raw OpenGL matrix and do the platform fix-up in HLSL under `UNITY_REVERSED_Z`. | [10] |
| T-202 | **Publish view+projection matrices to the material so the GPU reprojects** | Render once for the screen camera; every other camera reprojects. `_RenderOK` doubles as a staleness flag and a liveness protocol. | [10] |
| T-203 | **`#define _SelfTexture2D _JunkTexture` / `#include` / `#undef`** | Retarget a declaration in a package header you cannot edit. | [10] |
| T-204 | **`SetReplacementShader(shader, "")` — the empty tag is the optimisation** | A non-empty tag re-enters normal dispatch. Plus: cull all lights off the compute camera's layer. | [10] |

## Performance, player systems, math (T-205 – T-229)

| | technique | one line | where |
|---|---|---|---|
| T-205 | **The frame budget is spent by *activation*, not by early-out** | `gameObject.SetActive` / `enabled = false` / `Destroy(this)` remove a program from dispatch; an `if` at the top of `Update` does not. A behaviour whose whole job is to push inspector values once can `Destroy(this)` in `Start()` — everything it configured lives on the Renderer, not the behaviour. | [08] |
| T-206 | **Everything derived from an inspector value is computed once at init** | Angles → dot thresholds (`Vector3.Angle` is *several* externs), reciprocals, bool predicates, literal layer masks, cached `Transform`s, animator hashes. | [08] |
| T-207 | **Push derivation up the pipeline — including matrix rows you can reconstruct** | Store rows 0 and 1 of an orthonormal rotation; the shader rebuilds row 2 as `cross(r0, r1)`. A third of the constants *and* a third of the upload, for one `cross()` per pixel. | [08] |
| T-208 | **Sort by mutability at bake time so the per-frame loop is a contiguous prefix** | A data-layout decision made in the editor that deletes a branch from a hot loop — worth far more in Udon than in normal C#, because there are no filtering constructs and iteration is EXTERN-heavy. | [08] |
| T-209 | **Decompose *which part* changed, with a minimal write path per part** | Matrix unchanged → skip; only the translation column changed → write one `float4` and set one upload flag. Makes a moving object nearly free. | [08] |
| T-210 | **A write-through cache of *another object's* state, held by the writer** | Mirror what you push and skip the write when unchanged — steady state performs **zero** cross-behaviour writes. The inverse of the usual read cache, and specific to a cost model where the boundary crossing is what you pay for. | [01] |
| T-211 | **Round-robin amortisation with one dispatcher index** | Converts "N behaviours each working every N frames" into "one behaviour doing one unit per frame", removing the periodic spike. Randomise the phase at `Start` so N instances never spike together. | [08] |
| T-212 | **Frame-rate-exact IIR smoothing (`Mathf.Pow(k, dt)`) becomes mandatory once dispatch rate is variable** | This coupling is rarely stated. | [08] [13] |
| T-213 | **Async callbacks need their own delta time** | `Time.deltaTime` inside a readback or network callback describes the *rendering* frame, not the interval since your callback last landed. Generalises to every Udon callback not driven by the frame loop. | [08] [13] |
| T-214 | **Constant-time sliding-window mean** | Ring buffer + running sum, with the length derived from `Time.fixedDeltaTime` so the window is a constant *duration* on any client. | [13] |
| T-215 | **Player tags as the missing static storage** | `SetPlayerTag`/`GetPlayerTag` gives a hand-occupancy mutex across unrelated scripts, broadcast status, and a **cross-client object handle** (a hierarchy path resolved with `GameObject.Find`) with no registry and no synced index. | [07] |
| T-216 | **Capability tokens** | Refcount + mirror bool + `[FieldChangeCallback]` + an edge broadcast + a *synthesised release event* — the one cross-behaviour mutual-exclusion primitive Udon can express. Claimants keep a private bool so claim/release are idempotent. | [07] |
| T-217 | **How VRChat network IDs actually work** | Per-**GameObject**; components addressed by index in `GetComponents<VRCNetworkBehaviour>()` order; matched across scenes by hierarchy **path string**. Reordering, adding or removing a network component re-slots the others. | [07] |
| T-218 | **`LateUpdate` vs `PostLateUpdate` split by *data source*** | Device pose is valid in `LateUpdate`; bones are the IK output and need `PostLateUpdate`. The folk rule over-generalises. | [07] |
| T-219 | **Collider layers as client-local per-observer relationships** | Same object, two collision identities, zero network cost — and free self-exclusion for a targeting system. `Rigidbody.includeLayers`/`excludeLayers` do the same per object without touching the global matrix. | [07] |
| T-220 | **Rewrite your own perception instead of syncing** | A vehicle intercom built entirely from each client calling `SetVoiceDistanceNear/Far/Gain` over an already-synced membership list: zero sync, no ownership, no late-joiner problem. **Store player IDs, never `VRCPlayerApi` references.** | [07] |
| T-221 | **VRChat UI interactivity is physics** | Toggle `Collider.enabled` under `VRCUiShape`. | [07] |
| T-222 | **Seat calibration as successive approximation** | Power-of-two step quantisation converges in ~log₂ steps with no gain constant and is immune to an unknown loop rate; latch per axis only after the error stays small. | [13] |
| T-223 | **Anchor-relative sync** | A scene `Transform` is the shared coordinate frame, so a per-client origin offset cancels implicitly — no synced offset, no race. Publish the same anchor to shaders. `DetachChildren()` for its *side effect* (world transform preserved, local positions rebaked small) is the whole floating-origin technique in one line that looks like cleanup. | [13] |
| T-224 | **Closed forms beat simulation loops** | A damped harmonic oscillator branched by damping regime is exact for any `dt` with no stability limit — and deliberately uses `Mathf.Sqrt/Exp/Sin/Cos`, because **one EXTERN beats a polynomial's worth of VM instructions**. Keep the naive version as executable documentation. | [13] |
| T-225 | **Quaternion compression: two answers, chosen by dynamics** | Drop W and re-derive, versus four shorts. The same author does both; the deciding factor is the dynamics of the thing being synced. Angular-velocity reconstruction needs the double-cover 720° window, which forces a hand-written `RealSlerp` because Unity's takes the shortest arc. | [05] [13] |
| T-226 | **A local clock anchored to server time, re-anchored on frame hitches** | Sample at 1 Hz, integrate `Time.deltaTime`, correct at 1/20 strength, and **keep the sub-millisecond remainder in an accumulator**. `SmoothDamp` used as a low-pass filter *on a clock*, not as easing. | [13] |
| T-227 | **Same-tick float equality as a causality test** | `Time.time == LastDamageEventTime`. | [13] |
| T-228 | **Sample one, apply all** | Buoyancy from one probe; a propagating effect as a travelling scalar; branchless mute via a `0/1` int multiplier; amortisation folded into the maths (`*.2f`). | [13] |
| T-229 | **`Collider.ClosestPoint(p) == p`** | The only point-in-collider test available. | [13] |

## Debugging, introspection, anti-patterns (T-230 – T-252)

| | technique | one line | where |
|---|---|---|---|
| T-230 | **The Udon heap is a flat, string-keyed, externally readable/writable namespace** | Public variables are not special. `__refl_typeid`/`__refl_typename` identify an arbitrary `UdonBehaviour`'s U# type and cleanly reject graph programs. | [12] |
| T-231 | **Bake the Udon symbol table at build time** | `SerializedProgramAsset.RetrieveProgram()` → `IUdonSymbolTable` into `string[][]`/`Type[][]` gives a full runtime inspector with **zero runtime reflection**. (`Type[][]` and jagged arrays serialize on a behaviour because U# uses its own serializer.) | [12] |
| T-232 | **`__refl_argnames/argtypes/returnname/returntype_<export>`** | Emitted by a Harmony prefix on `MethodSymbol.Emit` ⇒ **self-describing behaviours** that work on third-party programs — including recovering a return value out of `SendCustomEvent`. | [12] [06] |
| T-233 | **`UDONSHARP_DEBUG` → the Node Definition Grabber dumps every exposed EXTERN** | And reading `UdonBehaviour.cs`'s event registrations tells you which Unity messages actually fire. This is how you build an authoritative address table instead of guessing. | [12] |
| T-234 | **Reach an Udon entry point U# doesn't expose by naming a public method after it** | The U# virtual list is a hand-curated convenience layer over a *string entry-point table*; the table is the authority. Grep `UdonBehaviour.cs` for `RunEvent("_...")`. | [03] |
| T-235 | **CrashWatcher** | The VM *disables* a behaviour that faults, so poll `UdonBehaviour.enabled` at 1 Hz: the only fault detector in a VM with no exceptions, and it requires **no cooperation from the watched code**. | [12] |
| T-236 | **The `[DefaultExecutionOrder(±1e9)]` bracket** | Two behaviours with `Stopwatch`es measure *all* Udon in the world per phase, including `PostLateUpdate`, with zero cooperation from anything. Reset keyed on `Time.frameCount`; `FixedUpdate` accumulates while the others assign. | [12] |
| T-237 | **Exfiltrate structured data via `VRCJson` + one `Debug.Log` in Chrome/Perfetto trace format** | The visualisation problem is then solved by an existing tool. Scrape the live player log with `FileShare.ReadWrite` + a marker string. | [12] |
| T-238 | **Push profiler samples into a CustomRenderTexture** | The GPU owns all history, so Udon holds none. | [12] [09] |
| T-239 | **Stub the Unity/VRChat surface so the logic compiles and runs as plain C#** | The only route to mechanically verifiable Udon logic in a VM with no tests and no debugger. Decide it before the code exists, not after. | [12] |
| T-240 | **Any state published via `VRCShader.SetGlobal*` is automatically inspectable by a replacement shader** | `SceneView.AddCameraMode` + `SetSceneViewShaderReplace` — the visualisation *is* the runtime state, with no second data path. | [12] |
| T-241 | **Build tombstone: a GameObject named "MyTool ran!"** | Puts the evidence *in the artefact*, so "did the pass run?" is answerable by anyone holding only the built world. `MoveGameObjectToScene` is load-bearing — `new GameObject()` lands in the *active* scene. | [12] [11] |
| T-242 | **`enabled` does not gate `SendCustomEvent` the way it gates `Update`** | A disabled behaviour is still fully callable. | [12] |
| T-243 | **NaN crashes the VRChat client** | Clamp every inverse-trig argument. There is nothing to catch and no partial failure. | [12] |
| T-244 | **An out-of-range index halts the behaviour** | There is no exception to catch, so precompute a safe length (`Mathf.Min(params int[])`) rather than bounds-checking in the loop — and **never ship an empty array**; pad at build time with a dummy the existing rejection path already discards. | [12] |
| T-245 | **Unity's `Vector3 ==` is approximate (~1e-5)** | Compare components individually wherever a comparison gates an exact fast path. Three float compares is likely *cheaper* than one EXTERN to the overloaded operator. Use `Matrix4x4.Equals`, not `==`, for change detection. | [99] |
| T-246 | **Unity's built-in blit shader is half precision** | An invisible correctness bug: world positions become slightly wrong with distance from origin and it reads as "jitter", not precision loss. Ship your own float `Copy` pass. | [99] |
| T-247 | **Global shader properties are process-wide and sticky** | They survive exiting play mode and leak between worlds. Use a one-shot teardown latch with *neutral* (not zero) reset values, and clear them from an editor hook on `EnteredEditMode`. | [99] |
| T-248 | **Udon writing to a serialized `Material` mutates the project asset** | Harmless in a build; in ClientSim it **permanently rewrites the `.mat` in your repo** every play session. Snapshot on `ExitingEditMode`, restore with `EditorUtility.CopySerialized`, and diff-log what changed. | [99] |
| T-249 | **`default:` stacked onto a real `case`** | Satisfies definite assignment without a `throw`, which Udon does not have and `switch` *expressions*, which U# rejects. Costs nothing; states the fallback policy exactly where a language with exceptions would state the failure policy. | [99] |
| T-250 | **No `try/finally` ⇒ make the critical section structurally return-free** | Hoist every validation above the mutation, make the restore idempotent and call it *first* so a previously-leaked state repairs itself. **The invariant is enforced by code shape, not by discipline.** | [99] |
| T-251 | **A self-recursive property getter corrupts locals rather than crashing** | Recursion without `[RecursiveMethod]` reuses one frame's locals. Worth a lint pass in any codebase using the "setter pushes to shader" idiom, which mass-produces near-identical accessors by copy-paste. | [99] |
| T-252 | **`(CollisionDetectionMode)intValue` crashes the behaviour** | A VM bug — switch on named constants instead. The adjacent enum casts fine. | [12] |

---

*Every constraint claim here is traceable to compiler source shipped in the Worlds SDK you already have.
Read the source rather than trusting this document, and report any error found here.*
