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
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * 0.5), t + (kind === "cue" ? 0.04 : 0.025));
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    env.connect(makePanner(viewPos)).connect(master);

    const partials = kind === "moon" ? [[1, "sine", 1], [1.5, "sine", 0.6], [2, "sine", 0.3]]
      : kind === "planet" ? [[1, "triangle", 1], [3, "sine", 0.15]]
      : kind === "cue" ? [[1, "sine", 1]]
      : [[1, "sine", 1], [2, "sine", 0.12]];
    for (const [mult, type, amp] of partials) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.value = freq * mult; g.gain.value = amp;
      o.connect(g).connect(env);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }

  // A short tick used by Find mode; pitch rises as you get closer to the target.
  // Find mode: a soft sonar ping from the target's direction; higher and faster as you get closer
  function tick(closeness, viewPos) {
    if (!ctx) return;
    ping(viewPos || [0, 0, 1], 392 + 392 * closeness, 0.32, "cue", 0.28);
  }

  // A two-note chime for "found it" / "locked on"
  // Found it: two warm notes going up
  function chime() {
    if (!ctx) return;
    ping([0, 0, 1], 659, 0.4, "cue", 0.6);
    setTimeout(() => ping([0, 0, 1], 988, 0.4, "cue", 0.9), 160);
  }

  // Short sound cues ("earcons") so a blind user knows what the app is doing:
  //   listen = rising notes (start talking), done = falling notes (stopped listening),
  //   error = low double buzz (didn't understand).
  // Only two interface cues, each with one meaning (the voice explains everything else):
  //   listen: a soft rising pair of notes = "I'm listening, speak now"
  //   ready:  one quiet low note = hands-free: "you can reply without saying Hey Star"
  let cuesOn = true;
  function setCues(on) { cuesOn = !!on; return cuesOn; }
  function earcon(type) {
    if (!ctx || !cuesOn) return;
    if (type === "listen") {
      ping([0, 0, 1], 523, 0.26, "cue", 0.35);
      setTimeout(() => ping([0, 0, 1], 784, 0.26, "cue", 0.45), 110);
    } else if (type === "ready") {
      ping([0, 0, 1], 392, 0.14, "cue", 0.4);
    }
  }

  let volume = 0.8;
  function setVolume(v) {
    volume = Math.min(1.5, Math.max(0, v));
    if (master) master.gain.value = volume;
    return volume;
  }
  function getVolume() { return volume; }

  // lower the star sounds while the app is talking, so speech is easy to understand
  let ducked = false;
  function duck(on) {
    if (!master || on === ducked) return;
    ducked = on;
    const t = ctx.currentTime;
    master.gain.cancelScheduledValues(t);
    master.gain.setTargetAtTime(on ? volume * 0.25 : volume, t, 0.08);
  }

  // Android phones can buzz; iPhones ignore this.
  function buzz(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_) {}
  }

  return { init, ping, tick, chime, earcon, setCues, buzz, duck, pitchFromColor, loudnessFromMagnitude, setVolume, getVolume };
})();

// Speech: the app's own voice (text-to-speech), or the user's screen reader.
//
// Browsers have several speech bugs, and each is handled here:
//  - iPhone/iPad stay silent unless the first speech starts directly from a tap,
//    so unlock() speaks a silent word inside the Start and Talk taps.
//  - Chrome cuts off utterances after about 15 seconds, so long answers are split
//    into sentences and queued one after another.
//  - Safari can drop speech that starts right after cancel(), so new speech waits a moment.
//  - Utterances sometimes never report that they finished, so a timer moves the queue on.
//  - Some computers list joke voices first ("Bad News", "Zarvox"); we pick a clear voice.
const Voice = (() => {
  let useScreenReader = false;
  let live = null;
  let lastText = "", lastAt = 0, lastSpoken = "";
  let lastUserAt = 0;        // when the app last answered the user
  let srBusyUntil = 0;       // screen-reader mode: estimated time the screen reader finishes
  let rate = 1.0;
  let queue = [];            // sentences waiting to be spoken
  let current = null;        // the utterance being spoken now
  let watchdog = null;
  let chosenVoice = null;
  let idleListeners = [];
  let srIdleTimer = null;
  function onIdle(fn) { idleListeners.push(fn); }
  function fireIdle() { for (const fn of idleListeners) { try { fn(); } catch (_) {} } }
  const synth = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;

  const NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|junior|organ|superstar|trinoids|whisper|wobble|zarvox|deranged|hysterical|grandma|grandpa|eddy|flo\b|reed|rocko|sandy|shelley|ralph|fred|kathy|princess/i;
  const PREFERRED = [/^samantha/i, /^ava\b/i, /^allison/i, /^alex$/i, /^susan/i, /google us english/i,
    /microsoft (aria|jenny|guy).*natural/i, /microsoft (aria|jenny|zira|david)/i, /^karen/i, /^daniel/i, /^moira/i, /^tessa/i];

  function pickVoice() {
    if (!synth) return;
    const voices = synth.getVoices().filter((v) => /^en([-_]|$)/i.test(v.lang) && !NOVELTY.test(v.name));
    if (!voices.length) return;
    for (const p of PREFERRED) {
      const v = voices.find((x) => p.test(x.name));
      if (v) { chosenVoice = v; return; }
    }
    chosenVoice = voices.find((v) => v.default) || voices.find((v) => /en[-_]US/i.test(v.lang)) || voices[0];
  }
  if (synth) {
    pickVoice();
    if (synth.addEventListener) synth.addEventListener("voiceschanged", pickVoice);
    else synth.onvoiceschanged = pickVoice;
  }

  function attach(liveRegion) { live = liveRegion; }

  // When the app voice is speaking, the live region is silenced so VoiceOver/TalkBack
  // users don't hear everything twice; in screen-reader mode the roles swap.
  function setScreenReader(on) {
    useScreenReader = on;
    if (live) live.setAttribute("aria-live", on ? "assertive" : "off");
    if (on) cancel();
  }

  function setRate(r) { rate = Math.min(1.8, Math.max(0.6, r)); return rate; }
  function getRate() { return rate; }
  function voiceName() { return chosenVoice ? chosenVoice.name : "default"; }

  // Must be called inside a tap: lets iPhones speak later, after any awaits.
  function unlock() {
    if (!synth || useScreenReader) return;
    try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; synth.speak(u); } catch (_) {}
  }

  // tidy text so it sounds right when read aloud
  function clean(text) {
    return String(text)
      .replace(/°/g, " degrees")
      .replace(/\s+/g, " ")
      .trim();
  }

  // split into sentences, then pack them into pieces under ~200 characters
  function chunks(text) {
    // split after . ! ? followed by a space, so decimals like "1.2 hours" stay whole
    const sentences = text.split(/(?<=[.!?]["')]?)\s+/);
    const out = [];
    let cur = "";
    for (let s of sentences) {
      s = s.trim();
      if (!s) continue;
      while (s.length > 220) { // a very long sentence: break at a comma or semicolon
        let cut = Math.max(s.lastIndexOf(", ", 200), s.lastIndexOf("; ", 200));
        if (cut < 60) cut = s.lastIndexOf(" ", 200);
        if (cur) { out.push(cur); cur = ""; }
        out.push(s.slice(0, cut + 1).trim());
        s = s.slice(cut + 1).trim();
      }
      if ((cur + " " + s).length > 200 && cur) { out.push(cur); cur = s; }
      else cur = cur ? cur + " " + s : s;
    }
    if (cur) out.push(cur);
    return out;
  }

  // auto: an automatic announcement (a star name while sweeping, a hint). Automatic speech
  // never talks over an answer the user asked for, and never repeats itself back to back.
  function say(text, { interrupt = true, force = false, auto = false } = {}) {
    if (!text) return false;
    const now = Date.now();
    if (auto) {
      if (speaking() || now - lastUserAt < 2500) return false;
      if (!force && text === lastText && now - lastAt < 1500) return false;
    } else {
      lastUserAt = now;
    }
    lastText = text; lastAt = now; lastSpoken = text;
    if (useScreenReader) {
      srBusyUntil = now + (text.split(/\s+/).length / 2.6) * 1000 / rate + 500;
      clearTimeout(srIdleTimer);
      srIdleTimer = setTimeout(fireIdle, srBusyUntil - now);
    }
    if (live) live.textContent = text; // captions for sighted companions and low-vision users
    if (useScreenReader) {
      if (live) {
        live.setAttribute("aria-live", interrupt ? "assertive" : "polite");
        live.textContent = ""; // re-set so screen readers announce repeats too
        setTimeout(() => { live.textContent = text; }, 30);
      }
      return true;
    }
    if (!synth) return true;
    const parts = chunks(clean(text));
    if (interrupt) {
      queue = [];
      current = null;
      synth.cancel();
      queue.push(...parts);
      setTimeout(pump, 80); // Safari drops speech started right after cancel()
    } else {
      queue.push(...parts);
      pump();
    }
    return true;
  }

  function pump() {
    if (!synth || current || !queue.length) return;
    const text = queue.shift();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate;
    u.lang = chosenVoice ? chosenVoice.lang : "en-US";
    if (chosenVoice) u.voice = chosenVoice;
    current = u;
    const done = () => {
      if (current !== u) return;
      current = null;
      clearTimeout(watchdog);
      if (queue.length) pump(); else fireIdle(); // finished everything: tell listeners
    };
    u.onend = done;
    u.onerror = done;
    // if the browser never reports the end, move on after the expected time
    // (the browser queues speech itself, so moving on early never cuts a sentence off)
    const expected = (text.length / (16 * rate)) * 1000 + 1500;
    clearTimeout(watchdog);
    watchdog = setTimeout(done, expected);
    synth.speak(u);
    if (synth.paused) synth.resume();
  }

  function cancel() {
    queue = [];
    current = null;
    clearTimeout(watchdog);
    if (synth) synth.cancel();
  }

  function repeat() { if (lastSpoken) say(lastSpoken, { force: true }); }

  function speaking() {
    if (useScreenReader) return Date.now() < srBusyUntil;
    if (!synth) return false;
    return !!current || queue.length > 0 || synth.speaking;
  }

  return { attach, say, setScreenReader, speaking, setRate, getRate, repeat, cancel, unlock, voiceName, chunks, clean, onIdle };
})();
