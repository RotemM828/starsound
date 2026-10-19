// audio.js — turning stars into sound.
//
// Mapping (the "sonification"):
//   brightness (magnitude)  -> loudness      brighter = louder
//   color (B−V index)       -> pitch         hot blue stars high, cool red stars low,
//                                            snapped to a pentatonic scale so groups
//                                            of stars sound musical, never clashing
//   position in view        -> 3D direction  HRTF spatial audio (use headphones)
//   closeness to center     -> ping rate     stars "twinkle" faster as you aim at them
//   planets / Moon          -> own timbres

const Sound = (() => {
  let ctx = null, master = null;

  function init() {
    if (ctx) { ctx.resume(); return; }
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4;
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(comp).connect(ctx.destination);
    // unlock audio on iOS with a silent blip
    const o = ctx.createOscillator(), g = ctx.createGain();
    g.gain.value = 0.0001; o.connect(g).connect(master); o.start(); o.stop(ctx.currentTime + 0.05);
  }

  // Pentatonic notes (C major pentatonic) from C3 to C7
  const SCALE = [];
  for (let midi = 48; midi <= 96; midi++) {
    if ([0, 2, 4, 7, 9].includes(midi % 12)) SCALE.push(midi);
  }
  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  // B−V of about −0.3 is a hot blue-white star, about +1.8 is a cool red giant.
  function pitchFromColor(bv) {
    const t = Math.min(1, Math.max(0, (bv + 0.3) / 2.1)); // 0 = blue, 1 = red
    const midi = 91 - t * 36;                             // ~G6 down to ~G3
    let best = SCALE[0];
    for (const n of SCALE) if (Math.abs(n - midi) < Math.abs(best - midi)) best = n;
    return midiToHz(best);
  }

  // Magnitude is logarithmic and backwards (smaller = brighter). Sirius ≈ −1.5,
  // the faintest stars we keep ≈ 4.5. Map that onto a comfortable volume range.
  function loudnessFromMagnitude(mag) {
    const m = Math.min(5, Math.max(-1.5, mag));
    return Math.pow(10, -0.4 * (m + 1.5) * 0.45);  // 1.0 for Sirius, ~0.08 at mag 4.5
  }

  function makePanner(viewPos) {
    const p = ctx.createPanner();
    p.panningModel = "HRTF";
    p.distanceModel = "linear";
    p.rolloffFactor = 0; // direction only, no distance fading
    // view frame: x = right, y = up, z = forward. Web Audio listener looks down −z.
    const [x, y, z] = viewPos;
    if (p.positionX) {
      p.positionX.value = x; p.positionY.value = y; p.positionZ.value = -z;
    } else {
      p.setPosition(x, y, -z);
    }
    return p;
  }

  // One star "twinkle": a soft bell-like note placed in 3D.
  function ping(viewPos, freq, gain, kind = "star", dur = 0.6) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * 0.5), t + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    env.connect(makePanner(viewPos)).connect(master);

    const partials = kind === "moon" ? [[1, "sine", 1], [1.5, "sine", 0.6], [2, "sine", 0.3]]
      : kind === "planet" ? [[1, "triangle", 1], [3, "sine", 0.15]]
      : [[1, "sine", 1], [2, "sine", 0.12]];
    for (const [mult, type, amp] of partials) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = freq * mult; g.gain.value = amp;
      o.connect(g).connect(env);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }

  // A short tick used by Find mode; pitch rises as you get closer to the target.
  function tick(closeness, viewPos) {
    if (!ctx) return;
    ping(viewPos || [0, 0, 1], 300 + 900 * closeness, 0.35, "planet", 0.12);
  }

  // A two-note chime for "found it" / "locked on"
  function chime() {
    if (!ctx) return;
    ping([0, 0, 1], 784, 0.5, "star", 0.5);
    setTimeout(() => ping([0, 0, 1], 1175, 0.5, "star", 0.7), 140);
  }

  // Short sound cues ("earcons") so a blind user knows what the app is doing:
  //   listen = rising notes (start talking), done = falling notes (stopped listening),
  //   error = low double buzz (didn't understand).
  function earcon(type) {
    if (!ctx) return;
    const seq = { listen: [523, 784], done: [784, 523], error: [196, 196] }[type];
    if (!seq) return;
    seq.forEach((f, i) => setTimeout(() => ping([0, 0, 1], f, 0.45, type === "error" ? "planet" : "star", 0.18), i * 120));
  }

  let volume = 0.8;
  function setVolume(v) {
    volume = Math.min(1.5, Math.max(0, v));
    if (master) master.gain.value = volume;
    return volume;
  }
  function getVolume() { return volume; }

  // Android phones can buzz; iPhones ignore this.
  function buzz(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) {}
  }

  return { init, ping, tick, chime, earcon, buzz, pitchFromColor, loudnessFromMagnitude, setVolume, getVolume };
})();

// Speech: the app's own voice, or the user's screen reader (VoiceOver/TalkBack).
const Voice = (() => {
  let useScreenReader = false;
  let live = null;
  let lastText = "", lastAt = 0;

  function attach(liveRegion) { live = liveRegion; }
  // When the app voice is speaking, the live region is silenced so VoiceOver/TalkBack
  // users don't hear everything twice; in screen-reader mode the roles swap.
  function setScreenReader(on) {
    useScreenReader = on;
    if (live) live.setAttribute("aria-live", on ? "assertive" : "off");
    if (on && "speechSynthesis" in window) speechSynthesis.cancel();
  }

  let rate = 1.0;
  let lastSpoken = "";
  function setRate(r) { rate = Math.min(1.8, Math.max(0.6, r)); return rate; }
  function getRate() { return rate; }
  function repeat() { if (lastSpoken) say(lastSpoken, { force: true }); }
  function cancel() { if ("speechSynthesis" in window) speechSynthesis.cancel(); }

  // pick a clear English voice once the browser has loaded its voice list
  let chosenVoice = null;
  function pickVoice() {
    if (!("speechSynthesis" in window)) return;
    const voices = speechSynthesis.getVoices().filter((v) => /^en(-|_|$)/i.test(v.lang));
    chosenVoice = voices.find((v) => v.localService && /en-US/i.test(v.lang)) ||
      voices.find((v) => /en-US/i.test(v.lang)) || voices[0] || null;
  }
  if ("speechSynthesis" in window) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }

  function say(text, { interrupt = true, force = false } = {}) {
    const now = Date.now();
    if (!force && text === lastText && now - lastAt < 1500) return; // avoid stutter repeats
    lastText = text; lastAt = now; lastSpoken = text;
    if (live) live.textContent = text; // always mirror for sighted companions
    if (useScreenReader) {
      if (live) live.setAttribute("aria-live", interrupt ? "assertive" : "polite");
      return;
    }
    if (!("speechSynthesis" in window)) return;
    if (interrupt) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate;
    if (chosenVoice) u.voice = chosenVoice;
    speechSynthesis.speak(u);
  }

  function speaking() {
    return !useScreenReader && "speechSynthesis" in window && speechSynthesis.speaking;
  }

  return { attach, say, setScreenReader, speaking, setRate, getRate, repeat, cancel };
})();
