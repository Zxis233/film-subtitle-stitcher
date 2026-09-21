const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf8');

function harness() {
  const nodes = new Map(), canvases = [], links = [], revoked = [], alerts = [], pending = [];
  function element() {
    const classes = new Set();
    return {
      value: '', checked: false, disabled: false, textContent: '', width: 0, height: 0,
      classList: { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)), contains: x => classes.has(x) },
      appendChild() {}, append() {}, remove() {}, click() {},
      getContext() {
        return { scale() {}, fillRect() {}, drawImage() {}, save() {}, restore() {}, fillText() {} };
      },
      toBlob(callback, mime) { pending.push({ callback, mime, width: this.width, height: this.height }); },
    };
  }
  const sandbox = {
    document: {
      querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, element()); return nodes.get(selector); },
      querySelectorAll() { return []; }, activeElement: null, body: element(),
      createElement(tag) { const el = element(); if (tag === 'canvas') canvases.push(el); if (tag === 'a') links.push(el); return el; },
    },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL: url => revoked.push(url) },
    window: { alert: text => alerts.push(text) },
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(0, source.indexOf('els.fileInput.addEventListener')), sandbox);
  const start = source.indexOf('function clearDropIndicators');
  vm.runInContext(source.slice(start, source.indexOf('els.timeline.addEventListener("dragover"', start)), sandbox);
  const run = code => vm.runInContext(code, sandbox);
  run('syncStateFromControls = () => {}; renderTimeline = () => {};');
  return { sandbox, nodes, canvases, links, revoked, alerts, pending, run };
}

test('preview stays bounded; export retains requested resolution, uses actual MIME, and releases canvas', () => {
  const h = harness();
  h.run('state.images = [{width:4000,height:4000,img:{}}]; state.format = "image/webp";');
  assert.equal(h.sandbox.renderComposite(), true);
  const preview = h.nodes.get('#previewCanvas');
  assert.ok(preview.width * preview.height <= 2000000);
  assert.ok(preview.width < 4000);
  h.sandbox.downloadCanvas();
  h.sandbox.downloadCanvas();
  assert.equal(h.pending.length, 1);
  assert.equal(h.pending[0].width, 4000);
  assert.equal(h.pending[0].height, 4000);
  h.pending[0].callback({type:'image/png'});
  assert.match(h.links[0].download, /\.png$/);
  assert.equal(h.canvases[0].width, 0);
  assert.equal(h.canvases[0].height, 0);
  assert.equal(h.nodes.get('#downloadBtn').disabled, false);
});

test('output limits apply after ratio conversion and still block full-resolution export', () => {
  const h = harness();
  assert.equal(h.sandbox.getOutputSizeError({width:4000,height:4000}), '');
  for (const size of [{width:4001,height:4000},{width:16385,height:1},{width:Infinity,height:1},{width:0,height:1}]) {
    assert.ok(h.sandbox.getOutputSizeError(size));
  }
  h.run('state.images = [{width:100,height:10000,img:{}}]; state.autoSize = false; els.outputWidth.value = "1000"; els.outputHeight.value = "100";');
  h.sandbox.downloadCanvas();
  assert.equal(h.pending.length, 0);
  assert.equal(h.nodes.get('#downloadBtn').disabled, true);
  h.nodes.get('#outputWidth').value = '10';
  assert.equal(h.sandbox.renderComposite(), true);
});

test('export failure releases resources and permits retry', () => {
  const h = harness();
  h.run('state.images = [{width:100,height:100,img:{}}];');
  h.sandbox.downloadCanvas();
  h.pending[0].callback(null);
  assert.equal(h.canvases[0].width, 0);
  assert.equal(h.alerts.length, 1);
  h.sandbox.downloadCanvas();
  assert.equal(h.pending.length, 2);
});

test('overlapping imports preserve batch order and tolerate failed files', async () => {
  const h = harness();
  const loads = [];
  h.sandbox.loadImageFile = file => new Promise((resolve, reject) => loads.push({file, resolve, reject}));
  const file = name => ({name, type:'image/png'});
  const first = h.sandbox.addFiles([file('slow'), file('bad')]);
  const second = h.sandbox.addFiles([file('next')]);
  await Promise.resolve();
  assert.deepEqual(loads.map(x => x.file.name), ['slow','bad']);
  loads[1].reject(new Error('bad'));
  loads[0].resolve({name:'slow'});
  await first;
  await Promise.resolve();
  loads[2].resolve({name:'next'});
  await second;
  assert.equal(h.run('state.images.map(x => x.name).join(",")'), 'slow,next');
  assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0], /bad/);
});

test('watermark applies centered offsets while retaining edge inset semantics', () => {
  const h = harness();
  const positions = [];
  const ctx = {save(){},restore(){},fillText(text,x,y){positions.push([x,y]);}};
  h.run('state.watermark.enabled=true; state.watermark.position="middle-center"; state.watermark.offsetX=10; state.watermark.offsetY=20;');
  h.sandbox.drawWatermark(ctx, {width:1000,height:500}, 0.5);
  assert.deepEqual(positions.pop(), [510,270]);
  assert.equal(ctx.shadowBlur, 2);
  h.run('state.watermark.position="bottom-right";');
  h.sandbox.drawWatermark(ctx, {width:1000,height:500});
  assert.deepEqual(positions.pop(), [990,480]);
});

test('drag placement distinguishes both halves and blank-space append', () => {
  const h = harness();
  h.run('state.images=[{id:"a"},{id:"b"},{id:"c"}];');
  const thumb = {dataset:{id:'b'},getBoundingClientRect:()=>({left:100,width:100})};
  const event = x => ({target:{closest:()=>thumb},clientX:x});
  const before = h.sandbox.getDropPlacement(event(120));
  const after = h.sandbox.getDropPlacement(event(180));
  assert.equal(before.index,1); assert.equal(before.after,false);
  assert.equal(after.index,2); assert.equal(after.after,true);
  h.sandbox.reorderImage('a',after.index);
  assert.equal(h.run('state.images.map(x=>x.id).join(",")'),'b,a,c');
  assert.equal(h.sandbox.getDropPlacement({target:{closest:()=>null}}).index,3);
});
