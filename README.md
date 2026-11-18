# 🏃 Tag Out

A 3D tag game for 2–8 players. Whoever is IT when the timer runs out is OUT. The last player left wins!

**Play it at https://verdeyengames.com/tagout/**

## How to play

- Press **▶ Play** to pick players, usernames, hats and bots (easy, normal or hard), the round length, and the map.
- **WASD** to move · **Shift** to run · **Space** to jump (press again for a double jump) · **F** to dash · **Q** to back dash · **C** to crawl · **Z/X** or drag the mouse to turn the camera · **Esc** to pause.
- When you're IT, just touch someone to tag them!
- **🌐 Play online**: one person presses **Make a room** and tells their friends the 4-letter code. Friends press **Join a room** on their own computers. The person who made the room picks the bots, round length and map, then presses **GO!** Online, everyone is called by their color. If a friend leaves partway through, a bot takes over for them.
- Gamepads work too: left stick to move, right stick for the camera, A to jump, B to dash, Y to back dash, RT to run, LT to crawl, Start to pause.

## Maps

Five maps: **the caves**, **space stares**, **the city**, **the feilds** and **the last chance**. They were all built with the game's own **🛠 Map Maker**, where you can make your own maps, test them, and save or export them.

## For grown-ups / developers

Plain HTML and JavaScript using three.js r128 from cdnjs, with no build step.

Online rooms use the family Firebase Realtime Database (`kvgames`), under `tagout/rooms/<CODE>`. Only game data goes through it: color slots, hats from the fixed list, positions and tag events. No names or text. The host's computer runs the rules and the bots, and each computer moves its own player (`js/net.js`, plus the event code in `js/game.js`). The database rules have to allow the `tagout` key. The official maps live in `maps/`. After changing them, run `node tools/build-maps.js` to update `js/maps-official.js`.
