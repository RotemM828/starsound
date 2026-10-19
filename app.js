// app.js — ties it together: builds tonight's sky, listens to where the phone
// points, plays the stars in view, and speaks names when you lock onto one.

(() => {
  const DEFAULT_LOC = { lat: 34.1459, lon: -118.8059, label: "Westlake Village" };
  const FOV_HALF = 14;       // degrees: stars within this cone of where you aim are audible
  const LOCK_ANGLE = 4;      // degrees: aim this close to a named object to hear its name
  const MAX_VOICES = 8;      // loudest N stars in view play at once

  const el = (id) => document.getElementById(id);
  const S = window.SKY_DATA;

  const app = {
    loc: { ...DEFAULT_LOC },
    timeMode: "now",        // "now" | "tonight" (9 PM local, handy for daytime demos)
    objects: [],            // stars + planets with ENU vectors for the current time
    running: false,
    paused: false,
    mode: "explore",        // "explore" | "find"
    target: null,
    nextPing: new Map(),
    lock: { id: null, since: 0 },
    announced: new Map(),   // id -> time last announced
    lastCon: null, conSince: 0,
    belowWarned: false,
    lastVec: [0, 1, 0], speed: 0, lastFrame: performance.now(),
    nextHint: 0, nextTick: 0,
    playingMelody: false, melodyToken: 0,
    listening: false,
    tour: null,             // { stops: [target...], i }
    lastTopic: null,        // { kind: "obj", id } | { kind: "con", id } for "tell me more"
    storyHintGiven: false,
  };

  // ---------- saved settings (this phone only) ----------
  const Prefs = {
    load() { try { return JSON.parse(localStorage.getItem("starsound-prefs") || "{}"); } catch (_) { return {}; } },
    save(p) { try { localStorage.setItem("starsound-prefs", JSON.stringify({ ...Prefs.load(), ...p })); } catch (_) {} },
  };

  // ---------- sky ----------
  function skyDate() {
    const d = new Date();
    if (app.timeMode === "tonight") {
      d.setHours(21, 0, 0, 0);
    }
    return d;
  }

  function rebuildSky() {
    const date = skyDate();
    const lst = Astro.localSiderealTime(date, app.loc.lon);
    const stars = S.stars.map((s, i) => ({
      id: "s" + i, idx: i, kind: "star", star: s, mag: s.mag,
      vec: Astro.equatorialToENU(s.ra, s.dec, app.loc.lat, lst),
      freq: Sound.pitchFromColor(s.bv),
    }));
    const bodies = Astro.solarSystem(date, app.loc.lat, app.loc.lon).map((b) => ({
      id: "p" + b.name, kind: b.name === "Moon" ? "moon" : "planet", name: b.name,
      mag: b.mag, vec: b.vec,
      freq: b.name === "Moon" ? 196 : { Mercury: 1047, Venus: 880, Mars: 330, Jupiter: 262, Saturn: 220 }[b.name],
    }));
    app.objects = stars.concat(bodies);
    app.byId = new Map(app.objects.map((o) => [o.id, o]));
    app.date = date;
    app.lst = lst;
  }

  // ---------- describing things in words ----------
  const COLOR_WORDS = { O: "blue", B: "blue-white", A: "white", F: "yellow-white",
    G: "yellow, like our Sun", K: "orange", M: "red" };
  const PLANET_FACTS = {
    Mercury: "the closest planet to the Sun",
    Venus: "the brightest planet, covered in thick clouds",
    Mars: "the red planet",
    Jupiter: "the largest planet",
    Saturn: "the ringed planet",
  };

  function nameOf(o) {
    if (o.kind !== "star") return o.name;
    return o.star.name || o.star.bayer || null;
  }

  function whereWords(o) {
    const { alt, az } = Astro.enuToAltAz(o.vec);
    if (alt < 0) return "below the horizon, toward the " + Astro.compassWord(az);
    const height = alt > 70 ? "nearly overhead" : alt > 40 ? "high" : alt > 15 ? "partway up" : "low";
    return `${height} in the ${Astro.compassWord(az)}, ${Math.round(alt)} degrees up`;
  }

  function describe(o, { withPlace = false } = {}) {
    const parts = [];
    if (o.kind === "moon") {
      const ph = Astro.moonPhase(app.date);
      if (!ph) parts.push("The Moon");
      else {
        const phase = /moon/.test(ph.name) ? `a ${ph.name}` : /quarter/.test(ph.name) ? `at ${ph.name}` : ph.name;
        parts.push(`The Moon, ${phase}, ${ph.lit} percent lit`);
      }
    } else if (o.kind === "planet") {
      parts.push(`${o.name}, ${PLANET_FACTS[o.name] || "a planet"}`);
    } else {
      const s = o.star;
      const name = nameOf(o);
      const con = s.con && S.cons[s.con];
      parts.push(name ? `${name}${con && s.name ? ", in " + con : ""}` : `A star in ${con || "the sky"}`);
      const color = COLOR_WORDS[s.sp];
      const bright = s.mag < 0.5 ? "One of the brightest stars in the sky" : s.mag < 1.6 ? "A very bright star" : "";
      if (bright && color) parts.push(`${bright}, ${color}`);
      else if (color) parts.push(`A ${color.split(",")[0]} star`);
      if (s.ly) parts.push(`About ${s.ly.toLocaleString()} light-years away`);
    }
    if (withPlace) parts.push(capitalize(whereWords(o)));
    return parts.join(". ") + ".";
  }

  function capitalize(t) { return t.charAt(0).toUpperCase() + t.slice(1); }

  // ---------- stories ("tell me more") ----------
  const STORIES = window.STORIES || { stars: {}, planets: {}, cons: {} };

  function storyForObject(o) {
    if (o.kind !== "star") return STORIES.planets[o.name] || null;
    return (o.star.name && STORIES.stars[o.star.name]) || null;
  }

  function hasStory(o) {
    return !!(storyForObject(o) || (o.kind === "star" && o.star.con && STORIES.cons[o.star.con]));
  }

  function tellMore(topic) {
    topic = topic || app.lastTopic;
    if (!topic) {
      const con = constellationAt(Sensors.state.vec);
      topic = con ? { kind: "con", id: con } : null;
    }
    if (!topic) { Voice.say("Point at something first, then say tell me more."); return; }
    if (topic.kind === "con") {
      const s = STORIES.cons[topic.id];
      Voice.say(s || `${S.cons[topic.id]}. I don't have a story for this constellation yet.`);
      return;
    }
    const o = app.byId.get(topic.id);
    if (!o) return;
    const s = storyForObject(o);
    if (s) { Voice.say(s); return; }
    const con = o.kind === "star" && o.star.con;
    if (con && STORIES.cons[con]) Voice.say(`${nameOf(o)} is part of ${S.cons[con]}. ${STORIES.cons[con]}`);
    else Voice.say(`I don't have a story for ${nameOf(o) || "this star"} yet. ${describe(o)}`);
  }

  // ---------- turning spoken names into targets ----------
  const DIRECTIONS = {
    north: { alt: 20, az: 0, label: "north" }, east: { alt: 20, az: 90, label: "east" },
    south: { alt: 20, az: 180, label: "south" }, west: { alt: 20, az: 270, label: "west" },
    up: { alt: 90, az: 0, label: "straight up" },
  };

  function buildVocabulary() {
    const v = [];
    for (const n of ["Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn"]) v.push({ key: n, ref: "planet:" + n });
    for (const s of S.stars) if (s.name) v.push({ key: s.name, ref: "star:" + s.name });
    for (const [id, name] of Object.entries(S.cons)) if (S.lines[id]) v.push({ key: name, ref: "con:" + id });
    Commands.setVocabulary(v);
  }

  function resolveRef(ref) {
    const [kind, name] = ref.split(":");
    if (kind === "planet" && name === "Sun") return { type: "sun", id: "Sun", label: "the Sun" };
    if (kind === "planet") return { type: "object", id: "p" + name, label: name === "Moon" ? "the Moon" : name };
    if (kind === "star") {
      const i = S.stars.findIndex((s) => s.name === name);
      return i >= 0 ? { type: "object", id: "s" + i, label: name } : null;
    }
    if (kind === "con") return S.lines[name] ? { type: "con", id: name, label: S.cons[name] } : null;
    if (kind === "dir") return DIRECTIONS[name] ? { type: "dir", id: name, label: DIRECTIONS[name].label } : null;
    return null;
  }

  // The official constellation that contains the direction you're aiming.
  function constellationAt(vec) {
    const eq = Astro.enuToEquatorial(vec, app.loc.lat, app.lst);
    return Astro.constellationOf(eq.ra, eq.dec, S.bounds);
  }

  // ---------- main loop ----------
  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.max(1, now - app.lastFrame) / 1000;
    app.lastFrame = now;
    const f = Sensors.update();
    app.speed = app.speed * 0.8 + 0.2 * (Astro.angleBetween(f, app.lastVec) / dt);
    app.lastVec = f;
    draw(f);
    updateStatus(f);
    if (!app.running || app.paused || app.listening) return;

    if (app.mode === "find") findStep(f, now);
    else if (!app.playingMelody) exploreStep(f, now);
  }

  function exploreStep(f, now) {
    const basis = Astro.viewBasis(f);
    const aimAlt = Astro.enuToAltAz(f).alt;
    const showBelow = el("below").checked;

    if (aimAlt < -5 && !showBelow) {
      if (!app.belowWarned) { Voice.say("Below the horizon. Aim higher."); app.belowWarned = true; }
      return;
    }
    if (aimAlt > 0) app.belowWarned = false;

    // which objects are in the listening cone?
    const inView = [];
    for (const o of app.objects) {
      if (!showBelow && o.vec[2] < 0) continue;
      const a = Astro.angleBetween(f, o.vec);
      if (a > FOV_HALF) continue;
      const centered = 1 - a / FOV_HALF;
      inView.push({ o, a, centered, score: Sound.loudnessFromMagnitude(o.mag) * (0.3 + centered) });
    }
    inView.sort((x, y) => y.score - x.score);
    const playing = inView.slice(0, MAX_VOICES);

    for (const v of playing) {
      const next = app.nextPing.get(v.o.id) || 0;
      if (now < next) continue;
      const view = Astro.toView(basis, v.o.vec);
      const gain = Math.min(1, Sound.loudnessFromMagnitude(v.o.mag)) * (0.25 + 0.75 * v.centered);
      Sound.ping(view, v.o.freq, gain, v.o.kind === "star" ? "star" : v.o.kind);
      const interval = 1500 - 1150 * v.centered;            // twinkle faster near center
      app.nextPing.set(v.o.id, now + interval * (0.85 + Math.random() * 0.3));
    }

    // lock-on: hold a named object near the center to hear about it
    let lockObj = null, la = LOCK_ANGLE;
    for (const v of inView) {
      if (v.a < la && nameOf(v.o) && (v.o.kind !== "star" || v.o.mag < 3.5)) { la = v.a; lockObj = v.o; }
    }
    if (!lockObj) { app.lock.id = null; }
    else if (app.lock.id !== lockObj.id) { app.lock = { id: lockObj.id, since: now }; }
    else if (now - app.lock.since > 450) {
      const last = app.announced.get(lockObj.id) ?? -Infinity;
      if (now - last > 15000) {
        app.announced.set(lockObj.id, now);
        app.lastTopic = { kind: "obj", id: lockObj.id };
        logObject(lockObj);
        let text = describe(lockObj);
        if (!app.storyHintGiven && hasStory(lockObj)) {
          text += " Say tell me more for its story.";
          app.storyHintGiven = true;
        }
        Voice.say(text);
        Sound.buzz(40);
        return;
      }
    }

    // gently name the constellation you're sweeping through, once you slow down
    if (el("conNames").checked && app.speed < 10) {
      const con = constellationAt(f);
      if (con !== app.lastCon) { app.lastCon = con; app.conSince = now; }
      else if (con && now - app.conSince > 1200 && app.announcedCon !== con && !Voice.speaking()) {
        app.announcedCon = con;
        app.lastTopic = { kind: "con", id: con };
        Voice.say(S.cons[con], { interrupt: false });
      }
    }
  }

  // ---------- find mode: a sonar beacon that leads you to a target ----------
  // target = { type: "object" | "con" | "dir", id, label }
  function targetVec(t = app.target) {
    if (!t) return null;
    if (t.type === "object") return app.byId.get(t.id).vec;
    if (t.type === "dir") { const d = DIRECTIONS[t.id]; return Astro.altAzToENU(d.alt, d.az); }
    // constellation: average direction of its line stars
    const idxs = [...new Set(S.lines[t.id].flat())];
    let v = [0, 0, 0];
    for (const i of idxs) { const o = app.objects[i]; v = [v[0] + o.vec[0], v[1] + o.vec[1], v[2] + o.vec[2]]; }
    return Astro.normalize(v);
  }

  function findStep(f, now) {
    const tv = targetVec();
    if (!tv) return;
    const angle = Astro.angleBetween(f, tv);
    const basis = Astro.viewBasis(f);
    const dir = Astro.normalize(Astro.toView(basis, tv)); // tick comes FROM the target's direction
    const t = app.target;
    const foundAngle = t.type === "con" ? 8 : t.type === "dir" ? 10 : 3;

    if (angle < foundAngle) { onFound(t); return; }

    if (now >= app.nextTick) {
      Sound.tick(1 - angle / 180, dir);
      app.nextTick = now + Math.max(90, Math.min(1100, angle * 12));
    }

    if (now >= app.nextHint && !Voice.speaking()) {
      const p = Astro.enuToAltAz(f), ta = Astro.enuToAltAz(tv);
      const dAz = ((ta.az - p.az + 540) % 360) - 180;
      const dAlt = ta.alt - p.alt;
      const hints = [];
      if (Math.abs(dAz) > 5 && ta.alt < 80) hints.push(`${dAz > 0 ? "Turn right" : "Turn left"} ${Math.round(Math.abs(dAz) / 5) * 5}`);
      if (Math.abs(dAlt) > 5) hints.push(`${dAlt > 0 ? "Raise" : "Lower"} ${Math.round(Math.abs(dAlt) / 5) * 5}`);
      if (hints.length) Voice.say(hints.join(". ") + ".", { interrupt: false });
      app.nextHint = now + 4500;
    }
  }

  function onFound(t) {
    Sound.chime();
    Sound.buzz([60, 60, 120]);
    const now = performance.now();
    app.mode = "explore"; app.target = null;
    el("findBtn").textContent = "Start finding";
    let text, conId = null;
    if (t.type === "dir") {
      text = t.id === "up" ? "You're pointing straight up." : `You're facing ${t.label}.`;
    } else if (t.type === "object") {
      const o = app.byId.get(t.id);
      app.announced.set(t.id, now); // don't repeat it on lock-on
      app.lastTopic = { kind: "obj", id: t.id };
      logObject(o);
      text = `Found it. ${describe(o)}`;
      if (app.tour) { const s = storyForObject(o); if (s) text += " " + s; }
    } else {
      conId = t.id;
      app.lastTopic = { kind: "con", id: conId };
      Log.add(S.cons[conId], "con");
      text = `Found ${t.label}.`;
      if (app.tour && STORIES.cons[conId]) text += " " + STORIES.cons[conId];
    }
    if (app.tour) {
      const last = app.tour.i >= app.tour.stops.length - 1;
      text += last ? " That was the last stop. Thanks for touring the sky!" : " Say next, or tap Next stop, when you're ready.";
      if (last) endTour(false);
    } else if (conId) {
      text += " Playing its shape.";
    }
    Voice.say(text);
    if (conId) waitForSpeech().then(() => playConstellation(conId));
  }

  async function waitForSpeech() {
    await wait(400);
    for (let i = 0; i < 120 && Voice.speaking(); i++) await wait(250);
    await wait(300);
  }

  function findTarget(target, { quiet = false } = {}) {
    if (!target) return;
    if (target.type === "object" && !app.byId.get(target.id)) return;
    app.melodyToken++; app.playingMelody = false;
    app.target = target;
    app.mode = "find"; app.nextTick = 0;
    el("findBtn").textContent = "Stop finding";
    const tv = targetVec();
    let intro;
    if (target.type === "dir") {
      intro = `Finding ${target.label}. Follow the ticking; it gets faster as you get closer.`;
    } else {
      const where = whereWords({ vec: tv });
      intro = `Finding ${target.label}. It is ${where}.`;
      if (tv[2] < 0) intro += " It's below the horizon right now, so you'll be pointing at the ground.";
      intro += quiet ? "" : " Follow the ticking; it gets faster as you get closer.";
    }
    Voice.say(intro);
    app.nextHint = performance.now() + 6000;
  }

  function startFind() {
    if (app.mode === "find") { stopAll(); return; }
    const val = el("target").value;
    if (!val) return;
    const [type, id] = val.split(":");
    findTarget({ type, id, label: el("target").selectedOptions[0].textContent });
  }

  function stopAll(say = true) {
    const was = app.mode === "find" || app.tour || app.playingMelody;
    app.melodyToken++; app.playingMelody = false;
    app.mode = "explore"; app.target = null;
    el("findBtn").textContent = "Start finding";
    if (app.tour) endTour(false);
    if (say) Voice.say(was ? "Stopped. Back to exploring." : "Exploring.");
  }

  // ---------- guided tour of tonight's sky ----------
  const TOUR_CONS = ["Ori", "UMa", "Cyg", "Sco", "Sgr", "Cas", "Leo", "Lyr", "Tau", "Gem", "Peg", "CMa", "Boo", "Aql", "And", "Aur", "UMi"];

  function buildTourStops() {
    const stops = [];
    const up = (v, minAlt = 15) => Astro.enuToAltAz(v).alt > minAlt;
    const moon = app.byId.get("pMoon");
    if (moon && up(moon.vec, 10)) stops.push({ type: "object", id: "pMoon", label: "the Moon" });
    for (const n of ["Jupiter", "Saturn", "Venus", "Mars"]) {
      const p = app.byId.get("p" + n);
      if (p && up(p.vec, 12)) stops.push({ type: "object", id: "p" + n, label: n });
    }
    const consUp = TOUR_CONS
      .map((id) => ({ id, alt: Astro.enuToAltAz(targetVec({ type: "con", id })).alt }))
      .filter((c) => c.alt > 25);
    for (const c of consUp) {
      if (stops.length >= 6) break;
      stops.push({ type: "con", id: c.id, label: S.cons[c.id] });
    }
    // one bright named star if there's room
    const star = app.objects.filter((o) => o.kind === "star" && o.star.name && STORIES.stars[o.star.name] && up(o.vec, 20))
      .sort((a, b) => a.mag - b.mag)[0];
    if (star) {
      // don't visit a star and its own constellation separately
      const dup = stops.findIndex((s) => s.type === "con" && s.id === star.star.con);
      if (dup >= 0) stops.splice(dup, 1);
      stops.splice(Math.min(2, stops.length), 0, { type: "object", id: star.id, label: star.star.name });
    }
    return stops.slice(0, 6);
  }

  function startTour() {
    const stops = buildTourStops();
    if (!stops.length) { Voice.say("Nothing bright enough is up for a tour right now."); return; }
    app.tour = { stops, i: 0 };
    el("nextBtn").hidden = false;
    const names = stops.map((s) => s.label);
    Voice.say(`Tour of the sky, ${stops.length} stops: ${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}. First stop.`);
    waitForSpeech().then(() => { if (app.tour) findTarget(stops[0], { quiet: false }); });
  }

  function nextStop() {
    if (!app.tour) { Voice.say("No tour is running. Say take me on a tour to start one."); return; }
    app.tour.i++;
    if (app.tour.i >= app.tour.stops.length) { endTour(true); return; }
    findTarget(app.tour.stops[app.tour.i], { quiet: true });
  }

  function endTour(say) {
    app.tour = null;
    el("nextBtn").hidden = true;
    if (say) Voice.say("That's the end of the tour.");
  }

  // ---------- constellation melody ----------
  async function playConstellation(conId) {
    conId = conId || constellationAt(Sensors.state.vec);
    if (!conId || !S.lines[conId]) { Voice.say("No constellation pattern here. Try another part of the sky."); return; }
    const token = ++app.melodyToken;
    app.playingMelody = true;
    app.announcedCon = conId;
    app.lastTopic = { kind: "con", id: conId };
    Voice.say(`The shape of ${S.cons[conId]}.`);
    await wait(1100);
    const basis = Astro.viewBasis(Sensors.state.vec);
    for (const seg of S.lines[conId]) {
      for (const i of seg) {
        if (token !== app.melodyToken) return;
        const o = app.objects[i];
        const view = Astro.toView(basis, o.vec);
        Sound.ping(view, o.freq, Math.max(0.25, Math.min(1, Sound.loudnessFromMagnitude(o.mag) * 2)), "star", 0.7);
        await wait(280);
      }
      await wait(220); // little breath between line segments
    }
    if (token === app.melodyToken) app.playingMelody = false;
  }

  // ---------- "tell me about X" without moving ----------
  function aboutTarget(target) {
    if (!target) return;
    if (target.type === "object") {
      const o = app.byId.get(target.id);
      app.lastTopic = { kind: "obj", id: o.id };
      const s = storyForObject(o);
      Voice.say(`${describe(o, { withPlace: true })}${s ? " " + s : ""} Say find ${target.label} to go there.`);
    } else if (target.type === "con") {
      app.lastTopic = { kind: "con", id: target.id };
      const where = whereWords({ vec: targetVec(target) });
      Voice.say(`${target.label} is ${where}. ${STORIES.cons[target.id] || ""}`);
    } else {
      findTarget(target);
    }
  }

  // ---------- voice commands ----------
  function runCommand(cmd) {
    const a = cmd.action;
    if (["find", "about", "riseSet", "visible", "distance", "logHas"].includes(a)) {
      const target = resolveRef(cmd.ref);
      if (!target) { Voice.say("I couldn't find that in tonight's sky data."); return; }
      if (a === "riseSet") return answerRiseSet(target, cmd.dir);
      if (a === "visible") return answerVisible(target);
      if (a === "distance") return answerDistance(target);
      if (a === "logHas") return logHas(target);
      if (target.type === "sun") {
        return Voice.say(`StarSound doesn't guide you to the Sun, so nobody nearby looks straight at it. ${sunAltitudeAt(new Date()) > 0 ? "It's up now." : "It's below the horizon now."} You can ask when the Sun rises or sets.`);
      }
      if (a === "find") findTarget(target); else aboutTarget(target);
      return;
    }
    switch (a) {
      case "here": return whatsHere();
      case "faq": return Voice.say(cmd.answer);
      case "log": return logSummary(cmd.period);
      case "logClear": app.confirmClear = Date.now(); return Voice.say("This erases everything you've logged. To be sure, say confirm clear.");
      case "logClearConfirm":
        if (app.confirmClear && Date.now() - app.confirmClear < 30000) { Log.clear(); app.confirmClear = 0; return Voice.say("Your log is cleared."); }
        return Voice.say("To erase your log, first say clear my log.");
      case "moonPhase": return answerMoonPhase();
      case "nextFull": return answerNextPhase("full");
      case "nextNew": return answerNextPhase("new");
      case "dark": return answerDark();
      case "meteors": return answerMeteors();
      case "handsFreeOn": return setHandsFree(true);
      case "handsFreeOff": return setHandsFree(false);
      case "tonight": return skyTonight();
      case "constellation": return playConstellation();
      case "tour": return startTour();
      case "next": return nextStop();
      case "more": return tellMore();
      case "stop": return stopAll();
      case "help": return Voice.say(Commands.HELP);
      case "tutorial": return tutorial();
      case "pause": return setPaused(true);
      case "resume": return setPaused(false);
      case "repeat": return Voice.repeat();
      case "calibrate": return calibrate();
      case "louder": case "quieter": {
        const v = Sound.setVolume(Sound.getVolume() + (a === "louder" ? 0.25 : -0.25));
        el("volume").value = v; Prefs.save({ volume: v });
        Sound.ping([0, 0, 1], 660, 0.6, "star", 0.4);
        return Voice.say(a === "louder" ? "Louder." : "Quieter.");
      }
      case "slower": case "faster": {
        const r = Voice.setRate(Voice.getRate() + (a === "faster" ? 0.15 : -0.15));
        el("rate").value = r; Prefs.save({ rate: r });
        return Voice.say(a === "faster" ? "Speaking faster." : "Speaking slower.");
      }
      case "timeNow": el("timeMode").value = "now"; app.timeMode = "now"; rebuildSky(); return Voice.say("Showing the sky right now.");
      case "timeTonight": el("timeMode").value = "tonight"; app.timeMode = "tonight"; rebuildSky(); return Voice.say("Showing the sky at 9 PM tonight.");
      case "findUnknown":
        Sound.earcon("error");
        return Voice.say(`I don't know ${cmd.said || "that"} yet. Try a planet, a bright star, or a constellation, like Find Orion.`);
      default:
        Sound.earcon("error");
        return Voice.say(cmd.heard ? `Sorry, I heard: ${cmd.heard}. Say help to hear what you can say.` : "I didn't catch that.");
    }
  }

  function talk() {
    if (!app.running) return;
    if (!Listen.supported()) {
      Voice.say("Voice commands aren't supported in this browser. Try Chrome on Android, or Safari on iPhone. All the buttons still work.");
      return;
    }
    Voice.cancel();
    Listen.start();
  }

  function onWake() {
    Voice.cancel();
    Sound.earcon("listen");
    Sound.buzz(30);
  }

  function onListenState(state, err) {
    if (state === "start") {
      app.listening = true;
      el("talkBtn").textContent = "Listening… tap to stop";
      el("talkBtn").setAttribute("aria-pressed", "true");
      Sound.earcon("listen");
      return;
    }
    if (state === "unsupported") return;
    app.listening = false;
    el("talkBtn").textContent = "Talk";
    el("talkBtn").setAttribute("aria-pressed", "false");
    if (state === "end" && !err) return;
    const reasons = {
      "not-allowed": "Microphone access is blocked. Allow the microphone in your browser settings, or use the buttons.",
      "service-not-allowed": "Voice commands aren't available here. On iPhone, make sure Siri and dictation are turned on.",
      "network": "Voice commands need an internet connection. Everything else still works offline.",
      "audio-capture": "I couldn't find a microphone.",
      "no-speech": "I didn't hear anything. Tap Talk and try again.",
      "aborted": null,
    };
    const msg = err in reasons ? reasons[err] : "Something went wrong with the microphone. Try again.";
    if (msg) { Sound.earcon("error"); Voice.say(msg); }
  }

  function setPaused(p) {
    app.paused = p;
    el("pauseBtn").textContent = app.paused ? "Resume sounds" : "Pause sounds";
    el("pauseBtn").setAttribute("aria-pressed", String(app.paused));
    Voice.say(p ? "Star sounds paused." : "Star sounds on.");
  }

  function tutorial() {
    Voice.say(
      "Here's how StarSound works. Hold your phone up like you're taking a photo of the sky, and use headphones. " +
      "Every star in front of the phone plays a note. Brighter stars are louder. Blue, hot stars sound high, and red, cooler stars sound low. " +
      "Stars to your left sound on your left. Stars twinkle faster as you aim right at them, and if you hold still on a bright star, I'll tell you its name. " +
      "The Moon and planets have their own sounds. To find something, tap Talk and say Find, then its name, and follow the ticking. " +
      "Say help any time to hear all the commands.");
  }

  // ---------- observing log: "what have I seen this month?" ----------
  // Every planet, bright star or constellation you find (or hold still on) is saved
  // on this phone with the date. Nothing leaves the device.
  const Log = {
    KEY: "starsound-log",
    all() { try { return JSON.parse(localStorage.getItem(this.KEY) || "[]"); } catch (_) { return []; } },
    add(name, kind) {
      if (!name) return;
      const list = this.all();
      const now = Date.now();
      // count each object once per night
      if (list.some((e) => e.n === name && now - e.t < 10 * 3600 * 1000)) return;
      list.push({ n: name, k: kind, t: now });
      try { localStorage.setItem(this.KEY, JSON.stringify(list.slice(-2000))); } catch (_) {}
    },
    clear() { try { localStorage.removeItem(this.KEY); } catch (_) {} },
    since(periodName) {
      const now = new Date();
      let start;
      if (periodName === "night") start = new Date(now.getTime() - 14 * 3600 * 1000);
      else if (periodName === "week") start = new Date(now.getTime() - 7 * 86400 * 1000);
      else if (periodName === "month") start = new Date(now.getFullYear(), now.getMonth(), 1);
      else if (periodName === "year") start = new Date(now.getFullYear(), 0, 1);
      else start = new Date(0);
      return this.all().filter((e) => e.t >= start.getTime());
    },
  };

  function logObject(o) {
    if (o.kind === "star") Log.add(o.star.name || o.star.bayer, "star");
    else Log.add(o.name, o.kind);
  }

  function listWords(arr) {
    if (arr.length <= 1) return arr.join("");
    return arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
  }

  function logSummary(periodName) {
    const label = { night: "tonight", week: "this week", month: "this month", year: "this year", all: "so far" }[periodName];
    const entries = Log.since(periodName);
    if (!entries.length) {
      Voice.say(`You haven't logged anything ${label} yet. Every planet, bright star, or constellation you find or hold still on gets saved automatically.`);
      return;
    }
    const uniq = (kinds) => [...new Set(entries.filter((e) => kinds.includes(e.k)).map((e) => e.n))];
    const planets = uniq(["planet", "moon"]).map((n) => (n === "Moon" ? "the Moon" : n));
    const stars = uniq(["star"]);
    const cons = uniq(["con"]);
    const parts = [];
    if (planets.length) parts.push(`${planets.length === 1 ? "one planet or moon" : planets.length + " planets and moons"}: ${listWords(planets)}`);
    if (stars.length) parts.push(`${stars.length === 1 ? "one star" : stars.length + " stars"}: ${listWords(stars.slice(0, 8))}${stars.length > 8 ? ", and more" : ""}`);
    if (cons.length) parts.push(`${cons.length === 1 ? "one constellation" : cons.length + " constellations"}: ${listWords(cons.slice(0, 8))}${cons.length > 8 ? ", and more" : ""}`);
    const nights = new Set(entries.map((e) => new Date(e.t).toDateString())).size;
    const joined = parts.length === 1 ? parts[0] : parts.slice(0, -1).join("; ") + "; and " + parts[parts.length - 1];
    Voice.say(`${capitalize(label)}, over ${nights === 1 ? "one night" : nights + " nights"}, you've found ${joined}.`);
  }

  function logHas(target) {
    const name = target.type === "object" ? nameOf(app.byId.get(target.id)) : target.label;
    const hits = Log.all().filter((e) => e.n === name);
    if (!hits.length) { Voice.say(`Not yet. Say find ${target.label} to look for it.`); return; }
    const last = new Date(hits[hits.length - 1].t);
    Voice.say(`Yes. You've found ${target.label} ${hits.length === 1 ? "once" : hits.length + " times"}, most recently on ${dayWords(last)}.`);
  }

  // ---------- sky questions: rise and set, moon phase, darkness, distance ----------
  function observer() { return new Astronomy.Observer(app.loc.lat, app.loc.lon, 0); }

  function timeWords(d) {
    const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `${dayWords(d, true)} at ${t}`;
  }

  function dayWords(d, relative = true) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((day - today) / 86400000);
    if (relative && diff === 0) return d.getHours() >= 17 ? "tonight" : "today";
    if (relative && diff === 1) return "tomorrow";
    if (relative && diff === -1) return "yesterday";
    return d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  }

  const BODY_NAMES = ["Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn"];

  // next rise or set within 2 days. Solar system bodies use astronomy-engine's search;
  // stars and constellations step through time with our own sky math.
  function nextRiseSet(target, dir) {
    const now = new Date();
    if (target.type === "sun" || (target.type === "object" && target.id.startsWith("p"))) {
      const body = target.type === "sun" ? "Sun" : target.id.slice(1);
      const res = Astronomy.SearchRiseSet(body, observer(), dir === "rise" ? +1 : -1, now, 2);
      return res ? res.date : null;
    }
    const raDec = targetRaDec(target);
    let prevUp = null;
    for (let m = 0; m <= 48 * 60; m += 4) {
      const d = new Date(now.getTime() + m * 60000);
      const lst = Astro.localSiderealTime(d, app.loc.lon);
      const up = Astro.equatorialToENU(raDec.ra, raDec.dec, app.loc.lat, lst)[2] > 0;
      if (prevUp !== null && up !== prevUp && (dir === "rise") === up) return d;
      prevUp = up;
    }
    return null;
  }

  function targetRaDec(target) {
    return Astro.enuToEquatorial(targetVec(target), app.loc.lat, app.lst);
  }

  function sunAltitudeAt(d) {
    const obs = observer();
    const eq = Astronomy.Equator("Sun", d, obs, true, true);
    return Astronomy.Horizon(d, obs, eq.ra, eq.dec).altitude;
  }

  function answerRiseSet(target, dir) {
    if (!target) return;
    const label = target.type === "sun" ? "the Sun" : target.label;
    const verb = dir === "rise" ? "rises" : "sets";
    const d = nextRiseSet(target, dir);
    if (d) { Voice.say(`${capitalize(label)} ${verb} ${timeWords(d)}.`); return; }
    const alt = target.type === "sun" ? sunAltitudeAt(new Date()) : Astro.enuToAltAz(targetVec(target)).alt;
    Voice.say(alt > 0 ? `${capitalize(label)} never sets from here; it circles the North Star all night.`
      : `${capitalize(label)} doesn't rise from here in the next two days.`);
  }

  function answerVisible(target) {
    if (target.type === "sun") {
      const alt = sunAltitudeAt(new Date());
      Voice.say(alt > 0 ? `Yes, the Sun is up. It sets ${timeWords(nextRiseSet(target, "set"))}.`
        : `No, the Sun is down. It rises ${timeWords(nextRiseSet(target, "rise"))}.`);
      return;
    }
    const vec = targetVec(target);
    const { alt } = Astro.enuToAltAz(vec);
    const label = capitalize(target.label);
    if (target.type === "dir") { findTarget(target); return; }
    if (alt > 0) {
      const set = nextRiseSet(target, "set");
      let t = `Yes. ${label} is ${whereWords({ vec })}.`;
      if (alt < 10) t += " That's very low, so trees or buildings may block it.";
      if (set) t += ` It sets ${timeWords(set)}.`;
      if (app.timeMode === "now" && sunAltitudeAt(new Date()) > -6) t += " The sky is still bright, though, so only the Moon and the brightest planets show up right now.";
      Voice.say(t);
    } else {
      const rise = nextRiseSet(target, "rise");
      Voice.say(`No, ${target.label} is below the horizon right now.${rise ? ` It rises ${timeWords(rise)}.` : ""}`);
    }
  }

  function answerDistance(target) {
    const AU_MILES = 92955807;
    if (target.type === "sun" || (target.type === "object" && target.id.startsWith("p"))) {
      const body = target.type === "sun" ? "Sun" : target.id.slice(1);
      const au = Astronomy.GeoVector(body, new Date(), true).Length();
      const lightMin = au * 8.3167;
      if (body === "Moon") {
        Voice.say(`The Moon is about ${Math.round(au * AU_MILES / 1000).toLocaleString()} thousand miles away right now. Its light takes about ${(lightMin * 60).toFixed(1)} seconds to reach you.`);
      } else {
        const miles = au * AU_MILES / 1e6;
        const big = miles >= 1000 ? `${(miles / 1000).toFixed(1)} billion` : `${Math.round(miles)} million`;
        const lt = lightMin >= 60 ? `${(lightMin / 60).toFixed(1)} hours` : `${Math.round(lightMin)} minutes`;
        Voice.say(`${body === "Sun" ? "The Sun" : body} is about ${big} miles away right now. Its light takes about ${lt} to reach you.`);
      }
      return;
    }
    if (target.type === "object") {
      const o = app.byId.get(target.id);
      Voice.say(o.star.ly ? `${target.label} is about ${o.star.ly.toLocaleString()} light-years away. The light you'd see tonight left it about ${o.star.ly.toLocaleString()} years ago.`
        : `I don't have a reliable distance for ${target.label}.`);
      return;
    }
    if (target.type === "con") {
      const ds = [...new Set(S.lines[target.id].flat())].map((i) => S.stars[i].ly).filter(Boolean).sort((a, b) => a - b);
      Voice.say(ds.length ? `The stars of ${target.label} aren't the same distance away. Its main stars range from about ${ds[0].toLocaleString()} to ${ds[ds.length - 1].toLocaleString()} light-years.`
        : `The stars of ${target.label} are at many different distances.`);
      return;
    }
    Voice.say("That's a direction, not an object.");
  }

  function answerMoonPhase() {
    const ph = Astro.moonPhase(new Date());
    const full = Astronomy.SearchMoonPhase(180, new Date(), 40);
    const neu = Astronomy.SearchMoonPhase(0, new Date(), 40);
    const moon = { type: "object", id: "pMoon", label: "the Moon" };
    const up = Astro.enuToAltAz(app.byId.get("pMoon").vec).alt > 0;
    const next = up ? `It's up now and sets ${timeWords(nextRiseSet(moon, "set"))}.` : `It rises ${timeWords(nextRiseSet(moon, "rise"))}.`;
    const nextPhase = full.date < neu.date ? `The next full moon is ${dayWords(full.date)}.` : `The next new moon is ${dayWords(neu.date)}.`;
    const phase = /moon/.test(ph.name) ? `a ${ph.name}` : /quarter/.test(ph.name) ? `at ${ph.name}` : `a ${ph.name} moon`;
    Voice.say(`The Moon is ${phase}, ${ph.lit} percent lit. ${next} ${nextPhase}`);
  }

  function answerNextPhase(which) {
    const res = Astronomy.SearchMoonPhase(which === "full" ? 180 : 0, new Date(), 40);
    const days = Math.round((res.date - new Date()) / 86400000);
    Voice.say(`The next ${which} moon is ${dayWords(res.date)}${days > 1 ? `, in ${days} days` : ""}.`);
  }

  function answerDark() {
    const obs = observer();
    const now = new Date();
    const alt = sunAltitudeAt(now);
    if (alt < -18) {
      const rise = Astronomy.SearchRiseSet("Sun", obs, +1, now, 1);
      Voice.say(`It's fully dark right now. The sky starts brightening about an hour and a half before sunrise, which is ${rise ? timeWords(rise.date) : "later"}.`);
      return;
    }
    const start = alt < 0 ? new Date(now.getTime() - 6 * 3600 * 1000) : now;
    const set = Astronomy.SearchRiseSet("Sun", obs, -1, start, 1);
    const civil = Astronomy.SearchAltitude("Sun", obs, -1, start, 1, -6);
    const astro = Astronomy.SearchAltitude("Sun", obs, -1, start, 1, -18);
    const hm = (d) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const sentences = [];
    if (set && set.date > now) sentences.push(`Sunset is ${timeWords(set.date)}.`);
    if (civil && civil.date > now) sentences.push(`The Moon, the brightest planets and the brightest stars show up around ${hm(civil.date)}.`);
    else sentences.push("The brightest stars and planets are already out.");
    if (astro) sentences.push(`It's fully dark by ${hm(astro.date)}.`);
    Voice.say(sentences.join(" ") + " Remember, StarSound works any time, even before dark.");
  }

  // Peak dates are approximate and shift by a day or so each year.
  const METEOR_SHOWERS = [
    { name: "Quadrantids", m: 0, d: 3, where: "the northeast, near the Big Dipper's handle" },
    { name: "Lyrids", m: 3, d: 22, where: "near Vega, in Lyra" },
    { name: "Eta Aquariids", m: 4, d: 6, where: "the east, before dawn" },
    { name: "Perseids", m: 7, d: 12, where: "the northeast, in Perseus" },
    { name: "Orionids", m: 9, d: 21, where: "Orion, which rises late in the evening" },
    { name: "Leonids", m: 10, d: 17, where: "Leo, which rises after midnight" },
    { name: "Geminids", m: 11, d: 14, where: "Gemini, high in the sky after about 10 PM" },
  ];

  function answerMeteors() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dated = METEOR_SHOWERS.map((s) => {
      let d = new Date(now.getFullYear(), s.m, s.d);
      if (d < new Date(today.getTime() - 2 * 86400000)) d = new Date(now.getFullYear() + 1, s.m, s.d);
      return { ...s, date: d };
    }).sort((a, b) => a.date - b.date);
    const s = dated[0];
    const days = Math.round((s.date - today) / 86400000);
    const when = days <= 0 ? "peaking right about now" : days === 1 ? "peaking tomorrow night" : days <= 7 ? `peaking in ${days} days, around ${dayWords(s.date, false)}` : `peaking around ${dayWords(s.date, false)}`;
    const after = dated[1];
    Voice.say(`The next big meteor shower is the ${s.name}, ${when}. The meteors seem to come from ${s.where}, and the best time is usually after midnight, away from city lights. After that comes the ${after.name}, around ${after.date.toLocaleDateString([], { month: "long", day: "numeric" })}.`);
  }

  function setHandsFree(on, { quiet = false } = {}) {
    if (on && !Listen.supported()) {
      Voice.say("Hands-free listening isn't supported in this browser. Try Chrome on Android, or Safari on iPhone.");
      return;
    }
    Listen.setHandsFree(on);
    el("handsFreeBtn").textContent = on ? "Hands-free: on" : "Hands-free: off";
    el("handsFreeBtn").setAttribute("aria-pressed", String(on));
    Prefs.save({ handsFree: on });
    if (!quiet) Voice.say(on ? "Hands-free is on. Start each command with Hey Star, like: Hey Star, find Jupiter. Headphones work best." : "Hands-free is off. Tap the screen to talk.", { interrupt: false });
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- sky tonight ----------
  function skyTonight() {
    const up = app.objects.filter((o) => o.vec[2] > 0.09); // above ~5°
    const bodies = up.filter((o) => o.kind !== "star");
    const stars = up.filter((o) => o.kind === "star" && o.star.name).sort((a, b) => a.mag - b.mag).slice(0, 4);
    const parts = [];
    const when = app.timeMode === "tonight" ? "At 9 PM tonight" : "Right now";
    const sunAlt = solarAltitude();
    if (app.timeMode === "now" && sunAlt > -6) parts.push("It is daytime or twilight, but StarSound still knows where every star is");
    const label = (b) => (b.name === "Moon" ? "the Moon" : b.name);
    if (bodies.length) parts.push(`${when}, ${bodies.map((b) => `${label(b)} is ${whereWords(b)}`).join("; ")}`);
    else parts.push(`${when}, no planets are up`);
    if (stars.length) parts.push(`Bright stars up: ${stars.map((s) => `${s.star.name}, ${Astro.compassWord(Astro.enuToAltAz(s.vec).az)}`).join("; ")}`);
    const ph = Astro.moonPhase(app.date);
    if (ph) parts.push(`The Moon is ${/moon|quarter/.test(ph.name) ? "at" : "a"} ${ph.name}`);
    parts.push("Say take me on a tour to visit the highlights");
    Voice.say(parts.join(". ") + ".");
  }

  function solarAltitude() {
    if (typeof Astronomy === "undefined") return -90;
    const obs = new Astronomy.Observer(app.loc.lat, app.loc.lon, 0);
    const eq = Astronomy.Equator("Sun", app.date, obs, true, true);
    return Astronomy.Horizon(app.date, obs, eq.ra, eq.dec).altitude;
  }

  function whatsHere() {
    const f = Sensors.state.vec;
    let best = null, bd = FOV_HALF;
    for (const o of app.objects) {
      if (!nameOf(o)) continue;
      const a = Astro.angleBetween(f, o.vec);
      const score = a - (o.kind !== "star" ? 3 : 0) + o.mag * 0.5;
      if (a < FOV_HALF && score < bd) { bd = score; best = o; }
    }
    const con = constellationAt(f);
    const p = Astro.enuToAltAz(f);
    let t = `You are aiming ${Math.round(p.alt)} degrees up, toward the ${Astro.compassWord(p.az)}.`;
    if (con) t += ` This is ${S.cons[con]}.`;
    if (best) t += ` Nearest bright object: ${describe(best)}`;
    app.lastTopic = best ? { kind: "obj", id: best.id } : con ? { kind: "con", id: con } : app.lastTopic;
    Voice.say(t);
  }

  function calibrate() {
    const bodies = app.objects.filter((o) => o.kind !== "star" && o.vec[2] > 0)
      .sort((a, b) => a.mag - b.mag);
    const bright = app.objects.filter((o) => o.kind === "star" && o.vec[2] > 0.2 && o.star.name)
      .sort((a, b) => a.mag - b.mag);
    const ref = bodies[0] || bright[0];
    if (!ref) { Voice.say("Nothing bright enough to calibrate on right now."); return; }
    const d = Sensors.calibrateTo(ref.vec);
    Voice.say(`Calibrated on ${nameOf(ref)}. Corrected by ${Math.round(Math.abs(d))} degrees.`);
  }

  // ---------- sighted-companion view (simple, for testing and the demo video) ----------
  const canvas = el("sky"), g = canvas.getContext("2d");
  function draw(f) {
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = devicePixelRatio || 1;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#05070f"; g.fillRect(0, 0, w, h);
    if (!app.objects.length) return;
    const basis = Astro.viewBasis(f);
    const scale = Math.min(w, h) / 2 / Math.tan(35 * Astro.DEG); // ~70° wide view
    const proj = (v) => {
      const p = Astro.toView(basis, v);
      if (p[2] < 0.2) return null;
      return [w / 2 + (p[0] / p[2]) * scale, h / 2 - (p[1] / p[2]) * scale];
    };
    // horizon
    g.strokeStyle = "#2a3a2a"; g.lineWidth = 1; g.beginPath();
    let started = false;
    for (let az = 0; az <= 360; az += 2) {
      const q = proj(Astro.altAzToENU(0, az));
      if (!q) { started = false; continue; }
      if (!started) { g.moveTo(q[0], q[1]); started = true; } else g.lineTo(q[0], q[1]);
    }
    g.stroke();
    // constellation lines
    g.strokeStyle = "rgba(120,150,220,0.35)";
    for (const segs of Object.values(S.lines)) {
      for (const seg of segs) {
        g.beginPath(); let on = false;
        for (const i of seg) {
          const q = proj(app.objects[i].vec);
          if (!q) { on = false; continue; }
          if (!on) { g.moveTo(q[0], q[1]); on = true; } else g.lineTo(q[0], q[1]);
        }
        g.stroke();
      }
    }
    // stars and planets
    g.font = "12px system-ui, sans-serif";
    for (const o of app.objects) {
      const q = proj(o.vec);
      if (!q) continue;
      const r = Math.max(0.8, 3.6 - o.mag * 0.6);
      g.fillStyle = o.kind === "star" ? starColor(o.star.bv) : o.kind === "moon" ? "#eeeeee" : "#ffd27a";
      g.beginPath(); g.arc(q[0], q[1], o.kind === "moon" ? 9 : o.kind === "planet" ? 4 : r, 0, 7); g.fill();
      if ((o.kind !== "star" || (o.star.name && o.mag < 2)) ) {
        g.fillStyle = "rgba(220,225,240,0.75)"; g.fillText(nameOf(o), q[0] + 6, q[1] - 6);
      }
    }
    // listening cone + crosshair
    const rr = Math.tan(FOV_HALF * Astro.DEG) * scale;
    g.strokeStyle = app.mode === "find" ? "#ffb347" : "#7fd1ff"; g.lineWidth = 1.5;
    g.beginPath(); g.arc(w / 2, h / 2, rr, 0, 7); g.stroke();
    g.beginPath(); g.moveTo(w / 2 - 8, h / 2); g.lineTo(w / 2 + 8, h / 2);
    g.moveTo(w / 2, h / 2 - 8); g.lineTo(w / 2, h / 2 + 8); g.stroke();
  }

  function starColor(bv) {
    const t = Math.min(1, Math.max(0, (bv + 0.3) / 2.1));
    const r = Math.round(170 + 85 * Math.min(1, t * 1.6));
    const gg = Math.round(200 + 40 * (1 - Math.abs(t - 0.4) * 1.5));
    const b = Math.round(255 - 150 * t);
    return `rgb(${r},${gg},${b})`;
  }

  function updateStatus(f) {
    const p = Astro.enuToAltAz(f);
    const sensorOk = Sensors.receiving();
    el("status").textContent =
      `${Sensors.state.mode === "simulate" ? "Practice mode" : sensorOk ? "Phone sensors on" : "Waiting for sensors…"} · ` +
      `aiming ${Math.round(p.alt)}° up, ${Math.round(p.az)}° (${Astro.compassWord(p.az)}) · ` +
      `${app.loc.label} · ${app.timeMode === "now" ? "now" : "tonight 9 PM"}`;
  }

  // ---------- setup ----------
  function fillTargets() {
    const sel = el("target");
    const add = (group, value, text) => {
      const o = document.createElement("option"); o.value = value; o.textContent = text; group.appendChild(o);
    };
    const g1 = document.createElement("optgroup"); g1.label = "Moon and planets";
    for (const n of ["Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn"]) add(g1, "object:p" + n, n);
    const g2 = document.createElement("optgroup"); g2.label = "Bright stars";
    S.stars.map((s, i) => ({ s, i })).filter((x) => x.s.name && x.s.mag < 1.8)
      .sort((a, b) => a.s.name.localeCompare(b.s.name))
      .forEach((x) => add(g2, "object:s" + x.i, x.s.name));
    const g3 = document.createElement("optgroup"); g3.label = "Constellations";
    Object.keys(S.lines).map((k) => [k, S.cons[k]]).sort((a, b) => a[1].localeCompare(b[1]))
      .forEach(([k, n]) => add(g3, "con:" + k, n));
    sel.append(g1, g2, g3);
  }

  function getLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(false);
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          app.loc = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: "your location" };
          resolve(true);
        },
        () => resolve(false),
        { timeout: 8000, maximumAge: 600000 },
      );
    });
  }

  async function keepAwake() {
    try { if ("wakeLock" in navigator) await navigator.wakeLock.request("screen"); } catch (_) {}
  }

  async function start(practice, handsFreeStart = false) {
    Sound.init();
    el("startPanel").hidden = true;
    el("controls").hidden = false;
    if (practice) {
      Sensors.startSimulation();
    } else {
      try { await Sensors.startPhone(); }
      catch (e) { Voice.say("Motion access was denied, so I switched to practice mode."); Sensors.startSimulation(); }
    }
    // start playing right away with the default location; refine once GPS answers
    rebuildSky();
    setInterval(rebuildSky, 5000);
    app.running = true;
    keepAwake();
    const prefs = Prefs.load();
    const voiceHint = !Listen.supported() ? "" : practice ? "Press the space bar and say help, any time. " :
      "To talk to me, tap anywhere on the screen, then speak. Say help to hear what you can ask. ";
    if (!prefs.welcomed) {
      Prefs.save({ welcomed: true });
      Voice.say("Welcome to StarSound. " + (practice ? "This is practice mode: use the arrow keys or drag the sky to aim. " :
        "Hold your phone up and point it at the sky. Use headphones for 3D sound. ") +
        "Every star in front of you plays a note: brighter is louder, blue is higher, red is lower. " +
        "Sweep slowly, and hold still on a star to hear its name. " + voiceHint +
        "To hear this again, say how does this work.");
    } else {
      Voice.say((practice ? "Practice mode. Arrow keys aim. " : "Point your phone at the sky. ") + voiceHint);
    }
    if (handsFreeStart || Prefs.load().handsFree) {
      setTimeout(() => setHandsFree(true, { quiet: !handsFreeStart }), 600);
    }
    getLocation().then((gotLoc) => {
      if (gotLoc) rebuildSky();
      else Voice.say("Location unavailable, so I'm using the sky over Westlake Village.", { interrupt: false });
    });
    if (!practice) {
      setTimeout(() => {
        if (!Sensors.receiving()) {
          Voice.say("I am not getting motion data from this device, so I switched to practice mode.");
          Sensors.startSimulation();
        }
      }, 2500);
    }
  }

  function bind() {
    Voice.attach(el("speech"));
    el("startPhone").onclick = () => start(false);
    el("startPractice").onclick = () => start(true);
    el("startHandsFree").onclick = () => start(false, true);
    el("hereBtn").onclick = whatsHere;
    el("findBtn").onclick = startFind;
    el("conBtn").onclick = () => playConstellation();
    el("tonightBtn").onclick = skyTonight;
    el("calBtn").onclick = calibrate;
    el("pauseBtn").onclick = () => setPaused(!app.paused);
    el("talkBtn").onclick = talk;
    el("tourBtn").onclick = () => (app.tour ? stopAll() : startTour());
    el("nextBtn").onclick = nextStop;
    el("moreBtn").onclick = () => tellMore();
    el("helpBtn").onclick = () => Voice.say(Commands.HELP);
    el("tutorialBtn").onclick = tutorial;
    el("stopBtn").onclick = () => stopAll();
    el("srMode").onchange = (e) => { Voice.setScreenReader(e.target.checked); Prefs.save({ sr: e.target.checked }); };
    el("conNames").onchange = (e) => Prefs.save({ conNames: e.target.checked });
    el("volume").oninput = (e) => { Sound.setVolume(Number(e.target.value)); Prefs.save({ volume: Number(e.target.value) }); };
    el("rate").oninput = (e) => { Voice.setRate(Number(e.target.value)); Prefs.save({ rate: Number(e.target.value) }); };
    el("rate").onchange = () => Voice.say("This is how fast I'll speak.");
    el("decl").onchange = (e) => { Sensors.state.declination = Number(e.target.value) || 0; Prefs.save({ decl: Sensors.state.declination }); };
    el("timeMode").onchange = (e) => { app.timeMode = e.target.value; rebuildSky(); };
    Listen.setHandlers({
      onCommand: (alts) => { Sound.earcon("done"); runCommand(Commands.parseAlternatives(alts)); },
      onState: onListenState,
      onWake,
    });
    Listen.setSpeakingCheck(() => Voice.speaking());
    el("handsFreeBtn").onclick = () => setHandsFree(!Listen.handsFree());
    el("logBtn").onclick = () => logSummary("month");
    el("moonBtn").onclick = answerMoonPhase;

    // Eyes-free: while using the phone's sensors, tapping anywhere that isn't a
    // control starts listening, so a blind user never has to find the Talk button.
    document.addEventListener("click", (e) => {
      if (!app.running || Sensors.state.mode !== "phone") return;
      if (e.target.closest("button, select, input, label, summary, details, a")) return;
      talk();
    });

    // practice mode: keyboard and drag
    window.addEventListener("keydown", (e) => {
      if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
      const step = e.shiftKey ? 10 : 3;
      const keys = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (keys[e.key] && Sensors.state.mode === "simulate") { e.preventDefault(); Sensors.nudge(...keys[e.key]); }
      if (e.key === "h") whatsHere();
      if (e.key === "c") playConstellation();
      if (e.key === "t") skyTonight();
      if (e.key === "m") tellMore();
      if (e.key === "n") nextStop();
      if (e.key === " " && app.running) { e.preventDefault(); talk(); }
    });
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => { drag = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag || Sensors.state.mode !== "simulate") return;
      Sensors.nudge(-(e.clientX - drag[0]) * 0.15, (e.clientY - drag[1]) * 0.15);
      drag = [e.clientX, e.clientY];
    });
    canvas.addEventListener("pointerup", () => { drag = null; });
  }

  function applyPrefs() {
    const p = Prefs.load();
    if (typeof p.volume === "number") { Sound.setVolume(p.volume); el("volume").value = p.volume; }
    if (typeof p.rate === "number") { Voice.setRate(p.rate); el("rate").value = p.rate; }
    if (typeof p.decl === "number") { Sensors.state.declination = p.decl; el("decl").value = p.decl; }
    if (typeof p.conNames === "boolean") el("conNames").checked = p.conNames;
    if (p.sr) { el("srMode").checked = true; Voice.setScreenReader(true); }
  }

  fillTargets();
  bind();
  applyPrefs();
  rebuildSky();
  buildVocabulary();
  requestAnimationFrame(frame);

  // offline support: cache the app so it works at dark-sky sites with no signal
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  window.StarSound = { app, rebuildSky, describe, skyTonight, whatsHere, playConstellation, runCommand, Log,
    startTour, nextStop, tellMore, findTarget, resolveRef }; // for testing
})();
