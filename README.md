# Sand3

Sand3是一个本机Web应用, 使用浏览器界面与Node/SQLite持久数据库完成HRTEM/SAED的晶相匹配查找。它使用 Tactical Telemetry / Industrial Brutalist 外层 UI、PDF2/CIF/TXT 数据源、SAED 环匹配和全部原始交互功能。核心判据保持为：

```text
g1 + g3 = g2
```

三个晶面距、两个晶面夹角及矢量闭合关系必须同时满足误差限制。

## 启动

需要 Node.js 22.5 或更高版本（使用内置 `node:sqlite`），不需要安装第三方依赖。

```bash
cd "~/Sand3"
npm start
```

然后打开 <http://127.0.0.1:8768>。

也可以直接双击 `启动Sand3.command`（macOS）或 `启动Sand3-Windows.bat`（Windows）。

## 支持的数据

- 图像：JPG、PNG、常见 8/16/32/64-bit TIFF、DM3。
- TIFF：支持无压缩、PackBits、LZW、Deflate 和浏览器可解码的 JPEG strip；BigTIFF 与 tiled TIFF 暂不支持。
- 晶体数据：JADE `pdf2.dat`、CIF、Jade 导出 TXT。
- `pdf2.dat` 以 80-byte 定长记录流式解析，并保存到 `Sand3-Industrial/database/sand3.sqlite`；原文件不会被修改。
- SQLite 索引会跨浏览器、跨重启保留，之后打开软件会直接调用，无需再次导入。

## 模块

- `core.js`：FFT、峰检测、倒易晶格、误差传播、对称展开和三晶面匹配核心。
- `image-io.js`：显微图像读取。
- `database.js`：浏览器端数据库接口及 CIF/TXT 解析。
- `database-service.js`：SQLite 存储、PDF2.DAT 流式解析和晶相预筛选。
- `server.js`：静态页面和本地数据库 API。
- `app.js`：界面控制和绘图。

## 测试

```bash
npm test
```

## 使用注意

- 数据库固定保存于 `Sand3/database/sand3.sqlite`；运行时可能同时出现 `-wal`、`-shm` 临时文件。
- 界面的“清空 Sand3 Industrial 数据库”会清除 SQLite 索引及旧版浏览器 IndexedDB，不会删除原始 `pdf2.dat`。

- HRTEM 模式填写实空间 `Å/pixel`；程序 FFT 后自动换算倒易标定。
- SAED 模式填写 `Å⁻¹/pixel`，不执行 FFT。
- DM3 中若保存了 `nm` 或 `1/nm` 标定，程序会分别建议 HRTEM 或 SAED 模式并自动换算为 Å 单位。
- JPG/PNG 通常没有物理标定，必须手动输入。
- 手动选点顺序为 `g1、g2、g3`，且期望满足 `g1 + g3 = g2`。
- 输入图会尝试自动定位底部水平标尺；识别值来自显微图元数据时可自动换算，否则需在标尺编辑框核对数值和单位。拖动端点时按住 Shift 可保持水平。
- 01 输入可重新自动识别标尺、选择矩形/正方形 ROI，并可框选局部放大或恢复完整视图。
- HRTEM 在输入图框选 ROI 后执行 FFT；SAED 直接显示原图。000 中心及三个衍射点均可拖动，测量值会同步更新。
- 02 几何只维护当前一组平行四边形；可框选放大、逐级缩小，并可开启亮点吸附辅助拖动 000 与 g 点。
- “Search”只读取卡片摘要并应用元素筛选，不执行三晶面完整匹配。
- 元素筛选采用精确元素集合：单击为一定包含，再次单击为可能包含，第三次恢复默认不包含；未选择元素默认不允许出现在卡片元素集合中。
- 结果可以按评分升序或降序显示；评分越低代表综合残差越小。
- CIF 当前根据晶胞枚举晶面，不删除系统消光反射，符合电子动力学衍射候选补充策略。
- `D` 状态 PDF 卡片默认不参与匹配。
- PDF2 数据库可能受许可约束；程序只读取用户本机文件，不应把数据库随程序分发。
