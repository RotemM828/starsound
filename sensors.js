// sensors.js — which way is the phone pointing?
//
// The browser gives three angles (alpha, beta, gamma). Following the W3C
// DeviceOrientation spec, the phone's rotation is R = Rz(alpha) · Rx(beta) · Ry(gamma),
// which turns phone coordinates into Earth coordinates (East, North, Up).
// The back camera looks along the phone's −z axis, so the pointing direction is
// −(third column of R):
//   East  = −(cosα·sinγ + sinα·sinβ·cosγ)
//   North = −(sinα·sinγ − cosα·sinβ·cosγ)
//   Up    = −(cosβ·cosγ)
// Sensor readings are noisy and the compass drifts, so we (1) smooth the vector
// rather than the angles (angles jump at 0°/360°), (2) correct for magnetic
// declination, and (3) allow a one-tap calibration on the Moon or a planet.

const Sensors = (() => {
  const DEG = Math.PI / 180;
  const state = {
    mode: "none",            // "phone" | "simulate"
    raw: [0, 1, 0],          // latest unsmoothed pointing vector
    vec: [0, 1, 0],          // smoothed pointing vector (ENU)
    declination: 11.5,       // degrees east; ~11.5° in Southern California
    calibration: 0,          // extra azimuth correction from calibrating, degrees
    iosOffset: null,         // iOS: converts relative alpha into compass alpha
    smoothing: 0.18,         // 0 = frozen, 1 = no smoothing
    simAlt: 35, simAz: 180,  // simulated pointing for desktop / demo
    lastEvent: 0,
    absolute: false,
  };

  function pointingFromAngles(alphaDeg, betaDeg, gammaDeg) {
    const a = alphaDeg * DEG, b = betaDeg * DEG, g = gammaDeg * DEG;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    const cg = Math.cos(g), sg = Math.sin(g);
    return [
      -(ca * sg + sa * sb * cg),
      -(sa * sg - ca * sb * cg),
      -(cb * cg),
    ];
  }

  // rotate a vector around the Up axis (positive = clockwise seen from above = toward East)
  function rotateAzimuth(v, deg) {
    const t = deg * DEG, c = Math.cos(t), s = Math.sin(t);
    return [v[0] * c + v[1] * s, -v[0] * s + v[1] * c, v[2]];
  }

  function onOrientation(e) {
    if (e.alpha == null || e.beta == null || e.gamma == null) return;
    let alpha = e.alpha;
    if (typeof e.webkitCompassHeading === "number") {
      // iOS: alpha is relative to where the phone started; webkitCompassHeading is
      // magnetic. Learn the offset while the phone is not near vertical, where the
      // compass reading is most trustworthy, and keep using it while aiming upward.
      const flatEnough = Math.abs(e.beta) < 60 && Math.abs(e.gamma) < 60;
      const compassAlpha = (360 - e.webkitCompassHeading) % 360;
      if (flatEnough || state.iosOffset === null) {
        let off = compassAlpha - alpha;
        off = ((off + 540) % 360) - 180;
        state.iosOffset = state.iosOffset === null ? off : blendAngle(state.iosOffset, off, 0.1);
      }
      alpha = alpha + state.iosOffset;
      state.absolute = true;
    } else if (e.absolute || e.type === "deviceorientationabsolute") {
      state.absolute = true;
    }
    // compass angles are measured from magnetic north; turn them into true north
    let v = pointingFromAngles(alpha, e.beta, e.gamma);
    v = rotateAzimuth(v, state.declination + state.calibration);
    state.raw = v;
    state.lastEvent = performance.now();
  }

  function blendAngle(a, b, k) {
    const d = ((b - a + 540) % 360) - 180;
    return a + d * k;
  }

  // Must be called from a button tap (iOS requires a user gesture).
  async function startPhone() {
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      const res = await DeviceOrientationEvent.requestPermission();
      if (res !== "granted") throw new Error("Motion permission was denied");
    }
    if ("ondeviceorientationabsolute" in window) {
      window.addEventListener("deviceorientationabsolute", onOrientation);
    } else {
      window.addEventListener("deviceorientation", onOrientation);
    }
    state.mode = "phone";
  }

  function startSimulation() {
    state.mode = "simulate";
    updateSim();
  }

  function updateSim() {
    state.simAlt = Math.max(-89, Math.min(89, state.simAlt));
    state.simAz = ((state.simAz % 360) + 360) % 360;
    state.raw = Astro.altAzToENU(state.simAlt, state.simAz);
  }

  function nudge(dAz, dAlt) {
    state.simAz += dAz; state.simAlt += dAlt; updateSim();
  }

  function aim(altDeg, azDeg) {
    state.simAlt = altDeg; state.simAz = azDeg; updateSim();
  }

  // call once per animation frame
  function update() {
    const k = state.mode === "simulate" ? 0.35 : state.smoothing;
    const v = state.vec, r = state.raw;
    state.vec = Astro.normalize([v[0] + (r[0] - v[0]) * k, v[1] + (r[1] - v[1]) * k, v[2] + (r[2] - v[2]) * k]);
    return state.vec;
  }

  // Point the phone at a known object, then call this with that object's vector.
  function calibrateTo(targetVec) {
    const p = Astro.enuToAltAz(state.vec), t = Astro.enuToAltAz(targetVec);
    const d = ((t.az - p.az + 540) % 360) - 180;
    state.calibration += d;
    state.vec = rotateAzimuth(state.vec, d);
    return d;
  }

  function receiving() {
    return state.mode === "simulate" || performance.now() - state.lastEvent < 1500;
  }

  return { state, startPhone, startSimulation, nudge, aim, update, calibrateTo, receiving, pointingFromAngles };
})();

if (typeof module !== "undefined") module.exports = Sensors;
