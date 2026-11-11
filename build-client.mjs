// Собирает public/index.html: вставляет движок правил в клиент.
import fs from 'node:fs';
const eng = fs.readFileSync('avtomonopolist-engine.js', 'utf8').replace(/^export /gm, '');
const src = fs.readFileSync('client.src.html', 'utf8');
fs.writeFileSync('public/index.html', src.replace('/*ENGINE*/', () => eng));
console.log('public/index.html собран');
