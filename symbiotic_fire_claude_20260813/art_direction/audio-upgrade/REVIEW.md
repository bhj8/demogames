# 最终音效与验收

现保留 **38 类、每类一条，共 38 条最终 WAV**，合计 9,527,272 字节（约 9.1 MiB）。覆盖枪械、装填、命中、怪物、移动、环境、补给与提示。

[声音核对室](../../_audio-art.html) · [游戏](../../index.html)

2026-09-22 按要求清理：删除本地 144 条生成候选、38 条备用音效、测试混音 WAV、旧频谱、截图和中间筛选文件。`assets/audio/bank.json` 只引用最终 38 条；核对室每类只有一个播放按钮。Git 历史未重写。

## 来源与筛选

沿用此前 AIGA / Stable Audio 3 small-sfx 流程中已通过检查、排序在前的最终素材，没有重新生成或修改 WAV。`generation-manifest.csv` 和 `selection.json` 只保留最终素材的生成参数、种子、SHA-256、起音、收尾与增益记录。

## 本次复验

- AIGA 原始 `contract.json`：38 / 38 通过，44.1 kHz / 立体声 / PCM 16-bit。
- 浏览器：38 条均解码成功，无音效请求失败；每个声音事件只引用一条素材。
- 混音：极端压力最大并发 42，峰值约 0.956；左右定位能量比均超过 10。
- 实机开火、换弹、脚步、落地、暂停清理、合成补位、音量保存及总静音通过。
- 核对室 38 张卡片、单条播放、停止、390px 布局通过；既有 `_todo13check.html` ALLPASS。

结果见 `asset-check.json`、`runtime-check.json`、`ui-check.json`。验证音频只在内存中渲染，不再落盘额外 WAV。风声仍保留交叉淡化，重复播放同一条最终素材。

主观听感未验收；格式与波形检查不能代替人耳试听。本次没有修改战斗或导航参数。

## 复验方式

使用已有 Node / Playwright / Chrome，设置 `PLAYWRIGHT_MODULE`、`CHROME_EXE`，运行 `verify.cjs` 和 `verify-ui.cjs`。素材检查沿用 AIGA 的 `check_audio.py assets/audio --profile sfx --contract art_direction/audio-upgrade/contract.json`。
