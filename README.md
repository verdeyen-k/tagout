# 🏃 Tag Out

A 3D tag game for 2–8 players. Whoever is IT when the timer runs out is OUT. The last player left wins!

**Play it at https://verdeyengames.com/tagout/**

## How to play

- Press **▶ Play** to pick players, usernames, hats and bots (easy, normal or hard), the round length, and the map.
- You always run, and never get tired. **WASD** to move · **Space** to jump (press again for a double jump) · **W+S** (or **F**) to dash · **A+D** (or **Q**) to back dash · hold **A+W+D** (or **C**) to crawl · **move the mouse** to look around (click the game first; Z/X work too) · **Esc** to pause.
- When you're IT, just touch someone to tag them!
- **🔥 Burning Battle** (pick it under **Mode**): IT is on fire and leaves a trail of fire behind them. Touch the fire and you're IT! When someone new is IT, the old fire goes out.
- **💰 Treasure Time** (pick it under **Mode**): half the players are ITs and the rest are runners. The ITs guard a treasure chest (follow the beam of light!). If an IT touches a runner, the runner zaps back to their spawn. Runners win if one of them grabs the treasure. The ITs win if time runs out first.
- **🌐 Play online**: one person presses **Make a room** and tells their friends the 4-letter code. Friends press **Join a room** on their own computers. The person who made the room picks the bots, round length and map, then presses **GO!** Online, everyone is called by their color. If a friend leaves partway through, a bot takes over for them.
- Gamepads work too: left stick to move, right stick for the camera, A to jump, B to dash, Y to back dash, LT to crawl, Start to pause.

## Maps

Six maps: **the caves**, **space stares**, **the city**, **the feilds**, **the last chance** and **shooter forever**. They were all built with the game's own **🛠 Map Maker**, where you can make your own maps, test them, and save or export them.

## For grown-ups / developers

Plain HTML and JavaScript using three.js r128 from cdnjs, with no build step.

Online rooms use the family Firebase Realtime Database (`kvgames`), under `tagout/rooms/<CODE>`. Only game data goes through it: color slots, hats from the fixed list, positions and tag events. No names or text. The host's computer runs the rules and the bots, and each computer moves its own player (`js/net.js`, plus the event code in `js/game.js`). The database rules have to allow the `tagout` key. The official maps live in `maps/`. After changing them, run `node tools/build-maps.js` to update `js/maps-official.js`.

After changing any file in `js/` or `css/`, bump the `?v=` number on its tag in `index.html` (for example `?v=2` to `?v=3`). That makes browsers load the new code instead of an old copy they saved.
