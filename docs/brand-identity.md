# EnvDock 品牌图标

当前选定 **B「双舱桥」**。两个错位舱体对应接口工作台的请求与响应面板，中央留出的通道表达配置解析与原生执行。品牌符号不使用字母 E、发送箭头或技术框架的标志。

## 唯一母版

`assets/brand/mark.svg` 是唯一可编辑母版。图形与配色由 `main` 维护，`windows` 和 `macos` 必须使用同一份母版及导出文件，不因系统不同改用其他标记。

| 角色 | 色值 |
| --- | --- |
| 暖石墨底 | `#17120E`（左上渐变至 `#33271F`） |
| 请求舱 | `#F3E9DC` |
| 响应舱 | `#FB923C` |

配色参考项目提供的「配色集合」中暖灰创作深色方案。色块只表达品牌，不替代应用中生产环境、成功或错误等状态语义。

## 各处输出

- `public/envdock.svg`：与母版逐字节一致，应用内 30px 品牌入口使用。底板铺满 SVG 画布，避免双重留白让侧栏标记过小。
- `src-tauri/icons/icon.png`：256px 通用导出。
- `src-tauri/icons/icon.ico`：16、24、32、48、64、128、256px，供 Windows 应用与安装器使用。
- `src-tauri/icons/icon.icns`：16、32、64、128、256、512、1024px，供 macOS 应用使用。仅在透明画布上增加系统图标留白，图形和配色相同。
- `src-tauri/installer/sidebar.bmp`、`header.bmp`：Windows 安装向导沿用同一标记。

16/24px 导出省略中间两根细柱，保留双舱的外轮廓和中央负空间；32px 以上保留完整图形。这是同一标记的小尺寸光学校正，不是平台专属图标。

## 再生与检查

图标导出仅依赖 Python 与 Pillow，不需要 macOS `iconutil`、浏览器或系统字体。依赖只用于制作资源，应用运行不加载 Python。

```sh
python -m pip install -r scripts/requirements-brand.txt
python scripts/generate-brand-assets.py
python scripts/generate-brand-assets.py --check
npm run test:packaging
```

脚本从母版读取所有几何与渐变，使用 Pillow 内置字体生成安装器图片。`assets/brand/exports.json` 记录母版与各导出文件的 SHA-256，打包检查会拒绝混用旧图标或漏更新某个格式。

更新图标时先编辑母版，再统一生成导出并同步至两个系统分支。禁止分别手工修改 ICNS、ICO、PNG 或 SVG；发布前对比三个分支中品牌资源的校验值，并核对安装包内资源与母版一致。
