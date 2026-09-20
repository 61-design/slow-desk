import {readFileSync, writeFileSync} from 'node:fs';
import vm from 'node:vm';
const context = {window:{}};
vm.runInNewContext(readFileSync(new URL('../tracks.js', import.meta.url), 'utf8'), context);
const catalogue = Object.fromEntries(context.window.CALM_TRACKS.map(track => [track.id, {title:track.title, series:track.series}]));
writeFileSync(new URL('./catalogue.mjs', import.meta.url), `// Generated from tracks.js; regenerate before deployment.\nexport default ${JSON.stringify(catalogue, null, 2)};\n`);
