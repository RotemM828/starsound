// tutorial.js — a short, spoken, tap-through introduction.
//
// Each step is read aloud and shown on a large card, then plays a live example of the
// sound it describes. Tap anywhere, or say "next", for the next step ("back", "repeat"
// and "skip" work too). It runs once
// the first time StarSound starts, and any time you say "tutorial" or open
// "How does it work?".

const Tutorial = (() => {
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const front = [0, 0, 1];

  const STEPS = [
    {
      title: "Welcome to StarSound",
      text: "StarSound lets you hear the night sky. This short tour explains the sounds and what you can ask. To go on, tap anywhere on the screen, or just say: next. You can also say back, repeat, or skip.",
    },
    {
      title: "Point your phone at the sky",
      text: "Hold your phone up, like you're taking a photo of the sky. The back of the phone, where the camera is, points at the stars you hear. Headphones work best, because sounds come from the direction of each star. If you can't hear the stars, turn off your phone's silent mode.",
    },
    {
      title: "Every star is a soft bell",
      text: "Each star in front of you plays a soft bell. Brighter stars are louder. Here is a bright star, and then a faint one.",
      demo: async () => { Sound.ping(front, 659, 1, "star", 1.2); await wait(1300); Sound.ping(front, 659, 0.18, "star", 1.2); },
    },
    {
      title: "Pitch tells you color",
      text: "Pitch tells you a star's color and temperature. Hot, blue stars sound high. Cooler, red stars sound low. Here is a blue star, and then a red one.",
      demo: async () => {
        Sound.ping(front, Sound.pitchFromColor(-0.2), 0.8, "star", 1.2); await wait(1300);
        Sound.ping(front, Sound.pitchFromColor(1.7), 0.8, "star", 1.4);
      },
    },
    {
      title: "Sound shows direction",
      text: "Stars to your left sound in your left ear, and stars to your right sound in your right ear. Stars twinkle faster as you aim right at them. Here is a star on your left, then on your right.",
      demo: async () => {
        for (let i = 0; i < 3; i++) { Sound.ping([-0.9, 0, 0.4], 784, 0.8, "star", 0.6); await wait(380); }
        await wait(500);
        for (let i = 0; i < 3; i++) { Sound.ping([0.9, 0, 0.4], 784, 0.8, "star", 0.6); await wait(380); }
      },
    },
    {
      title: "The Moon and planets",
      text: "The Moon and the planets have their own sounds, so they stand out from the stars. Here is a planet, and then the Moon.",
      demo: async () => { Sound.ping(front, 330, 0.9, "planet", 1.0); await wait(1300); Sound.ping(front, 196, 1, "moon", 1.6); },
    },
    {
      title: "Finding something",
      text: "When you ask me to find something, you'll hear a soft ping coming from its direction. The ping gets faster and higher as you get closer, and two rising notes mean you found it. I'll also say things like: turn left 20 degrees.",
      demo: async () => {
        const steps = [0.1, 0.3, 0.5, 0.7, 0.85, 0.95];
        for (const c of steps) { Sound.tick(c, front); await wait(900 - c * 700); }
        await wait(250); Sound.chime();
      },
    },
    {
      title: "Talking to StarSound",
      text: "To ask me something, tap anywhere on the screen. If you use VoiceOver, double-tap anywhere. Wait for two soft rising notes, which mean I'm listening, then ask your question, like: What am I pointing at? Find Jupiter. What's up tonight? Or, is Saturn up?",
      demo: async () => { Sound.earcon("listen"); },
    },
    {
      title: "Hold still to learn more",
      text: "When you hold still on the Moon, a planet, or a bright star, I'll tell you what it is. Then you can ask: describe it, what's nearby, how far is it, or, take me there. You can also ask questions like, why do stars twinkle?",
    },
    {
      title: "You're ready",
      text: "That's the tour. Say help any time to hear what you can ask, show menu to see every button, or tutorial to hear this again. Say next, or tap anywhere, to finish.",
    },
  ];

  let i = 0;
  let token = 0;
  let onDone = null;

  function render() {
    const s = STEPS[i];
    $("tutStep").textContent = `${i + 1} of ${STEPS.length}`;
    $("tutTitle").textContent = s.title;
    $("tutText").textContent = s.text;
    $("tutReplay").hidden = !s.demo;
    $("tutBack").disabled = i === 0;
    $("tutNext").textContent = i === STEPS.length - 1 ? "Start exploring" : "Next";
    const dots = $("tutDots");
    dots.textContent = "";
    STEPS.forEach((_, k) => { const d = document.createElement("span"); if (k === i) d.className = "on"; dots.appendChild(d); });
  }

  // speak the step, then play its example sound once the speech has finished
  async function play() {
    const my = ++token;
    const s = STEPS[i];
    Voice.say(`${s.title}. ${s.text}`);
    if (!s.demo) return;
    await wait(400);
    for (let k = 0; k < 160 && Voice.speaking(); k++) await wait(150);
    if (my !== token) return;
    await wait(300);
    s.demo();
  }

  function go(k) {
    i = Math.max(0, Math.min(STEPS.length - 1, k));
    render();
    play();
  }

  function next() { if (i >= STEPS.length - 1) finish(); else go(i + 1); }
  function back() { if (i > 0) go(i - 1); }
  function replay() { token++; const s = STEPS[i]; if (s.demo) s.demo(); }

  // spoken controls while the tutorial is open
  const SAY = {
    next: /\b(next|continue|go on|keep going|okay|ok|got it|yes|forward|move on|ready|done)\b/,
    back: /\b(back|previous|go back|last one|before)\b/,
    repeat: /\b(repeat|again|replay|huh|pardon|one more time)\b/,
    skip: /\b(skip|stop|exit|close|finish|end|enough|start exploring|im ready|i know|leave)\b/,
  };
  function heard(alts) {
    for (const a of alts) {
      const t = a.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (SAY.skip.test(t)) return finish();
      if (SAY.back.test(t)) return back();
      if (SAY.repeat.test(t)) return go(i);
      if (SAY.next.test(t)) return next();
      if (t === "what" || t === "sorry") return go(i);
    }
  }

  function open(done) {
    onDone = done || null;
    if (typeof Listen !== "undefined" && Listen.supported()) Listen.setOpenMic(true, heard);
    const d = $("tutorial");
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
    go(0);
    setTimeout(() => $("tutNext").focus(), 50);
  }

  function finish() {
    token++;
    if (typeof Listen !== "undefined") Listen.setOpenMic(false);
    Voice.cancel();
    const d = $("tutorial");
    if (d.close) d.close(); else d.removeAttribute("open");
    if (onDone) onDone();
  }

  function isOpen() { return $("tutorial").open; }

  // controls: tap anywhere on the card to advance; buttons for back, replay, and skip
  $("tutorial").addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    next();
  });
  $("tutNext").addEventListener("click", next);
  $("tutBack").addEventListener("click", back);
  $("tutReplay").addEventListener("click", replay);
  $("tutSkip").addEventListener("click", finish);
  $("tutorial").addEventListener("cancel", (e) => { e.preventDefault(); finish(); }); // Escape key
  $("tutorial").addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight") { e.preventDefault(); next(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
  });

  return { open, isOpen, STEPS };
})();
