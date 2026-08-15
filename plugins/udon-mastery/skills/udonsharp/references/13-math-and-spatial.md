# 13 — Math & spatial

The Udon-specific part of doing maths. Ordinary algorithms are out of scope; what is in scope is *how the
cost model changes which algorithm is correct*.

---

## Contents

- [1. Calling out is cheaper than computing](#1-calling-out-is-cheaper-than-computing)
- [2. Matrices and transforms](#2-matrices-and-transforms)
- [3. Coordinate frames as shared state](#3-coordinate-frames-as-shared-state)
- [4. Quaternions](#4-quaternions)
- [5. Time and filtering](#5-time-and-filtering)
- [6. Convergence without a control loop](#6-convergence-without-a-control-loop)
- [7. Geometry, cheaply](#7-geometry-cheaply)
- [8. Numerical hazards specific to this platform](#8-numerical-hazards-specific-to-this-platform)

---

## 1. Calling out is cheaper than computing

The arithmetic rule from [00](00-mental-and-cost-model.md), repeated here because it inverts normal
numerical instinct:

> **Count host calls, not arithmetic operations. Optimise toward the largest built-in that does the job.**

- `quat * mirrorQuat`, one EXTERN, beats four swizzle-and-negate VM operations.
- Three nested `Vector3.Lerp` calls beat writing the Hermite basis in scalars.
- A **closed-form damped harmonic oscillator** should call `Mathf.Sqrt`/`Exp`/`Sin`/`Cos` outright, because one EXTERN beats a polynomial approximation's worth of VM instructions. Branch it by damping regime and it is **exact for any `dt` with no stability limit**, unlike the spring-and-damper integration usually written first.
- But `Vector3.Angle` is *several* externs, so precompute a cosine `const` and use `Dot`. `const float` literals fold into the instruction stream with **no heap symbol**.

The counterweight: **algebra done at authoring time beats either**:

- A **closed-form projectile-with-drag** replaces a nested simulation loop. Keep the naive version in the file as executable documentation.
- **`tan(a + b)` via the tangent-addition identity** widens a cone by a fixed safety margin without ever calling `Atan`/`Tan` at runtime: the code stays in tangent space with one divide.
- **Oct projection is scale-invariant**, so L1-normalise directly and avoid a `sqrt` entirely.
- Inspector angles → dot thresholds, divisions → reciprocals, `Quaternion.Euler` → literal quaternion components, all at init.

---

## 2. Matrices and transforms

- **Scale-stripped TRS matrices** (`Matrix4x4.TRS(pos, rot, Vector3.one)`) instead of `TransformPoint`, and **`MultiplyPoint3x4`** to skip the perspective divide.
- **`ref` into a `Vector3`'s component field**, and mutating a by-value parameter as scratch, to avoid a `new Vector3` constructor EXTERN.
- **Precompute the inverse.** The runtime should never call `Matrix4x4.inverse`; compute it in the editor and ship it.
- **Elide a matrix row.** A rotation matrix is orthonormal, so row 2 is `cross(r0, r1)`. Storing rows 0 and 1 saves a third of the constants *and* a third of the per-change upload, for one `cross()` per pixel, the correct trade when constants are permanently resident and ALU is not the bottleneck. Caveat: a mirrored (negative-determinant) transform needs the negated cross, and nothing checks.
- **Compare matrices with `Matrix4x4.Equals`** (exact `ValueType.Equals`), not `==`, when the comparison gates an expensive rebuild.
- **`DetachChildren()` for its side effect.** Detaching preserves world transform, so every child's local position is rebaked small: the entire floating-origin technique is one line that looks like cleanup.
- **Re-pivot a prefab onto its centre of mass at load** so rotation extrapolation stops inducing position error; `rb.inertiaTensor = rb.inertiaTensor` freezes the auto tensor.
- **Solve for the play-space origin when teleporting**: `teleportRot * inverse(playerRot) * offset`: a composition that is easy to get wrong.
- **`SetLossyScale` by iteration**: Unity has no `lossyScale` setter and the naive `target / parent.lossyScale` is wrong under parent rotation, so ~20 rounds of multiplicative correction is the practical answer.

---

## 3. Coordinate frames as shared state

**Anchor-relative sync.** Put the true coordinate frame in a scene `Transform` and express everything
relative to it: the per-client origin offset then cancels *implicitly*, with no synced offset and no race.
Publish the same anchor to shaders as a global so the GPU agrees.

This is the general form of a recurring idea: **encode the frame in the scene graph and let the engine
maintain it**, rather than carrying an offset in every message. Related: **collider layers as client-local
per-observer relationships** ([07](07-player-systems-and-identity.md)), and
**`transform.GetSiblingIndex()` as an element's own index** into its owner's arrays.

---

## 4. Quaternions

- **Two compressions; choose by the dynamics of the thing being synced**: drop W and re-derive, versus send four `short`s. Both are correct for different motion.
- **Angle-axis × angle = three floats.**
- **The double cover matters.** If you need to reconstruct *angular velocity*, you need the 720° window, which means a hand-written `RealSlerp`: Unity's `Slerp` and `Angle` take the shortest arc and will silently discard half your range.
- **Unrolled literal quaternion constants** rather than `Quaternion.Euler` at runtime: the six cubemap face rotations as five instance fields with the sixth being identity-by-omission. The verified win is eliminating 5–6 transcendental EXTERNs per bake; the "branch beats array index" part is inference.

---

## 5. Time and filtering

- **Which clock, and which phase, are first-class design decisions.**
  - `Time.timeAsDouble` / `Time.timeSinceLevelLoadAsDouble` over `Time.time` for long instances: `Time.time` loses resolution after hours and a 0.03 s tick will drift.
  - `Time.deltaTime` inside `FixedUpdate` is the fixed step, which silently breaks anything computing "one frame".
  - **Async callbacks need their own delta time.** `Time.deltaTime` inside a readback or network callback describes the *rendering* frame, not the interval since your callback last landed. Track `_timePrev` yourself. Generalises to every Udon callback not driven by the frame loop.
- **A local clock anchored to server time**: sample at 1 Hz, integrate `Time.deltaTime`, correct at 1/20 strength, and **keep the sub-millisecond remainder in an accumulator**. Re-anchor exactly on frame hitches (`deltaTime > .099f`). `SmoothDamp` as a **low-pass filter on a clock**, not as easing, where `Networking.SimulationTime` misbehaves.
- **Frame-rate-exact IIR smoothing (`Mathf.Pow(k, dt)`) becomes mandatory once dispatch rate is variable**, a coupling that is rarely stated, and the reason amortisation and smoothing must be designed together.
- **Difference-adaptive smoothing**: make the time constant a function of how different the new sample is, with `pow(diff * 1.5, 0.1)` doing the work, mapping almost any non-zero difference near 1 while keeping 0 at 0, so the response is a **soft switch rather than a proportional gain**.
- **Constant-time sliding-window mean**: ring buffer plus running sum, with the length derived from `Time.fixedDeltaTime` so the window is a constant *duration* on any client.
- **Same-tick float equality as a causality test** (`Time.time == LastDamageEventTime`).
- **A one-frame catch-up loop** bridging `Update`-driven remote objects and `FixedUpdate` physics, with `ensureNoSelfCollision_time != Time.fixedTime` as a zero-state "has a physics step happened" predicate.

---

## 6. Convergence without a control loop

**Successive approximation with power-of-two step quantisation** is the standout. Halve the step each time
the error changes sign: it converges in ~log₂ steps, needs **no gain constant**, is **immune to an unknown
loop rate**, latches per axis independently once the error stays small, and only resends to late joiners
once converged. Compare with what it replaces: a PID or an exponential approach, both of which need tuning
against a rate you do not control.

**PD-style convergence onto an extrapolated raw target** is the netcode variant: rotate acceleration by the
*observed* rotation delta, and treat a >90° acceleration reversal as a crash guard. Layer
**adaptive branching that spends only the latency budget not already consumed**, the sign of one float
selecting between three smoothing algorithms, on top of it.

---

## 7. Geometry, cheaply

- **`Collider.ClosestPoint(p) == p`** is the only point-in-collider test available.
- **`Plane.GetSide`** as a cheap half-space test.
- **`RaycastNonAlloc` with a reusable length-1 buffer**, and **re-derive `secondsPerStep` from the rounded frame count** so samples land on physics-step boundaries.
- **Unit-space templates plus one affine transform.** Every shape that is an affine image of a canonical form is an inspector-assigned unit mesh scaled by `localScale`; a capsule cannot be a scaled sphere but *can* be three scaled primitives. Only genuinely-varying topology falls through to runtime generation, and **make that classification at design time**.
- **One-stroke polylines.** A wireframe box is a 16-point Eulerian path walking all 12 edges, retracing 4; twelve draw calls become one, and the retraced pixels are free (they only double-blend under alpha).
- **Trilateration recovers a quantity the protocol never transmits.** Three fixed-geometry contact receivers with known radii turn three proximity readings into a length: `length = tipRadius * (tipProx - rootProx) + 0.01f`. The sender broadcasts nothing but its position. Group senders that belong together by **same-player + sub-centimetre positional coincidence**, because the API offers no grouping.
- **Round-robin target acquisition as a greedy tournament over time**, where the override clause is what makes it correct and line-of-sight is confirmed by *what the ray hits*.
- **`Physics.ComputePenetration`** for write-on-surface, and **`Rigidbody.includeLayers`/`excludeLayers`** for per-object collision filtering.
- **Re-arm overlap detection by cycling the *collider***, not the GameObject: activation does not re-evaluate overlaps, component enabling does.
- **Sometimes the divide-by-zero guard *is* the trigger.** A sonic boom fires exactly where the naive code would produce infinity: the singularity is the physical event. Look for that before writing a separate detector.

---

## 8. Numerical hazards specific to this platform

- **NaN crashes the VRChat client.** Clamp every inverse-trig argument.
- **Unity's `Vector3 ==` / `Quaternion ==` are approximate** (~1e-5 relative). Compare components individually wherever the comparison gates an exact fast path, and three float compares is likely *cheaper* than one EXTERN to the overloaded operator.
- **A narrowing cast wraps rather than saturating.** Clamp explicitly before quantising to `sbyte`/`short`.
- **`Convert.ToInt16` rounds where a cast truncates.**
- **`(uint)(x * 255f)` without `+ 0.5f` is off by one for about half of all values**, and the bug looks like memory corruption, not rounding.
- **Choose a packing radix that stays exactly representable** (under 2²⁴ for a float32 mantissa) or the unpack silently corrupts.
- **fp16 packing loses the last two bits** (established empirically, not from a spec).
- **Some drivers canonicalise NaN and denormal bit patterns on upload.** Bit-packing into a float's mantissa is safe only while the exponent field stays in a normal range.
- **NaN/denormal survival through VRChat's *serializer*** is the single highest-risk unverified assumption in the sync work.
- **Never write a deliberately non-antisymmetric `CompareTo`** to stop a sorted *set* deduping. It works until something else sorts the same data.
