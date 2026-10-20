// commands.js — understanding what the user said.
//
// Speech recognition gives us text like "where's jupiter" or "find the big dipper".
// This turns that text into an action the app can run, e.g. {action: "find", target}.
// It is deliberately forgiving: recognizers mishear star names ("serious" for Sirius,
// "beetlejuice" for Betelgeuse), so we keep a list of common mishearings and also
// accept close spellings using edit distance.

const Commands = (() => {
  // English nicknames for constellations and objects -> what they refer to
  const ALIASES = {
    "big dipper": "con:UMa", "the plough": "con:UMa", "plough": "con:UMa", "great bear": "con:UMa",
    "little dipper": "con:UMi", "little bear": "con:UMi",
    "orions belt": "con:Ori", "the hunter": "con:Ori", "hunter": "con:Ori",
    "the scorpion": "con:Sco", "scorpion": "con:Sco", "scorpio": "con:Sco",
    "the archer": "con:Sgr", "teapot": "con:Sgr", "the teapot": "con:Sgr",
    "the swan": "con:Cyg", "swan": "con:Cyg", "northern cross": "con:Cyg",
    "the lion": "con:Leo", "the bull": "con:Tau", "the twins": "con:Gem", "twins": "con:Gem",
    "the queen": "con:Cas", "big dog": "con:CMa", "great dog": "con:CMa", "little dog": "con:CMi",
    "the eagle": "con:Aql", "eagle": "con:Aql", "the lyre": "con:Lyr", "lyre": "con:Lyr",
    "winged horse": "con:Peg", "great square": "con:Peg",
    "pleiades": "con:Tau", "seven sisters": "con:Tau",
    "north star": "star:Polaris", "pole star": "star:Polaris", "dog star": "star:Sirius",
    "red planet": "planet:Mars", "evening star": "planet:Venus", "morning star": "planet:Venus",
    "north": "dir:north", "south": "dir:south", "east": "dir:east", "west": "dir:west",
    "overhead": "dir:up", "straight up": "dir:up", "zenith": "dir:up",
    "sun": "planet:Sun", "milky way": "con:Sgr", "center of the galaxy": "con:Sgr", "center of the milky way": "con:Sgr",
    "galactic center": "con:Sgr", "andromeda galaxy": "con:And",
  };

  // Things recognizers commonly hear instead of star names
  const MISHEARD = {
    "serious": "star:Sirius", "beetlejuice": "star:Betelgeuse", "beetle juice": "star:Betelgeuse",
    "a cappella": "star:Capella", "acapella": "star:Capella", "vegas": "star:Vega",
    "ryan": "con:Ori", "o ryan": "con:Ori", "oh ryan": "con:Ori", "orient": "con:Ori",
    "the moon": "planet:Moon", "moon": "planet:Moon", "jupitor": "planet:Jupiter",
    "saturday": "planet:Saturn", "antares": "star:Antares", "and terrace": "star:Antares",
    "algebra": "star:Aldebaran", "all debaran": "star:Aldebaran", "spike a": "star:Spica",
    "arc tourist": "star:Arcturus", "arctic": "star:Arcturus", "dene": "star:Deneb",
  };

  const FIND_PREFIXES = [
    "where is", "wheres", "where are", "show me", "take me to", "point me to", "point me at",
    "guide me to", "help me find", "look for", "find me", "find", "fine", "locate", "search for",
    "go to", "which way is", "how do i find", "face",
  ];
  const ABOUT_PREFIXES = ["tell me about", "what is", "whats", "who is", "describe", "information about", "info about"];

  function normalize(t) {
    return t.toLowerCase()
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripThe(t) { return t.replace(/^(the|a|an) /, ""); }

  function editDistance(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[a.length][b.length];
  }

  // vocab: [{key: "jupiter", ref: "planet:Jupiter"}, ...] built by the app from its data
  let vocab = [];
  function setVocabulary(entries) {
    const all = [...entries];
    for (const [k, v] of Object.entries(ALIASES)) all.push({ key: k, ref: v });
    for (const [k, v] of Object.entries(MISHEARD)) all.push({ key: k, ref: v });
    vocab = all.map((e) => ({ key: normalize(e.key), ref: e.ref }))
      .sort((a, b) => b.key.length - a.key.length); // longest first: "ursa minor" before "ursa"
  }

  // find which named thing the text mentions
  function matchTarget(text) {
    const t = " " + stripThe(normalize(text)) + " ";
    if (t.trim() === "") return null;
    for (const e of vocab) {
      if (t.includes(" " + e.key + " ")) return e.ref;
    }
    // fuzzy: compare without spaces, allow small spelling differences
    const squashed = t.replace(/ /g, "");
    if (squashed.length < 4) return null;
    let best = null, bd = Infinity;
    for (const e of vocab) {
      const k = e.key.replace(/ /g, "");
      if (k.length < 4) continue;
      const d = editDistance(squashed, k);
      const limit = k.length >= 8 ? 2 : 1;
      if (d <= limit && d < bd) { bd = d; best = e.ref; }
    }
    return best;
  }

  const has = (t, phrases) => phrases.some((p) => (" " + t + " ").includes(" " + p + " "));
  const is = (t, phrases) => phrases.includes(t);

  function afterPrefix(t, prefixes) {
    for (const p of prefixes) {
      if (t === p) return "";
      if (t.startsWith(p + " ")) return t.slice(p.length + 1);
    }
    return null;
  }

  // Answers to general astronomy questions (data/faq.js): every word of a pattern
  // must appear in the question (a trailing "s" is allowed: star -> stars).
  function matchFaq(t) {
    const faq = (typeof window !== "undefined" && window.FAQ) || [];
    const words = new Set(t.split(" "));
    const hasWord = (w) => words.has(w) || words.has(w + "s") || (w.endsWith("s") && words.has(w.slice(0, -1)));
    for (const entry of faq) {
      for (const p of entry.patterns) {
        if (normalize(p).split(" ").every(hasWord)) return entry.answer;
      }
    }
    return null;
  }

  function period(t) {
    if (has(t, ["tonight", "today", "this evening"])) return "night";
    if (has(t, ["this week", "week"])) return "week";
    if (has(t, ["this year", "year"])) return "year";
    if (has(t, ["ever", "all time", "total", "in total", "altogether", "all together"])) return "all";
    return "month";
  }

  // Returns {action, ref?, heard}
  function parse(raw) {
    const t = normalize(raw || "");
    const r = (action, extra = {}) => ({ action, heard: raw, ...extra });
    if (!t) return r("none");
    let m;

    // quick control words
    if (is(t, ["stop", "cancel", "never mind", "nevermind", "stop finding", "end tour", "stop tour", "quit"])) return r("stop");
    if (has(t, ["all commands", "every command", "full list", "more commands", "all the commands", "list of commands"])) return r("helpAll");
    if (has(t, ["what can i say", "what can you do", "commands", "instructions"]) || is(t, ["help", "help me", "help please"])) return r("help");
    if (has(t, ["how does this work", "how does it work", "explain the sounds", "what do the sounds mean", "tutorial"])) return r("tutorial");

    // hands-free listening
    if (has(t, ["hands free", "handsfree", "hand free", "hands three"])) {
      return has(t, ["off", "stop", "disable", "exit", "end", "turn off"]) ? r("handsFreeOff") : r("handsFreeOn");
    }

    // "why ..." questions go straight to the astronomy answers
    if (/^(why|how come)\b/.test(t)) {
      const a = matchFaq(t);
      if (a) return r("faq", { answer: a });
      const ref = matchTarget(t.replace(/^(why|how come) /, ""));
      if (ref) return r("about", { ref });
    }

    // observing log
    if (has(t, ["clear my log", "delete my log", "erase my log", "reset my log", "clear the log", "delete the log", "erase my list", "clear my list"])) return r("logClear");
    if (has(t, ["confirm clear", "yes clear", "yes delete", "yes erase", "confirm delete"])) return r("logClearConfirm");
    if ((m = t.match(/^(have|did) i (ever )?(seen|found|see|find|spotted|spot) (.+)$/))) {
      const ref = matchTarget(m[4].replace(/ (yet|before|ever|this month|this week|this year|tonight)$/, ""));
      if (ref) return r("logHas", { ref });
    }
    if (has(t, ["what have i seen", "what have i found", "what did i see", "what did i find", "my log", "observing log",
      "my list", "what have i spotted", "what ive seen", "what i have seen", "what i've seen"]) ||
      /how many (\w+ )?(stars|planets|constellations|things|objects)? ?(have i|did i) (seen|found|see|find)/.test(t) ||
      /(planets|stars|constellations) (have i|did i) (seen|found|see|find)/.test(t)) {
      return r("log", { period: period(t) });
    }

    // sky questions
    if (has(t, ["meteor shower", "meteor showers", "meteors", "next shower"]) ||
        (has(t, ["shooting stars"]) && has(t, ["when", "tonight", "next", "see", "any"]))) return r("meteors");
    if ((m = t.match(/\b(full|new) moon\b/)) && has(t, ["when", "next", "how long", "how many days"])) return r(m[1] === "full" ? "nextFull" : "nextNew");
    if (has(t, ["moon phase", "phase of the moon", "phase is the moon", "is the moon full", "how full is the moon",
      "what does the moon look like", "whats the moon look like", "full moon", "new moon", "moons phase", "moon look like"])) return r("moonPhase");
    if (has(t, ["when does it get dark", "when is it dark", "when will it be dark", "get dark", "until dark",
      "when can i see stars", "when can i see the stars", "twilight", "when do the stars come out", "when do stars come out"])) return r("dark");
    if (has(t, ["sunset", "sun set", "sun go down", "sun goes down"])) return r("riseSet", { ref: "planet:Sun", dir: "set" });
    if (has(t, ["sunrise", "sun rise", "sun come up", "sun comes up"])) return r("riseSet", { ref: "planet:Sun", dir: "rise" });
    if (has(t, ["moonrise", "moon rise"])) return r("riseSet", { ref: "planet:Moon", dir: "rise" });
    if (has(t, ["moonset", "moon set"])) return r("riseSet", { ref: "planet:Moon", dir: "set" });
    if ((m = t.match(/^(when|what time) (does|will|is|do) (.+?) (rise|rising|come up|coming up|set|setting|go down|going down)\b/))) {
      const ref = matchTarget(m[3]);
      if (ref) return r("riseSet", { ref, dir: /rise|rising|up/.test(m[4]) ? "rise" : "set" });
    }
    if ((m = t.match(/^(is|are|can i see|will i see|can we see|could i see|will i be able to see|is there) (.+?)( up| out| visible| in the sky| tonight| right now| now| yet| still up)*$/))) {
      const ref = matchTarget(m[2]);
      if (ref) return r("visible", { ref });
    }
    if ((m = t.match(/^(how far (away )?(is|are)|whats the distance to|what is the distance to|distance to) (.+?)( away| from here| from earth| from us)*$/))) {
      const ref = matchTarget(m[4]);
      if (ref) return r("distance", { ref });
    }

    if (is(t, ["pause", "mute", "quiet", "be quiet", "silence", "pause sounds", "stop sounds", "stop the sounds"])) return r("pause");
    if (is(t, ["resume", "unmute", "play", "start", "resume sounds", "start sounds", "continue", "unpause"])) return r("resume");
    if (has(t, ["louder", "volume up", "turn it up", "more volume"])) return r("louder");
    if (has(t, ["quieter", "softer", "volume down", "turn it down", "less volume"])) return r("quieter");
    if (has(t, ["slower", "slow down", "speak slower", "talk slower"])) return r("slower");
    if (has(t, ["faster", "speed up", "speak faster", "talk faster"])) return r("faster");
    if (has(t, ["repeat", "say that again", "say again", "what did you say", "again"])) return r("repeat");
    if (has(t, ["calibrate", "calibration", "recalibrate"])) return r("calibrate");
    if (has(t, ["next", "next stop", "skip", "go on", "keep going"])) return r("next");
    if (has(t, ["tour", "show me around", "guided", "give me a tour"])) return r("tour");

    // time travel
    if (has(t, ["switch to now", "right now mode", "real time", "use now", "current time", "back to now"])) return r("timeNow");
    if (has(t, ["9 pm", "nine pm", "9pm", "switch to tonight", "tonight mode", "later tonight"])) return r("timeTonight");

    // "tell me about X" / "tell me more"
    if (has(t, ["tell me more", "more", "story", "tell me a story", "more about it", "more about that", "tell me the story"]) &&
        !afterPrefix(t, ABOUT_PREFIXES)) {
      const ref = matchTarget(t.replace(/tell me more|about|story|more/g, ""));
      return ref ? r("about", { ref }) : r("more");
    }

    // what am I pointing at
    if (has(t, ["what am i pointing at", "what am i looking at", "what is that", "whats that", "what is this",
      "whats this", "what do i hear", "where am i pointing", "what is here", "whats here", "where am i looking",
      "identify", "what star is this", "what star is that", "what am i facing", "what is in front of me",
      "whats in front of me"])) return r("here");

    // find X
    const findRest = afterPrefix(t, FIND_PREFIXES);
    if (findRest !== null) {
      const ref = matchTarget(findRest);
      if (ref) return r("find", { ref });
      if (has(t, ["planets", "the planets"])) return r("tonight");
      return r("findUnknown", { said: findRest });
    }

    // general astronomy questions
    const faqAnswer = matchFaq(t);
    if (faqAnswer) return r("faq", { answer: faqAnswer });

    // tonight summary
    if (has(t, ["tonight", "whats up", "what is up", "what can i see", "whats in the sky", "what is in the sky",
      "whats visible", "what is visible", "sky tonight", "whats out", "what is out", "which planets", "what planets"])) return r("tonight");

    if (has(t, ["play this constellation", "play the constellation", "play constellation", "play the shape",
      "play its shape", "play the pattern", "constellation", "play this"])) return r("constellation");

    const aboutRest = afterPrefix(t, ABOUT_PREFIXES);
    if (aboutRest) {
      const ref = matchTarget(aboutRest);
      if (ref) return r("about", { ref });
    }

    // just a name on its own -> find it
    const ref = matchTarget(t);
    if (ref) return r("find", { ref });

    return r("unknown");
  }
  // Try each recognizer guess and take the first one we understand.
  function parseAlternatives(list) {
    let first = null;
    for (const alt of list) {
      const p = parse(alt);
      if (!first) first = p;
      if (p.action !== "unknown" && p.action !== "none" && p.action !== "findUnknown") return p;
    }
    return first || parse("");
  }

  const HELP = "Here's what you can ask. What am I pointing at? What's up tonight? Find Jupiter, or, find the Big Dipper. " +
    "Take me on a tour. Is Saturn up? What's the moon phase? Tell me more. " +
    "You can also ask astronomy questions, like, why do stars twinkle? To hear every command, say: all commands.";

  const HELP_ALL = "Every command. Pointing: What am I pointing at. Which way is north. " +
    "Finding: Find, then a name, like Find Vega. Stop. " +
    "Tours: Take me on a tour. Next. " +
    "Sky questions: What's up tonight. Is Mars up. When does the Moon rise. When does Orion set. When is sunset. " +
    "When does it get dark. What's the moon phase. When is the next full moon. How far is Jupiter. When is the next meteor shower. " +
    "Learning: Tell me more. Tell me about Vega. Play this constellation. And questions like, what is a light-year. " +
    "Your log: What have I seen this month. Have I seen Saturn. " +
    "Sound: Pause. Resume. Louder. Quieter. Speak slower. Speak faster. Repeat. " +
    "Hands-free: say hands free on, then start each command with Hey Star. Say hands free off to stop.";

  return { parse, parseAlternatives, setVocabulary, matchTarget, matchFaq, normalize, editDistance, HELP, HELP_ALL };
})();

if (typeof module !== "undefined") module.exports = Commands;
