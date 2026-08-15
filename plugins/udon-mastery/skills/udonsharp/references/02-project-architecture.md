# 02 — Project architecture

How to organise a world's Udon layer when you have no interfaces, no generics on behaviours, one
inheritance slot, and a boundary cost that punishes chattiness.

---

## Contents

- [1. How many programs?](#1-how-many-programs)
- [2. Abstraction without interfaces](#2-abstraction-without-interfaces)
- [3. Names are the type system, and nothing checks them](#3-names-are-the-type-system-and-nothing-checks-them)
- [4. Visibility is four ABIs](#4-visibility-is-four-abis)
- [5. The `COMPILER_UDONSHARP` seam](#5-the-compiler_udonsharp-seam)
- [6. Shipping a package](#6-shipping-a-package)
- [7. Initialisation and ordering](#7-initialisation-and-ordering)
- [8. Two architectures worth copying wholesale](#8-two-architectures-worth-copying-wholesale)

---

## 1. How many programs?

The default answer is **fewer than you think**, because an intra-behaviour call is a label jump and a
cross-behaviour call is four externs ([01](01-extern-economics.md)).

**`partial class` is the tool that makes this bearable.** It compiles (Roslyn merges partials before
UdonSharp sees the type), and it is proven in production at scale: a 1,300-line drawer split across 13
files, one per shape family; a media-player manager across 7; a network serialiser across 3.

The convention that makes it composable: each part declares its own fields under a `[Header]` and a
`StartX()` / `UpdateX()` / `OnDestroyX()` triple, and the root file's real `Start`/`Update`/`OnDestroy` fan
out to them. Each part owns its lifecycle without any of them declaring `Start` twice.

```csharp
// ShapeDrawer.cs
[DefaultExecutionOrder(-1)] [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
public partial class ShapeDrawer : UdonSharpBehaviour {
    private void Start() { StartLineDrawer(); StartMeshDrawer(); StartTextDrawer(); }
}
// ShapeDrawer.Line.cs — no base list, no attributes
public partial class ShapeDrawer {
    [Header("Line")] public GameObject linePrefab;
    private void StartLineDrawer() { … }
}
```

Class attributes (`[UdonBehaviourSyncMode]`, `[DefaultExecutionOrder]`) must appear on exactly one part.
`[Header]` ordering in the inspector follows compiler-determined declaration order across parts and is not
stable; don't rely on it.

**Split into separate behaviours only for a structural reason, never a stylistic one.** The structural
reasons:

- **Two sync frequencies.** Udon serialises a behaviour's whole synced set atomically, so update frequency is a *type* decision unless you split.
- **Two retention semantics.** Deltas via `[NetworkCallable]` on one behaviour, the retained snapshot via `[UdonSynced]` on another. See [05](05-sync-architecture-and-late-joiners.md).
- **Ownership granularity.** Authority is per GameObject, so each subsystem on its own object gives N independent ownership domains in one prefab.
- **Frame scheduling.** `gameObject.SetActive` is per-object, so a plugin on its own object can be scheduled in and out of the frame. Isolate anything that genuinely needs `Update` in its own small script so worlds that don't use it pay nothing.
- **A continuation.** A purpose-built behaviour is the closure the language forbids. See [03](03-event-and-callback-architecture.md).
- **A sidecar for one capability.** A `NoVariableSync` behaviour next to a `SyncMode.None` plugin gives it exactly one network-event channel and keeps the network-callable surface to one method.

---

## 2. Abstraction without interfaces

Six substitutes exist. **Pick by whether the call needs typed arguments and whether the set of participants
is known at build time:** typed + known → abstract base; typed + discovered → base plus `GetComponent<T>`;
untyped → string dispatch; known at build time and hot → resolve it at edit time and pay nothing at runtime.

| approach | gives you | costs |
|---|---|---|
| **Abstract `UdonSharpBehaviour` base** | typed parameters, compile-checked calls, real virtual dispatch across programs | your one inheritance slot; **every empty virtual is emitted into every subclass program** |
| **`GetComponent<TBase>()` as a type filter** | typed arguments across a dynamically discovered boundary, which `SendCustomEvent` cannot give you | the base-class cost, plus a `GetComponent` that is itself expensive |
| **String dispatch (`SendCustomEvent`)** | language-agnostic (works from UdonGraph/CyanTrigger), zero declaration cost, no inheritance | no arguments, no compile checking, four externs per call |
| **Duck typing by symbol probe** | zero coupling; works on programs you did not compile against | strings, and a probe per check |
| **`Component[]` / untyped registry** | heterogeneous storage when the contract is a string anyway | the container type is irrelevant, so nothing is checked |
| **Edit-time symbol-table injection** | a plain serialized reference at runtime: **zero** runtime cost | build tooling ([11](11-editor-time-tooling.md)) |

Notes that matter when choosing:

- **The abstract base *is* the ABI.** Base-class-first symbol layout plus inherited symbol counters is what makes cross-program virtual dispatch work at all. Where it applies, virtual dispatch is *strictly better* than `SendCustomEvent`: typed parameters, no strings.
- **Base-class granularity is a program-size decision**, because the tax is per consumer. Ship several differently-sized bases (40 / 5 / 2 / 1 virtual members) off one publisher rather than one fat base.
- **`virtual`-with-a-default-body, not `abstract`,** makes adding a member non-breaking and lets a consumer package compile standalone.
- **`sealed override`** narrows an inherited ABI; `private protected virtual` gives an overridable hook **without exporting an Udon entry point**: access modifier as a security boundary.
- **An empty abstract behaviour is a cost-free type tag**: no members, so no dispatch cost, but usable for `[CustomEditor(typeof(T), true)]` or as a `GetComponent` filter.
- **Consider spending no inheritance slot at all.** For a small or heterogeneous subsystem, `Component[]` + string dispatch, `GetComponents` + string with zero registration, and edit-time injection all leave the slot free for something that needs it more.

Duck-typing primitives worth knowing:

- `GetProgramVariableType(name) == null` is an **existence probe**: the closest Udon has to "does this object implement X?".
- `GetUdonTypeName().Split('.')` gives runtime type identity; `GetUdonTypeID<T>()` folds to a compile-time constant and makes a string-keyed type registry rename-safe.
- **`SendCustomEvent` on an unexported name is a silent no-op**, which is what makes participation cost zero declaration, and also what makes the whole scheme unverifiable.
- `GetType() == typeof(BoxCollider)` works for *Unity* types (exact match only, so subclasses fall through); `typeof` on a **user** type does not.

---

## 3. Names are the type system, and nothing checks them

A framework can carry three product families, no base class, 32 duplicated method names and a variable-name
contract, with the directory tree as its only compatibility documentation. That works, and it is the shape
you get when you refuse the inheritance slot, but it is only defensible with one discipline:

**Strings at runtime, `nameof` at author time.** Put the wiring code in an assembly that *references* the
Udon assembly, so every name is `nameof(Type.Member)` and a rename becomes a compile error in the wiring
rather than a runtime no-op. Add `-warnaserror+` to that assembly's `csc.rsp`. **Adopt the string ABI and
the reference-plus-`nameof` discipline together, or not at all.**

**Encode the audience in the event-name prefix.** `_L_` local, `_O_` owner, `_G_` global, `_P_` passenger,
so an extension reads its execution context off the event name and contains almost no `if (IsOwner)`. A
coarser `ALL_`/`OWNER_` split plus a per-handler self-check is the same idea. And because the routing key is
*data*, you can virtualise a scope by rewriting the name: `Replace("O_PilotEnter", "P_PassengerEnter")`
gives a sub-scope with no parameter on any listener.

---

## 4. Visibility is four ABIs

| declaration | serialized | Udon-exported | network-callable | notes |
|---|---|---|---|---|
| `public` field | yes | yes | — | inspector-visible; costs a serialized slot |
| `[NonSerialized] public` field | no | yes | — | **the correct default for runtime state** |
| `internal` / `private` field | no | no | — | **still reachable by `SetProgramVariable`**: name-based lookup ignores C# accessibility |
| property | — | no | — | deliberately invisible to the string ABI |
| `public` method | — | yes | yes unless `_`-prefixed | 0-arg methods keep their source name; built-in events must never be renamed |
| `_`-prefixed public method | — | yes | **no**, unless it also carries `[NetworkCallable]` | a real safety convention, not a lock |

`[SerializeField] private` + `[HideInInspector]` + `internal` is the combination for **machine wiring**:
invisible to the designer, writable by build tooling, reachable by `SetProgramVariable`, out of the public
API surface.

---

## 5. The `COMPILER_UDONSHARP` seam

The structural idea to adopt first. Covered in [00 §4](00-mental-and-cost-model.md#4-if-is-the-master-key-and-there-are-two-defines);
the architectural consequences:

**One source file, two base classes.** Fork the *class declaration line itself*, leaving one unmatched
brace on each side of the `#else`. The obvious factorings (shared abstract base, partial split) both fail
because *the base type* is what differs.

```csharp
#if UDONSHARP
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class VolumeInstance : UdonSharpBehaviour
#else
    public class VolumeInstance : MonoBehaviour
#endif
    { /* one shared body */ }
```

**`using` aliases erase the API difference.** `using GlobalShader = VRC.SDKBase.VRCShader;` versus
`= UnityEngine.Shader;`. The body then has *no conditionals at all* across ~20 call sites. A wrapper
method per API would cost a call plus heap symbols on per-frame paths; an alias costs nothing because
Roslyn erases it. It unifies calls with **identical signatures and nothing else**, so expect partial
mileage: VRChat's `SetGlobalTexture` overload has a different parameter list from Unity's and no alias can
bridge that.

**A no-op attribute shim deletes every remaining `#if`.** Supply a 3-line `UdonSyncedAttribute` or
`FieldChangeCallbackAttribute` under the inverse guard: attributes are name-resolved and can be inert, so
`[FieldChangeCallback(nameof(X))]` compiles in the MonoBehaviour build too, and you never `#if` a field.

**Then push everything you can to the editor side.** `FindObjectsOfType`, LINQ, `OrderByDescending`, mesh
inspection, `AssetDatabase`, `throw`, file IO all belong in an `[ExecuteInEditMode]` `MonoBehaviour` that
writes results straight into the U# behaviour's serialized fields. Done properly the shipped Udon program
is a few hundred lines that transform a prefix of an array and upload globals. **Choose the split point by
mutability, not by convenience**: anything that can only change in the editor is computed there and
serialized.

Two traps:

- **A `#if`-guarded field breaks the play-mode proxy** (U# reflects over *every* instance field, including non-serialized private ones). Park editor-only state in a `static readonly ConditionalWeakTable<TBehaviour, EditorState>` and reintroduce the field *names* as forwarding properties.
- **In editor Play mode both the proxy and the real Udon behaviour execute.** For anything writing global state the proxy's stale copy clobbers what Udon just uploaded, invisible outside the editor. Guard with `Application.isPlaying && GetComponent("VRC.Udon.UdonBehaviour") != null`, using the *string* overload so your runtime asmdef need not reference the SDK assembly.

---

## 6. Shipping a package

- **`defineConstraints` + `versionDefines` with an empty expression.** An empty version expression means "any version", i.e. *define this symbol iff the package is installed at all*, so an assembly self-gates on package presence with no project settings involved. Layer `overrideReferences: true` plus a `precompiledReferences` allowlist on top: that turns "this code must stay Udon-compilable" into a **csc-enforced build constraint** rather than a review convention, and csc's errors are far better than UdonSharp's.
- **Note that asmdef `versionDefines` do not reach the U# pass**: rebuild them yourself under `COMPILER_UDONSHARP`.
- **`autoReferenced: true`** on the runtime assembly so consumers need no asmdef edits; `false` on editor assemblies.
- **`[assembly: InternalsVisibleTo("Assembly-CSharp-Editor")]`** lets serialized fields stay `internal`: editor write access, Unity serialization, no runtime API surface.
- **`public static T Get(GameObject)` on the behaviour as the discovery entry point**, rather than telling consumers to `GetComponent`. It centralises future fallback logic, legacy component names and version shims inside the package: the only real versioning lever a type-referenced Udon ABI has.
- **A facade with value-pinned mirrored enums.** Declare the public enum's members *from* the internal ones (`Hole = Internal.AddLight.Hole`) so the cast is provably correct and an internal reordering becomes a **compile-time event in the public API file**, where a hand-written `switch` map compiles fine while silently going wrong.
- **Gate an optional dependency down to the field, not the file.** Guard the foreign-typed field and the implementation; leave the class, its settings and its enums outside, so scene references and serialized settings survive an install/uninstall. Removing the type orphans every reference in the scene.
- **A generated forwarding include** (`Assets/…/X.cginc` containing one `#include "Packages/…/X.cginc"`) gives third-party shaders a stable path forever while the real file moves, and survives `.unitypackage` installs. The same idea one level up: **pin one stable identifier and derive everything else from it**: a script's own GUID resolved with `AssetDatabase.GUIDToAssetPath` locates every sibling asset regardless of install method.
- **Remove your scripting defines when the package disappears.** This is commonly omitted, and a stale define fails the next compile inside someone else's package.

---

## 7. Initialisation and ordering

- **`Start()` re-declared public and idempotent** is an "ensure init" barrier callable cross-behaviour (`queue.Start();`), so initialisation ordering stops mattering.
- **`[DefaultExecutionOrder]` works on a `UdonSharpBehaviour`** (`EmitContext.cs:92-98`, **Worlds SDK 3.10.4**). Use it as a hand-authored, sparsely-numbered global pipeline in which *the unannotated majority is itself a stage*. The lowest legal value is `int.MinValue + 1000000`.
- **Belt and braces when you don't own the dependency.** Carry `[DefaultExecutionOrder(100)]` *and* do the work in `LateUpdate`, so the phase separation holds even if the attribute is ignored. That is the right call whenever the other side's ordering guarantees are not auditable.
- **The real init signal is often a broadcast event, not a lifecycle callback**, and a delayed event by *frames* is the right tool for "after everyone's `Start()`", where a time delay would be a guess.
- **Disabled behaviours never initialise and silently miss sync.** Toggle every pooled object active-then-back at `Start`.

---

## 8. Two architectures worth copying wholesale

**"The Udon program is a dumb carrier."** All authoring logic in an editor `MonoBehaviour`; the runtime
holds finished arrays and an upload loop. See [11](11-editor-time-tooling.md).

**"Udon is an address bus, not a data bus."** Bulk data lives in textures; Udon moves only indices,
pointers and mode flags. Done consistently, a ~4,000-line runtime contains exactly **one** `Update()`, in a
48-line helper. See [09](09-udon-gpu-bridges.md).
