# Hook

<p align="center">
  <a href="README.md"><strong>English</strong></a>
  ·
  <a href="README.zh-CN.md"><strong>简体中文</strong></a>
</p>

<p align="center">
  面向 Windows 的开源桌面截图工具。
</p>

<p align="center">
  维护方：<strong>yamiyu</strong>
</p>

<p align="center">
  <a href="https://github.com/aiaimimi0920/Hook/actions/workflows/build-hook-exe.yml"><img src="https://github.com/aiaimimi0920/Hook/actions/workflows/build-hook-exe.yml/badge.svg" alt="Build Hook EXE" /></a>
  <img src="https://img.shields.io/badge/platform-Windows-0078D6" alt="Windows" />
  <img src="https://img.shields.io/badge/Tauri-v2-24C8DB" alt="Tauri v2" />
  <img src="https://img.shields.io/badge/SolidJS-TypeScript-2C4F7C" alt="SolidJS TypeScript" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-F4EA2A" alt="MIT License" /></a>
</p>

Hook 适合用于随手截图与简单编辑。

## 目录

- [为什么是 Hook](#为什么是-hook)
- [核心能力](#核心能力)
- [发布包选择](#发布包选择)
- [信任与策略](#信任与策略)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

## 为什么是 Hook

Hook 关注的是截图工具和更重型设计工具之间的那段空白：

- 截图之后还可以继续直接编辑和组织
- 贴图、标注、引用图可以沉淀在同一个桌面工作区
- 回收站和参考列表让素材可反复利用
- 节点画布和本地能力桥接让它不只是“图片收集器”

## 核心能力

- **截图与长截图**
  - 区域截图
  - 长截图会话
  - 面向桌面性能的文件型截图载荷
- **贴图与标注工作区**
  - 裁剪、边框、透明度、光栅效果、取色复制
  - 文本、编号、图形、画笔、高亮
  - 回收站与参考列表
- **桌面工作流画布**
  - 节点图、连线、分组参数、同步入口
  - 面向编辑的顶部工具栏与上下文菜单
  - 本地启动辅助与单实例控制

## 发布包选择

- **安装版（如果 release 页面提供，则优先推荐）**
  - 更适合长期桌面常驻使用
  - 如果你希望在 **任务管理器** 这类特殊前台窗口场景下尽量保持稳定交互，优先使用安装版
  - 走的是签名后的 UIAccess 安装路径，并安装到 `Program Files`
- **便携版**
  - 解压即用
  - 适合快速试用和普通日常截图
  - 在部分 Windows 前台窗口 / 权限组合下，仍可能碰到交互限制；如果必须继续使用便携版，可把“以**管理员身份**启动”作为兜底方案

完整说明见 [`UIACCESS_DISTRIBUTION.md`](UIACCESS_DISTRIBUTION.md)。

## 信任与策略

- [代码签名策略](docs/CODE_SIGNING_POLICY.md)
- [隐私策略](docs/PRIVACY_POLICY.md)
- [UIAccess 发布说明](UIACCESS_DISTRIBUTION.md)

## 参与贡献

欢迎提交 issue、构建反馈和聚焦型改进建议：

- Issues：<https://github.com/aiaimimi0920/Hook/issues>
- 本地校验：在打包或提交修改前先运行 `npm run verify:local`。
- 公共包标识符：`com.yamiyu.hook`。为了兼容旧本地数据目录，Hook 仍会回退读取 `io.github.aiaimimi0920.hook` 和 `com.vmjcv.hook`。

## 许可证

MIT

## 友情链接

- [linux.do](https://linux.do/) 感谢 linux.do 社区的推广
