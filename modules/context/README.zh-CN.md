# OpenAgent 上下文模块

本模块把项目的上下文放进每个 agent 会话都会读的文档里。它包含一个 skill 和装这些上下文的文件模板。模块没有代码：下载只要 git，任何会读 skill 的 agent 都能用（Claude Code、Codex 等）。

[English](README.md)

你会得到：

- `docs/` 下给计划、报告、调研、指南定好的位置，以及找旧文档的办法，每个会话都按同一套规矩存、按同一套规矩找。
- `CLAUDE.md` / `AGENTS.md` 的契约模板：每个会话先读的规则，每条标出处，150 行以内。
- `DECISIONS.md` 的决策日志模板，ADR（架构决策记录）格式：每个设计选择，附证据和拍板人。
- 给已有项目做体检：文档放在哪、契约、决策日志和提交规范；用户愿意的话，再把文档挪进 `docs/`，并参考以往对话引导重写契约。用户点头前什么都不写。
- 和 AI agent 一起干活踩过的坑：模板里的规则是从哪来的，以及审查、上下文隔离、并行子 agent、思考强度、个人习惯放哪。

skill 有英文和中文两版。skill 用什么语言写，agent 往往就用什么语言回答，所以选你想让它回复的那种。

| 语言 | skill 文件夹 |
|---|---|
| 英文 | [en/openagent-context](en/openagent-context/SKILL.md) |
| 中文 | [zh-CN/openagent-context](zh-CN/openagent-context/SKILL.md) |

每个文件夹里有 `SKILL.md` 和 `references/`：[契约模板](zh-CN/openagent-context/references/contract-template.md)、[决策日志模板](zh-CN/openagent-context/references/decision-log-template.md)、[和 AI agent 一起干活](zh-CN/openagent-context/references/working-with-ai-agents.md)。

## 安装

把这句话发给你的主 agent：

```text
Install the context module of OpenAgent from https://github.com/wingsofsky/OpenAgent in Chinese: follow INSTALL.md in that repository
```

手动安装，只下载这个模块：

```bash
git clone --filter=blob:none --sparse https://github.com/wingsofsky/OpenAgent.git <repo>
cd <repo> && git sparse-checkout set modules/context
```

再把对应语言的 skill（`zh-CN` 或 `en`）复制到 agent 读 skill 的地方。只给一个项目用：

```bash
mkdir -p <project>/.claude/skills
cp -r <repo>/modules/context/zh-CN/openagent-context <project>/.claude/skills/
```

所有项目都用，就复制到 `~/.claude/skills/`。Codex 从 `<project>/.agents/skills/` 读同样的文件夹。复制不会跟着更新：`git pull` 之后再复制一次。装完重启 agent 会话。

## 用法

skill 告诉 agent 计划、报告、笔记放在哪，下一个会话就找得到：

```
docs/
  plans/      2026-10-26-search-redesign.md     计划、设计
  reports/    2026-10-26-release-check.md       工作报告、复盘
  research/   2026-10-20-vector-db-compare.md   调研、对比
  guides/     2026-09-30-local-setup.md         操作说明
  notes/                                        其他
```

文件名以日期开头；同一件事已有文档时，agent 先更新它，不另起新文件。另有三个文件装着每个会话都要的东西：

| 文件 | 装什么 |
|---|---|
| `CLAUDE.md` / `AGENTS.md` | 每个会话都要遵守的规则，每条标出处，150 行以内 |
| `DECISIONS.md` | 每个设计选择，附证据和拍板人；只追加 |
| `MEMORY.md` | agent 的长期事实索引：你的偏好、本机的坑、东西在哪 |

进度写在 `docs/plans/`，不进这三个文件。

不用跑任何命令。agent 写文档、找文档，或者你让它建 `CLAUDE.md`、开决策日志时，会自动加载这个 skill。它写你的契约之前会先给你看草稿。

## 许可证

[Apache-2.0](../../LICENSE)
