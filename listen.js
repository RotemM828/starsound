// listen.js — voice input using the browser's built-in speech recognition.
//
// No accounts, no API keys: Chrome (Android, desktop) and Safari (iPhone, iPad, Mac)
// include speech recognition. Chrome sends the audio to Google's servers to turn it
// into text, so voice commands need an internet connection; every command also has
// a button, so the app still works offline.
//
// Two ways to listen:
//  1. Tap to talk: tap the Talk button (or anywhere on the screen) -> rising chime ->
//     say one command -> falling chime.
//  2. Hands-free: the microphone stays on. Commands start with the wake phrase
//     "Hey Star" ("Hey Star, find Jupiter"), so normal conversation is ignored.
//     Saying just "Hey Star" arms it for the next sentence. The microphone pauses
//     while the app is talking, so it never hears itself.
//     Follow-ups: right after the app finishes speaking, a soft chime plays and for
//     a few seconds you can reply without the wake phrase ("describe it").

const Listen = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let active = false;          // a recognition session is running
  let mode = "off";            // "off" | "once" | "handsfree"
  let armedUntil = 0;          // hands-free: accept a command without the wake phrase until then
  let isSpeaking = () => false;
  let watchdog = null;
  let handlers = { onCommand: () => {}, onState: () => {}, onWake: () => {}, onFollowUp: () => {} };
  let wasSpeaking = false;
  const FOLLOW_UP_MS = 7000;

  const WAKE = /^(hey |hi |ok |okay )?(star sound|starsound|stars|star|starr|starz)\b[ ,.!]*/i;

  function supported() { return !!SR; }
  function listening() { return mode === "once" && active; }
  function handsFree() { return mode === "handsfree"; }
  function setHandlers(h) { handlers = { ...handlers, ...h }; }
  function setSpeakingCheck(fn) { isSpeaking = fn; }

  // --- tap to talk ---
  function start() {
    if (!SR) { handlers.onState("unsupported"); return; }
    if (mode === "handsfree") { armedUntil = Date.now() + 8000; handlers.onWake(); return; }
    if (active) { stop(); return; }
    mode = "once";
    handlers.onState("start");
    setTimeout(() => begin(false), 280); // pause so the start chime isn't picked up
  }

  function begin(continuous) {
    rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.continuous = continuous;
    rec.maxAlternatives = 4;
    let gotResult = false;
    rec.onresult = (e) => {
      gotResult = true;
      const res = e.results[e.results.length - 1];
      if (!res.isFinal && res.isFinal !== undefined) return;
      const alts = [];
      for (let i = 0; i < res.length; i++) alts.push(res[i].transcript);
      if (mode === "handsfree") handleHandsFree(alts);
      else handlers.onCommand(alts, { wake: true });
    };
    rec.onerror = (e) => {
      gotResult = true;
      if (mode === "handsfree") {
        if (e.error === "not-allowed" || e.error === "service-not-allowed" || e.error === "audio-capture") {
          setHandsFree(false);
          handlers.onState("error", e.error);
        }
        return; // no-speech / network blips: the watchdog restarts us
      }
      handlers.onState("error", e.error);
    };
    rec.onend = () => {
      active = false;
      if (mode === "once") { mode = "off"; handlers.onState("end", gotResult ? null : "no-speech"); }
    };
    try { rec.start(); active = true; }
    catch (err) {
      active = false;
      if (mode === "once") { mode = "off"; handlers.onState("error", "start-failed"); }
    }
  }

  function stop() {
    if (rec) { try { rec.stop(); } catch (_) {} }
  }

  // --- hands-free ---
  function handleHandsFree(alts) {
    const now = Date.now();
    for (const a of alts) {
      const text = a.trim();
      const m = text.match(WAKE);
      if (m) {
        const rest = text.slice(m[0].length).trim();
        if (!rest) { armedUntil = now + 8000; handlers.onWake(); return; }
        armedUntil = 0;
        handlers.onCommand([rest, ...alts.filter((x) => x !== a).map((x) => x.replace(WAKE, "").trim())], { wake: true });
        return;
      }
    }
    // within the follow-up window (or after a bare "Hey Star"), no wake phrase is needed
    if (now < armedUntil) { armedUntil = 0; handlers.onCommand(alts, { wake: false }); }
    // otherwise: ordinary conversation, ignore it
  }

  function setHandsFree(on) {
    if (on && !SR) { handlers.onState("unsupported"); return false; }
    clearInterval(watchdog);
    if (on) {
      mode = "handsfree";
      // keep the microphone running, but switch it off while the app is talking
      watchdog = setInterval(() => {
        if (mode !== "handsfree") return;
        if (isSpeaking()) { if (active) { try { rec.abort(); } catch (_) {} active = false; } return; }
        if (!active) begin(true);
      }, 400);
    } else {
      mode = "off";
      if (rec) { try { rec.abort(); } catch (_) {} }
      active = false;
    }
    return on;
  }

  // called when the app finishes speaking: for a few seconds, a reply needs no wake phrase
  function speechDone() {
    if (mode !== "handsfree") return;
    armedUntil = Date.now() + FOLLOW_UP_MS;
    handlers.onFollowUp();
  }

  return { supported, listening, handsFree, setHandlers, setSpeakingCheck, start, stop, setHandsFree, speechDone, WAKE };
})();
