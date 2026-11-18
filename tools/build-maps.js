// Packs maps/*.tagmap.json into js/maps-official.js so the game can load them from a double-clicked file.
// Run: node tools/build-maps.js
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const ORDER = ['the-caves', 'space-stares', 'the-city', 'the-feilds', 'the-last-chance', 'shooter-forever'];
const files = fs.readdirSync(path.join(root, 'maps')).filter((f) => f.endsWith('.json'));
files.sort((a, b) => {
  const ia = ORDER.indexOf(a.replace(/\.tagmap\.json$/, '')), ib = ORDER.indexOf(b.replace(/\.tagmap\.json$/, ''));
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
});
const maps = files.map((f) => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'maps', f), 'utf8'));
  m.id = 'official-' + f.replace(/\.tagmap\.json$/, '');
  return m;
});
fs.writeFileSync(path.join(root, 'js', 'maps-official.js'),
  '// Made by tools/build-maps.js from the maps/ folder. Edit the maps, not this file.\n' +
  'window.TG = window.TG || {};\nTG.OFFICIAL_MAPS = ' + JSON.stringify(maps) + ';\n');
console.log('Packed ' + maps.length + ' maps: ' + maps.map((m) => m.name).join(', '));
