# StarSound

Hear the night sky. StarSound lets blind and visually impaired people explore the stars by sound. Point a phone at the sky and every star in view plays a note:

| Star property | Sound |
|---|---|
| Brightness (magnitude) | Loudness: brighter stars are louder |
| Color (B−V index) | Pitch: hot blue stars are high, cool red stars are low (pentatonic scale) |
| Position in view | 3D direction through headphones (HRTF spatial audio) |
| Closeness to where you aim | Twinkle rate: faster near the center |
| Moon and planets | Their own instrument sounds |

Hold still on a star or planet and the app says its name, color, and distance. StarSound calculates where everything is, so it works through clouds and even in daytime.

## Features

- **Voice control:** tap the big Talk button (or press Space on a computer) and speak. Uses the browser's built-in speech recognition, so it needs no accounts or keys.
- **Explore:** sweep the sky and hear it; hold still to hear names; constellation names are spoken as you pass through them.
- **Find:** "Find Jupiter", "Find the Big Dipper", "Which way is north". A ticking sound comes *from the direction of the target* and speeds up as you get closer, with spoken hints ("Turn right 40. Raise 20.").
- **Guided tour:** "Take me on a tour" picks up to 6 highlights currently above the horizon (Moon, planets, a bright star, constellations), leads you to each one, and tells its story. Say "Next" to move on.
- **Stories:** "Tell me more" or "Tell me about Vega" reads a short story about stars, planets, the Moon, and 28 constellations.
- **Play this constellation:** hear a constellation's shape as a melody traced along its lines.
- **What's up tonight:** a spoken summary of planets, bright stars, and the Moon phase.
- **Accessible:** large buttons; works with VoiceOver and TalkBack (switch in Settings); adjustable speaking speed and volume, which the phone remembers; sound cues for listening, done, and not understood; vibration on Android.
- **Works offline:** after the first visit, the app is saved on the phone (except voice commands, which need internet on most phones). It can be added to the home screen like an app.

### Eyes-free use

A blind user is holding the phone up at the sky, so nothing requires finding a button:

- **Tap anywhere** on the screen (while using the phone's sensors) to talk.
- **Hands-free mode** (say "hands free on", or choose "Start hands-free"): the microphone stays on, and commands start with the wake phrase **"Hey Star"**, as in "Hey Star, is Saturn up?" Saying just "Hey Star" arms it for the next sentence. Ordinary conversation is ignored, and the microphone pauses while the app is speaking. This also works with the phone strapped to a headband, so the app follows your head.
- **Sound cues** signal listening, done, and not understood. A spoken welcome explains everything on first use.

### What you can say

| Ask | Answer |
|---|---|
| What am I pointing at? / What am I facing? | Constellation and nearest bright object |
| What's up tonight? / What planets can I see? | Planets, bright stars, Moon phase |
| Find Jupiter / Find the Big Dipper / Which way is north? | Guides you there by sound |
| Take me on a tour, then Next | Guided tour of tonight's highlights |
| Is Saturn up? / Can I see the Moon tonight? | Yes or no, where it is, and when it sets or rises |
| When does the Moon rise? / When does Orion set? / When is sunset? | Exact times for your location |
| What's the moon phase? / When is the next full moon? | Phase, percent lit, moonrise or moonset, next full or new moon |
| When does it get dark? | Sunset, when bright stars appear, when it's fully dark |
| How far is Mars? / How far is Vega? | Live distance and light travel time |
| When's the next meteor shower? | Next shower, date, and where to listen |
| What have I seen this month? / Have I seen Saturn? | Your observing log (tonight, this week, month, year, or ever) |
| Why do stars twinkle? / What is a light-year? / What's a black hole? | Answers to about 25 common astronomy questions, offline |
| Tell me more / Tell me about Vega / Why is Mars red? | Stories |
| Play this constellation | Constellation melody |
| Pause, Resume, Louder, Quieter, Speak slower/faster, Repeat, Help, Stop | Controls |

Every planet, bright star, and constellation you find is saved automatically to an observing log on the phone. Nothing is sent anywhere.

## Running it

It's plain HTML and JavaScript with no build step and no accounts needed.

- **On a computer:** open `index.html` in Chrome or Safari and choose Practice mode. Aim with the arrow keys (Shift for bigger steps) or by dragging the sky. Keys: Space = talk, `h` = what am I pointing at, `c` = play constellation, `t` = what's up tonight, `m` = tell me more, `n` = next tour stop. (Voice commands and offline mode need the app hosted online, below.)
- **On a phone:** motion sensors and location need HTTPS, so host it on GitHub Pages:
  1. Create a GitHub repository named `starsound`.
  2. Choose **Add file → Upload files** and drag in all the files in this folder.
  3. Go to **Settings → Pages**, set the source to **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
  4. After a minute, open `https://<your-username>.github.io/starsound/` on your phone. Use headphones.

## How it works

- `astro.js` — the sky math. It converts each star's catalog position (right ascension and declination) into altitude and azimuth for your location and time, using local sidereal time and the hour angle. Everything is represented as 3D unit vectors (East, North, Up), so angles between things are dot products. It also includes the reverse conversion and a ray-casting test against the official IAU constellation boundaries to tell which constellation you're aiming at.
- `sensors.js` — turns the phone's orientation angles (alpha, beta, gamma) into the direction the back camera points, using the rotation matrix from the W3C DeviceOrientation spec. It smooths the vector rather than the angles (angles jump at 0°/360°), corrects for magnetic declination, handles iPhone's relative compass, and supports calibrating on the Moon or a planet.
- `audio.js` — the sonification, built on the Web Audio API with HRTF spatial panning, plus speech output.
- `commands.js` — turns what the user said into an action. It handles nicknames ("Big Dipper"), common mishearings ("serious" → Sirius, "beetlejuice" → Betelgeuse), and close misspellings using edit distance. It tries each of the recognizer's guesses until one makes sense.
- `listen.js` — voice input through the browser's speech recognition: tap-to-talk, and hands-free listening with the "Hey Star" wake phrase, which pauses while the app speaks.
- `stories.js` — the spoken stories. Easy to add more.
- `faq.js` — answers to common astronomy questions. Easy to add more.
- `sw.js` and `manifest.webmanifest` — offline support and installing to the home screen.
- `app.js` — the main loop, Explore and Find modes, constellation melodies, and the simple sky view for sighted companions.
- `sky-data.js` — 1,044 naked-eye stars, constellation lines, and constellation boundaries, generated from the sources below.

The star-position math was checked against the astronomy-engine library and matches within 0.002°. Star positions use J2000 catalog coordinates; precession since 2000 shifts them by about 0.4°, far smaller than phone compass error.

## Credits and licenses

- Star data: [HYG Database](https://github.com/astronexus/HYG-Database) by David Nash (astronexus), CC BY-SA 4.0.
- Constellation lines and boundaries: [d3-celestial](https://github.com/ofrohn/d3-celestial) by Olaf Frohn, BSD-3-Clause.
- Moon and planet positions: [astronomy-engine](https://github.com/cosinekitty/astronomy) by Don Cross, MIT license.

## AI use disclosure

<!-- Fill this in honestly before you submit. The Congressional App Challenge requires full disclosure of AI use. -->
