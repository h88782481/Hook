# Hook

<p align="center">
  <a href="README.md"><strong>简体中文</strong></a>
  ·
  <a href="README.en.md"><strong>English</strong></a>
</p>

<p align="center">
  面向 Windows 的开源桌面截图工具。
</p>

<p align="center">
  维护方：<strong>yamiyu</strong>
</p>

<p align="center">
  <a href="https://github.com/aiaimimi0920/Hook/actions/workflows/release-hook-tag.yml"><img src="https://github.com/aiaimimi0920/Hook/actions/workflows/release-hook-tag.yml/badge.svg" alt="Release Hook Tag" /></a>
  <img src="https://img.shields.io/badge/platform-Windows-0078D6" alt="Windows" />
  <img src="https://img.shields.io/badge/Tauri-v2-24C8DB" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/SolidJS-TypeScript-2C4F7C" alt="SolidJS TypeScript" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-F4EA2A" alt="MIT License" /></a>
</p>

Hook 适合用于随手截图与简单编辑。

## 目录

- [为什么是 Hook](#为什么是-hook)
- [核心能力](#核心能力)
- [发布包](#发布包)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 为什么是 Hook

Hook 关注的是截图工具和更重型设计工具之间的那段空白：

- 截图之后还可以继续直接编辑和组织
- 贴图、标注、引用图可以沉淀在同一个桌面工作区
- 回收站和参考列表让素材可反复利用
- 贴图之间可连线同步标注，方便做对照与传递

## 核心能力

- **截图与长截图**
  - 区域截图
  - 长截图会话
  - 面向桌面性能的文件型截图载荷
- **贴图与标注工作区**
  - 裁剪、边框、透明度、光栅效果、取色复制
  - 文本、编号、图形、画笔、高亮
  - 回收站与参考列表
- **桌面贴图画布**
  - 贴图连线、分组、会话同步
  - 面向编辑的顶部工具栏与上下文菜单
  - 本地启动辅助与单实例控制

## 发布包

当前公开发布仅提供**便携版**（解压即用）。

如果你在 **任务管理器** 等特殊前台窗口场景下碰到交互限制，可以尝试以**管理员身份**启动。

## 参与贡献

欢迎提交 issue、构建反馈和聚焦型改进建议：

- Issues：<https://github.com/aiaimimi0920/Hook/issues>
- 本地校验：运行 `npm run verify:local`（typecheck + 前端构建）。打包由 GitHub Actions 自动完成。
- 公共包标识符：`com.yamiyu.hook`。

## 许可证

MIT

## 友情链接

- [linux.do](https://linux.do/) 感谢 linux.do 社区的推广
