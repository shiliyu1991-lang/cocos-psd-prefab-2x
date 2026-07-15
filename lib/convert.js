'use strict';
/**
 * psd2prefab core — Cocos Creator 2.4.x PSD -> Prefab converter.
 * - layer naming convention drives node type / filtering / dedup
 * - PSD TEXT layers auto-become cc.Label (string + fontSize + color from PSD),
 *   even without an lbl_ prefix; explicit prefixes still win
 * - node / image / prefab names romanized to English (pinyin); Label display
 *   text keeps the original content
 * - pixel-accurate alignment; MD5 image dedup
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readPsd, initializeCanvas } = require('ag-psd');
const { PNG } = require('pngjs');

initializeCanvas(
    function createCanvas() { throw new Error('createCanvas not supported (headless psd2prefab)'); },
    function createImageData(width, height) {
        return { width: width, height: height, data: new Uint8ClampedArray(width * height * 4) };
    }
);

const BUILTIN_SPRITE_MATERIAL = 'eca5d2f2-8ef6-41c2-bbe6-f9c79d09c432';

let _pinyin = null;
try { _pinyin = require('pinyin-pro').pinyin; } catch (e) { _pinyin = null; }
function romanizeName(s) {
    s = String(s == null ? '' : s);
    if (/^[\x00-\x7F]*$/.test(s)) return s;
    let r = '';
    for (const ch of s) {
        if (/[A-Za-z0-9]/.test(ch)) r += ch;
        else if (ch === '_' || ch === '-') r += ch;
        else if (/[一-龥]/.test(ch) && _pinyin) {
            const py = _pinyin(ch, { toneType: 'none', type: 'array' })[0] || '';
            r += py.charAt(0).toUpperCase() + py.slice(1);
        }
    }
    return r;
}
function englishName(base, kind) {
    let r = romanizeName(base).replace(/^[_\-]+|[_\-]+$/g, '');
    if (!r) {
        r = kind === 'label' ? 'Label' : kind === 'button' ? 'Button'
            : kind === 'layout' ? 'Layout'
            : (kind === 'sprite' || kind === 'sprite-sliced') ? 'Sprite' : 'Node';
    }
    return r;
}
function typePrefix(kind){
    if (kind==='sprite'||kind==='sprite-sliced') return 'Img_';
    if (kind==='label'||kind==='richtext') return 'Label_';
    if (kind==='button') return 'Btn_'; // btn_ 图层 -> 节点名加 Btn_ 前缀
    return 'Node_';
}
function clampSuffix(s){ // <=8 letters/digits; keep a trailing number for disambiguation
    s=String(s);
    const m=s.match(/(\d+)$/); const tail=m?m[1]:''; const head=tail?s.slice(0,s.length-tail.length):s;
    const budget=Math.max(0,8-tail.length);
    let out='', cnt=0;
    for(const ch of head){
        if(/[A-Za-z0-9]/.test(ch)){ if(cnt>=budget) break; cnt++; out+=ch; }
        else { if(cnt>=budget) break; out+=ch; }
    }
    return out.replace(/[_\-]+$/,'') + tail;
}
function prefixedName(base, kind){ const p=typePrefix(kind); base=String(base); if(base.indexOf(p)===0) base=base.slice(p.length); return p+clampSuffix(base); }

const TYPE_PREFIX = {
    lbl_: 'label', rt_: 'richtext', btn_: 'button', tog_: 'toggle',
    sp_: 'sprite-sliced', prog_: 'progress', node_: 'empty', mask_: 'mask',
    sv_: 'scrollview', edit_: 'editbox', lay_: 'layout',
};
const IGNORE_PREFIX = ['ref_', 'tmp_'];
const IGNORE_NAMES = new Set(['bg_guide']);

function parseName(rawName) {
    const r = { raw: rawName, ignore: false, ignoreReason: null, type: 'sprite',
        base: rawName, slice: null, mods: {}, ref: null, explicitType: false };
    let name = String(rawName == null ? '' : rawName).trim();
    if (name === '') { r.ignore = true; r.ignoreReason = 'empty-name'; return r; }
    if (name.startsWith('//')) { r.ignore = true; r.ignoreReason = 'comment'; return r; }
    if (name.startsWith('!')) { r.ignore = true; r.ignoreReason = 'bang-ignore'; return r; }
    for (const p of IGNORE_PREFIX) {
        if (name.toLowerCase().startsWith(p)) { r.ignore = true; r.ignoreReason = 'ignore-prefix:' + p; return r; }
    }
    if (IGNORE_NAMES.has(name.toLowerCase())) { r.ignore = true; r.ignoreReason = 'ignore-name'; return r; }
    if (name.toLowerCase().startsWith('keep_')) { r.mods.keepInactive = true; name = name.slice(5); }
    const tokens = name.split(/\s+/);
    const head = [];
    for (const tok of tokens) {
        if (tok.startsWith('#')) r.slice = parseSlice(tok.slice(1));
        else if (tok.startsWith('@')) parseMod(tok.slice(1), r.mods);
        else if (tok.includes('=')) r.ref = tok.split('=')[1] || null;
        else head.push(tok);
    }
    let core = head.join(' ');
    let matched = null;
    for (const pre of Object.keys(TYPE_PREFIX)) {
        if (core.toLowerCase().startsWith(pre)) { matched = pre; break; }
    }
    if (matched) {
        r.type = TYPE_PREFIX[matched];
        r.explicitType = true;
        r.base = core.slice(matched.length);
        if (matched === 'lay_') {
            const m = /^(h|v|grid)_/i.exec(r.base);
            if (m) { r.mods.layout = m[1].toLowerCase(); r.base = r.base.slice(m[0].length); }
            else r.mods.layout = 'h';
        }
    } else { r.base = core; }
    if (r.slice && r.type === 'sprite') r.type = 'sprite-sliced';
    if (!r.base) r.base = core || rawName;
    return r;
}
function parseSlice(s) {
    const n = s.split(',').map((x) => parseInt(x.trim(), 10)).filter((x) => Number.isFinite(x));
    if (n.length === 1) return { top: n[0], right: n[0], bottom: n[0], left: n[0] };
    if (n.length === 2) return { top: n[0], right: n[1], bottom: n[0], left: n[1] };
    if (n.length >= 4) return { top: n[0], right: n[1], bottom: n[2], left: n[3] };
    return { top: 0, right: 0, bottom: 0, left: 0 };
}
function parseMod(m, mods) {
    const lower = m.toLowerCase();
    if (/^\d+x$/.test(lower)) { mods.scale = parseInt(lower, 10); return; }
    if (lower === 'nocrop') { mods.nocrop = true; return; }
    if (lower === 'flipx') { mods.flipX = true; return; }
    if (lower === 'flipy') { mods.flipY = true; return; }
    if (lower === 'gray') { mods.gray = true; return; }
    if (lower === 'unique') { mods.unique = true; return; }
    if (/^(90|180|270)$/.test(lower)) { mods.rotate = parseInt(lower, 10); return; }
    mods[lower] = true;
}
function uuid() {
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
const FILEID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function fileId() { let s = ''; const b = crypto.randomBytes(22); for (let i=0;i<22;i++) s += FILEID_CHARS[b[i]%64]; return s; }
function alphaBBox(id){
    const W=id.width,H=id.height,data=id.data; let minX=W,minY=H,maxX=-1,maxY=-1;
    for(let y=0;y<H;y++){ const row=y*W; for(let x=0;x<W;x++){ if(data[(row+x)*4+3]>8){ if(x<minX)minX=x; if(x>maxX)maxX=x; if(y<minY)minY=y; if(y>maxY)maxY=y; } } }
    if(maxX<0) return null;
    return { x:minX, y:minY, w:maxX-minX+1, h:maxY-minY+1 };
}
// Read a Photoshop "Stroke" layer style (描边) into a simple {size,color,opacity}.
// PS layer styles are non-destructive (stored as descriptors, not baked into pixels),
// so ag-psd exposes them via layer.effects.stroke[] but never renders them. We only
// bake the common case here — a solid-color OUTSIDE stroke; gradient/pattern fills and
// inside/center positions are flagged as unsupported so the caller can warn.
const STROKE_MAX = 64;
function readStroke(layer) {
    const fx = layer && layer.effects;
    if (!fx || fx.disabled || !Array.isArray(fx.stroke) || !fx.stroke.length) return null;
    const e = fx.stroke.find((s) => s && s.enabled !== false && s.present !== false);
    if (!e) return null;
    const sizePx = (e.size && typeof e.size.value === 'number') ? Math.round(e.size.value) : 0;
    if (sizePx < 1) return null;
    const fill = e.fillType || 'color';
    const pos = e.position || 'outside';
    if (fill !== 'color' || pos !== 'outside') return { unsupported: true, reason: fill + '/' + pos };
    const col = e.color || {};
    const opacity = (typeof e.opacity === 'number') ? Math.max(0, Math.min(1, e.opacity)) : 1;
    return { size: Math.min(STROKE_MAX, sizePx),
        color: { r: Math.round(col.r || 0), g: Math.round(col.g || 0), b: Math.round(col.b || 0) },
        opacity };
}
function layerToPng(layer, crop, stroke) {
    const id = layer.imageData;
    if (!id || !id.width || !id.height) return null;
    const c = crop || { x:0, y:0, w:id.width, h:id.height };
    if (stroke && stroke.size) return strokePng(id, c, stroke);
    const png = new PNG({ width: c.w, height: c.h });
    for(let y=0;y<c.h;y++){
        const srcStart=((y+c.y)*id.width + c.x)*4;
        png.data.set(id.data.subarray(srcStart, srcStart + c.w*4), (y*c.w)*4);
    }
    return { buf: PNG.sync.write(png), width: c.w, height: c.h, rgba: png.data };
}
// Bake a solid OUTSIDE stroke onto the layer pixels. The canvas grows by `size` px on
// every side (kept symmetric so the visual center is unchanged — the caller expands the
// node bounds the same way). The stroke ring comes from a chamfer distance transform of
// the layer's alpha, then the original pixels are composited (src-over) on top.
function strokePng(id, c, stroke) {
    const s = stroke.size, W = c.w + 2*s, H = c.h + 2*s, N = W*H;
    const base = new Uint8Array(N*4);
    for (let y=0;y<c.h;y++){
        const src=((y+c.y)*id.width + c.x)*4, dst=((y+s)*W + s)*4;
        base.set(id.data.subarray(src, src + c.w*4), dst);
    }
    const INF=1e9, D1=3, D2=4, dist=new Float64Array(N);
    for (let i=0;i<N;i++) dist[i] = (base[i*4+3] >= 128) ? 0 : INF;
    for (let y=0;y<H;y++) for (let x=0;x<W;x++){
        const i=y*W+x; let d=dist[i];
        if (y>0){ d=Math.min(d, dist[i-W]+D1); if(x>0) d=Math.min(d, dist[i-W-1]+D2); if(x<W-1) d=Math.min(d, dist[i-W+1]+D2); }
        if (x>0) d=Math.min(d, dist[i-1]+D1);
        dist[i]=d;
    }
    for (let y=H-1;y>=0;y--) for (let x=W-1;x>=0;x--){
        const i=y*W+x; let d=dist[i];
        if (y<H-1){ d=Math.min(d, dist[i+W]+D1); if(x<W-1) d=Math.min(d, dist[i+W+1]+D2); if(x>0) d=Math.min(d, dist[i+W-1]+D2); }
        if (x<W-1) d=Math.min(d, dist[i+1]+D1);
        dist[i]=d;
    }
    const png=new PNG({ width: W, height: H }), o=png.data;
    const sr=stroke.color.r, sg=stroke.color.g, sb=stroke.color.b, sop=stroke.opacity;
    for (let i=0;i<N;i++){
        let cov = s - dist[i]/3 + 0.5; cov = cov<0 ? 0 : (cov>1 ? 1 : cov);
        const sa = sop*cov, oa = base[i*4+3]/255, ra = oa + sa*(1-oa);
        if (ra<=0){ o[i*4]=o[i*4+1]=o[i*4+2]=o[i*4+3]=0; continue; }
        o[i*4]   = Math.round((base[i*4]  *oa + sr*sa*(1-oa))/ra);
        o[i*4+1] = Math.round((base[i*4+1]*oa + sg*sa*(1-oa))/ra);
        o[i*4+2] = Math.round((base[i*4+2]*oa + sb*sa*(1-oa))/ra);
        o[i*4+3] = Math.round(ra*255);
    }
    return { buf: PNG.sync.write(png), width: W, height: H, rgba: o };
}

// ---- Perceptual hashing (visual-similarity dedup) ----
// Unlike MD5 (byte-exact), these produce a 64-bit fingerprint of the DOWNSCALED
// grayscale image so near-identical images (tiny compression/scale diffs) get
// close fingerprints. Grayscale is weighted by alpha so a UI silhouette matters.
function _grayAt(rgba, W, sx, sy) {
    const i = (sy * W + sx) * 4;
    const a = rgba[i + 3] / 255;
    return (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a;
}
function _downsampleGray(rgba, W, H, cols, rows) {
    const g = new Float64Array(cols * rows);
    for (let ty = 0; ty < rows; ty++) for (let tx = 0; tx < cols; tx++) {
        const sx = Math.min(W - 1, Math.floor((tx + 0.5) * W / cols));
        const sy = Math.min(H - 1, Math.floor((ty + 0.5) * H / rows));
        g[ty * cols + tx] = _grayAt(rgba, W, sx, sy);
    }
    return g;
}
// Returns a 64-char '0'/'1' string, or null if the image is empty.
function perceptualHash(rgba, W, H, algo) {
    if (!rgba || !W || !H) return null;
    if (algo === 'ahash') { // average hash: bit = pixel >= mean
        const g = _downsampleGray(rgba, W, H, 8, 8);
        let sum = 0; for (let i = 0; i < 64; i++) sum += g[i];
        const avg = sum / 64; let s = '';
        for (let i = 0; i < 64; i++) s += g[i] >= avg ? '1' : '0';
        return s;
    }
    // dhash (default): bit = pixel brighter than its right neighbour (9x8 grid)
    const g = _downsampleGray(rgba, W, H, 9, 8);
    let s = '';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += g[y * 9 + x] < g[y * 9 + x + 1] ? '1' : '0';
    return s;
}
function hamming(a, b) { if (!a || !b || a.length !== b.length) return 64; let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; }

// Scan a PSD for VISUALLY SIMILAR (not byte-identical) exported images and return
// clusters, WITHOUT writing anything. The panel shows these for the user to pick
// which clusters to merge; the chosen merges come back to convert() as opts.mergeMap
// (member-md5 -> representative-md5). Byte-identical dups are already handled by MD5
// dedup, so they collapse to one member here and only cross-md5 clusters are reported.
function scanSimilar(opts) {
    const report = { ignored: [], images: [], reused: 0, revalidated: 0, trimmed: 0, flattened: 0, mergedDecor: 0, written: 0, nodes: 0, labels: 0, strokeBaked: 0, strokeSkipped: [] };
    const buf = fs.readFileSync(opts.psdPath);
    const psd = readPsd(buf, { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
    const model = buildModel(psd, opts, report);
    const rootNode = { kind: 'empty', info: parseName(opts.prefabName || 'root'), name: 'root',
        px: { left: 0, top: 0, right: model.W, bottom: model.H }, width: model.W, height: model.H,
        opacity: 255, color: { r: 255, g: 255, b: 255 }, active: true, children: model.roots };
    if (opts.flattenWrappers !== false) flattenWrappers(rootNode, report);
    if (opts.mergeDecor) mergeDecor(rootNode, report);
    uniquifySiblings(rootNode);
    const algo = opts.simAlgo === 'ahash' ? 'ahash' : 'dhash';
    const items = [];
    (function walk(node) {
        const isImg = (node.kind === 'sprite' || node.kind === 'sprite-sliced');
        if (isImg && node.layer && node.info && !node.info.ref && !(node.info.mods && node.info.mods.unique)) {
            const png = layerToPng(node.layer, node.crop, node.stroke);
            if (png) { const ph = perceptualHash(png.rgba, png.width, png.height, algo);
                if (ph) items.push({ name: node.name, md5: md5(png.buf), phash: ph, w: png.width, h: png.height }); }
        }
        for (const c of (node.children || [])) walk(c);
    })(rootNode);
    // Collapse byte-identical images first (MD5 dedup already covers them).
    const byMd5 = {};
    for (const it of items) { if (!byMd5[it.md5]) byMd5[it.md5] = { md5: it.md5, phash: it.phash, w: it.w, h: it.h, names: [] }; byMd5[it.md5].names.push(it.name); }
    const uniq = Object.keys(byMd5).map((k) => byMd5[k]);
    // Union-find: connect images whose fingerprints are within the threshold.
    const thr = (opts.simThreshold != null) ? (opts.simThreshold | 0) : 5;
    const parent = uniq.map((_, i) => i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
        if (hamming(uniq[i].phash, uniq[j].phash) <= thr) { const ri = find(i), rj = find(j); if (ri !== rj) parent[ri] = rj; }
    }
    const clusters = {};
    for (let i = 0; i < uniq.length; i++) { const r = find(i); (clusters[r] = clusters[r] || []).push(i); }
    const groups = [];
    Object.keys(clusters).forEach((r) => {
        const idxs = clusters[r]; if (idxs.length < 2) return; // only cross-md5 clusters are interesting
        let dmax = 0; for (let a = 0; a < idxs.length; a++) for (let b = a + 1; b < idxs.length; b++) { const d = hamming(uniq[idxs[a]].phash, uniq[idxs[b]].phash); if (d > dmax) dmax = d; }
        const members = idxs.map((i) => ({ md5: uniq[i].md5, name: uniq[i].names[0], count: uniq[i].names.length, w: uniq[i].w, h: uniq[i].h }));
        members.sort((a, b) => (b.w * b.h) - (a.w * a.h)); // keep the largest as representative (best quality)
        groups.push({ rep: members[0].md5, distanceMax: dmax, members });
    });
    groups.sort((a, b) => b.members.length - a.members.length);
    return { imageCount: items.length, uniqueCount: uniq.length, algo, threshold: thr, groups };
}
function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }

// Build a project-wide dedup table by scanning EVERY sprite-frame PNG under
// assets/ (not just this conversion's outDir). Keyed by the PNG's MD5; the value
// reuses the asset's existing sprite-frame uuid (read from its .png.meta), so a
// matching layer points at the asset already in the project — no new PNG.
// Read-only: this table is consulted but never written back to .psd_assets.json.
function buildGlobalDedupTable(assetsRoot) {
    const tbl = {};
    const stack = [assetsRoot];
    while (stack.length) {
        const dir = stack.pop();
        let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
        for (const ent of ents) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) { stack.push(full); continue; }
            if (!/\.png$/i.test(ent.name)) continue;
            let meta; try { meta = JSON.parse(fs.readFileSync(full + '.meta', 'utf8')); } catch (e) { continue; }
            // 2.4.x: sprite-frame lives in the texture meta's subMetas, keyed by name.
            const subs = meta && meta.subMetas ? Object.keys(meta.subMetas).map((k) => meta.subMetas[k]) : [];
            const sf = subs.find((s) => s && s.importer === 'sprite-frame' && s.uuid);
            if (!sf) continue;
            let buf; try { buf = fs.readFileSync(full); } catch (e) { continue; }
            const hash = md5(buf);
            if (tbl[hash]) continue; // first match wins (stable)
            const rel = path.relative(assetsRoot, full).split(path.sep).join('/');
            tbl[hash] = { png: rel, spriteUuid: sf.uuid, w: sf.rawWidth || 0, h: sf.rawHeight || 0 };
        }
    }
    return tbl;
}
function makeTextureMeta(textureUuid, spriteUuid, spriteName, w, h, slice) {
    const b = slice || { top: 0, right: 0, bottom: 0, left: 0 };
    return { ver: '2.3.7', uuid: textureUuid, importer: 'texture', type: 'sprite',
        wrapMode: 'clamp', filterMode: 'bilinear', premultiplyAlpha: false, genMipmaps: false,
        packable: true, width: w, height: h, platformSettings: {}, subMetas: { [spriteName]: {
            ver: '1.0.6', uuid: spriteUuid, importer: 'sprite-frame', rawTextureUuid: textureUuid,
            trimType: 'auto', trimThreshold: 1, rotated: false, offsetX: 0, offsetY: 0, trimX: 0, trimY: 0,
            width: w, height: h, rawWidth: w, rawHeight: h,
            borderTop: b.top, borderBottom: b.bottom, borderLeft: b.left, borderRight: b.right, subMetas: {} } } };
}
function nodeObj(name, parentId, childIds, compIds, prefabId, opacity, color, w, h, x, y, active) {
    return { __type__: 'cc.Node', _name: name, _objFlags: 0,
        _parent: parentId == null ? null : { __id__: parentId },
        _children: childIds.map((id) => ({ __id__: id })), _active: active !== false,
        _components: compIds.map((id) => ({ __id__: id })), _prefab: { __id__: prefabId },
        _opacity: opacity == null ? 255 : opacity,
        _color: { __type__: 'cc.Color', r: color.r, g: color.g, b: color.b, a: 255 },
        _contentSize: { __type__: 'cc.Size', width: w, height: h },
        _anchorPoint: { __type__: 'cc.Vec2', x: 0.5, y: 0.5 },
        _trs: { __type__: 'TypedArray', ctor: 'Float64Array', array: [x, y, 0, 0, 0, 0, 1, 1, 1, 1] },
        _eulerAngles: { __type__: 'cc.Vec3', x: 0, y: 0, z: 0 },
        _skewX: 0, _skewY: 0, _zIndex: 0, _is3DNode: false, _groupIndex: 0, groupIndex: 0, _id: '' };
}
function spriteObj(nodeId, spriteUuid, sliced) {
    return { __type__: 'cc.Sprite', _name: '', _objFlags: 0, node: { __id__: nodeId }, _enabled: true,
        _materials: [{ __uuid__: BUILTIN_SPRITE_MATERIAL }], _srcBlendFactor: 770, _dstBlendFactor: 771,
        _spriteFrame: spriteUuid ? { __uuid__: spriteUuid } : null, _type: sliced ? 1 : 0, _sizeMode: 0,
        _fillType: 0, _fillCenter: { __type__: 'cc.Vec2', x: 0, y: 0 }, _fillStart: 0, _fillRange: 0,
        _isTrimmedMode: true, _atlas: null, _id: '' };
}
function labelObj(nodeId, str, fontSize) {
    const fs2 = fontSize || 24;
    return { __type__: 'cc.Label', _name: '', _objFlags: 0, node: { __id__: nodeId }, _enabled: true,
        _materials: [{ __uuid__: BUILTIN_SPRITE_MATERIAL }], _srcBlendFactor: 1, _dstBlendFactor: 771,
        _string: str, _N$string: str, _fontSize: fs2, _lineHeight: Math.round(fs2 * 1.25),
        _enableWrapText: false, _N$file: null, _isSystemFontUsed: true, _spacingX: 0, _batchAsBitmap: false,
        _styleFlags: 0, _underlineHeight: 0, _N$horizontalAlign: 1, _N$verticalAlign: 1,
        _N$fontFamily: 'Arial', _N$overflow: 0, _N$cacheMode: 0, _id: '' };
}
function buttonObj(nodeId, targetNodeId) {
    return { __type__: 'cc.Button', _name: '', _objFlags: 0, node: { __id__: nodeId }, _enabled: true,
        _normalMaterial: null, _grayMaterial: null, duration: 0.1, zoomScale: 1.2, clickEvents: [],
        _N$interactable: true, _N$enableAutoGrayEffect: false, _N$transition: 3, transition: 3,
        _N$normalColor: { __type__: 'cc.Color', r: 214, g: 214, b: 214, a: 255 },
        _N$pressedColor: { __type__: 'cc.Color', r: 211, g: 211, b: 211, a: 255 },
        _N$hoverColor: { __type__: 'cc.Color', r: 255, g: 255, b: 255, a: 255 },
        _N$disabledColor: { __type__: 'cc.Color', r: 124, g: 124, b: 124, a: 255 },
        _N$normalSprite: null, _N$pressedSprite: null, pressedSprite: null, _N$hoverSprite: null,
        hoverSprite: null, _N$disabledSprite: null, _N$target: { __id__: targetNodeId == null ? nodeId : targetNodeId }, _id: '' };
}
function layoutObj(nodeId, dir) {
    const type = dir === 'v' ? 2 : dir === 'grid' ? 3 : 1;
    return { __type__: 'cc.Layout', _name: '', _objFlags: 0, node: { __id__: nodeId }, _enabled: true,
        _layoutSize: { __type__: 'cc.Size', width: 100, height: 100 }, _resize: 1, _N$layoutType: type,
        _N$cellSize: { __type__: 'cc.Size', width: 40, height: 40 }, _N$startAxis: 0, _N$paddingLeft: 0,
        _N$paddingRight: 0, _N$paddingTop: 0, _N$paddingBottom: 0, _N$spacingX: 0, _N$spacingY: 0,
        _N$verticalDirection: 1, _N$horizontalDirection: 0, _N$affectedByScale: false, _id: '' };
}
function prefabInfoObj(rootId, fid) {
    return { __type__: 'cc.PrefabInfo', root: { __id__: rootId }, asset: { __id__: 0 }, fileId: fid, sync: false };
}
function _ctr(px){ return { x:(px.left+px.right)/2, y:(px.top+px.bottom)/2 }; }
function _area(n){ return (n.px.right-n.px.left)*(n.px.bottom-n.px.top); }
function flattenWrappers(node, report){
    if(!node.children) return;
    node.children = node.children.map(function(c){
        var cur=c, nm=c.name, did=false;
        while(cur.kind==='empty' && cur.children && cur.children.length===1 && cur.opacity===255 && cur.active!==false){ cur=cur.children[0]; did=true; }
        if(did){ cur.name=nm; report.flattened=(report.flattened||0)+1; }
        return cur;
    });
    node.children.forEach(function(c){ flattenWrappers(c, report); });
}
function mergeDecor(node, report){
    if(!node.children) return;
    var keep=[];
    for(var j=0;j<node.children.length;j++){
        var c=node.children[j], dropped=false;
        if(c.kind==='sprite'||c.kind==='sprite-sliced'){
            var cc=_ctr(c.px);
            for(var i=0;i<keep.length;i++){
                var k=keep[i]; if(k.kind!=='sprite'&&k.kind!=='sprite-sliced') continue;
                var kc=_ctr(k.px);
                var near=Math.abs(cc.x-kc.x)<=8 && Math.abs(cc.y-kc.y)<=8;
                var ratio=Math.min(_area(c),_area(k))/Math.max(_area(c),_area(k),1);
                if(near && ratio>=0.7){ if(_area(c)>_area(k)) keep[i]=c; dropped=true; report.mergedDecor=(report.mergedDecor||0)+1; break; }
            }
        }
        if(!dropped) keep.push(c);
    }
    node.children=keep;
    node.children.forEach(function(c){ mergeDecor(c, report); });
}
function uniquifySiblings(node){
    if(!node.children) return;
    var seen={};
    for(var i=0;i<node.children.length;i++){
        var c=node.children[i], nm=c.name, base=nm, k=2;
        while(seen[nm]) nm=base+'_'+(k++);
        seen[nm]=true; c.name=nm; uniquifySiblings(c);
    }
}
function buildModel(psd, opts, report) {
    const W = psd.width, H = psd.height;
    function walk(layer, depth) {
        const info = parseName(layer.name);
        // 命名以 ! 开头(或 // / ref_ / tmp_ 等)= 忽略:直接返回 null,且不会向下递归
        // children,所以该图层及其整个子树都不会导出。
        if (info.ignore) { report.ignored.push({ name: layer.name, reason: info.ignoreReason }); return null; }
        const hidden = layer.hidden === true || (layer.opacity === 0);
        if (hidden && !info.mods.keepInactive && !opts.keepHidden) { report.ignored.push({ name: layer.name, reason: 'hidden' }); return null; }
        const isGroup = Array.isArray(layer.children);
        if (isGroup) {
            const kids = [];
            for (const c of layer.children) { const k = walk(c, depth + 1); if (k) kids.push(k); }
            if (kids.length === 0) { report.ignored.push({ name: layer.name, reason: 'empty-group' }); return null; }
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const k of kids) { minX = Math.min(minX, k.px.left); minY = Math.min(minY, k.px.top); maxX = Math.max(maxX, k.px.right); maxY = Math.max(maxY, k.px.bottom); }
            return { kind: info.type === 'empty' ? 'empty' : mapGroupKind(info.type),
                info, name: prefixedName((opts.englishNames !== false) ? englishName(info.base || layer.name, info.type) : (info.base || layer.name), info.type === 'empty' ? 'empty' : mapGroupKind(info.type)),
                px: { left: minX, top: minY, right: maxX, bottom: maxY }, width: maxX - minX, height: maxY - minY,
                opacity: Math.round((layer.opacity == null ? 1 : layer.opacity) * 255), color: { r: 255, g: 255, b: 255 }, active: !hidden, children: kids };
        }
        // ---- leaf ----
        // Photoshop TEXT layer? -> default to Label (string/size/color from PSD),
        // unless the name explicitly forces another type (e.g. sp_ to rasterize).
        const ts = (layer.text && typeof layer.text.text === 'string') ? layer.text : null;
        const isText = !!ts;
        let kind = info.type;
        if (isText && !info.explicitType) kind = 'label';

        let left = layer.left || 0, top = layer.top || 0;
        let right = (layer.right != null) ? layer.right : left;
        let bottom = (layer.bottom != null) ? layer.bottom : top;
        let w = right - left, h = bottom - top;

        let fontSize = null, textColor = null;
        if (isText) {
            const style = ts.style || {};
            fontSize = Math.round(style.fontSize || 0) || null;
            const fc = style.fillColor;
            if (fc && typeof fc.r === 'number') textColor = { r: Math.round(fc.r), g: Math.round(fc.g), b: Math.round(fc.b) };
            if (w <= 0 || h <= 0) { // point text w/o bbox -> estimate
                const fz = fontSize || 24;
                const len = (ts.text || '').replace(/\s/g, '').length || 1;
                h = Math.round(fz * 1.3); w = Math.max(fz, Math.round(len * fz));
                const tr = ts.transform || [];
                const tx = (typeof tr[4] === 'number') ? tr[4] : left;
                const ty = (typeof tr[5] === 'number') ? tr[5] : top;
                left = Math.round(tx - w / 2); top = Math.round(ty - fz);
                right = left + w; bottom = top + h;
            }
        }
        let crop = null;
        if (opts.trimTransparent !== false && !isText && layer.imageData && kind !== 'sprite-sliced' && !info.mods.nocrop) {
            const bb = alphaBBox(layer.imageData);
            if (!bb) { report.ignored.push({ name: layer.name, reason: 'fully-transparent' }); return null; }
            if (bb.w < (right - left) || bb.h < (bottom - top)) {
                left = left + bb.x; top = top + bb.y; right = left + bb.w; bottom = top + bb.h;
                w = bb.w; h = bb.h; crop = bb; report.trimmed++;
            }
        }
        if (w <= 0 || h <= 0) { report.ignored.push({ name: layer.name, reason: 'empty-bounds' }); return null; }
        // PS "描边" (stroke layer style): bake a solid outside stroke into the exported PNG.
        // Outside stroke grows the visual box by `size` px on every side, so expand the
        // bounds symmetrically here — center (hence node position) stays put, contentSize
        // and the sprite frame both grow to match.
        let stroke = null;
        if (kind === 'sprite' && !isText && opts.bakeStroke !== false && layer.imageData) {
            const st = readStroke(layer);
            if (st && st.unsupported) report.strokeSkipped.push({ name: layer.name, reason: st.reason });
            else if (st) {
                const s = st.size;
                left -= s; top -= s; right += s; bottom += s; w += 2*s; h += 2*s;
                stroke = st; report.strokeBaked++;
            }
        }
        return { kind: kind, info, crop: crop, stroke: stroke,
            name: prefixedName((opts.englishNames !== false) ? englishName(info.base || layer.name, kind) : (info.base || layer.name), kind),
            rawBase: isText ? ts.text : (info.base || layer.name), fontSize: fontSize,
            px: { left, top, right, bottom }, width: w, height: h,
            opacity: Math.round((layer.opacity == null ? 1 : layer.opacity) * 255),
            color: textColor || { r: 255, g: 255, b: 255 }, active: !hidden, layer, children: [] };
    }
    const roots = [];
    for (const c of (psd.children || [])) { const k = walk(c, 0); if (k) roots.push(k); }
    return { W, H, roots };
}
function mapGroupKind(type) {
    if (type === 'button') return 'button';
    if (type === 'layout') return 'layout';
    if (type === 'scrollview') return 'scrollview';
    if (type === 'mask') return 'mask';
    return 'empty';
}
async function convert(opts) {
    const psdPath = opts.psdPath, projectRoot = opts.projectRoot;
    const outDir = opts.outDir || 'PSD';
    const prefabName = opts.prefabName || path.basename(psdPath).replace(/\.psd$/i, '');
    const dedup = opts.dedup !== false, dryRun = !!opts.dryRun;
    const validateCache = !!opts.validateCache;
    const outName = (opts.englishNames !== false) ? englishName(prefabName, 'empty') : prefabName;
    const report = { ignored: [], images: [], reused: 0, revalidated: 0, mergedSimilar: 0, trimmed: 0, flattened: 0, mergedDecor: 0, written: 0, nodes: 0, labels: 0, strokeBaked: 0, strokeSkipped: [], prefab: null };
    const buf = fs.readFileSync(psdPath);
    const psd = readPsd(buf, { useImageData: true, skipThumbnail: true, skipLinkedFilesData: true });
    const model = buildModel(psd, opts, report);
    const assetsRoot = path.join(projectRoot, 'assets');
    const texDirRel = path.posix.join(outDir, 'textures');
    const prefabDirRel = path.posix.join(outDir, 'prefabs');
    const texDirAbs = path.join(assetsRoot, outDir, 'textures');
    const prefabDirAbs = path.join(assetsRoot, outDir, 'prefabs');
    const tablePath = path.join(assetsRoot, outDir, '.psd_assets.json');
    if (!dryRun) { fs.mkdirSync(texDirAbs, { recursive: true }); fs.mkdirSync(prefabDirAbs, { recursive: true }); }
    let table = {};
    if (dedup && fs.existsSync(tablePath)) { try { table = JSON.parse(fs.readFileSync(tablePath, 'utf8')); } catch (e) { table = {}; } }
    // dedupAll: extend the dedup search to the WHOLE assets folder (read-only scan).
    const globalTable = (dedup && opts.dedupAll) ? buildGlobalDedupTable(assetsRoot) : null;
    if (globalTable) report.globalScanned = Object.keys(globalTable).length;
    // mergeMap: user-approved visual-similar merges (member-md5 -> representative-md5).
    // The first-encountered member of each cluster exports; the rest reuse its sprite.
    const mergeMap = (dedup && opts.mergeMap && typeof opts.mergeMap === 'object') ? opts.mergeMap : null;
    const repSet = mergeMap ? new Set(Object.keys(mergeMap).map((k) => mergeMap[k])) : null; // representative hashes
    const mergeCanon = {}; // canonical-hash -> resolved {spriteUuid,w,h}
    const usedNames = new Set();
    function uniqueFileName(base) { const n = sanitize(base) || 'img'; let cand = n, i = 1; while (usedNames.has(cand)) cand = n + '_' + (i++); usedNames.add(cand); return cand; }
    function resolveImage(node) {
        const png = layerToPng(node.layer, node.crop, node.stroke); if (!png) return null;
        const hash = md5(png.buf); const sliced = node.kind === 'sprite-sliced' ? node.info.slice : null;
        const eligible = !node.info.mods.unique;
        // Approved visual-similar merge: all members of a cluster (incl. the
        // representative itself) share one canonical key; the first-encountered
        // member exports, the rest reuse it. Takes precedence over new exports.
        const canonKey = (mergeMap && eligible) ? (mergeMap[hash] || (repSet.has(hash) ? hash : null)) : null;
        if (canonKey && mergeCanon[canonKey]) { report.mergedSimilar++; report.reused++; return mergeCanon[canonKey]; }
        let res = null;
        if (dedup && eligible && table[hash]) {
            const ent = table[hash];
            let cacheOk = true;
            if (validateCache) { // re-export if the cached file was deleted from the project
                const pngAbs = path.join(assetsRoot, ent.png);
                cacheOk = fs.existsSync(pngAbs) && fs.existsSync(pngAbs + '.meta');
            }
            if (cacheOk) { report.reused++; res = { spriteUuid: ent.spriteUuid, w: png.width, h: png.height }; }
            else { report.revalidated++; delete table[hash]; } // stale -> fall through and re-export
        }
        // Project-wide reuse: a matching PNG already exists somewhere in assets —
        // point at its existing sprite-frame instead of writing a new image.
        if (!res && globalTable && eligible && globalTable[hash]) {
            const ent = globalTable[hash];
            report.reused++;
            res = { spriteUuid: ent.spriteUuid, w: png.width, h: png.height };
        }
        if (!res) {
            const fname = uniqueFileName(node.name); const texUuid = uuid(), spriteUuid = uuid();
            if (!dryRun) {
                fs.writeFileSync(path.join(texDirAbs, fname + '.png'), png.buf);
                fs.writeFileSync(path.join(texDirAbs, fname + '.png.meta'), JSON.stringify(makeTextureMeta(texUuid, spriteUuid, fname, png.width, png.height, sliced), null, 2));
            }
            report.images.push({ name: fname, hash, w: png.width, h: png.height }); report.written++;
            if (dedup && eligible) table[hash] = { png: path.posix.join(texDirRel, fname + '.png'), textureUuid: texUuid, spriteUuid, w: png.width, h: png.height };
            res = { spriteUuid, w: png.width, h: png.height };
        }
        if (canonKey && !mergeCanon[canonKey]) mergeCanon[canonKey] = res; // register cluster canonical
        return res;
    }
    const out = [];
    out.push({ __type__: 'cc.Prefab', _name: outName, _objFlags: 0, _native: '', data: { __id__: 1 }, optimizationPolicy: 0, asyncLoadAssets: false, readonly: false });
    const prefabNodeIds = []; let rootId = null;
    function cocosCenter(px) { return { x: (px.left + px.right) / 2 - model.W / 2, y: model.H / 2 - (px.top + px.bottom) / 2 }; }
    function emit(node, parentId, parentAbs) {
        const abs = cocosCenter(node.px); const pos = { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y };
        const nodeId = out.length; out.push(null); prefabNodeIds.push(nodeId);
        const compIds = [], childIds = [];
        if (node.kind === 'sprite' || node.kind === 'sprite-sliced') {
            const img = node.info.ref ? resolveByRef(node, table) : resolveImage(node);
            const cid = out.length; out.push(spriteObj(nodeId, img ? img.spriteUuid : null, node.kind === 'sprite-sliced')); compIds.push(cid);
        } else if (node.kind === 'label') {
            const str = (node.layer && node.layer.text && node.layer.text.text) || node.rawBase || node.name;
            const cid = out.length; out.push(labelObj(nodeId, str, node.fontSize || guessFontSize(node))); compIds.push(cid); report.labels++;
        } else if (node.kind === 'button') { const cid = out.length; out.push(buttonObj(nodeId, nodeId)); compIds.push(cid); }
        else if (node.kind === 'layout') { const cid = out.length; out.push(layoutObj(nodeId, node.info.mods.layout || 'h')); compIds.push(cid); }
        for (const child of (node.children || [])) { const id = emit(child, nodeId, abs); childIds.push(id); }
        const scale = node.info.mods.scale || 1; let w = node.width, h = node.height;
        if (scale > 1) { w = Math.round(w / scale); h = Math.round(h / scale); }
        out[nodeId] = nodeObj(node.name, parentId, childIds, compIds, -1, node.opacity, node.color, w, h, pos.x, pos.y, node.active);
        report.nodes++; node._serId = nodeId; return nodeId;
    }
    const rootNode = { kind: 'empty', info: parseName(prefabName), name: outName,
        px: { left: 0, top: 0, right: model.W, bottom: model.H }, width: model.W, height: model.H,
        opacity: 255, color: { r: 255, g: 255, b: 255 }, active: true, children: model.roots };
    if (opts.flattenWrappers !== false) flattenWrappers(rootNode, report);
    if (opts.mergeDecor) mergeDecor(rootNode, report);
    uniquifySiblings(rootNode);
    rootId = emit(rootNode, null, { x: 0, y: 0 });
    for (const nid of prefabNodeIds) { const piId = out.length; out.push(prefabInfoObj(rootId, fileId())); out[nid]._prefab = { __id__: piId }; }
    const prefabJson = JSON.stringify(out, null, 2); const prefabUuid = uuid();
    const prefabRel = path.posix.join(prefabDirRel, outName + '.prefab');
    if (!dryRun) {
        fs.writeFileSync(path.join(prefabDirAbs, outName + '.prefab'), prefabJson);
        fs.writeFileSync(path.join(prefabDirAbs, outName + '.prefab.meta'), JSON.stringify({ ver: '1.3.2', uuid: prefabUuid, importer: 'prefab', optimizationPolicy: 'AUTO', asyncLoadAssets: false, readonly: false, subMetas: {} }, null, 2));
        if (dedup) fs.writeFileSync(tablePath, JSON.stringify(table, null, 2));
    }
    report.prefab = { name: outName, uuid: prefabUuid, path: 'db://assets/' + prefabRel, objectCount: out.length };
    return report;
}
function resolveByRef(node, table) { for (const k of Object.keys(table)) { if (table[k].png.endsWith('/' + node.info.ref + '.png')) return { spriteUuid: table[k].spriteUuid, w: table[k].w, h: table[k].h }; } return null; }
function guessFontSize(node) { const h = node.height; if (h >= 8 && h <= 200) return Math.max(12, Math.round(h * 0.8)); return 24; }
function sanitize(s) { return String(s).replace(/[^\w一-龥\-]+/g, '_').replace(/^_+|_+$/g, ''); }
module.exports = { convert, parseName, buildModel, scanSimilar };
