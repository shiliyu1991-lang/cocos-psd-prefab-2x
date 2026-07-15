'use strict';

/**
 * cocos-psd-prefab-2x — dockable panel (2.4 panel API).
 * Pick a .psd, set output dir / prefab name / options, hit Convert.
 */

const PKG = 'cocos-psd-prefab-2x';

function ipc(msg) {
    const args = Array.prototype.slice.call(arguments, 1);
    return new Promise((resolve, reject) => {
        Editor.Ipc.sendToMain.apply(Editor.Ipc, [PKG + ':' + msg].concat(args, [
            (err, data) => { if (err) reject(err instanceof Error ? err : new Error(String(err))); else resolve(data); },
        ]));
    });
}

Editor.Panel.extend({
    template: `
<div class="pp">
    <header>PSD → 预制体</header>
    <div class="hint" id="proj">project: …</div>

    <div class="prop"><label>PSD 文件</label><input id="psdpath" type="text" placeholder="点下方“选择 PSD”…" readonly></div>
    <div class="minirow"><button id="pickpsd">选择 PSD</button></div>

    <div class="prop"><label>输出目录</label><input id="psdout" type="text" placeholder="PSD  →  assets/PSD/"></div>
    <div class="prop"><label>预制体名</label><input id="psdname" type="text" placeholder="留空则用 PSD 文件名"></div>
    <div class="minirow l"><label class="chk"><input id="psddedup" type="checkbox" checked> MD5 去重复用相同图片</label></div>
    <div class="minirow l"><label class="chk"><input id="psddedupall" type="checkbox"> 去重范围扩大到整个 assets 文件夹（复用已存在的图，稍慢）</label></div>
    <div class="minirow l"><label class="chk"><input id="psdtrim" type="checkbox" checked> 裁剪图片四周透明边（尺寸/位置更准；取消则保留原图）</label></div>
    <div class="minirow l"><label class="chk"><input id="psdflatten" type="checkbox" checked> 压平只含1个子节点的空容器（更扁平，好写代码）</label></div>
    <div class="minirow l"><label class="chk"><input id="psddecor" type="checkbox"> 合并重叠的装饰图（外发光+内层等，实验性）</label></div>
    <div class="minirow l"><label class="chk"><input id="psdvalidate" type="checkbox"> 检测缓存图片是否还在（被删过就重导，稍慢）</label></div>

    <div class="simhead">视觉相似查重（感知哈希，仅报告，需手动勾选才会合并）</div>
    <div class="prop">
        <label>算法/阈值</label>
        <select id="psdsimalgo">
            <option value="dhash">感知哈希 dHash（推荐）</option>
            <option value="ahash">感知哈希 aHash</option>
        </select>
        <select id="psdsimthr">
            <option value="3">严格 ≤3</option>
            <option value="5" selected>中等 ≤5</option>
            <option value="8">宽松 ≤8</option>
            <option value="12">很宽松 ≤12</option>
        </select>
        <button id="scansim">扫描相似图</button>
    </div>
    <div class="hint" id="simhint"></div>
    <div class="simbox" id="simbox"></div>

    <div class="row"><button id="convertpsd" class="primary">转换为预制体</button></div>
    <div class="hint" id="psdresult"></div>

    <input id="psdfile" type="file" accept=".psd,.psb" style="display:none">
    <footer>独立扩展 · 依赖已内置（无需 npm install）。规范见 docs/PSD命名规范.md</footer>
</div>`,
    style: `
:host { display: block; }
.pp { padding: 12px; font-size: 12px; display: flex; flex-direction: column; gap: 8px; color: #ccc; }
.pp header { font-weight: bold; font-size: 14px; }
.pp .prop { display: flex; align-items: center; gap: 8px; }
.pp .prop label { width: 64px; color: #aaa; flex: none; }
.pp .prop input { flex: 1; background: #2228; color: #ddd; border: 1px solid #4445; border-radius: 3px; padding: 3px 6px; }
.pp .row { display: flex; gap: 8px; margin-top: 2px; }
.pp button { background: #3a3a3a; color: #ddd; border: 1px solid #555; border-radius: 3px; padding: 5px 12px; cursor: pointer; }
.pp button:hover { background: #454545; }
.pp button.primary { background: #2b6cb0; border-color: #2b6cb0; color: #fff; flex: 1; font-weight: bold; padding: 7px; }
.pp button[disabled] { opacity: 0.45; cursor: default; }
.pp .minirow { display: flex; justify-content: flex-end; margin-top: -2px; }
.pp .minirow.l { justify-content: flex-start; }
.pp .chk { color: #aaa; cursor: pointer; }
.pp .hint { color: #888; font-size: 11px; white-space: pre-wrap; word-break: break-all; line-height: 1.5; min-height: 14px; }
.pp .hint .ok { color: #3c3; } .pp .hint .bad { color: #d66; }
.pp footer { color: #777; margin-top: 6px; font-size: 11px; }
.pp .simhead { color: #9ab; font-size: 11px; margin-top: 4px; border-top: 1px solid #3a3a3a; padding-top: 8px; }
.pp select { background: #2228; color: #ddd; border: 1px solid #4445; border-radius: 3px; padding: 3px 4px; }
.pp .simbox { display: flex; flex-direction: column; gap: 4px; max-height: 200px; overflow-y: auto; }
.pp .simbox:empty { display: none; }
.pp .simbar { display: flex; gap: 8px; align-items: center; color: #999; }
.pp .simbar a { color: #6ab0f3; cursor: pointer; text-decoration: underline; }
.pp .simgroup { background: #2a2a2a; border: 1px solid #3d3d3d; border-radius: 3px; padding: 4px 6px; }
.pp .simgroup .chk { color: #ccc; }
.pp .simmembers { color: #8a8a8a; font-size: 11px; margin: 2px 0 0 20px; word-break: break-all; }
.pp .simmembers .rep { color: #3c9; }
`,
    $: {
        proj: '#proj',
        psdpath: '#psdpath',
        pickpsd: '#pickpsd',
        psdout: '#psdout',
        psdname: '#psdname',
        psddedup: '#psddedup',
        psddedupall: '#psddedupall',
        psdtrim: '#psdtrim',
        psdflatten: '#psdflatten',
        psddecor: '#psddecor',
        psdvalidate: '#psdvalidate',
        psdsimalgo: '#psdsimalgo',
        psdsimthr: '#psdsimthr',
        scansim: '#scansim',
        simhint: '#simhint',
        simbox: '#simbox',
        convertpsd: '#convertpsd',
        psdresult: '#psdresult',
        psdfile: '#psdfile',
    },

    _setDisabled(el, on) {
        if (!el) return;
        if (on) el.setAttribute('disabled', ''); else el.removeAttribute('disabled');
    },
    _pickPsd() { if (this.$psdfile) this.$psdfile.click(); },
    _onPsdFile() {
        const f = this.$psdfile && this.$psdfile.files && this.$psdfile.files[0];
        if (f && f.path) {
            this._psdPath = f.path;
            if (this.$psdpath) this.$psdpath.value = f.path;
            if (this.$psdresult) this.$psdresult.innerText = '';
            this._clearSim();
        }
    },
    _esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); },
    _clearSim() {
        this._simGroups = null;
        if (this.$simbox) this.$simbox.innerHTML = '';
        if (this.$simhint) this.$simhint.innerText = '';
    },
    async _scanSim() {
        if (!this._psdPath) {
            if (this.$simhint) this.$simhint.innerHTML = '<span class="bad">请先选择 PSD 文件</span>';
            return;
        }
        const params = {
            psdPath: this._psdPath,
            name: ((this.$psdname && this.$psdname.value) || '').trim() || undefined,
            trim: this.$psdtrim ? this.$psdtrim.checked : true,
            flatten: this.$psdflatten ? this.$psdflatten.checked : true,
            mergeDecor: this.$psddecor ? this.$psddecor.checked : false,
            simAlgo: (this.$psdsimalgo && this.$psdsimalgo.value) || 'dhash',
            simThreshold: parseInt((this.$psdsimthr && this.$psdsimthr.value) || '5', 10),
        };
        try {
            this._clearSim();
            if (this.$simhint) this.$simhint.innerText = '扫描中…';
            this._setDisabled(this.$scansim, true);
            const r = await ipc('scan-similar-psd', params);
            this._renderSim(r);
        } catch (e) {
            if (this.$simhint) this.$simhint.innerHTML = '<span class="bad">扫描失败</span>: ' + this._esc(e && e.message ? e.message : e);
        } finally {
            this._setDisabled(this.$scansim, false);
        }
    },
    _renderSim(r) {
        const groups = (r && r.groups) || [];
        this._simGroups = groups;
        if (this.$simhint) {
            this.$simhint.innerHTML = groups.length
                ? '发现 <b>' + groups.length + '</b> 组视觉相似（共扫描 ' + (r.imageCount || 0) + ' 图，去重后 ' + (r.uniqueCount || 0) + ' 图，' + this._esc(r.algo) + ' ≤' + r.threshold + '）。勾选的组会在转换时合并为 1 张（保留最大尺寸那张）。'
                : '未发现视觉相似图（' + this._esc(r.algo) + ' ≤' + (r.threshold != null ? r.threshold : '') + '，共 ' + (r.imageCount || 0) + ' 图）。可放宽阈值再扫。';
        }
        if (!this.$simbox) return;
        if (!groups.length) { this.$simbox.innerHTML = ''; return; }
        let html = '<div class="simbar">勾选=合并　<a id="simall">全选</a>　<a id="simnone">全不选</a></div>';
        groups.forEach((g, gi) => {
            const members = g.members.map((m) => {
                const dim = ' <span style="color:#666">' + m.w + '×' + m.h + (m.count > 1 ? ' ×' + m.count : '') + '</span>';
                const isRep = m.md5 === g.rep;
                return '<span class="' + (isRep ? 'rep' : '') + '">' + this._esc(m.name) + (isRep ? '(代表)' : '') + dim + '</span>';
            }).join('　');
            html += '<div class="simgroup">'
                + '<label class="chk"><input type="checkbox" class="simcb" data-gi="' + gi + '" checked> '
                + '组' + (gi + 1) + ' · 距离≤' + g.distanceMax + ' · ' + g.members.length + ' 张</label>'
                + '<div class="simmembers">' + members + '</div></div>';
        });
        this.$simbox.innerHTML = html;
        const all = this.$simbox.querySelector('#simall'), none = this.$simbox.querySelector('#simnone');
        const setAll = (v) => { this.$simbox.querySelectorAll('.simcb').forEach((cb) => { cb.checked = v; }); };
        if (all) all.addEventListener('click', () => setAll(true));
        if (none) none.addEventListener('click', () => setAll(false));
    },
    _buildMergeMap() {
        if (!this._simGroups || !this._simGroups.length || !this.$simbox) return null;
        const map = {};
        this.$simbox.querySelectorAll('.simcb').forEach((cb) => {
            if (!cb.checked) return;
            const g = this._simGroups[parseInt(cb.getAttribute('data-gi'), 10)];
            if (g) g.members.forEach((m) => { if (m.md5 !== g.rep) map[m.md5] = g.rep; });
        });
        return Object.keys(map).length ? map : null;
    },
    async _convertPsd() {
        if (!this._psdPath) {
            if (this.$psdresult) this.$psdresult.innerHTML = '<span class="bad">请先选择 PSD 文件</span>';
            return;
        }
        const params = {
            psdPath: this._psdPath,
            outDir: ((this.$psdout && this.$psdout.value) || '').trim() || 'PSD',
            name: ((this.$psdname && this.$psdname.value) || '').trim() || undefined,
            dedup: this.$psddedup ? this.$psddedup.checked : true,
            dedupAll: this.$psddedupall ? this.$psddedupall.checked : false,
            trim: this.$psdtrim ? this.$psdtrim.checked : true,
            flatten: this.$psdflatten ? this.$psdflatten.checked : true,
            mergeDecor: this.$psddecor ? this.$psddecor.checked : false,
            validateCache: this.$psdvalidate ? this.$psdvalidate.checked : false,
            mergeMap: this._buildMergeMap(),
        };
        try {
            if (this.$psdresult) this.$psdresult.innerText = '转换中…';
            this._setDisabled(this.$convertpsd, true);
            const r = await ipc('convert-psd', params);
            const p = (r && r.prefab) || {};
            const ignored = (r && r.ignored && r.ignored.length) || 0;
            if (this.$psdresult) {
                this.$psdresult.innerHTML =
                    '<span class="ok">完成</span>  节点 ' + (r.nodes || 0) +
                    ' · 新图 ' + (r.written || 0) + ' · 复用 ' + (r.reused || 0) +
                    (r.globalScanned != null ? '(全项目扫描 ' + r.globalScanned + ' 图)' : '') +
                    (r.trimmed ? ' · 裁剪 ' + r.trimmed : '') +
                    (r.flattened ? ' · 压平 ' + r.flattened : '') +
                    (r.mergedSimilar ? ' · 相似合并 ' + r.mergedSimilar : '') +
                    (r.mergedDecor ? ' · 合并 ' + r.mergedDecor : '') +
                    (r.strokeBaked ? ' · 描边 ' + r.strokeBaked : '') +
                    (r.revalidated ? ' · 重导 ' + r.revalidated : '') +
                    ' · 忽略 ' + ignored +
                    ((r.strokeSkipped && r.strokeSkipped.length) ? '\n描边未烘焙(需栅格化) ' + r.strokeSkipped.length + ' 层: ' + r.strokeSkipped.map(function(s){return s.name + '(' + s.reason + ')';}).join(', ') : '') +
                    '\n' + (p.path || '');
            }
        } catch (e) {
            if (this.$psdresult) {
                this.$psdresult.innerHTML = '<span class="bad">失败</span>: ' +
                    String(e && e.message ? e.message : e);
            }
        } finally {
            this._setDisabled(this.$convertpsd, false);
        }
    },

    ready() {
        if (this.$pickpsd) this.$pickpsd.addEventListener('click', () => this._pickPsd());
        if (this.$psdfile) this.$psdfile.addEventListener('change', () => this._onPsdFile());
        if (this.$convertpsd) this.$convertpsd.addEventListener('click', () => this._convertPsd());
        if (this.$scansim) this.$scansim.addEventListener('click', () => this._scanSim());
        // Changing algo/threshold invalidates the current cluster list.
        if (this.$psdsimalgo) this.$psdsimalgo.addEventListener('change', () => this._clearSim());
        if (this.$psdsimthr) this.$psdsimthr.addEventListener('change', () => this._clearSim());
        ipc('project-path').then((d) => {
            if (this.$proj) this.$proj.innerText = 'project: ' + ((d && d.path) || '(unknown)');
        }).catch(() => {});
    },

    close() {},
});
