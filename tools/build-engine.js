// Build the engine bundle the shell installs: engine.js + tabbridge.js + wiring.js.
// Run from the perchance agent tools: paste this file's body into execute_js (it has
// no path runner; the `fs` global is the workspace). Reads ENGINE_BUNDLE_VERSION
// from main.pjs, writes src/engine.bundle.js (checked in — the panel fetches it and
// pushes it to the shell via __installEngine).
const main = await fs.readTextFile('main.pjs');
const vm = main.match(/ENGINE_BUNDLE_VERSION\s*=\s*"([^"]+)"/);
if (!vm) throw new Error('ENGINE_BUNDLE_VERSION not found in main.pjs');
const ver = vm[1];
const parts = ['src/engine/games.js', 'src/engine/wordle-lists.js', 'src/engine/wordle.js', 'src/engine/modaudit.js', 'src/engine/engine.js', 'src/engine/tabbridge.js', 'src/engine/wiring.js'];
let out = '/* CHLOE_ENGINE_BUNDLE version=' + ver + ' parts=engine,tabbridge,wiring — installed by chloe-shell via __installEngine */\n';
for (const p of parts) {
  const src = await fs.readTextFile(p);
  out += '\n/* ---- ' + p + ' (' + src.length + ' bytes) ---- */\n' + src;
}
out += '\n;globalThis.__CHLOE_ENGINE_BUNDLE_VERSION = ' + JSON.stringify(ver) + ';\n';
try { new Function(out); } catch (e) { throw new Error('bundle SYNTAX: ' + (e && e.message)); }
await fs.writeTextFile('src/engine.bundle.js', out);
// eval smoke with stubs (wiring needs ChloeT0/ChloeTabBridge from the bundle itself)
const stubs = [
  'var GM_getValue=function(){return null},GM_setValue=function(){},GM_deleteValue=function(){},GM_xmlhttpRequest=function(){},GM_openInTab=function(){},GM_registerMenuCommand=function(){},GM_addValueChangeListener=function(){};',
  'var window={top:{},confirm:function(){return false},prompt:function(){return null},open:function(){}};',
  'var location={hash:"",href:"http://x/",pathname:"/",search:""};var history={replaceState:function(){}};',
  'var BroadcastChannel=undefined;var localStorage={getItem:function(){return null},setItem:function(){}};',
  'var setInterval=function(){return 0},clearInterval=function(){};var console={log:function(){},error:function(){}};'
].join('');
const api = new Function('Shell', stubs + out + '\n;return __chloeWire(Shell);')(
  { LINKWIN: { addEventListener: function () {} }, tabRole: 'queen', engineVersion: ver });
if (api.getVersion() !== ver) throw new Error('bundle version seam wrong: ' + api.getVersion());
const keys = Object.keys(api).sort();
return { version: ver, bytes: out.length, apiKeys: keys };
