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
    <div class="minirow l"><label class="chk"><input id="psdtrim" type="checkbox" checked> 裁剪图片四周透明边（尺寸/位置更准；取消则保留原图）</label></div>
    <div class="minirow l"><label class="chk"><input id="psdflatten" type="checkbox" checked> 压平只含1个子节点的空容器（更扁平，好写代码）</label></div>
    <div class="minirow l"><label class="chk"><input id="psddecor" type="checkbox"> 合并重叠的装饰图（外发光+内层等，实验性）</label></div>
    <div class="minirow l"><label class="chk"><input id="psdvalidate" type="checkbox"> 检测缓存图片是否还在（被删过就重导，稍慢）</label></div>

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
`,
    $: {
        proj: '#proj',
        psdpath: '#psdpath',
        pickpsd: '#pickpsd',
        psdout: '#psdout',
        psdname: '#psdname',
        psddedup: '#psddedup',
        psdtrim: '#psdtrim',
        psdflatten: '#psdflatten',
        psddecor: '#psddecor',
        psdvalidate: '#psdvalidate',
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
        }
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
            trim: this.$psdtrim ? this.$psdtrim.checked : true,
            flatten: this.$psdflatten ? this.$psdflatten.checked : true,
            mergeDecor: this.$psddecor ? this.$psddecor.checked : false,
            validateCache: this.$psdvalidate ? this.$psdvalidate.checked : false,
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
                    (r.trimmed ? ' · 裁剪 ' + r.trimmed : '') +
                    (r.flattened ? ' · 压平 ' + r.flattened : '') +
                    (r.mergedDecor ? ' · 合并 ' + r.mergedDecor : '') +
                    (r.revalidated ? ' · 重导 ' + r.revalidated : '') +
                    ' · 忽略 ' + ignored + '\n' + (p.path || '');
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
        ipc('project-path').then((d) => {
            if (this.$proj) this.$proj.innerText = 'project: ' + ((d && d.path) || '(unknown)');
        }).catch(() => {});
    },

    close() {},
});
