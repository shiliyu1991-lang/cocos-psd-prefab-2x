'use strict';

/**
 * cocos-psd-prefab-2x — standalone Cocos Creator 2.4.x editor extension.
 *
 * Adds menu  PSD 工具/PSD 转预制体  → opens a dockable panel that converts a
 * .psd into a prefab (PNG export + sprite-frame meta + MD5 dedup), writing the
 * result into the project's assets and refreshing the asset-db.
 *
 * No MCP / WebSocket bridge — this is the converter on its own. The conversion
 * logic lives in ./lib/convert.js; ag-psd + pngjs + pinyin-pro are vendored
 * under ./node_modules so the extension runs without any npm install.
 */

const Path = require('path');

const PKG = 'cocos-psd-prefab-2x';

function _safe(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }
function _err(e) {
    if (!e) return new Error('unknown error');
    return (e instanceof Error) ? e : new Error(typeof e === 'string' ? e : JSON.stringify(e));
}
function _editorLog() { try { Editor.log.apply(Editor, arguments); } catch (e) { /* ignore */ } }

// Run a conversion and import the result. Returns the converter report.
async function convertPsd(params) {
    params = params || {};
    if (!params.psdPath) throw new Error('convert-psd needs psdPath');

    const projectRoot = _safe(() => Editor.Project.path, null);
    if (!projectRoot) throw new Error('cannot resolve Editor.Project.path');

    let core;
    try {
        core = require(Path.join(__dirname, 'lib', 'convert.js'));
    } catch (e) {
        throw new Error('failed to load converter deps (ag-psd / pngjs / pinyin-pro). They are '
            + 'normally vendored under ' + Path.join(__dirname, 'node_modules')
            + '. If missing, run `npm install` in ' + __dirname + '. '
            + (e && e.message ? e.message : String(e)));
    }

    const outDir = (params.outDir && String(params.outDir).trim()) || 'PSD';
    const report = await core.convert({
        psdPath: params.psdPath,
        projectRoot: projectRoot,
        outDir: outDir,
        prefabName: (params.name && String(params.name).trim()) || undefined,
        dedup: params.dedup !== false,
        trimTransparent: params.trim !== false,
        flattenWrappers: params.flatten !== false,
        mergeDecor: !!params.mergeDecor,
        validateCache: !!params.validateCache,
        keepHidden: !!params.keepHidden,
    });

    // Import the new assets (fire-and-forget; a refresh can be slow).
    try { Editor.assetdb.refresh('db://assets/' + outDir, function () {}); } catch (e) { /* ignore */ }

    _editorLog('[' + PKG + '] converted: ' + (report.prefab && report.prefab.path)
        + '  nodes=' + report.nodes + ' written=' + report.written
        + ' reused=' + report.reused + ' ignored=' + report.ignored.length);
    return report;
}

module.exports = {
    load() {
        _editorLog('[' + PKG + '] loaded — menu: PSD 工具/PSD 转预制体');
    },
    unload() {},

    messages: {
        // Menu entry -> open the dockable panel.
        open() {
            Editor.Panel.open(PKG);
        },
        // Panel -> run a conversion. Replies via event.reply(err, data).
        'convert-psd'(event, params) {
            convertPsd(params || {}).then(
                (r) => event.reply(null, r),
                (e) => event.reply(_err(e).message));
        },
        // Expose project path so the panel can show it.
        'project-path'(event) {
            event.reply(null, { path: _safe(() => Editor.Project.path, null) });
        },
    },
};
