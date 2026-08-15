# 09 — Udon↔GPU bridges

If a system moves bulk data per frame, read §1 before designing it.

---

## Contents

- [1. The thesis: Udon is an address bus, not a data bus](#1-the-thesis-udon-is-an-address-bus-not-a-data-bus)
- [2. Global shader arrays — the contract](#2-global-shader-arrays--the-contract)
- [3. `MaterialPropertyBlock`](#3-materialpropertyblock)
- [4. The CustomRenderTexture as memory](#4-the-customrendertexture-as-memory)
- [5. Blit passes as an instruction set](#5-blit-passes-as-an-instruction-set)
- [6. GPU → Udon](#6-gpu--udon)
- [7. Encoding across the boundary](#7-encoding-across-the-boundary)
- [8. Awkward corners of the Udon graphics API](#8-awkward-corners-of-the-udon-graphics-api)
- [9. Getting geometry out without a mesh](#9-getting-geometry-out-without-a-mesh)

---

## 1. The thesis: Udon is an address bus, not a data bus

> Publish an **index** at `Start()`; let the shader do all addressing against a global texture. Bulk data
> never enters the Udon heap.

Concretely: give the per-entity behaviour **no `Update` at all**. `Start()` fills one
`MaterialPropertyBlock` with static configuration, chiefly the entity's *address*, e.g.
`props.SetInt("_DMXChannel", …)`, and applies it to every renderer. The payload values never touch Udon;
the shader samples a globally-set texture at the offset it was told about once. Re-push only when a *human*
changes something, from property setters. **Entity count then becomes free in Udon terms**: a
~4,000-line runtime built this way has one `Update()` in total.

The intuitive architecture, a manager that reads the data and pushes per-entity values out, is
O(entities) Udon work per frame. Avoid it in favour of the pattern above.

### Rasterise your data instead of marshalling it

One step further, and it removes the fixed-size-array cap entirely. Make each entity a `MeshRenderer`
carrying its parameters in a `MaterialPropertyBlock`; point a dedicated camera at those meshes and render
them into a RenderTexture. **The entity's world transform arrives on the GPU for free, because the renderer
already uploads its object-to-world matrix.** Any clustering or aggregation then runs as a
CustomRenderTexture update, entirely GPU-side. Total per-frame Udon work for a whole lighting system:

```csharp
VRCShader.SetGlobalVector(_playerPositionID, pos);   // that's it
```

It inverts the framing from *"how do I get N structs from Udon to the shader"* to **"what already moves
data to the GPU?"**, removing the array cap, the transform loop, the `SetGlobalVectorArray` calls and all
change-tracking in one move. Same observation from the shader side: **renderer transforms are a
zero-EXTERN Udon→GPU channel**, walkable across instances with `UNITY_SETUP_INSTANCE_ID` on a synthetic
struct.

The index each entity needs is free too: **`Renderer.sortingOrder`** is a serialized field with no
inspector UI, assigned at build time by a scene processor. Indexing, ordering *and* priority are all handled
by machinery that already exists: no registry behaviour, no Udon array, no runtime `IndexOf`. Pass
`includeInactive: true` so an object toggled off at edit time keeps its index.

---

## 2. Global shader arrays — the contract

**Two rules before any of the rest, and both are silent when broken.**

**(a) Udon publishes globals through `VRCShader`, not `Shader`.**

```csharp
// name MUST start with "_Udon"
private int _dataID;
void Start() { _dataID = VRCShader.PropertyToID("_UdonMyData"); }
void Push()  { VRCShader.SetGlobalVectorArray(_dataID, _buffer); }
```

`VRCShader` exposes `PropertyToID` and
`SetGlobalColor/Float/FloatArray/Integer/Matrix/MatrixArray/Texture/Vector/VectorArray`. Per-*material* and
per-*renderer* writes still use the ordinary Unity API (`Material.SetFloat`,
`MaterialPropertyBlock.SetVector`); only the **global** namespace routes through `VRCShader`. If the same
source also compiles outside Udon, alias the difference away rather than branching:
`using GlobalShader = VRC.SDKBase.VRCShader;` versus `= UnityEngine.Shader;`
([02 §5](02-project-architecture.md#5-the-compiler_udonsharp-seam)).

Watch one wart: **`SetGlobalInteger` still writes its value as a `float`**, a Unity bug VRChat documents.
Declare the HLSL side accordingly rather than assuming an integer register.

**(b) The property name must be prefixed `_Udon`**, or be the single literal exception `_AudioTexture`.
VRChat namespaces the global shader namespace so worlds cannot collide with each other or with avatar
shaders. A name without the prefix does not error; **the write is simply ignored**, and you debug a shader
that reads zeroes. Every shipped system therefore uses names like `_Udon_LTCGI_Texture_LOD0` and
`_UdonLightVolumeFwdWorldMatrix`. Name the HLSL uniform to match.

Then three rules, applied without exception, are what make a global-array system allocation-free:

1. **Resolve every property name once** into an `int` via `PropertyToID`, inside an `_isInitialized`-guarded init. Clear the flag in `OnEnable`, not just `Start`, so IDs re-resolve after a domain reload.
2. **Upload every array at full capacity once**, even empty. Unity **locks a global array's length at the first `SetGlobalVectorArray` for that property name**; later shorter uploads do not shrink it and the shader keeps reading the old length.
3. **Communicate liveness with *count* scalars.** Arrays are always full-length with a valid prefix and unread garbage in the tail. "Everything is off" then costs 8 scalar writes instead of clearing 300+ vectors.

### And the cross-world hazard

> **Global arrays must ALWAYS be uploaded at max length, or you corrupt other worlds.**

`SetGlobalVectorArray` sizes the underlying constant buffer on **first** upload *for the process lifetime*.
VRChat keeps one process across world loads, and avatar shaders read these globals. So a world that
uploads 4 elements permanently shrinks the buffer, and the next world's 16-element upload is silently
truncated. **The "obvious" memory saving is a cross-world correctness bug.** (The constant-buffer mechanism
is inferred, not independently verified, but the failure it describes makes it cheap insurance either
way.)

### The 1023 limit

`float _Samples0L[1023]` pads each element to a full float4 register; 4 × 1023 = 4092, just under the D3D
4096-register limit. **The entire CPU-side transport shape is derived from a GPU register rule**, visible
only by reading both sides.

- Stage through a `float[1023]` **field**, filled with one `Array.Copy`: one EXTERN versus ~1023 interpreted iterations. Reuse one staging buffer across all channels, and size *source* buffers `1023*4` rather than 4096 for the same reason.
- The stale tail is uploaded on the last chunk, so **the shader must respect a length uniform, not the array size**.
- **Two array sizes for two traffic shapes**: `SetFloatArray` uploads the whole array every call, so using a 1023-float buffer for a 1–3-point live delta moves 4 KB to carry 12 bytes. Splitting also separates the *semantics*: the live path needs per-point timestamps, the bulk path must appear instantly.
- ***Contested*: cbuffer aliasing with `packoffset`** to break the limit (with a never-taken branch to defeat dead-code elimination). One well-regarded source recommends it; another **explicitly retracts** it as slower than a texture past roughly 100 reads per invocation, replacing it with a **Morton/Z-ordered texture** so sequential logical reads hit adjacent cache lines. Neither position is measured. **Decision rule: choose on read count, not write cost.** Under ~100 reads the cbuffer trick is fine; past that, stage to a texture and Z-order it.
- **`float3[]` in HLSL, `Vector4[]` from Udon** works: constant-buffer array elements are padded to 16 bytes regardless of declared width, so the shader can declare the semantically correct width with zero repacking. **The corollary is the trap**: `float3[]` does *not* pack three-to-a-float4, so it saves nothing, which is why arrays that genuinely need to save space use explicit `*2`/`*3`/`*6` strides on `float4[]`. (Standard HLSL, unverified on GLES3/Quest.)
- **`bool[]` HLSL uniforms fed from a C# `float[]`** works for the same reason (4 bytes per element), and lets the compiler treat the value as a predicate instead of comparing `!= 0` per element per pixel. Undocumented and backend-dependent.

---

## 3. `MaterialPropertyBlock`

Always a property block; never `renderer.material`.

- **`renderer.material` clones the material** on first access: breaks batching, leaks a Unity object per renderer in a world that never unloads, and costs a fresh EXTERN chain per property. Use `sharedMaterials` as a read-modify-write of the array (`sharedMaterial` only touches submesh 0).
- **Pool the blocks; never re-`new` one per draw.** A fresh block per frame is a managed allocation per entity per frame.
- **Merge, do not replace.** `SetPropertyBlock` clobbers wholesale, so a library that skips `if (r.HasPropertyBlock()) r.GetPropertyBlock(block);` **silently destroys every other system's per-renderer overrides**. That is the difference between a library that composes and one that does not.
- **Unity copies the block on assignment**, which is what makes "mutate one block, `SetPropertyBlock` N times with different values" work, including the rarely-used **per-submesh overload** `SetPropertyBlock(block, subMesh)`.
- **`[PerRendererData]`** on exactly the properties Udon writes is the **declared ABI**: zero runtime effect, hides them from the material inspector so nobody authors a value that will be overwritten, and is the only *machine-readable* record of which string keys Udon may set.
- **Instanced properties survive batching** (`UNITY_ACCESS_INSTANCED_PROP`), which is why hundreds of entities can share one material and one draw call while each reads a different slice.
- **Property blocks defeat GPU instancing for properties not declared in an instancing cbuffer**: the one real cost.

---

## 4. The CustomRenderTexture as memory

**The CRT is the universal Udon-accessible mutable GPU memory, and `updateMode` is the universal on/off
switch**: flipping `Realtime` ↔ `OnDemand` arms or disarms an entire GPU subsystem for one enum write and
zero per-frame Udon cost.

**Retype it to integers.** Copy Unity's `UnityCustomRenderTexture.cginc` into your project and change one
declaration:

```hlsl
Texture2D<uint4> _SelfTexture2D;      // was: sampler2D _SelfTexture2D
```

That turns a float, filtered, sRGB-hostile CRT into **exact 128-bit-per-texel integer RAM**, with the CRT's
own double-buffering as free read-modify-write. Replacing the *include* rather than the shader is the
minimal intervention that retypes the whole pipeline while keeping Unity's update-zone vertex shader
working. Pair it with `Cull Off / ZTest Off / Lighting Off / Blend One Zero`: every fixed-function state
that could perturb an exact write, explicitly disabled.

**Make the CRT the system's entire mutable state.** N passes, each owning a disjoint rectangle, each
reading the previous frame via `_SelfTexture2D[xy]`. Udon pushes raw inputs and **never reads state back**.
Even a fractional accumulator lives in a texture pixel. Add a terminal no-op pass purely as a safe CRT
update-zone index.

Practical notes: a CRT over a *volume* is a draw-call trap, since Unity dispatches one draw call per depth
slice; the platform UV-origin flip belongs in the coordinate macro every pass opens with; and a CRT's
material is just a `Material`, so `Graphics.Blit` can drive it outside the CRT system entirely, which is
how you precompute the *exact* thing the runtime would compute. You must then hand-supply the CRT built-in
uniforms (`CustomRenderTextureCenters`, `…SizesAndRotations`), which are not bound in that context, or the
bake is silently wrong.

---

## 5. Blit passes as an instruction set

Udon cannot dispatch compute shaders. So:

> **A multi-pass blit material is the instruction set, and `enum BlitPass` is the opcode table.**

**Two `VRCGraphics.Blit` constraints that are not Unity's**, both documented by VRChat and both fatal rather
than degraded:

- **A null destination is rejected.** Unity's `Graphics.Blit(src, null)` targets the screen; Udon does not allow it. Always supply a RenderTexture.
- **On Quest the blit fails outright** unless the shader declares **`ZTest Always`** *or* the destination RenderTexture has depth turned off. This is the single most common reason a GPU pipeline works on PC and silently produces nothing on Android; set `ZTest Always` by default on every blit shader you write.

`Write = 0, Erase = 1, Copy = 2, WriteRange = 3, … Undo = 11, WriteZeroRange = 12`. Every mutation (add,
erase, undo, defragment, clear-timestamps) is a blit with a pass index.

**Make the GPU render texture *be* the data structure.** 65 536 points live in an `ARGBFloat` RT; adding
one is two property sets plus one `VRCGraphics.Blit`, **three EXTERNs regardless of n**, and zero Udon
heap growth.

Supporting machinery:

- **Geometrically growing GPU buffer with copy-on-resize**: `List<T>` for VRAM. Power-of-two square so index↔xy is shifts and `GenerateMips` stays legal; seeded with a **sentinel** rather than zero (zero is itself a data value); old contents blitted in; floor of 256 to avoid startup churn.
- **`VRCRenderTexture.GetTemporary`/`ReleaseTemporary`**: the Udon-exposed shim for a `RenderTexture.GetTemporary` that is not itself exposed. Deriving the temporary from `_rt.descriptor` is what makes scratch surfaces track a growing buffer automatically. When a surface must keep its bindings instead, **resize in place** (`Release()` → mutate → `Create()`): every binding survives that.
- **UInt16 index buffer + automatic submesh splitting**: `kMaxSubmeshCapacity = 9362 // floor(65535/7)`, the *same* index array backing every submesh because the offset lives in a uniform, N identical materials creating N draw calls, and a per-submesh property block differentiating them.
- **An edit-time-baked vertex/index LUT mesh** so growth is two EXTERNs per 128 points instead of a 4-million-iteration loop. The mesh carries *no information*: positions come from the RT, topology is a fixed pattern.
- **`Renderer.bounds` is settable and overrides the mesh's**, the only way to make shader-displaced geometry cull correctly. And it must be **synced**, because a late joiner receiving a truncated tail would compute a volume smaller than the geometry it is about to be sent.
- **Unity's built-in blit shader is half precision.** Ship your own float `Copy` pass or world positions become subtly wrong with distance from the origin, a bug that reads as "jitter", not as precision loss.

---

## 6. GPU → Udon

**The modern channel** is `VRCAsyncGPUReadback.Request(tex, mip, (IUdonEventReceiver)receiver)` with
`OnAsyncGpuReadbackComplete`. Notes:

- The plain form `VRCAsyncGPUReadback.Request(texture, 0, this)` is current; the `(IUdonEventReceiver)(Component)this` double-cast is an older form still common in existing code.
- The **receiver need not be `this`**: see [03 §3](03-event-and-callback-architecture.md#3-continuations-for-callbacks-with-no-user-data). Receiver identity is the closure.
- `TryGetData` writes into an array **you supply**, so preallocate it (`Color32[1]`, `float[1]`) and reuse.
- Latency is unbounded: you need an in-flight state machine, and a failure path that clears whatever mutex you set or sync deadlocks.

**Let the GPU reduce; read one texel.** A 64×32 RT with `useMipMap`/`autoGenerateMips`, blitted into each
frame, then a readback of `mipmapCount - 1`: **a single texel that is the hardware box-filtered average of
the entire frame**. Four bytes per frame for "what colour is the TV right now". You never compute an
average; you ask the texture unit for one it already made.

**GPU stream compaction without compute.** Erasing punches holes; compacting needs a prefix sum. Instead:
rewrite the ring into Morton order → build a 1/0 occupancy mask → **`GenerateMips()` on the mask *is* a
hierarchical sum** → each output texel walks the mip pyramid to find its source (Z-order makes the descent
local) → reduce to 1×1 and read back **a single float** for the new count.

**Readback as the late-joiner snapshot source**, when state lives only in VRAM: blit through an `RFloat` RT
purely as **format normalisation** so `TryGetData(float[])` sees a flat stream; reorder the ring
oldest-first; clamp keeping the **newest tail** (a naive implementation truncates the wrong end). Budget
~1 MB of readback plus ~1 MB of transient heap, so fire it at most once per join behind a randomised delay
and ship it off by default.

**The legacy channel**, still the only way to read an arbitrary render target on older SDKs, is a
manually pulsed camera:

```csharp
void Update() {
    if (cam.enabled) cam.enabled = false;             // exactly one render per pulse
    if (--lastUpdate <= 0) { cam.enabled = RenderCam; lastUpdate = UpdateEveryXFrames; }
}
public void OnPostRender() { Buffer.ReadPixels(new Rect(0,0,W,H), 0, 0); /* decode */ }
```

`OnPostRender` **fires on a `UdonSharpBehaviour` only if the behaviour is on the Camera GameObject**:
*placement is the synchronisation primitive*. Pulsing `enabled` turns a render callback into a
rate-limited DMA, and disabling first thing in `Update` guarantees exactly one render per pulse regardless
of script order. Idle cost is one `Camera.enabled` get and set. `OnPostRender` is still a documented Unity event available to Udon, but this whole technique is
superseded by `VRCAsyncGPUReadback`; reach for the legacy path only on an SDK that lacks it.

---

## 7. Encoding across the boundary

**Udon only ever sees `Color`, four normalized floats.** So:

> **The translation is a rendering problem, not an Udon problem.** Do not make Udon decode a hostile
> format; spend one fullscreen pass re-laying-out the data into the only shape the CPU-side API can
> express, and pay only the readback.

Unpack each `uint4` into **six RGB texels**: 18 byte-slots carrying 16 bytes of payload, where the waste
buys an **alpha-free** layout. Alpha is the one lane render targets, blend state and PNG encoders routinely
mangle; never use it as a data lane.

**Byte-exact reconstruction is `*255.0f + 0.5f` on both sides.** The `+0.5` converts C#'s truncating cast
into round-to-nearest; without it roughly half of all values are off by one, and the bug looks like memory
corruption rather than rounding. Preconditions: linear (not sRGB), point-filtered, uncompressed 8-bit,
mip 0.

**Deliberately over-encode.** Pay 256 texels to carry one 8-bit channel, a 16×16 solid block per value,
and decode it as **`LinearRgbToLuminance(c.rgb)`** rather than `.r`. The redundancy *is* the error
correction: a block that large survives bilinear filtering, mip selection, non-integer scaling and
video-codec chroma subsampling, so the same channel works whether the data arrives as a local texture or a
compressed video stream, and the luminance average recovers the value even if the transport shifted
individual colour channels.

**Packing into float lanes:**

- **Bit-reinterpret, don't store-as-float.** `BitConverter.SingleToInt32Bits` / `Int32BitsToSingle` are exposed; storing an integer *as* a float wastes a whole lane and loses precision above 2²⁴, where bit-reinterpretation packs 23+ bits at zero cost and the shader recovers them with a free `asuint()`.
- **Choose a radix that stays exactly representable**: `x + y*256 + code*65536` is deliberately below 2²⁴.
- **Stack sentinel + sign + integer + fraction in one float**, with a `+1` bias so zero is signable.
- **Strings as denormal floats**: a bit pattern whose *mantissa is the codepoint*, four per `Vector4`.
- **Base-1024 four-channel packing**; **14-bit-safe fp16 packing** via `f32tof16`/`f16tof32` with `precise` (the last two bits get stomped, established empirically); **splitting a wide integer across two float channels**.
- Caveat: some drivers canonicalise NaN/denormal patterns on upload. Keep the exponent field in a normal range.

**Program/RAM images as textures.** Bake megabytes of binary at edit time into **four single-channel
`Texture2D` assets**, so "loading a program" is four `SetTexture` EXTERNs. Four textures rather than one
RGBA32 because single-channel formats are not gamma-corrected or premultiplied, the fourth byte plane is an
ordinary colour plane rather than *the* alpha channel, and planes swap independently.

---

## 8. Awkward corners of the Udon graphics API

- **`VRCGraphics.Blit` needs a throwaway blit to bind a texture-array slice.** Blit a 1×1 dummy RT into the destination slice purely for the side effect of binding it, then do the real material blit.
- **No overload takes both `destDepthSlice` and a custom `Material`.** Escape: passing a `Texture2DArray` as the *source* triggers Unity's all-slices binding path, so a **1×1×1 dummy texture exists solely as a binding-mode trigger** and is never sampled. Undocumented. Two transferable insights: a CRT over a volume is a draw-call trap, and **an asset can exist purely to select a code path in an engine API**.
- **`Camera.SetTargetBuffers(throwaway.colorBuffer, real.depthBuffer)`** is the only route to mixing attachments from two RenderTextures, which is how you get a sampleable depth map from an arbitrary viewpoint.
- **Camera execution order is the order you called `SetTargetBuffers`**, not `Camera.depth`: declarative config becomes imperative call order.
- **`Blit` clobbers `_MainTex_ST`.** Ship a `_MainTex_ST_Override`.
- **Global shader properties are process-wide and sticky**: they survive exiting play mode and leak between worlds. Use a one-shot teardown latch with *neutral* (not zero) reset values, and clear them from an editor hook on `EnteredEditMode`.
- **A texture property with any default cannot be overridden by `SetGlobalTexture`**: declare `= "" {}`.
- **Feature detection by texture dimensions**: an unbound global resolves to Unity's tiny default, so `GetDimensions(w,h); return w > 16;` is a presence test, and the *size of the fallback* is the sentinel.
- **`VRCShader.SetGlobalVector` beats four `SetGlobalFloat`s** (the one place a runtime measurement is claimed).
- **Sometimes the right answer is to move work back to the CPU**: reading the camera position inside a CRT is unreliable *and* costs a texture sample per invocation, so one `SetGlobalVector` per frame is both cheaper and more correct, with the cull distance packed into the unused `.w`.

---

## 9. Getting geometry out without a mesh

- **A baked degenerate-quad mesh as the particle buffer**: per particle, four vertices at the *identical* random position (position doubles as the seed) plus two triangles, expanded in the vertex shader by `vertexID & 3`. Zero runtime allocation, streams like any mesh, and Udon's entire role is uploading matrices and counts.
- **Kill a primitive by writing `w = -1`**: the whole triangle fails clipping before rasterisation. No `discard`, no branch, the cheapest possible cull. Pair with an absurd `mesh.bounds` to defeat Unity's culling and re-implement it in the shader, which has the per-instance distance information Unity does not.
- **Geometry shaders as the random-access write path**: clip-space position *is* the write address, so a degenerate one-pixel quad is a store instruction. Also the route to post-skinning vertex data.
- **The fixed-function blender as a 3-slot shift register** (`Blend DstAlpha Zero` is a data-dependent shift): read-modify-write with no UAVs.
- **Unit-space templates plus one affine transform**: every shape that is an affine image of a canonical form is an inspector-assigned unit `Mesh` scaled by `localScale`. A capsule cannot be a scaled sphere but *can* be three scaled primitives. Only genuinely-varying topology falls through to runtime generation, and make that classification **at design time**: templated shapes cost 0 geometry EXTERNs where a dynamic one costs 5 array allocations plus ~132 sin/cos per frame.
- **One-stroke polylines**: a wireframe box is a 16-point path walking all 12 edges as one continuous stroke, retracing 4. Twelve pool allocations and twelve draw calls become one.
- **Push profiler history into a CustomRenderTexture** via `SetVectorArray`, so the GPU owns all history and Udon holds none.
