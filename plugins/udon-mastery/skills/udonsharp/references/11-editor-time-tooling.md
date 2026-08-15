# 11 — Editor-time tooling

Editor-time work is where the largest Udon wins are, and also where technique quality varies most widely:
some techniques should always be used, others are dangerous if misapplied. Each section ends with an
**adopt/skip verdict**.

---

## Contents

- [1. The four facts everything rests on](#1-the-four-facts-everything-rests-on)
- [2. Build hooks and their ordering](#2-build-hooks-and-their-ordering)
- [3. Build-time mutation without scars](#3-build-time-mutation-without-scars)
- [4. Injection and dependency resolution](#4-injection-and-dependency-resolution)
- [5. Codegen and bakes](#5-codegen-and-bakes)
- [6. Not dirtying the scene](#6-not-dirtying-the-scene)
- [7. Validation, migration and refusal](#7-validation-migration-and-refusal)
- [8. Reflection and Harmony, done responsibly](#8-reflection-and-harmony-done-responsibly)
- [9. Smaller adoptable items](#9-smaller-adoptable-items)
- [10. How to read an unfamiliar editor codebase](#10-how-to-read-an-unfamiliar-editor-codebase)

---

## 1. The four facts everything rests on

**(a) The C# component you edit is a *proxy*.** The thing that runs is a sibling `UdonBehaviour` with its
own serialized public-variable table. `myBehaviour.field = x` from editor code writes the proxy and is
**silently discarded at build**. Nothing warns you; the inspector even shows the new value, and it is gone
on the next domain reload.

**(b) The correct write target differs by context:**

```csharp
private static void SetUdonProgramVariable(UdonBehaviour ub, string name, object value) {
    if (ub == null) return;
    // Edit/build instances have no live program; Play Mode writes must reach the initialized heap.
    if (Application.isPlaying) ub.SetProgramVariable(name, value);
    else                        ub.publicVariables.TrySetVariableValue(name, value);
}
```

Reach the behaviour with `UdonSharpEditorUtility.GetBackingUdonBehaviour(proxy)`. This is **the single most
load-bearing fact for any editor tooling**.

Two corollaries that bite silently: **a proxy reference stored in a field whose declared type is not a
`UdonSharpBehaviour` is cleared to null at build**, and **you must never re-enable a proxy behaviour**, since
the proxy is bookkeeping rather than a component you own.

Note the connection to [03](03-event-and-callback-architecture.md): `SetProgramVariable` is exactly the
call that fires `_onVarChange_*`, so Play-mode injection reaches the same callbacks runtime writes do.

**(c) A U# reference *is* an `UdonBehaviour`.** A field typed `public MyManager Manager;` holds a backing
`UdonBehaviour` at runtime; the typed C# view is a compile-time fiction. Wrap the *value* in
`GetBackingUdonBehaviour` too, or you silently produce a broken reference with **no error at build or at
runtime**. Non-behaviour references (`Material`, `Camera`, `GameObject[]`) go in as-is.

**(d) The legacy proxy dance, where you still meet it.** `UpdateProxy()` → mutate → `ApplyProxyModifications()`,
with lookups via `GetUdonSharpComponent<T>()` rather than `GetComponent<T>()`. Read-only edit-time code (a
gizmo) needs only the pull half, and `ProxySerializationPolicy.RootOnly` is the cheap policy that avoids
walking referenced behaviours. Wrap every call site in `#pragma warning disable 0618`: these APIs are
`[Obsolete]` and remain the only thing that works for this SDK generation.

> **Verdict: ADOPT, all four.** These are fixed rules rather than optional techniques. Getting (a)/(b) wrong
> produces a world that works in the editor and is broken on upload, which is the worst failure shape available.

---

## 2. Build hooks and their ordering

| hook | fires on | mutations persist? | can abort? |
|---|---|---|---|
| `IVRCSDKBuildRequestedCallback` | upload only (**not** play mode) | **yes — the real scene** | **yes**, return `false` |
| `IProcessSceneWithReport` / `[PostProcessScene]` | upload **and play-mode entry** | no — a throwaway copy | by throwing |
| `IPreprocessBuildWithReport` | upload | n/a | by throwing |
| `[RuntimeInitializeOnLoadMethod]` | play mode | no | `EditorApplication.isPlaying = false` |
| `EditorApplication.playModeStateChanged` | play mode | yes at `ExitingEditMode` — the last moment objects are still the edit-time ones | — |

The rules:

- **`IProcessSceneWithReport` also fires on play-mode entry.** Guard `if (Application.isPlaying) return;` or your pass double-runs.
- **No single hook fires on every path.** Register on **both**: `IVRCSDKBuildRequestedCallback` *and* `IProcessSceneWithReport`, or *and* `playModeStateChanged`.
- **Ordering is a real API.** `callbackOrder = -1` runs before U# bakes proxy fields into the public-variable table; `90` runs immediately before U# compiles, which is where a read-only integrity check belongs; `-1000` runs before essentially everything, which is where import-setting fixes belong; `-10000` and `int.MinValue + 100` are the "claim first" values. These numbers are coupled to UdonSharp's own order and an SDK change moves them silently.
- **Returning `false` from `OnBuildRequested` aborts the upload** with no exception. This is the veto point, and it fires *before* the scene copy, so the scene is still authorable and edits are undoable, which is what turns a validator into a gate.
- **Play mode skips `IVRCSDKBuildRequestedCallback` entirely**, so what runs in play mode differs from what actually uploads, with no visible sign of the gap. Fire it by hand from an `IProcessSceneWithReport`, with a **one-frame latch shared between two unrelated callback interfaces** (`EditorApplication.delayCall += () => ranThisFrame = false`) so a real build cannot double-fire.
- Then you must **suppress every other package's build callbacks** in play mode, or every package's shader lockdown and full recompile runs on every play-mode entry. Match by **simple type name** through `TypeCache`, with no compile-time dependency on the packages being suppressed, and set `__result = true` before skipping, since these callbacks return "may the build continue".
- **One `[InitializeOnLoadMethod]` dispatcher beats thirty.** Unity gives no ordering, no isolation (one throw can leave later ones unrun, obscured by `TargetInvocationException`) and no visibility. A dispatcher over `TypeCache.GetMethodsWithAttribute<T>()` gives deterministic order, per-hook `try/catch` with the inner exception unwrapped, invalid methods *warned about by name* rather than silently skipped, and an `EditorPrefs`-gated timing table.
- **`[InitializeOnLoad]` static constructors fire before the scene is loaded**, so `GetRootGameObjects()` is empty. Defer by exactly one `EditorApplication.update` tick and unsubscribe immediately. And **`-=` then `+=`** makes registration idempotent across domain reloads.

> **Verdict: ADOPT the ordering discipline and dual registration.** **ADOPT the abort-on-invalid gate**: it is
> the cheapest possible defence against uploading a broken world.
> **CONSIDER the play-mode build-parity project** (fire the VRChat callbacks yourself + suppress
> third-party ones): genuinely valuable, and a multi-hook commitment. Adopt an existing implementation
> rather than reinventing it.

---

## 3. Build-time mutation without scars

**The scene the build sees is a copy, so you may destructively canonicalize it.** The reference shape is a
preprocessor with three *ordered* passes:

1. apply authoring data, then **call the real runtime update method once** and `CopyProxyToUdon` the result;
2. create the runtime `Material`s (Udon cannot `new Material(shader)` at all) and inject them plus any hidden camera into the Udon heap;
3. **after** publication, null out every authoring `Texture3D` / atlas / cookie / LUT / shadowmap reference on both proxy and Udon table.

The third pass is the non-obvious one: **serialized references are what pull assets into the build**, so
nulling them post-bake is how a baked-atlas system stops shipping its source textures. Comment the
ordering, because reversing it strips nulls into the Udon table.

**And when the thing you must mutate is a prefab *asset*:** instantiate it into a lazily-created **inactive**
`__PrefabHolder` inside the throwaway scene, memoise original→instance, rewrite the property, and push the
instance onto a work stack so its own references recurse. Unity's own cleanup is the teardown: **a scene is
a legal place to put an asset you want to mutate.** The two alternatives (copy to a temp folder and delete
after; mutate in place and restore) both need a cleanup path that survives crashes. Cost: the built world
carries one inactive copy of each referenced prefab.

**Non-destructive by construction, not by cleanup.** Never snapshot-and-restore the project. Work exclusively
where Unity already throws things away — the build-scene copy, play mode, `HideFlags.HideAndDontSave`
objects, `Library/`, a generated temp package. A restore path means the mutation belongs somewhere Unity
already discards; move it rather than writing one.

**The scene stores intent; the build stores the resolved value.** Sync mode, program references, DI wiring and
derived data: none of it is persisted. On a large scene that is the difference between reviewable diffs and
none, and it is normal to need several dedicated hooks whose only job is stopping something *else* writing
derived state into the saved scene.

**Note the exception**: a design that requires proxy heap values to ship *in the scene asset* must save the
**real scene** rather than use a throwaway copy, hooked to `IVRCSDKBuildRequestedCallback` **and**
`playModeStateChanged`. Know which of the two models you are in before you write the first hook.

> **Verdict: ADOPT "run the runtime at build time" and "null the authoring references".** Between them
> they remove startup work *and* download size, and they need no new machinery.
> **ADOPT the prefab-into-the-throwaway-scene trick** if you have prefab references to patch.
> **ADOPT "intent in the scene, resolved value at build"** as a default posture.

---

## 4. Injection and dependency resolution

**Build-time DI, where the field's declared type is the query**:

```csharp
[SerializeField] private MyThing[] allThings;   // + UdonDiInjectField{ targetField="allThings", registeredName="thing" }
```

Two string-only marker components (`UdonDiRegister{name}` on the provider, `UdonDiInjectField{field, name}`
on the consumer) and one scene pass. **Array-ness of the target field is what selects "one" vs "all"**, so
the same two components express both singleton injection *and* the fan-out subscriber list that normally
forces a hand-maintained array. Make ambiguity a hard build error. Runtime cost: **zero**, since the built
program has an ordinary serialized reference, indistinguishable from a hand-drag.

**Convention-based DI by scanning the compiled symbol table** is the lighter variant: read
`SerializedProgramAsset.RetrieveProgram().SymbolTable.GetExportedSymbols()`, match a name (`"audioLink"`),
and write via `publicVariables.TrySetVariableValue` on the **backing** behaviour, constructing the slot
with `Activator.CreateInstance(typeof(UdonVariable<>)…)` if it is absent.

**`[Singleton]` on the manager *type*, with zero annotation at the use site**, keyed off the *field's*
declared type, so marking one class retroactively auto-wires every existing reference, and duplicate
instances become a build error, an invariant a runtime singleton cannot enforce in Udon.

**`[InjectUnityAction("onClick")]`** declares a UnityEvent subscription *in the subscriber, next to the
handler*, so renaming the handler renames the wiring. The build pass finds a **sibling component field
whose name equals the string** and derives from `UnityEventBase`, then emits exactly the persistent listener
a human would have dragged, via `Delegate.CreateDelegate(typeof(UnityAction<string>), backingUdonBehaviour,
SendCustomEvent)` + `UnityEventTools.AddStringPersistentListener`. Matching **by field-name string rather
than by type** means one attribute handles `Button.onClick`, `Toggle.onValueChanged` and any third-party
event with no per-type support code.

**`nameof` across an assembly reference is what makes a string ABI safe.** Put the wiring in an editor
assembly that *references* the Udon assembly, so every name is `nameof(Type.Member)` and a rename is a
compile error in the wiring rather than a runtime no-op. Add `-warnaserror+` to its `csc.rsp`. **The
architecture is the point, not `nameof` itself**: wiring in the behaviour's own `Start()`, or in a build
script with no reference, forfeits it.

**`[RunOnBuild]` on an *instance* method is a build-time `Start()`** whose results freeze into serialized
fields; expand it to derived types, because abstract-base polymorphism is forced on you. The house-wide
generalisation is an `InitializeOnBuild()` convention: the behaviour owns its init logic but executes it at
build, and inside `#if !COMPILER_UDONSHARP` it may use LINQ and `List<T>`.

**The arithmetic behind all of this**: `GetComponent<TUdonSharpBehaviour>()` lowers to
`GetComponents(typeof(UdonBehaviour))` plus a string-keyed `GetProgramVariable` heap probe and a boxed-long
compare **per component**. Build-time injection is arithmetic, not taste.

> **Verdict: ADOPT.** This is the highest-leverage editor category there is: it deletes runtime
> registries, `GameObject.Find`, and every "did I forget to drag this?" bug, and costs nothing at runtime.
> Start with `[Singleton]`-style type-keyed injection; add the marker-component form when you need
> fan-out.

---

## 5. Codegen and bakes

- **Generate both sides of a contract from one schema.** Emit the HLSL memory map *and* the wall of zero-argument U# accessors from one header. A runtime offset table would be smaller source but worse Udon (an array-index EXTERN and a heap symbol per lookup, and no constant folding), and, decisively, generating both sides removes the one fatal bug class: a silent Udon/HLSL memory-map skew. The alternative accumulates empirical correction tables; shipped code exists with five hard-coded correction ranges and a comment saying nobody knows why they are needed.
- **Rewrite a checked-in `.cginc`'s `#define`s in place** from scene analysis, line-oriented rather than whole-file, so user edits survive and the generated state is reviewable in a diff. See [10 §6](10-vrc-shader-toolbox.md#6-shipping-a-header-other-people-include).
- **Hijack Unity's own lightmapper as a general GI service.** `Experimental.Lightmapping.SetAdditionalBakedProbes(id, positions)` registers voxel centres as extra probes; the user's normal "Generate Lighting" evaluates them; `GetAdditionalBakedProbes` returns SH **plus a validity channel** (reuse it as the "inside geometry" signal rather than re-deriving one). **Namespace the ID space** (`0x4C560000` = ASCII `'L','V'`) so two tools doing the same trick cannot collide, and allocate IDs **monotonically, never reused**, so a readback cannot pick up a previous bake's results.
- **One implementation, three execution environments, joined by the global uniform namespace.** Have the probe-bake **compute shader `#include` the same header as the world's fragment shaders**, drive it with **exactly the global names the Udon runtime uploads**, and feed it from the runtime's own packed buffers. Satisfy unused sampler slots the shared include still references with cached 1×1 `HideAndDontSave` dummies and zeroed counts. *What the baker computed and what the world renders cannot disagree by construction.*
- **Design every runtime routine with an injectable "do it all now" configuration.** The editor bake should *be* the runtime behaviour with its frame-amortisation knob at maximum (`FacesPerFrame = 6`), editor-quality settings, and the runtime's own "this is inactive, skip it" guards defeated, all restored in a `finally`. **Accept this constraint up front; it is not something to retrofit.**
- **…and the reverse: have the editor *read* the runtime's packed buffers** rather than reimplementing the packing. Both directions exist to keep exactly one implementation.
- **Serialized fields as continuation state for a multi-phase editor operation.** A bake spans `Lightmapping` callbacks and can cross a domain reload; `try/finally` loses everything and leaves the project **permanently mutated** (wrong ambient colour, wrong material GI flags). Make every restore value a `[SerializeField]` under `[Header("Bake Cache (do not edit!)")]` plus a `bakeInProgress` latch, so **the scene file is the operation's journal** and the next domain load can finish the rollback. Ship a manual reset script too.
- **Editor coroutine as a `Task` scheduler.** An `IEnumerator` is the scheduler; `Task.Run`/`Parallel.For` are the workers. Three load-bearing details: **marshal by hoisting, not locking** (read Unity objects on the main thread into plain arrays and capture only those — there is no `SynchronizationContext` to post back to in edit mode); a `WaitForTask` helper that **rethrows `task.Exception.InnerException` on the coroutine's thread** so a worker fault is an ordinary editor error rather than a swallowed `AggregateException`; and the whole body inside `try { … } finally { cancel; cleanup; }`, which — **because this is an iterator — runs when the enumerator is *disposed***, including on every `yield break` and when the driver simply stops enumerating. That converts ~10 scattered error paths into single-line `yield break`s.
- **Editor-time HTTP with a scene-scoped hashed cache** turns a "remote playlist" into a build-time feature disguised as a runtime one.
- **Edit-time "save state"**: the same camera + `ReadPixels` channel used for runtime readback is, at edit time, a general "serialise GPU state to an asset" pipeline. The limit case is shipping a pre-booted VM image as a PNG.

> **Verdict: ADOPT "generate both sides from one schema"** wherever a memory layout is shared between C#
> and HLSL — the alternative accumulates empirical correction tables, and there is shipped proof of it.
> **ADOPT the injectable one-shot configuration** as a design habit for anything amortised.
> **CONSIDER the lightmapper hijack** only if you genuinely need baked data at arbitrary points; it rests
> on an `Experimental` + `[Obsolete]` API that has moved between Unity versions.

---

## 6. Not dirtying the scene

- **`EditorJsonUtility.ToJson` before/after fingerprint**: snapshot, sync, compare, and only then `SetDirty`. Exact, needs no per-field discipline, and cheap relative to the inspector repaint it accompanies.
- **`FullSetDirty`**: `SetDirty` alone loses injected values on prefab instances. Pair with `PrefabUtility.RecordPrefabInstancePropertyModifications`: **the two lines that stop bakes evaporating**.
- **`ObjectChangeEvents.changesPublished` as the edit-time sync driver.** The typed change stream gives exactly the events proxy synchronisation needs — including reparenting (queue *three* objects: the moved one and both parents) and prefab-instance updates, which `OnValidate` cannot see at all, and without polling every component every editor frame. Three guards are the real content: **re-entrancy** (the flush writes to the components whose events it consumes, so without an `_isFlushing` guard the updater feeds itself forever); **busy-state re-queue, not drop** (`isCompiling || isUpdating || Undo.isProcessing` → retry; play-mode entry → `Clear()`, because Play mode owns the heap); and **two triggers for one batch** — also flush from the Scene View render path, which avoids a stale camera frame while keeping `delayCall` as the fallback when no Scene View is visible.
- **`OnWillSaveAssets` as a scrub gate**, the *last* point before serialization, covering every way a save can be triggered. Two-phase, because they are genuinely different storage locations: null the derived fields on non-prefab-instances, and **prune `PrefabUtility.GetPropertyModifications` on prefab instances** (setting a field to the prefab's value does *not* clear the override record). Two traps: returning anything but the full input array **cancels those saves**, and `SetPropertyModifications` wipes the prefab's `hideFlags`, so restore them yourself.
- **Move a serialized field out-of-band so it stops appearing as a prefab override.** U#'s Odin serializer stores a prefab reference inside *every instance*, so essentially every U# prefab instance carries a junk override. Keep the value in a side table under `Library/` (machine-local, regenerable, never committed) and **materialise the field for exactly the duration of one serialization callback** — a Harmony prefix restores it, `PatchMode.Finalizer` pulls it back out and clears it even if Odin throws.
- **Stop a third-party `[ExecuteInEditMode]` component dirtying the scene**: Harmony-prefix `Update`/`OnEnable` on **every type in the offending assembly** with one shared argument-less guard, then **replay** the suppressed work reflectively inside `IProcessSceneWithReport`. Even the packages that build this ship it disabled by default; treat that as the verdict.
- **Detect editor Duplicate** by reading `Event.current.commandName == "Duplicate"` inside `OnValidate`, since Unity has no `OnDuplicated`, and `OnValidate` otherwise gives no indication why it fired.
- **An `AssetPostprocessor` as an *invalidation source***: ignore the argument arrays entirely and treat any refresh as "my derived state may have been silently rolled back". Defer the rebuild to the next render so a 500-file reimport costs one rebuild.
- **`EditorApplication.playModeStateChanged` at `EnteredEditMode`** to clear global shader properties, which survive play mode.

> **Verdict: ADOPT the fingerprint, `FullSetDirty`, and the `OnWillSaveAssets` scrub.** On a large scene
> they are the difference between reviewable diffs and none.
> **CONSIDER `ObjectChangeEvents`** if you have edit-time preview to keep in sync; it is the correct API
> and the re-entrancy guard is mandatory.
> **SKIP the Harmony-based suppression of third-party lifecycle methods** unless you are shipping a
> package to strangers.

---

## 7. Validation, migration and refusal

- **A three-part definition of "this U# component is intact"**: the backing exists, `backing.gameObject == proxy.gameObject` (not stolen from elsewhere), and `GetUdonSharpBehaviourType(backing) == proxy.GetType()` (exact program type), plus a reverse sweep for orphaned backings. **Three failure axes, none of which produce an error**; they produce a world that silently does nothing. Run this predicate from the build gate.
- **Use the same predicate in three roles**: build gate, migration preflight, and a post-`AddComponent` assertion, so there is one definition in the package.
- **A migrator that guesses is worse than one that stops.** Treat `Length != 1` as fatal everywhere; refuse prefab instances outright (UdonSharp cannot safely create a new backing behaviour as an added override on a prefab instance — asserted, **unverified**); prefer **physical co-location over serialized links**, which may be stale after prefab overrides; count and report blocked items, never repair them. Network-ID conflicts want the same treatment: classify them, refuse to auto-fix the class where guessing destroys data, and let one unsafe item veto the whole batch.
- **All-or-nothing creation with an explicit rollback.** The preflight proves *none of these proxy types existed on any of these objects*, which is what makes "roll back by deleting **everything** of these types" correct, and it is the only formulation that survives `AddComponent` throwing *after* it has already attached something. Run the destructive step only after `CopyProxyToUdon` **and a re-read verification that the registration persisted**.
- **Reading the scene's raw YAML to recover fields the class no longer declares.** Unity **drops serialized values whose field is gone** and `SerializedObject` reflects the current type — only the `.unity` text still has them. Parse once per scene (cached), keep `!u!114` documents containing a known legacy field prefix, key by file ID, and match live components with `GlobalObjectId.GetGlobalObjectIdSlow`. Read each value under **two names** (original and a `_legacy…` shim) so intermediate versions are recognised. The correctness gate is the sharp part: **`savedYamlIsAuthoritative = !scene.isDirty`** — never replay stale saved YAML over unsaved proxy edits after a domain reload. (`[FormerlySerializedAs]` only helps if you knew about the rename before the old version shipped.)
- **Retype a component in place by rewriting `m_Script`** through `SerializedObject`: keeps the fileID, so every inbound reference survives, with `[FormerlySerializedAs]` carrying the data.
- **A serialized "migration considered" flag** distinguishes "user set false" from "never seen"; generalise it to a monotonically increasing schema-version int.
- **Deferred dirty-marking with a `dry` flag threaded through every mutation** gives one code path for "fix" and "report".
- **`UdonSharpUndo.AddComponent<T>`** is the only correct way to add a U# behaviour from editor code: plain `Undo.AddComponent` adds only the proxy, and the failure appears only in an uploaded world.
- **Interactive abort with a persisted opt-out**: a three-button modal whose "don't show again" lives in a **project asset** (so it travels with the repo) rather than `EditorPrefs`, and which can open the fixing tool.
- **An exception type carrying its own dialog and abort decision**, with `TargetInvocationException` unwrapped.

> **Verdict: ADOPT the intactness predicate and the build gate.** They cost almost nothing and catch the
> failure class that is otherwise undiagnosable.
> **ADOPT "refuse rather than guess"** as the migrator's whole philosophy.
> **CONSIDER YAML recovery** only when you have actually removed a field and need the data: it is
> text-format-only, ties you to Unity's exact emitter formatting, and needs the `isDirty` gate.

---

## 8. Reflection and Harmony, done responsibly

Any nontrivial build tooling eventually reaches into unversioned internals. When it does, copy this discipline
wholesale:

- **Make every reflection target a `static readonly` field of a nested `private abstract class Reflection : ReflectionHelper`.** `IsReady<Reflection>()` reflects over that class's own static fields and returns false if any is null, empty, or an errored patch; every hook's init begins `if (!ReflectionHelper.IsReady<Reflection>()) return;` so **a failed lookup degrades the feature to *absent*, never to a crash**.
- One global pass over `TypeCache.GetTypesDerivedFrom<ReflectionHelper>()` collects the **fully qualified field paths** of everything that failed and emits **one aggregated warning naming exactly what broke**, instead of N runtime exceptions at arbitrary later times. `[ReflectionHelperOptional]` excludes targets that legitimately may not exist.
- **The pattern inverts where the reflection lives**: hoisting lookups into a declarative, enumerable manifest is what makes "is this feature viable on this SDK?" a single generic call.
- **Per-site null guards, a second known signature for an older SDK, `UnpatchAll` before `PatchAll`**, and closure classes found by mangled-name substring.
- **A re-entrancy latch synthesises "around" advice from a prefix**: return `true` if already wrapping, else open the wrapper, set the flag, invoke the original through the cached `MethodInfo`, clear in a `finally` (essential — an exception otherwise leaves the latch set and permanently disables the patch), return `false`. Two sibling shapes: a **depth counter** using `PatchMode.Finalizer` to decrement (Finalizer runs even when the original throws; Postfix does not), and the one-frame `delayCall` flag.
- **`TypeCache` over `AppDomain.GetAssemblies()`**: Unity's pre-built index, free where an `AppDomain` walk costs seconds per reload. `method.Name.Split('.').Last()` handles **explicit interface implementations**, whose reflected names are fully qualified and invisible to a direct `GetMethod` lookup.
- **Compare a private enum by `Enum.GetName`, never by value.**
- **Feature-detect a dependency by reflected *field presence***. Note the sharp case where the detection result changes the **data format** rather than a capability flag, so the same predicate must be consulted at both bake-configuration and bake-interpretation time or you get silently mis-rotated output.
- **Invalidate-then-poll-for-recreation**: when you must stamp a value onto an object the host creates and there is no creation event, deliberately null the host's cache to guarantee a fresh object appears inside the window you are watching.
- **Decoy sinks** for an uncooperative writer: hand it a fake `SerializedProperty` on a `HideAndDontSave` `ScriptableObject`, or **poison its own cached `FieldInfo`** so writes land in a harmless string: interception *without any patch at all*. A decoy is total by construction where suppression must enumerate every path.
- **Every invasive mechanism gets three guards**: a user-facing menu kill switch, an `IsReady<>()` viability check, and a backstop that catches what the primary misses (if a patch silently fails, the save hook still strips the changes back out) — **plus a full uninstaller**. What makes it safe to relocate the SDK's assets and virtualise its fields is that a reversal path exists and is exercised. Write it as a *reconciler* — declare the target layout; it creates, moves and destroys to match — so "run it again with a different target" is a valid uninstall.
- **Untyped serialized-property walks beat knowing the schema.** Iterate `IterateFast()` looking only at `ObjectReference` and know not a single field name, which is why such passes work on third-party Udon programs.

> **Verdict: ADOPT `ReflectionHelper` and the three-guard rule** if you write *any* reflection-based
> tooling. It is twenty lines and it converts "tooling exploded after an SDK update" into one actionable
> warning.
> **CONSIDER Harmony patches** for genuine SDK bugs, with the discipline above.
> **SKIP IL-transpiling every user assembly to virtualise a field.** Know the *self-exclusion* constraint it
> teaches (the patch must have exactly one hole, its own assembly, or there is no way left to read the ground
> truth), but do not build it.
> **SKIP rewriting third-party `.cs` files on disk.**

---

## 9. Smaller adoptable items

- **`MonoBehaviour, IEditorOnly` + `hideFlags DontSaveInBuild`** = editor data with genuinely zero shipped cost: a build-stripped **annotation channel** with prefab overrides, Undo and hierarchy search.
- **Rich edit-time schema, one `int` at runtime.** Put the whole model (`struct`, `string[]`, `ScriptableObject`, custom inspector) behind `#if UNITY_EDITOR`; the runtime carries a GUID string and an index. The reflex when told "no structs" is to flatten into parallel arrays *in the behaviour*, which serializes the schema into every instance's Udon heap.
- **Edit-time WYSIWYG by calling the behaviour's own runtime push method**, choosing an inert variant outside play mode: **preview implemented as an argument to the production method**, so preview can never drift from runtime.
- **Driving a *live* Udon behaviour from a custom inspector**: `CopyProxyToUdon(All)` → `backingBehaviour.SendCustomEvent(nameof(M))` → `CopyUdonToProxy(All)`. **`SendCustomEvent` on the backing behaviour is how editor code invokes Udon**, since a plain C# call runs the proxy rather than the program, and U# performs its own recursive proxy serialization *after* the inspector returns, so the queued variant defers the whole round trip to `delayCall`.
- **An inspector button that bakes must flush, bake, then re-acquire its `SerializedProperty`s.** `ApplyModifiedProperties()` in the *middle* of `OnInspectorGUI` looks wrong and is required; re-calling `FindProperty` is the step most implementations miss, and its failure looks like an unrelated UI glitch.
- **A custom inspector that *writes* scene state on first draw and then recurses to redraw** — "inspector as initialiser of last resort".
- **Deterministic ordering via a scene-path + zero-padded sibling-index sort key**, because `Resources.FindObjectsOfTypeAll` order is unspecified and any budget divided *in iteration order* then differs between machines. It also returns components inside loaded **prefab assets**, so filter explicitly.
- **`Resources.FindObjectsOfTypeAll` + `hideFlags != None` + `!IsPersistent(transform.root)`** is the correct "every object in every loaded scene" walk.
- **An in-scene preview with no GameObject**: `Camera.onPreCull` filtered to Scene View cameras, issuing `Graphics.DrawMeshInstanced(..., camera,...)` with an explicit camera argument. **Structurally incapable of being saved, uploaded, or deleted by a user**, where a hidden GameObject leaks into scenes and prefabs. Dispose from `beforeAssemblyReload` or you leak one `HideAndDontSave` object per recompile.
- **Per-camera scoping of a process-global uniform** via a `Stack<float>` pushed in `onPreCull` and popped in `onPostRender`: **the pre/post-render callbacks *are* a scope**, and a stack rather than a saved field is what makes nested camera renders correct.
- **Custom Scene View camera modes driven by replacement shaders reading the live Udon globals**, so the visualisation *is* the runtime state with no second data path. Corollary: **any state published via `VRCShader.SetGlobal*` is automatically inspectable this way, for free**.
- **Recover `Library/LastBuild.buildreport` into `Assets/`** for a per-asset size breakdown: group by `sourceAssetPath` and sum, or shared assets are double-counted. And `TextureUtil.GetStorageMemorySizeLong` (build size) vs `GetRuntimeMemorySizeLong` (VRAM) are **two different numbers**; optimising one can worsen the other.
- **Lint findings as data objects carrying their own auto-fix `Action`**, with `IEquatable` group merging and a three-way dialog (fix / cancel / bypass).
- **Three tiers of "don't ask me again"**: `SessionState`, project-namespaced `EditorPrefs`, and `DialogOptOutDecisionType` sharing one key; and **two persistence tiers as a "once per `Library` lifetime" latch** (`SessionState` + a canary file in `Library/`). **Choose the storage location for what destroys it.**
- **Scripting defines do not rebuild Udon programs**: call `UdonSharpProgramAsset.CompileAllCsPrograms` as well as `CompilationPipeline.RequestScriptCompilation`. Install defines idempotently (`definesChanged |= set.Add(x)`; writing unconditionally causes a domain-reload loop), and **the hard part is *removing* stale ones**.
- **A script's own GUID as the anchor for locating sibling assets**: O(1), exact, survives moves, renames and install method, where `FindAssets` is slower and ambiguous.
- **A self-deleting marker component plus an extension method declared in the Editor assembly on a Runtime type** gives build-time behaviour attached to a runtime component with **no `#if` in the runtime assembly**.
- **Custom inspectors switchable off by a scripting define**: a runtime flag cannot un-register a `[CustomEditor]`; only conditional compilation can.
- **Build tombstone**: an empty `GameObject("MyTool ran!")`, `MoveGameObjectToScene`d into the *processed* scene (`new GameObject()` lands in the *active* one). Puts the evidence in the artefact.

---

## 10. How to read an unfamiliar editor codebase

**Grep is not a coverage proxy.** Searching a package's editor files for `UdonSharpEditorUtility` /
`publicVariables` / `SetProgramVariable` and skipping the ones that do not match will reliably miss the
bake architecture, which is where the real work lives. **The highest-value build-time work is not
U#-API-shaped**: compute bakes, scene-YAML migration and edit-time precomputation produce ordinary
serialized data that some *other* code later uploads.

> **Judge an editor file by what it produces, not by which API it calls.**
