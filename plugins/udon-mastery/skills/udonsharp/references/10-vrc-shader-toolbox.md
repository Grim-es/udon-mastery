# 10 — VRC shader toolbox

The shader-side half of the contract. [09](09-udon-gpu-bridges.md) covers getting data *to* the GPU; this
file covers what the GPU side has to know to be a good partner, and the VRChat-specific traps.

---

## Contents

- [1. Versioning against shaders you do not control](#1-versioning-against-shaders-you-do-not-control)
- [2. The accessor indirection](#2-the-accessor-indirection)
- [3. Per-consumer bounds, baked at edit time](#3-per-consumer-bounds-baked-at-edit-time)
- [4. Depth, occlusion and stereo](#4-depth-occlusion-and-stereo)
- [5. Rendering technique worth stealing](#5-rendering-technique-worth-stealing)
- [6. Shipping a header other people include](#6-shipping-a-header-other-people-include)
- [7. The one contested entry](#7-the-one-contested-entry)

---

## 1. Versioning against shaders you do not control

The hardest constraint in this whole area: **your consumers are third-party avatar and world shaders, each
carrying a *copy* of your `.cginc` at whatever version it was compiled against, by people you will never
meet.** A shader keyword cannot help: those shaders were compiled long ago, elsewhere.

**Use a runtime-uploaded float as the handshake.** The shader carries its compile-time
`#define MYPKG_VERSION 3` and `#define MYPKG_MIN_SUPPORTED 2`; the runtime pushes
`VRCShader.SetGlobalFloat(_UdonMyPkgVersionID, 3)` every rebuild: global names must start with `_Udon`
([09 §2](09-udon-gpu-bridges.md#2-global-shader-arrays--the-contract)). Every entry point gates on it:

```hlsl
[branch] if (_UdonMyPkgEnabled == 0 || _UdonMyPkgVersion < MYPKG_MIN_SUPPORTED) {
    /* fallback path */
}
```

**Because an absent Udon runtime leaves the global at its default `0`, "no such system in this world" and
"too old a runtime" are the same branch, for free.** Put feature-level differences inline
(`_Version < 3 ? 1.0 : …`). Give loop bounds the mirror treatment on the consumer side
(`min((uint)_Count, VRCLV_MAX_LIGHTS)`), so **each side distrusts the other's bounds**.

The packing in [09 §7](09-udon-gpu-bridges.md#7-encoding-across-the-boundary) is contorted for the same
reason: every new field has to be smuggled into channels an older shader ignores. Mark every such
concession at the site (`// Match the v2 shader ABI`), or a later edit will remove it as apparently dead
code.

**The alternative discipline: freeze, don't edit.** Pin the original version discriminator forever (one
shipped system froze `red = 3.02f` in perpetuity), and move the live version to unused channels of the
same vector. A three-tier
ladder works because **each tier's discriminator lives in a different place** (channel y, channel x,
texture width), which is what lets a new scheme be added without breaking the previous one.

**Feature detection is always inference from an observable.** `GetDimensions(w, h); return w > 16;`: an
unbound global resolves to Unity's tiny default texture, so **the size of the fallback is the sentinel**.
Amortise the probe and make the *negative* path the cheap one.

---

## 2. The accessor indirection

The structural idea to adopt first:

```hlsl
// yourpackage_uniform.cginc
#ifdef YOURPKG_STATIC_UNIFORMS
  float4 _Vertices_0_get(uint i) { return _static_uniforms[uint2(0, i)]; }  // texture
#else
  float4 _Vertices_0_get(uint i) { return _Vertices_0[i]; }                 // cbuffer
#endif
```

The shader body never indexes storage directly. **Putting the switch at the *accessor* means zero `#ifdef`s
in the ~500 lines of math that consume it**, where the instinct is to `#ifdef` around the update loop and
end up with the conditional everywhere.

The payoff is not only tidiness. The baked-texture form makes the whole dataset one sampler bind instead of
five constant-buffer arrays, the vertices are **pre-transformed to world space at bake** so the static path
skips the per-frame transform loop entirely, and critically, **it works with no Udon program present at
all**, which is what lets avatar shaders in other worlds still function.

---

## 3. Per-consumer bounds, baked at edit time

Every consumer sees a different subset of sources. The obvious shader loop is
`for (i = 0; i < MAX; i++) if (mask[i]) …`: a branch and a mask fetch per source per pixel, mostly for
empty slots.

Instead, have the editor compute **per renderer** the index of its last visible source and ship that as the
loop bound in the renderer's property block. Three ideas compose:

1. **Invert the mask polarity** (`1 = not visible, 0 = visible`) so the padding value used to fill unused slots (`Enumerable.Repeat(1.0f, …)`) automatically means "off". **Choosing a flag's polarity so the pad/default value is the safe one is a real design decision.**
2. Sort dynamic sources first (see [08](08-performance-patterns.md)) so "last visible index" is a meaningful bound rather than a random one.
3. Floor the bound at the dynamic count, because dynamic sources can become visible after the bake.

A per-pixel branch becomes a loop bound.

---

## 4. Depth, occlusion and stereo

**`_CameraDepthTexture` only exists if something asks the camera to render it.** A fully-baked world has
zero realtime lights and therefore no depth texture at all: the shader compiles, samples garbage, and the
bug looks like anything but a missing pass. Four things must all hold:

1. a **realtime light** in the scene (add a disabled-by-default, zero-intensity "depth light" purely to
   force the pass; this is the standard workaround, not a hack);
2. the camera's `depthTextureMode` includes `Depth`;
3. the geometry you want to read writes depth: an `Opaque`/`AlphaTest` queue pass with `ZWrite On`;
4. your sampling pass runs *after* it, i.e. in `Transparent` or later.

Miss any one and you sample an undefined texture with no error.

Distinguishing passes: `unity_LightShadowBias` is zero-filled in a **camera depth prepass** but not in a
real shadow map; `_ProjectionParams.z` fingerprints a camera so utility geometry can hide from itself.

**Avoid the depth texture entirely where you can**: a **stencil bit can carry a depth-test result** into a
pass that has depth testing disabled, with a hand-derived `InverseLinearEyeDepth`.

**`GL.GetGPUProjectionMatrix` is not exposed to Udon.** Push the raw OpenGL matrix and reconstruct the
platform fix-up inside the shader under `UNITY_REVERSED_Z`. And **publish view+projection matrices to
the material so the GPU reprojects**: render once for the screen camera and let every other camera
reproject, with `_RenderOK` doubling as a staleness flag and a one-float liveness protocol.

**Oblique near-plane projection** with a per-eye self-disabling guard plane (`Plane.GetSide` as a cheap
half-space test) is the portal technique; **layer 4 (Water) with `mask & ~0x410`** is the mirror-layer
recursion-prevention convention worth reusing.

**Stereo, specifically:**

- **Billboard against the *averaged* stereo camera position**: `(unity_StereoWorldSpaceCameraPos[0] + [1]) * 0.5`. Per-eye billboarding makes the two eyes disagree and the label refuses to fuse. `_WorldSpaceCameraPos` does not give you this inside a stereo pass.
- **Force world-up in the look-at basis.** Otherwise text rolls as the player tilts their head, which is nauseating in VR. This is a comfort requirement, not an aesthetic one.
- **`"DisableBatching" = "True"` is mandatory** for any shader that reads its own object transform. Dynamic batching bakes vertices into world space and **resets `unity_ObjectToWorld` to identity**, so the symptom (everything offset) looks nothing like the cause.
- `UNITY_MATRIX_I_V` differs slightly per eye, harmless for diffuse shading, worth knowing for anything exact.

---

## 5. Rendering technique worth stealing

- **Two passes of the same program, differing only in render state.** Pass 1 `ZTest Always, ZWrite Off` with alpha × 0.2 (a faint ghost, drawn first so it cannot occlude); pass 2 `ZTest LEqual, ZWrite On`. X-ray debug visibility with **zero Udon-side occlusion logic and zero raycasts**, where the instinct is one pass with `ZTest Always` (no depth cues at all) or `ZTest LEqual` (invisible when occluded). Gate the optional depth-texture fade as a `[Toggle] shader_feature_local` so worlds without a depth pass compile the sample out rather than reading garbage.
- **`SV_VertexID % 3` as free barycentrics**: no geometry shader (so it works on Quest), no extra vertex stream. The key observation: *"split the triangles"* and *"give each triplet sequential IDs"* are **the same operation**, so one C# rebuild (`newVertices[i] = vertices[triangles[i]]; newTriangles[i] = i;`) satisfies both and the barycentric attribute becomes redundant data you were about to upload for nothing.
  - **`SV_VertexID` is not dependable on every graphics API.** The portable variant puts the index in `uv0`, duplicated across all four vertices of a quad so it survives interpolation exactly. Using `SV_VertexID` in a runtime shader and `uv0` in an editor one is a legitimate deliberate split.
- **Clip-space depth bias** `positionCs.z += _DepthOffset * positionCs.w`, branched on `UNITY_REVERSED_Z`: perspective-correct, so an overlay sits in front of its surface at *every* distance without a per-object offset.
- **`AlphaToMask On` plus `a = (t - _Cutoff)/max(fwidth(t), 1e-4) + 0.5`**: analytic alpha sharpening that gets MSAA-quality antialiased lines out of the **AlphaTest** queue, so debug geometry never enters transparent sorting.
- **Branch opaque vs transparent in C# by alpha** (`a >= 0.999f ? opaqueMat: transparentMat`) rather than shipping one alpha-blended shader, to keep opaque solids out of the transparent queue.
- **A fake view-space directional light in three uniforms** for runtime-`Instantiate`d geometry that has no lightmap and no realtime lights to receive. Author it in **view** space and transform by `UNITY_MATRIX_I_V`, so it is a headlamp and shading always reads as form: a world-space fixed direction leaves shapes dark from some angles, which for debug geometry is a bug.
- **`[fastopt]`** on an unbounded loop: the difference between compiling in seconds and not compiling at all. And **clamp the loop bound inside the shader**, not in Udon, so no material-property race or malicious `SetInt` can produce a zero-or-huge iteration count.
- **`tex2Dlod` with explicit LOD 0** for anything that is data: never let the hardware pick a mip.
- **Named `GrabPass` as a global texture channel** reachable by *avatar* shaders, with `GetDimensions` as the missing null check.
- **Point lights as a positional data bus**, with an **empty `ForwardAdd` pass** added purely to change Unity's light-classification decision, and light alpha as an identity tag.
- **`SetReplacementShader(shader, "")`: the empty tag is the optimisation**; a non-empty tag re-enters normal dispatch. Cull all lights off the compute camera's layer while you are there.

---

## 6. Shipping a header other people include

- **A forwarding include.** `Assets/…/X.cginc` containing one `#include "Packages/…/X.cginc"` gives third-party shaders a stable path forever while the real file moves, and survives `.unitypackage` installs.
- **`#ifndef` guards around any macro your header introduces**: a shared header that defines `glsl_mod` unguarded breaks whoever already had one.
- **`#define _SelfTexture2D _JunkTexture` / `#include` / `#undef`** retargets a declaration in a package header you cannot edit.
- **A 255-entry LUT shipped as one multi-line `#define`**: the preprocessor as data transport.
- **Sampler-free `Texture2D<float4>` + `[uint2]` loads**, with a standard-indexing fallback set automatically under `SHADER_TARGET_SURFACE_ANALYSIS` so surface-shader analysis still parses.
- **`Vector2` as an address type** so a pass base and an offset stay separable, "pointer arithmetic for free".
- **Rewrite your own `#define`s from what the scene actually contains.** Locate the config `.cginc` by GUID, `File.ReadAllLines`, and **comment or uncomment individual `#define` lines in place** based on scene facts, also stamping `#define MAX_SOURCES N` so the C#/HLSL contract cannot drift. This is the most aggressive form of "move runtime cost to build time": it removes *shader instructions*, driven automatically rather than by the user remembering to toggle something. A **line-oriented rewrite of a checked-in file** (rather than whole-file codegen) keeps user edits and makes the generated state reviewable in a diff, and the comment above each `#define` doubles as its inspector description: one file, no parallel metadata. Trap: the file lives in `Assets/`, so two scenes with different needs in one project fight over it.
- **A shader keyword is a variant; a `#define` is not.** Prefer editing the config for scene-wide facts and keywords only for genuinely per-material ones.
- **Material tags as an indirect opt-in protocol.** `mat.GetTag("MySystem", true)`, and **the tag's *value* names the material's own toggle property** (`return mat.GetFloat(tag) != 0;`), with `"ALWAYS"` for unconditional. One level of indirection lets any shader author opt in **without agreeing on a property name**, and lets a single material toggle it per instance. `searchFallbacks: true` makes it inheritable from the SubShader.

---

## 7. The one contested entry

**`packoffset` cbuffer aliasing to break the 1023-element limit** is recommended by one credible source and
explicitly retracted by another, and neither position is measured. Decision rule and both arguments:
[09 §2](09-udon-gpu-bridges.md#the-1023-limit).

Related correction worth carrying: a single-buffered camera loop that appears to work is relying on an
**HDR camera format mismatch** causing Unity to insert a blit. *All* formats need double buffering: do not
generalise from a loop that happened to survive.
