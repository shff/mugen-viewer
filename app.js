'use strict';

const $ = id => document.getElementById(id);
let character, currentAction, frameIndex = 0, elapsed = 0, lastTime = 0, playing = true, loadId = 0;
let runtime;
const expressionCache = new Map();
const canvas = $('preview'), ctx = canvas.getContext('2d');

$('zip').addEventListener('change', event => { if (event.target.files[0]) loadZip(event.target.files[0]); event.target.value = ''; });
let dragDepth = 0;
document.addEventListener('dragenter', event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) { dragDepth++; $('drop-overlay').hidden = false; } });
document.addEventListener('dragover', event => event.preventDefault());
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
document.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true; if (event.dataTransfer.files[0]) loadZip(event.dataTransfer.files[0]); });
$('play').onclick = () => { playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; };
$('restart').onclick = () => { if (runtime?.active) enterState(runtime.stateNo, 'Restart state'); else { frameIndex = 0; elapsed = 0; draw(); } };
$('zoom').onchange = () => draw();
$('search').oninput = () => showCommands();
$('animation-search').oninput = event => { const query = event.target.value.toLowerCase(); for (const button of $('actions').children) button.hidden = !button.textContent.toLowerCase().includes(query); };

async function loadZip(file) {
  const ticket = ++loadId;
  $('error').hidden = true;
  $('status').textContent = 'Reading ' + file.name + '…';
  try {
    const entries = readZip(await file.arrayBuffer());
    const definitions = entries.filter(entry => /\.def$/i.test(entry.name));
    let selected, definition;
    for (const entry of definitions) {
      const sections = parseSections(decode(await entry.read()));
      if (sections.some(section => section.name === 'files' && section.values.sprite)) { selected = entry; definition = sections; break; }
    }
    if (!selected) throw Error('No character DEF with a sprite reference was found in this ZIP.');
    const info = definition.find(section => section.name === 'info')?.values || {};
    const files = definition.find(section => section.name === 'files').values;
    const directory = selected.name.slice(0, selected.name.lastIndexOf('/') + 1);
    const resolve = name => entries.find(entry => entry.name.toLowerCase() === normalize(directory + unquote(name)).toLowerCase());
    const required = async key => { const entry = resolve(files[key] || ''); if (!entry) throw Error('Missing character file: ' + (files[key] || key)); return entry.read(); };
    const sprites = readSff(await required('sprite'));
    const animations = readAir(decode(await required('anim')));
    if (!animations.get(0)?.frames.length) throw Error('The character has no idle animation (AIR action 0).');
    const constants = files.cns ? parseSections(decode(await required('cns'))) : [];
    const states = new Map(), stateDefinitions = new Map(), commandSections = [];
    for (const [key, name] of Object.entries(files)) {
      if (key !== 'cmd' && !/^st(?:\d+|common)?$/.test(key)) continue;
      const entry = resolve(name); if (!entry) continue;
      const sections = parseSections(decode(await entry.read()));
      if (key === 'cmd') commandSections.push(...sections);
      let definition;
      for (const section of sections) {
        const state = section.name.match(/^statedef\s+(-?\d+)/);
        if (state) {
          const id = Number(state[1]);
          definition = stateDefinitions.has(id) ? undefined : { ...section, controllers: [] };
          if (definition) stateDefinitions.set(id, definition);
          if (!states.has(id) && /^\d+$/.test(section.values.anim || '')) states.set(id, Number(section.values.anim));
        } else if (definition && /^state(?:\s|$)/.test(section.name)) definition.controllers.push(section);
      }
    }
    const links = new Map(), commandTransitions = new Map();
    for (const section of commandSections) {
      if ((section.values.type || '').toLowerCase() !== 'changestate' || !section.values.value) continue;
      for (const match of section.body.matchAll(/\bcommand\s*=\s*"([^"]+)"/gi)) {
        if (!commandTransitions.has(match[1])) commandTransitions.set(match[1], []);
        commandTransitions.get(match[1]).push(section.values.value);
        const animation = states.get(Number(section.values.value));
        if (animations.has(animation) && !links.has(match[1])) links.set(match[1], animation);
      }
    }
    const commands = [], seen = new Set();
    for (const section of commandSections.filter(section => section.name === 'command')) {
      const name = unquote(section.values.name || '');
      if (!name || seen.has(name)) continue;
      seen.add(name);
      commands.push({ name, input: section.values.command || '', action: links.get(name), transitions: [...new Set(commandTransitions.get(name) || [])] });
    }
    const palettes = [];
    for (const [key, name] of Object.entries(files)) if (/^pal\d+$/.test(key) && resolve(name)) palettes.push({ name: key, data: await resolve(name).read() });
    const palette = palettes.find(palette => palette.name === 'pal1')?.data;
    if (ticket !== loadId) return;
    character = { info, sprites, animations, commands, palettes, palette, stateDefinitions, constants, cache: new Map() };
    $('character-name').textContent = unquote(info.displayname || info.name || selected.name);
    $('author').textContent = info.author ? 'By ' + unquote(info.author) : 'Author not specified';
    $('archive-name').textContent = file.name;
    const data = constants.find(section => section.name === 'data')?.values || {};
    $('properties').replaceChildren();
    for (const [label, value] of [['Sprites', sprites.size], ['Animations', animations.size], ['Palettes', palettes.length], ['Life', data.life], ['Attack', data.attack], ['Defence', data.defence], ['SFF version', '1']]) {
      if (value === undefined) continue;
      const row = document.createElement('div'), term = document.createElement('dt'), description = document.createElement('dd');
      term.textContent = label; description.textContent = value; row.append(term, description); $('properties').append(row);
    }
    $('actions').replaceChildren();
    for (const [id, action] of animations) {
      const name = new Map([[0, 'Idle'], [20, 'Walk forward'], [21, 'Walk back'], [11, 'Crouch'], [40, 'Jump start'], [195, 'Taunt']]).get(id) || 'Action ' + id;
      const button = document.createElement('button'); button.textContent = name + ' · ' + action.frames.length + ' frames'; button.dataset.action = id; button.onclick = () => selectAction(id, name); $('actions').append(button);
    }
    $('animation-count').textContent = animations.size; $('animation-search').disabled = false; $('animation-search').value = '';
    $('all-animations').hidden = false; $('search').disabled = false; $('search').value = ''; showCommands();
    $('empty').hidden = true; canvas.hidden = false; $('preview-label').hidden = false; $('play').disabled = false; $('restart').disabled = false;
    playing = true; $('play').textContent = 'Pause'; selectAction(0, 'Idle');
    setupRuntime();
    $('status').textContent = entries.length + ' files · ' + formatSize(file.size) + ' · loaded locally';
  } catch (error) { if (ticket !== loadId) return; $('error').textContent = error.message; $('error').hidden = false; $('status').textContent = 'Could not load ' + file.name; }
}

function showCommands() {
  $('commands').replaceChildren();
  const query = $('search').value.toLowerCase();
  const commands = character.commands.filter(command => (command.name + ' ' + command.input).toLowerCase().includes(query)).sort((a, b) => Number(Boolean(b.transitions.length)) - Number(Boolean(a.transitions.length)));
  $('command-count').textContent = character.commands.length;
  for (const command of commands) {
    const button = document.createElement('button'), name = document.createElement('span'), input = document.createElement('small');
    button.className = 'command'; name.textContent = command.name; input.textContent = command.input;
    const link = document.createElement('small'); link.textContent = command.transitions.length ? '▶ Trigger state ' + command.transitions[0] : 'No state transition defined';
    button.append(name, input, link);
    button.title = 'Trigger the linked state without gameplay conditions';
    button.onclick = () => {
      for (const item of $('commands').children) item.classList.toggle('active', item === button);
      sendCommand(command.name);
    }; $('commands').append(button);
  }
  if (!commands.length) $('commands').textContent = 'No matching commands.';
}

function selectAction(id, name, raw = true) {
  if (raw && runtime) runtime.active = false;
  currentAction = character.animations.get(id); frameIndex = 0; elapsed = 0;
  playing = true; $('play').textContent = 'Pause';
  $('action-name').textContent = name || 'Action ' + id;
  for (const button of $('actions').children) button.classList.toggle('active', Number(button.dataset.action) === id);
  draw();
  if (raw && runtime) updateRuntimeInfo();
}

function draw() {
  if (!character || !currentAction?.frames.length) return;
  const frame = currentAction.frames[frameIndex], sprite = character.sprites.get(frame.group + ',' + frame.image);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  $('frame-info').textContent = 'FRAME ' + (frameIndex + 1) + ' / ' + currentAction.frames.length + ' · SPRITE ' + frame.group + ', ' + frame.image;
  if (!sprite) { $('frame-info').textContent += ' · missing'; return; }
  let image = character.cache.get(sprite);
  if (!image) { image = decodePcx(sprite, character.palette); character.cache.set(sprite, image); }
  const scale = Number($('zoom').value) * canvas.width / Math.max(canvas.clientWidth, 1);
  ctx.save(); ctx.imageSmoothingEnabled = false;
  ctx.translate(canvas.width / 2 + (frame.x + (runtime?.active ? runtime.x : 0)) * scale, canvas.height * .78 + (frame.y + (runtime?.active ? runtime.y : 0)) * scale);
  if (runtime?.active) ctx.scale(runtime.facing, 1);
  ctx.scale(frame.flip.includes('H') ? -scale : scale, frame.flip.includes('V') ? -scale : scale);
  ctx.drawImage(image, -sprite.x, -sprite.y); ctx.restore();
}

function tick(time) {
  const delta = Math.min(time - lastTime, 250); lastTime = time;
  if (playing && currentAction?.frames.length) {
    elapsed += delta;
    if (runtime?.active) {
      try {
        while (elapsed >= 1000 / 60 && playing) { elapsed -= 1000 / 60; stepRuntime(); }
        draw(); updateRuntimeInfo();
      } catch (error) { playing = false; $('play').textContent = 'Play'; $('error').textContent = error.message; $('error').hidden = false; }
      requestAnimationFrame(tick); return;
    }
    let frame = currentAction.frames[frameIndex];
    while (frame.duration >= 0 && elapsed >= Math.max(1, frame.duration) * 1000 / 60) {
      elapsed -= Math.max(1, frame.duration) * 1000 / 60;
      frameIndex++; if (frameIndex >= currentAction.frames.length) frameIndex = currentAction.loop;
      frame = currentAction.frames[frameIndex];
    }
    try { draw(); } catch (error) { playing = false; $('play').textContent = 'Play'; $('error').textContent = error.message; $('error').hidden = false; }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function readZip(buffer) {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer), entries = [];
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (view.getUint32(end, true) === 0x06054b50) break;
  if (end < Math.max(0, bytes.length - 65557)) throw Error('This file is not a valid ZIP archive.');
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw Error('Split ZIP archives are not supported.');
  let offset = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw Error('Invalid ZIP directory.');
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true), compressed = view.getUint32(offset + 20, true), size = view.getUint32(offset + 24, true), nameLength = view.getUint16(offset + 28, true), local = view.getUint32(offset + 42, true);
    const name = normalize(new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength)));
    if (!name.endsWith('/') && !name.startsWith('__MACOSX/') && !name.split('/').some(part => part.startsWith('._'))) entries.push({ name, size, async read() {
      if (flags & 1) throw Error('Encrypted ZIP entries are not supported.');
      if (size > 128 * 1024 * 1024) throw Error('ZIP entry exceeds the 128 MB limit.');
      if (view.getUint32(local, true) !== 0x04034b50) throw Error('Invalid ZIP entry.');
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      if (start + compressed > bytes.length) throw Error('Truncated ZIP entry.');
      const data = bytes.subarray(start, start + compressed);
      if (method === 0) return data;
      if (method !== 8) throw Error('Unsupported ZIP compression method: ' + method);
      const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
      const chunks = []; let length = 0;
      while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > size || length > 128 * 1024 * 1024) { await reader.cancel(); throw Error('ZIP entry expands beyond its declared size.'); } chunks.push(value); }
      if (length !== size) throw Error('Truncated ZIP data.');
      const result = new Uint8Array(length); let position = 0; for (const chunk of chunks) { result.set(chunk, position); position += chunk.length; } return result;
    } });
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return entries;
}

function readSff(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (new TextDecoder().decode(bytes.subarray(0, 12)) !== 'ElecbyteSpr\0') throw Error('Invalid SFF sprite file.');
  if (bytes[15] !== 1) throw Error('This version supports SFF v1 characters. SFF v2 is not supported yet.');
  const sprites = new Map(), ordered = []; let offset = view.getUint32(24, true), palette, basePalette;
  const count = view.getUint32(20, true), header = view.getUint32(28, true);
  for (let i = 0; i < count && offset; i++) {
    if (offset + header > bytes.length || header < 19) throw Error('Invalid SFF sprite header.');
    const next = view.getUint32(offset, true), length = view.getUint32(offset + 4, true), group = view.getUint16(offset + 12, true), number = view.getUint16(offset + 14, true), linked = view.getUint16(offset + 16, true);
    if (offset + header + length > bytes.length) throw Error('Truncated SFF sprite.');
    const data = length ? bytes.subarray(offset + header, offset + header + length) : ordered[linked]?.data;
    if (!data) throw Error('Invalid linked SFF sprite.');
    if (length && !bytes[offset + 18] && data.length >= 897 && data[data.length - 769] === 12) palette = data.subarray(data.length - 768);
    if (!basePalette && palette) basePalette = palette;
    // Character sprite 0,0 starts the base palette sequence after portrait palettes.
    if (group === 0 && number === 0) palette = basePalette;
    const spritePalette = length ? palette : ordered[linked].palette;
    const sprite = { group, number, x: view.getInt16(offset + 8, true), y: view.getInt16(offset + 10, true), data, palette: spritePalette, shared: spritePalette === basePalette };
    ordered.push(sprite); sprites.set(group + ',' + number, sprite); offset = next;
  }
  return sprites;
}

function decodePcx(sprite, externalPalette) {
  const bytes = sprite.data, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 128 || bytes[0] !== 10 || bytes[3] !== 8 || bytes[65] !== 1) throw Error('Only 8-bit indexed PCX sprites are supported.');
  const width = view.getUint16(8, true) - view.getUint16(4, true) + 1, height = view.getUint16(10, true) - view.getUint16(6, true) + 1, stride = view.getUint16(66, true);
  if (width <= 0 || height <= 0 || stride < width || width * height > 16000000) throw Error('Invalid PCX dimensions.');
  const palette = externalPalette && sprite.shared ? externalPalette : sprite.palette;
  if (!palette || palette.length < 768) throw Error('Sprite palette is missing.');
  const output = document.createElement('canvas'); output.width = width; output.height = height;
  const context = output.getContext('2d'), image = context.createImageData(width, height);
  let source = 128, position = 0;
  while (position < stride * height) {
    if (source >= bytes.length) throw Error('Truncated PCX pixels.');
    let value = bytes[source++], count = 1;
    if (bytes[2] === 1 && (value & 192) === 192) { count = value & 63; if (!count || source >= bytes.length) throw Error('Invalid PCX run.'); value = bytes[source++]; }
    while (count-- && position < stride * height) {
      const x = position % stride, y = Math.floor(position / stride); position++;
      if (x >= width) continue;
      const target = (y * width + x) * 4;
      // ACT stores palette colors in reverse order relative to SFF v1 PCX indices.
      const color = externalPalette && sprite.shared ? (255 - value) * 3 : value * 3;
      image.data[target] = palette[color]; image.data[target + 1] = palette[color + 1]; image.data[target + 2] = palette[color + 2]; image.data[target + 3] = value === 0 ? 0 : 255;
    }
  }
  context.putImageData(image, 0, 0); return output;
}

function readAir(text) {
  const actions = new Map(); let action;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(';')[0].trim(), match = line.match(/^\[Begin Action\s+(\d+)\]/i);
    if (match) { action = { frames: [], loop: 0 }; actions.set(Number(match[1]), action); }
    else if (action && /^loopstart$/i.test(line)) action.loop = action.frames.length;
    else if (action && /^-?\d+\s*,/.test(line)) { const parts = line.split(',').map(part => part.trim()); if (parts.length >= 5 && parts.slice(0, 5).every(part => /^-?\d+$/.test(part))) action.frames.push({ group: Number(parts[0]), image: Number(parts[1]), x: Number(parts[2]), y: Number(parts[3]), duration: Number(parts[4]), flip: (parts[5] || '').toUpperCase() }); }
  }
  for (const [id, action] of actions) { if (!action.frames.length) actions.delete(id); else if (action.loop >= action.frames.length) action.loop = 0; }
  return actions;
}

function parseSections(text) {
  const sections = []; let section;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(';')[0].trim(), header = line.match(/^\[([^\]]+)\]/);
    if (header) { section = { name: header[1].trim().toLowerCase(), values: {}, entries: [], body: '' }; sections.push(section); }
    else if (section) { section.body += line + '\n'; const pair = line.match(/^([^=]+)=(.*)$/); if (pair) { const key = pair[1].trim().toLowerCase(), value = pair[2].trim(); section.values[key] = value; section.entries.push([key, value]); } }
  }
  return sections;
}
function setupRuntime() {
  expressionCache.clear();
  runtime = { active: true, stateNo: 0, prevStateNo: 0, time: 0, serial: 0, tick: 0, animNo: 0, animTick: 0, frameTime: 0, ended: false, ctrl: 1, stateType: 's', moveType: 'i', physics: 's', x: 0, y: 0, vx: 0, vy: 0, facing: 1, life: 1000, power: Number($('power').value), vars: new Map(), held: new Set(), pulses: new Map(), counts: new Map(), issues: new Set(), trace: [], roundState: 2, win: 0, lose: 0, hit: {}, hitAge: 0, moveHit: 0, moveGuarded: 0 };
  runtime.life = Number(character.constants.find(section => section.name === 'data')?.values.life) || 1000;
  $('simulation').hidden = false; $('inputs').replaceChildren(); $('events').replaceChildren();
  for (const [symbol, label] of [['B', '← Back'], ['D', '↓ Crouch'], ['U', '↑ Jump'], ['F', '→ Forward'], ['x', 'X'], ['y', 'Y'], ['z', 'Z'], ['a', 'A'], ['b', 'B'], ['c', 'C'], ['s', 'Start']]) {
    const button = document.createElement('button'); button.textContent = label; button.dataset.input = symbol;
    button.onpointerdown = event => { event.preventDefault(); button.setPointerCapture(event.pointerId); holdInput(symbol, true); };
    button.onpointerup = button.onpointercancel = button.onlostpointercapture = () => holdInput(symbol, false);
    $('inputs').append(button);
  }
  for (const [event, label] of [['intro', 'Intro'], ['win', 'Win round'], ['lose', 'Lose / time over'], ['hit', 'Get hit'], ['fall', 'Knockdown'], ['ko', 'KO'], ['contact', 'Attack connects'], ['guarded', 'Attack blocked']]) {
    const button = document.createElement('button'); button.textContent = label; button.onclick = () => triggerEvent(event); $('events').append(button);
  }
  $('reset-runtime').onclick = () => { $('guard-threat').checked = false; setupRuntime(); };
  $('power').oninput = () => { if (runtime) runtime.power = Math.max(0, Math.min(3000, Number($('power').value))); };
  enterState(0, 'Character loaded'); updateRuntimeInfo();
}

const keyInputs = { ArrowLeft: 'B', ArrowRight: 'F', ArrowDown: 'D', ArrowUp: 'U', KeyA: 'x', KeyS: 'y', KeyD: 'z', KeyZ: 'a', KeyX: 'b', KeyC: 'c', Enter: 's' };
document.addEventListener('keydown', event => {
  if (!runtime || event.metaKey || event.ctrlKey || event.altKey || event.target.isContentEditable || !keyInputs[event.code] || /INPUT|SELECT|TEXTAREA|BUTTON/.test(event.target.tagName)) return;
  event.preventDefault(); if (!event.repeat) holdInput(keyInputs[event.code], true);
});
document.addEventListener('keyup', event => { if (runtime && keyInputs[event.code]) holdInput(keyInputs[event.code], false); });
globalThis.addEventListener('blur', () => { if (runtime) { runtime.held.clear(); for (const button of $('inputs').children) button.classList.toggle('active', false); } });

function holdInput(symbol, down) {
  if (!runtime) return;
  if (down && !runtime.active) { runtime.active = true; enterState(0, 'Return from raw animation'); }
  if (down) { runtime.held.add(symbol); playing = true; $('play').textContent = 'Pause'; }
  else runtime.held.delete(symbol);
  for (const button of $('inputs').children) button.classList.toggle('active', runtime.held.has(button.dataset.input));
}

function sendCommand(name) {
  if (!runtime.active) { runtime.active = true; enterState(0, 'Return from raw animation'); }
  const command = character.commands.find(command => command.name === name);
  const previous = runtime.stateNo;
  let entered = false;
  for (const target of command?.transitions || []) {
    try { if (enterState(evaluate(target), 'Viewer command: ' + name)) { entered = true; break; } }
    catch (error) { runtime.issues.add(error.message); }
  }
  if (entered) { playing = true; $('play').textContent = 'Pause'; }
  $('status').textContent = entered ? name + ' · state ' + previous + ' → ' + runtime.stateNo : name + ' · no linked state available in this character';
  draw(); updateRuntimeInfo();
}

function triggerEvent(event) {
  runtime.active = true; playing = true; $('play').textContent = 'Pause';
  runtime.held.clear(); runtime.pulses.clear();
  if (event === 'contact' || event === 'guarded') {
    runtime.moveHit = Number(event === 'contact'); runtime.moveGuarded = Number(event === 'guarded');
  } else if (event === 'intro' || event === 'win' || event === 'lose') {
    runtime.roundState = event === 'intro' ? 0 : 3; runtime.win = Number(event === 'win'); runtime.lose = Number(event === 'lose');
    runtime.y = 0; runtime.vx = 0; runtime.vy = 0;
    enterState(event === 'intro' ? 5900 : event === 'win' ? 180 : 170, event);
  } else {
    const strength = Number($('hit-strength').value), fall = event !== 'hit';
    runtime.hit = { animtype: strength, groundtype: 1, airtype: 1, damage: [20, 50, 90][strength], hittime: 20, slidetime: 10, ctrltime: 20, shaketime: 8, xvel: -3, yvel: fall ? -7 : 0, fall: Number(fall), 'fall.recover': 1, 'fall.recovertime': 30, 'fall.yvel': 0, 'fall.damage': 0, hitcount: 1, yaccel: .49 };
    runtime.life = event === 'ko' ? 0 : Math.max(1, runtime.life - runtime.hit.damage); runtime.hitAge = 0; runtime.ctrl = 0;
    enterState(runtime.stateType === 'a' ? 5020 : runtime.stateType === 'c' ? 5010 : 5000, event);
  }
  $('status').textContent = 'Triggered ' + event; draw(); updateRuntimeInfo();
}

function enterState(id, reason, control, animation) {
  if (!Number.isInteger(id) || !character.stateDefinitions.has(id)) { runtime.issues.add('Missing state ' + id); return false; }
  const definition = character.stateDefinitions.get(id), values = definition.values;
  runtime.prevStateNo = runtime.stateNo; runtime.stateNo = id; runtime.time = 0; runtime.serial++; runtime.counts.clear(); runtime.moveHit = 0; runtime.moveGuarded = 0;
  for (const [key, field, fallback] of [['type', 'stateType', 's'], ['movetype', 'moveType', 'i'], ['physics', 'physics', 'n']]) {
    const setting = (values[key] || fallback).toLowerCase(); if (setting !== 'u') runtime[field] = setting;
  }
  try {
    if (values.ctrl !== undefined) runtime.ctrl = Number(Boolean(evaluate(values.ctrl)));
    if (control !== undefined) runtime.ctrl = control;
    if (values.velset) { const parts = splitExpressions(values.velset); runtime.vx = evaluate(parts[0]); runtime.vy = parts[1] ? evaluate(parts[1]) : 0; }
    if (values.poweradd) runtime.power = Math.max(0, Math.min(3000, runtime.power + evaluate(values.poweradd)));
    if (animation !== undefined || values.anim !== undefined) setRuntimeAnimation(animation ?? evaluate(values.anim));
  } catch (error) { runtime.issues.add('State ' + id + ': ' + error.message); }
  runtime.trace.push({ tick: runtime.tick, from: runtime.prevStateNo, to: id, reason }); if (runtime.trace.length > 60) runtime.trace.shift();
  return true;
}

function setRuntimeAnimation(id, element = 1) {
  if (!character.animations.has(id)) { runtime.issues.add('Missing animation ' + id); return; }
  selectAction(id, 'State ' + runtime.stateNo + ' · Animation ' + id, false);
  runtime.animNo = id; frameIndex = Math.max(0, Math.min(currentAction.frames.length - 1, element - 1));
  runtime.frameTime = 0; runtime.animTick = currentAction.frames.slice(0, frameIndex).reduce((sum, frame) => sum + Math.max(0, frame.duration), 0); runtime.ended = false;
}

function stepRuntime() {
  if (!runtime?.active) return;
  runtime.tick++;
  const before = runtime.serial;
  // MUGEN evaluates global controllers before the current state's controllers.
  for (const id of [-3, -2, -1]) { runControllers(character.stateDefinitions.get(id)?.controllers || []); if (runtime.serial !== before) break; }
  let transitions = 0;
  while (true) {
    const serial = runtime.serial;
    runControllers(character.stateDefinitions.get(runtime.stateNo)?.controllers || []);
    if (serial === runtime.serial) break;
    if (++transitions >= 32) throw Error('Stopped: more than 32 state transitions in one tick.');
  }
  const processedSerial = runtime.serial;
  // These transitions are supplied by the game engine rather than common1.cns.
  if (runtime.stateNo === 140 && runtime.ended) enterState(runtime.stateType === 'a' ? 51 : runtime.stateType === 'c' ? 11 : 0, 'Guard exit complete', 1);
  if (runtime.ctrl && runtime.roundState === 2 && runtime.moveType !== 'h' && runtime.stateNo !== 140) {
    const up = runtime.held.has('U'), down = runtime.held.has('D'), back = runtime.held.has('B'), forward = runtime.held.has('F');
    if (runtime.stateType !== 'a') {
      if (up) enterState(40, 'Jump input', 0);
      else if (back && $('guard-threat').checked && ![120, 130, 131].includes(runtime.stateNo)) enterState(120, 'Guard threat + back', 0);
      else if ([0, 20].includes(runtime.stateNo) && down) enterState(10, 'Crouch input', 1);
      else if ([10, 11].includes(runtime.stateNo) && !down) enterState(12, 'Release crouch', 1);
      else if ([0, 20].includes(runtime.stateNo) && !down && forward !== back && runtime.stateNo !== 20) enterState(20, 'Walk input', 1);
      else if (runtime.stateNo === 20 && forward === back) enterState(0, 'Release walk', 1);
    }
  }
  if (runtime.stateNo === 0 && runtime.roundState === 0) { runtime.roundState = 2; runtime.ctrl = 1; }
  if (runtime.serial === processedSerial) {
    const gravity = runtimeConstant('movement.yaccel');
    if (runtime.physics === 'a') runtime.vy += gravity;
    if (runtime.physics === 's' || runtime.physics === 'c') runtime.vx *= runtimeConstant(runtime.physics === 's' ? 'movement.stand.friction' : 'movement.crouch.friction');
    runtime.x += runtime.vx * runtime.facing; runtime.y += runtime.vy;
    if (runtime.physics === 'a' && runtime.y >= 0 && runtime.vy > 0) { runtime.y = 0; runtime.vy = 0; enterState(52, 'Ground contact', 0); }
    if (runtime.serial === processedSerial) { advanceRuntimeAnimation(); runtime.time++; }
  }
  runtime.hitAge++;
  for (const [name, ticks] of runtime.pulses) { if (ticks <= 1) runtime.pulses.delete(name); else runtime.pulses.set(name, ticks - 1); }
}

function advanceRuntimeAnimation() {
  if (!currentAction?.frames.length) return;
  runtime.ended = false;
  const frame = currentAction.frames[frameIndex]; if (frame.duration < 0) return;
  runtime.frameTime++; runtime.animTick++;
  if (runtime.frameTime >= Math.max(1, frame.duration)) {
    runtime.frameTime = 0; frameIndex++;
    if (frameIndex >= currentAction.frames.length) { runtime.ended = true; frameIndex = currentAction.loop; runtime.animTick = currentAction.frames.slice(0, frameIndex).reduce((sum, frame) => sum + Math.max(0, frame.duration), 0); }
  }
}

function runControllers(controllers) {
  for (const controller of controllers) {
    const values = controller.values, type = (values.type || '').toLowerCase(); if (type === 'null' || !type) continue;
    const all = [], groups = new Map();
    for (const [key, expression] of controller.entries) {
      if (key === 'triggerall') all.push(expression);
      else if (/^trigger\d+$/.test(key)) { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(expression); }
    }
    const check = expression => { try { return Boolean(evaluate(expression)); } catch (error) { runtime.issues.add(error.message); return false; } };
    if (!all.every(check) || ![...groups.values()].some(group => group.every(check))) continue;
    const count = runtime.counts.get(controller) || 0, persistent = Number(values.persistent ?? 1);
    runtime.counts.set(controller, count + 1);
    if ((persistent === 0 && count > 0) || (persistent > 1 && count % persistent !== 0)) continue;
    const value = (key = 'value', fallback) => values[key] === undefined ? fallback : evaluate(values[key]);
    try {
      if (type === 'changestate' || type === 'selfstate') { if (enterState(value(), controller.name, value('ctrl'), value('anim'))) return; }
      else if (type === 'changeanim') setRuntimeAnimation(value(), value('elem', 1));
      else if (type === 'ctrlset') runtime.ctrl = Number(Boolean(value()));
      else if (type === 'statetypeset') { for (const [key, field] of [['statetype', 'stateType'], ['movetype', 'moveType'], ['physics', 'physics']]) if (values[key] && values[key].toLowerCase() !== 'u') runtime[field] = values[key].toLowerCase(); }
      else if (['velset', 'veladd', 'velmul', 'posset', 'posadd'].includes(type)) {
        for (const axis of ['x', 'y']) if (values[axis] !== undefined) { const field = type.startsWith('vel') ? 'v' + axis : axis, amount = value(axis); if (type.endsWith('set')) runtime[field] = amount; else if (type.endsWith('mul')) runtime[field] *= amount; else runtime[field] += amount; }
      } else if (type === 'hitvelset') { for (const axis of ['x', 'y']) if (value(axis, 0)) runtime['v' + axis] = runtime.hit[axis + 'vel'] || 0; }
      else if (type === 'varset' || type === 'varadd') {
        const assignment = controller.entries.find(([key]) => /^(?:var|fvar|sysvar|sysfvar)\(\d+\)$/.test(key));
        const key = assignment ? assignment[0] : (values.fv !== undefined ? 'fvar' : 'var') + '(' + value(values.fv !== undefined ? 'fv' : 'v') + ')';
        const amount = assignment ? evaluate(assignment[1]) : value(); runtime.vars.set(key, (type === 'varadd' ? runtime.vars.get(key) || 0 : 0) + amount);
      } else if (type === 'varrangeset') { const kind = values.fvalue !== undefined ? 'fvar' : 'var'; for (let i = value('first', 0); i <= value('last', kind === 'var' ? 59 : 39); i++) runtime.vars.set(kind + '(' + i + ')', value(kind === 'var' ? 'value' : 'fvalue', 0)); }
      else if (type === 'poweradd' || type === 'powerset') runtime.power = Math.max(0, Math.min(3000, (type === 'poweradd' ? runtime.power : 0) + value()));
      else if (type === 'lifeadd' || type === 'lifeset') runtime.life = Math.max(value('kill', 1) ? 0 : 1, (type === 'lifeadd' ? runtime.life : 0) + value());
      else if (type === 'turn') runtime.facing *= -1;
      else runtime.issues.add('Controller not simulated: ' + type);
    } catch (error) { runtime.issues.add(controller.name + ': ' + error.message); }
  }
}

function runtimeConstant(name) {
  const parts = name.split('.'), section = parts.shift();
  const constants = character.constants.find(entry => entry.name === section)?.values || {};
  let key = parts.join('.'), axis;
  if (/\.[xy]$/.test(key)) { axis = key.slice(-1); key = key.slice(0, -2); }
  if (section === 'velocity' && key === 'jump' && axis === 'y') key = 'jump.neu';
  const raw = constants[key];
  if (raw === undefined) { if (section === 'movement' && name.endsWith('friction')) return .85; if (name === 'movement.yaccel') return .44; throw Error('Missing constant: ' + name); }
  const values = splitExpressions(raw); return evaluate(values[axis === 'y' ? 1 : 0] || '0');
}

function commandActive(name) {
  if (runtime.pulses.has(name)) return true;
  const command = character.commands.find(command => command.name === name);
  if (!command) return false;
  const input = command.input.replace(/\s/g, '');
  if (!/^\/?\$?(?:[UD]?[BF]?|[abcxyzs])$/.test(input)) return false;
  const symbol = input.replace(/[/$]/g, '');
  if (!symbol) return false;
  return [...symbol].every(key => runtime.held.has(key));
}

function splitExpressions(text) {
  const parts = []; let depth = 0, start = 0, quoted = false;
  for (let i = 0; i < text.length; i++) { if (text[i] === '"') quoted = !quoted; if (quoted) continue; if ('(['.includes(text[i])) depth++; if (')]'.includes(text[i])) depth--; if (text[i] === ',' && depth === 0) { parts.push(text.slice(start, i).trim()); start = i + 1; } }
  parts.push(text.slice(start).trim()); return parts;
}

function evaluate(text) {
  if (typeof text !== 'string') throw Error('Missing expression');
  if (!expressionCache.has(text)) expressionCache.set(text, parseExpression(text));
  const result = evalExpression(expressionCache.get(text));
  if (typeof result === 'number' && !Number.isFinite(result)) throw Error('Non-finite expression: ' + text);
  return result;
}

function parseExpression(text) {
  const source = text.toLowerCase().replace(/"[^"]*"/g, match => match).replace(/\b(vel|pos|p2dist|p2bodydist|screenpos)\s+([xy])\b/g, '$1.$2')
    .replace(/\banimelem\s*=\s*(\d+)(?:\s*,\s*(>=|<=|!=|=|>|<)\s*(-?\d+))?/g, (_, element, op, offset) => 'animelemtime(' + element + ')' + (op || '=') + (offset || '0'));
  const tokens = []; let offset = 0;
  while (offset < source.length) {
    const match = source.slice(offset).match(/^\s*("[^"]*"|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[a-z_][a-z0-9_.]*|\*\*|&&|\|\||\^\^|!=|<=|>=|:=|[()+\-*/%!=<>&|^~,\[\]])/);
    if (!match) { if (!source.slice(offset).trim()) break; throw Error('Unsupported expression: ' + text); }
    tokens.push(match[1]); offset += match[0].length;
  }
  let index = 0;
  const precedence = { '||': 1, '^^': 2, '&&': 3, '|': 4, '^': 5, '&': 6, '=': 7, '!=': 7, '<': 8, '>': 8, '<=': 8, '>=': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10, '**': 11 };
  const parse = (minimum = 0) => {
    const token = tokens[index++]; let node;
    if (['!', '-', '+', '~'].includes(token)) node = { kind: 'unary', op: token, child: parse(11) };
    else if (token === '(' || token === '[') {
      const first = parse();
      if (tokens[index] === ',') { index++; const second = parse(), end = tokens[index++]; if (end !== ')' && end !== ']') throw Error('Invalid range: ' + text); node = { kind: 'range', low: first, high: second, lowOpen: token === '(', highOpen: end === ')' }; }
      else { if (token !== '(' || tokens[index++] !== ')') throw Error('Invalid parentheses: ' + text); node = first; }
    } else if (token?.startsWith('"')) node = { kind: 'literal', value: token.slice(1, -1) };
    else if (/^(?:\d|\.)/.test(token || '')) node = { kind: 'literal', value: Number(token) };
    else if (/^[a-z_]/.test(token || '')) {
      if (tokens[index] === '(') { index++; const args = []; if (tokens[index] !== ')') { do { args.push(parse()); if (tokens[index] !== ',') break; index++; } while (true); } if (tokens[index++] !== ')') throw Error('Invalid function: ' + text); node = { kind: 'call', name: token, args }; }
      else node = { kind: 'name', name: token };
    } else throw Error('Unsupported expression: ' + text);
    while (precedence[tokens[index]] !== undefined && precedence[tokens[index]] >= minimum) { const op = tokens[index++], right = parse(precedence[op] + (op === '**' ? 0 : 1)); node = { kind: 'binary', op, left: node, right }; }
    return node;
  };
  const node = parse(); if (index !== tokens.length) throw Error('Unsupported expression: ' + text); return node;
}

function evalExpression(node) {
  if (node.kind === 'literal') return node.value;
  if (node.kind === 'name') {
    const name = node.name;
    if (['s', 'c', 'a', 'l', 'i', 'h', 'n', 'u'].includes(name)) return name;
    const values = { time: runtime.time, stateno: runtime.stateNo, prevstateno: runtime.prevStateNo, anim: runtime.animNo, ctrl: runtime.ctrl, statetype: runtime.stateType, movetype: runtime.moveType, physics: runtime.physics, facing: runtime.facing, life: runtime.life, lifemax: Number(character.constants.find(s => s.name === 'data')?.values.life) || 1000, alive: Number(runtime.life > 0), power: runtime.power, powermax: 3000, palno: 1, roundstate: runtime.roundState, roundno: 1, roundsexisted: 0, matchno: 1, matchover: Number(runtime.roundState === 3), win: runtime.win, winko: runtime.win, wintime: runtime.win, lose: runtime.lose, drawgame: 0, ishelper: 0, numhelper: 0, numtarget: 0, numproj: 0, numenemy: 1, numpartner: 0, inguarddist: Number($('guard-threat').checked), movehit: runtime.moveHit, movecontact: Number(Boolean(runtime.moveHit || runtime.moveGuarded)), moveguarded: runtime.moveGuarded, hitcount: runtime.moveHit, uniqhitcount: runtime.moveHit, hitpausetime: 0, hitover: Number(runtime.hitAge >= (runtime.hit.hittime || 20)), hitshakeover: Number(runtime.hitAge >= (runtime.hit.shaketime || 8)), hitfall: runtime.hit.fall || 0, hitrecover: 0, 'vel.x': runtime.vx, 'vel.y': runtime.vy, 'pos.x': runtime.x, 'pos.y': runtime.y, 'p2dist.x': Number($('opponent-distance').value) - runtime.x, 'p2dist.y': -runtime.y, 'p2bodydist.x': Number($('opponent-distance').value) - runtime.x, 'p2bodydist.y': -runtime.y, p2statetype: 's', p2movetype: 'i', p2stateno: 0, p2life: 1000, p2name: '', p4name: '', name: unquote(character.info.name || '').toLowerCase(), authorname: unquote(character.info.author || '').toLowerCase(), random: Math.floor(Math.random() * 1000), pi: Math.PI, gametime: runtime.tick, tickspersecond: 60, command: { command: true } };
    if (name === 'animtime') { if (runtime.ended) return 0; if (currentAction.frames.some(frame => frame.duration < 0)) return -1; return runtime.animTick - currentAction.frames.reduce((sum, frame) => sum + Math.max(1, frame.duration), 0); }
    if (Object.hasOwn(values, name)) return values[name];
    throw Error('Trigger not supported: ' + name);
  }
  if (node.kind === 'range') return { range: true, low: evalExpression(node.low), high: evalExpression(node.high), lowOpen: node.lowOpen, highOpen: node.highOpen };
  if (node.kind === 'unary') { const value = evalExpression(node.child); return node.op === '!' ? Number(!value) : node.op === '~' ? ~value : node.op === '-' ? -value : +value; }
  if (node.kind === 'call') {
    const name = node.name, args = node.args;
    if (name === 'ifelse' || name === 'cond') return evalExpression(evalExpression(args[0]) ? args[1] : args[2]);
    if (['var', 'fvar', 'sysvar', 'sysfvar'].includes(name)) return runtime.vars.get(name + '(' + evalExpression(args[0]) + ')') || 0;
    if (name === 'const') return runtimeConstant(args[0].name);
    if (name === 'gethitvar') { const key = args[0].name; if (Object.hasOwn(runtime.hit, key)) return runtime.hit[key]; throw Error('Hit parameter not supplied: ' + key); }
    if (name === 'selfanimexist' || name === 'animexist') return Number(character.animations.has(evalExpression(args[0])));
    if (name === 'numhelper' || name === 'numtarget' || name === 'numexplod' || name === 'numprojid') return 0;
    if (name === 'animelemtime') { const element = evalExpression(args[0]); if (element < 1 || element > currentAction.frames.length) return -999999; const start = currentAction.frames.slice(0, element - 1).reduce((sum, frame) => sum + Math.max(1, frame.duration), 0); return runtime.animTick - start; }
    if (name === 'animelemno') return frameIndex + 1;
    const functions = { abs: Math.abs, floor: Math.floor, ceil: Math.ceil, exp: Math.exp, ln: Math.log, log: Math.log10, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, min: Math.min, max: Math.max };
    if (Object.hasOwn(functions, name)) return functions[name](...args.map(evalExpression));
    throw Error('Function not supported: ' + name);
  }
  const left = evalExpression(node.left), op = node.op;
  if (op === '&&') return left ? Number(Boolean(evalExpression(node.right))) : 0;
  if (op === '||') return left ? 1 : Number(Boolean(evalExpression(node.right)));
  const right = evalExpression(node.right);
  if (op === '=' || op === '!=') {
    const equal = left?.command ? commandActive(right) : right?.range ? (right.lowOpen ? left > right.low : left >= right.low) && (right.highOpen ? left < right.high : left <= right.high) : left === right;
    return Number(op === '=' ? equal : !equal);
  }
  switch (op) { case '+': return left + right; case '-': return left - right; case '*': return left * right; case '/': return left / right; case '%': return left % right; case '**': return left ** right; case '<': return Number(left < right); case '>': return Number(left > right); case '<=': return Number(left <= right); case '>=': return Number(left >= right); case '&': return left & right; case '|': return left | right; case '^': return left ^ right; case '^^': return Number(Boolean(left) !== Boolean(right)); default: throw Error('Operator not supported: ' + op); }
}

function updateRuntimeInfo() {
  $('runtime-info').textContent = runtime.active ? 'State ' + runtime.stateNo + ' ← ' + runtime.prevStateNo + ' · tick ' + runtime.time + ' · animation ' + runtime.animNo + ' · ' + runtime.stateType.toUpperCase() + ' · control ' + runtime.ctrl + ' · life ' + runtime.life + ' · power ' + runtime.power : 'Raw animation preview · state runner suspended';
  $('transitions').replaceChildren();
  for (const transition of runtime.trace) { const item = document.createElement('li'); item.textContent = '[' + transition.tick + '] ' + transition.from + ' → ' + transition.to + ' · ' + transition.reason; $('transitions').append(item); }
  $('limitations').replaceChildren(); $('limitation-count').textContent = runtime.issues.size;
  for (const issue of runtime.issues) { const item = document.createElement('li'); item.textContent = issue; $('limitations').append(item); }
}

function decode(bytes) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('shift_jis').decode(bytes); } }
function unquote(value) { return value.trim().replace(/^"(.*)"$/, '$1'); }
function normalize(path) { const parts = []; for (const part of path.replaceAll('\\', '/').split('/')) { if (part === '..') parts.pop(); else if (part !== '.') parts.push(part); } return parts.join('/'); }
function formatSize(size) { return size >= 1048576 ? (size / 1048576).toFixed(1) + ' MB' : size >= 1024 ? (size / 1024).toFixed(1) + ' KB' : size + ' B'; }
