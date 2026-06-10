# cocos-psd-prefab-2x

独立的 **Cocos Creator 2.4.x** 编辑器扩展:把 Photoshop `.psd` **一键转换成预制体**
——自动导出 PNG、生成带 spriteFrame 的 `.meta`、按图层命名规范建节点树,并做一系列
**对写代码友好**的处理。也可作为命令行工具脱离编辑器使用。

> 适配 Cocos Creator 2.4.x(在 2.4.15 上开发/验证)。

## 特性

- **一键转换**:PSD 图层树 → 预制体节点树,像素级对齐(锚点 0.5/0.5,按真实包围盒定位)。
- **类型识别**:位图→`cc.Sprite`、文字图层→`cc.Label`(自动取文本/字号/颜色,无需前缀)、
  `btn_`→`cc.Button`、`lay_`→`cc.Layout`、`sp_ #..`→九宫格。
- **MD5 去重**:相同图片只导一张,跨预制体/跨次运行共用。
- **裁剪透明边**:自动裁掉图层四周全透明区域,尺寸/位置更准(可关,`@nocrop` 单层例外)。
- **代码友好命名**:节点名全英文(中文转拼音)+ 类型前缀(`Img_`/`Label_`/`Node_`)+
  后缀≤8字符(保留区分数字)+ **同父节点下名字唯一**(`getChildByName` 可用)。
- **结构清理**:压平只含 1 个子的空容器(保留外层名)、可选合并重叠装饰图。
- **删图自愈**:可选检测缓存图片是否还在,被删过自动重导。

## 安装(放进工程)

```bash
git clone https://github.com/<your-name>/cocos-psd-prefab-2x.git
cd cocos-psd-prefab-2x
npm install        # 安装依赖 ag-psd / pngjs / pinyin-pro
```

把整个 `cocos-psd-prefab-2x` 文件夹放到目标工程的 `packages/` 目录下,例如:

```
<你的工程>/packages/cocos-psd-prefab-2x/
```

重启 / 刷新 Cocos Creator 后,菜单出现 **`PSD 工具 / PSD 转预制体`**。
(也可放到全局 `~/.CocosCreator/packages/` 让所有工程共用。)

> 提示:`node_modules/` 未提交到仓库。clone 后跑一次 `npm install` 即可;也可在
> Release 里放一个含依赖的整包 zip,下载解压即用、无需 install。

## 用法（编辑器面板）

1. 菜单 `PSD 工具 / PSD 转预制体` 打开面板。
2. 点 **选择 PSD**。
3. 可选项(复选框):MD5 去重、裁剪透明边、压平空容器(默认开);合并装饰图、检测缓存(默认关)。
4. 点 **转换为预制体**。结果显示 `节点 / 新图 / 复用 / 裁剪 / 压平 / 合并 / 重导 / 忽略`,
   产物在 `assets/<输出目录>/`,资源库自动刷新。

## 用法（命令行）

```bash
node psd2prefab.js <input.psd> --project <Cocos工程根目录> [--out PSD] [--name X] [--no-dedup] [--dry-run]
```

## 文档

- `docs/PSD命名规范.md` —— 完整的图层命名规范 + 输出命名规则 + 给美术的命名建议。
- `docs/操作指南.html` —— 图文操作指南(含面板示意、流程图、常见问题)。

## 目录结构

```
cocos-psd-prefab-2x/
├── package.json        扩展清单(menu + panel)
├── main.js             主进程:菜单 / IPC / 转换 / 刷新资源库
├── panel/index.js      面板 UI
├── psd2prefab.js       命令行入口
├── lib/convert.js      转换核心(解析/对齐/裁剪/过滤/去重/命名/序列化)
├── docs/               命名规范 + HTML 操作指南
└── test/               make_test_psd.js(造样例)+ verify.js(断言)
```

## License

MIT © liyu
