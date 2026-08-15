# 12 — Debugging & introspection

No debugger, no breakpoints, no exceptions, no stack traces, no test runner. Build these instead.

---

## Contents

- [1. The heap is a flat, string-keyed namespace](#1-the-heap-is-a-flat-string-keyed-namespace)
- [2. Knowing what actually exists](#2-knowing-what-actually-exists)
- [3. Detecting failure](#3-detecting-failure)
- [4. Profiling](#4-profiling)
- [5. Getting data out](#5-getting-data-out)
- [6. Visualising](#6-visualising)
- [7. Testing](#7-testing)
- [8. Platform bugs worth knowing (they will look like your bug)](#8-platform-bugs-worth-knowing-they-will-look-like-your-bug)
- [9. Comment the *why*, not the what](#9-comment-the-why-not-the-what)

---

## 1. The heap is a flat, string-keyed namespace

**Public variables are not special.** The Udon heap is externally readable and writable by name, and U#
itself puts non-public symbols in the same space: `__refl_typeid`, `__refl_typename`, `__gintnl_*`,
`__gintnl_SwitchTable_*`, `__gintnl_RetAddress_*`.

That gives you:

- **Type identification of an arbitrary `UdonBehaviour`.** `__refl_typeid` / `__refl_typename` tell you which U# type a behaviour is running, and cleanly reject graph programs, which have neither.
- **A general side channel.** `SetProgramVariable` on any behaviour writes a named slot; `GetProgramVariable` reads one. This is the argument channel ([03](03-event-and-callback-architecture.md)), the DI channel ([11](11-editor-time-tooling.md)), and the introspection channel, all at once.
- **Self-describing behaviours**, if you emit the metadata. A Harmony prefix on `MethodSymbol.Emit` can add `__refl_argnames_<export>`, `__refl_argtypes_<export>`, `__refl_returnname_<export>` and `__refl_returntype_<export>`, which works on *third-party* programs, and gives you return values out of `SendCustomEvent` (valid only immediately after the call).
- **Compile-scoped dynamic variables**, if you go further: smuggle compile-time state through the compiler's own symbol table as a fake heap symbol. A **user attribute on a U# method is visible at emit time and can steer codegen**.

**But prefer baking the symbol table.** `SerializedProgramAsset.RetrieveProgram()` → `IUdonSymbolTable` at
`[PostProcessScene]`, serialized into `string[][]` / `Type[][]`, gives a **full runtime inspector with zero
runtime reflection**. (`Type[][]` and jagged arrays serialize on a behaviour because U# uses its own
serializer.) A live variable editor reading and writing any field in the world then costs **four EXTERNs
over build-time-baked data**.

---

## 2. Knowing what actually exists

- **`UDONSHARP_DEBUG` → the Node Definition Grabber** dumps every exposed EXTERN, which is how you build an authoritative address table instead of guessing at the whitelist. It also emits `.uasm`, which is where the instruction counts in [01](01-extern-economics.md) come from.
- **Read `UdonBehaviour.cs`'s event registrations** to see which Unity messages actually fire, and grep it for `RunEvent("_...")` to find entry points U# does not expose.
- **`GetProgramVariableType(name) == null`** is the runtime existence probe.
- **A generated document rots exactly like a hand-written one.** Shipped ABI docs exist that were produced by a runtime probe and list 77 events against 172 actually emitted. Re-run the probe rather than relying on its checked-in output.

---

## 3. Detecting failure

**The VM disables a behaviour that faults.** So:

```csharp
// poll at 1 Hz
if (!watched.enabled) { /* it crashed */ }
```

**A crash watcher is the only fault detector available in a VM with no exceptions, and it requires no
cooperation from the watched code.** Everything else is inference:

- **`!gameObject.activeInHierarchy` inside `OnEnable`** detects the Udon "OnEnable ran but OnDisable never will" bug, since that state is unreachable in stock Unity, so its being false is a reliable signature.
- **A contradiction is an event**: "I received a state update for an object I think I own" is ownership theft.
- **Guard by round-trip**: re-derive the input from the value you just computed and require *exact* equality before engaging a fast path. A self-validating derivation that refuses to activate when its assumption is false: the right substitute for the exceptions Udon lacks.
- **Use `Utilities.IsValid` in a `while` condition**, where a plain null check is reported not to work.

---

## 4. Profiling

**The `[DefaultExecutionOrder(±1e9)]` bracket.** Two behaviours, one at `int.MinValue + 1000000`, one at
`int.MaxValue`, each holding a `Stopwatch`, measure **all Udon in the world per phase**, including
`PostLateUpdate`, with **zero cooperation from anything being measured**. Reset keyed on `Time.frameCount`;
`FixedUpdate` accumulates (`+=`) because it may run 0..n times per frame, while the others assign.

Other pieces:

- **`System.Diagnostics.Stopwatch` works inside Udon** (`GetTimestamp`/`Frequency`/`Elapsed`), verified in shipped code, though the whitelist itself lives in a binary. Cache `1/Frequency` once.
- **Instrument the producer; don't heuristically parse the output.** Patch the compiler so its output is analysable rather than trying to parse what it already emitted; rewrite the C# syntax tree before U# sees it rather than post-processing assembly.
- **State the cost of your instrumentation.** A syntax-tree profiler rewriter adds 2 public methods, 2 fields and ~3 `__refl_` heap values to **every** behaviour in the project.
- **A wall-clock budget self-tunes, but check the constant.** A leftover 5000 ms budget defeats the whole mechanism and looks like it is working.
- **An editor window that measures its own refresh and downgrades to manual when slow**, with the distinction it encodes being *implicit trigger vs user intent*.
- **Push profiler samples into a CustomRenderTexture** via `SetVectorArray`, so the GPU owns all history and Udon holds none. Gate the pump on window visibility.

---

## 5. Getting data out

- **`VRCJson` + one `Debug.Log`, in Chrome/Perfetto trace format.** The visualisation problem is then solved by an existing tool. Minify to a single line so it survives log processing.
- **Scrape the live player log** with `FileShare.ReadWrite` plus a marker string.
- **Inject VRChat launch flags via a wrapper exe**: `--enable-udon-debug-logging`, `--watch-worlds`, and `--profile=#` to test sync with yourself.
- **`[RecursiveMethod]` tree rewrite to make a `DataToken` graph JSON-printable**, with `switch` on `GetType().ToString()` string literals.
- **Base64 of raw floats inside a `VRCJson` envelope** for user-facing export/import: exact bit-for-bit round trip, no decimal reparse ([04](04-data-structures-and-boxing.md)).
- **Readback of one texel** where the data lives on the GPU: a mipped RT plus a readback of `mipmapCount - 1` moves 4 bytes and gives you the average of a whole frame. See [09](09-udon-gpu-bridges.md).

---

## 6. Visualising

- **Any state published via `VRCShader.SetGlobal*` is automatically inspectable by a replacement shader**: `SceneView.AddCameraMode` + `SetSceneViewShaderReplace`, with the debug shaders sampling the same globals the shipping shaders do. **The visualisation *is* the runtime state; there is no second data path.**
- **Keep an in-world immediate-mode drawer.** Its design matters: `[DefaultExecutionOrder(-1)]` retiring last frame's draws in an *early* `Update` is what makes `DrawLine(...)` fire-and-forget regardless of which callback drew it. See [09](09-udon-gpu-bridges.md) for the pooling and shader technique.
- **The two-pass silhouette** (`ZTest Always` ghost then `ZTest LEqual` solid) gives x-ray debug visibility with zero Udon-side occlusion logic. See [10](10-vrc-shader-toolbox.md).
- **An in-scene preview with no GameObject**: `Camera.onPreCull` + camera-scoped `DrawMeshInstanced`, `HideAndDontSave`, disposed on `beforeAssemblyReload`, is structurally incapable of being saved or uploaded.
- **A build tombstone** (`new GameObject("MyTool ran!")` moved into the processed scene) makes "did the pass run?" answerable by anyone holding only the built world, and doubles as a runtime capability probe.

---

## 7. Testing

There is no test runner for Udon. The only way to get mechanically verifiable Udon logic is to **stub the
Unity/VRChat surface so the logic compiles and runs as plain C#**. If you write anything with a wire format,
a parser or a state machine, keep it in a shape that can run outside Udon; that decision has to be made
before the code exists, not after.

The nearest thing to integration testing:

- **`--profile=#` launch flags** to run two clients and test sync alone.
- **A single-client netcode harness** under `#if UNITY_EDITOR`: the owner runs the *receive* path on its own packets, which is only possible when `Deserialization(...)` takes the wire payload as **parameters** rather than reading fields, a structural decision made specifically to enable it.
- **Play mode is a first-class build target**, and getting it to run the same pipeline as an upload is a multi-hook project; see [11 §2](11-editor-time-tooling.md#2-build-hooks-and-their-ordering).

---

## 8. Platform bugs worth knowing (they will look like your bug)

- **Serialization callbacks never fire when you are alone in the instance.** The single most common "works with a friend, does nothing solo" report.
- **`UdonBehaviour.OnDisable` fires during editor play-mode *teardown* but not in-game**, so teardown logic there is editor-only behaviour you cannot rely on.
- **"Build & Reload" leaves `VRC_SdkBuilder.ActiveBuildType == None`**, so *every* "am I uploading?" detection in *every* package is wrong during it. The robust alternative is a **stack-trace probe** with a one-editor-frame cache: "am I inside operation X?" is literally a question about the stack, and the stack cannot be faked by a flag someone forgot to set.
- **With "Reload Scene" disabled**, ClientSim deletes `EditorOnly`-tagged objects before network-id setup, and a whole family of `Awake`-ordering assumptions in third-party packages break.
- **`Networking.FindComponentInPlayerObjects` logs a line per non-matching PlayerObject, per call**; cache the result.
- **`UdonSharpBehaviour`'s explicit `OnBeforeSerialize` is sometimes invoked with `this == null`** during reimport.
- **`GetPlayerCount()` is stale inside `OnPlayerLeft`**; defer a frame.
- **`(CollisionDetectionMode)intValue` crashes the behaviour**; the adjacent enum casts fine. Switch on named constants.
- **NaN crashes the VRChat client.** Clamp every inverse-trig argument.
- **An out-of-range index halts the behaviour** with nothing to catch.
- **`enabled` does not gate `SendCustomEvent`** the way it gates `Update`.
- **A property returning an array hands back a copy**, so `x.arr[0] = v` silently does nothing.
- **`Renderer.material` clones**; `Array.IndexOf(arr, null)` cannot see Unity fake-nulls; `Vector3 ==` is approximate. See [99](99-anti-patterns.md).
- **Udon writing to a serialized `Material` permanently rewrites the `.mat` in your repo** during ClientSim.
- **A self-recursive property getter corrupts locals rather than crashing**, because recursion without `[RecursiveMethod]` reuses one frame.
- **Unity's built-in blit shader is half precision.**
- **Global shader properties survive exiting play mode** and leak between worlds.
- **`Shader.Find` in a static initialiser runs at domain reload**, before shaders may be imported on a fresh project; a null there silently disables a feature.
- **An unbound global texture resolves to Unity's tiny default**, which is also useful, as a feature probe.

---

## 9. Comment the *why*, not the what

The most valuable lines in an Udon codebase are the ones explaining why something is strange, because each
one encodes an experiment already run and not repeatable from the code alone. Two rules follow:

- **Record measurements you cannot explain, verbatim.** "For unknown reasons this is faster than the clever indexing" is better documentation than a plausible theory, and it tells the next reader not to undo it.
- **Say when a layout is empirical.** A comment admitting that a correction range was found by trial marks exactly where a hand-rolled scheme has accumulated correction tables, which is the realistic cost of not deriving the layout from a schema ([11 §5](11-editor-time-tooling.md#5-codegen-and-bakes)).
