# WSSpecKit 中文输出提示设计

## 背景

WSSpecKit 首版要求内置文档、CLI 和 Skill 使用中文。Task 8 曾将该要求实现为 TypeScript 静态数据流分析器，并把扫描结果接入构建门禁。该实现需要追踪函数调用、变量赋值、解构和控制流，复杂度与产品核心目标不匹配。

## 决策

中文输出改为 Agent 行为约定，不再作为编译期静态分析规则。

内置 Driver Skill 必须明确提示：

> 面向用户的说明、文档和交互文案默认使用中文；协议字段、类型名、URI、命令名和错误码保持英文。

Agent 在执行 Workflow 时遵循该提示。WSSpecKit 不分析任意 TypeScript 数据流，也不检查用户自行安装的 Global Skill 或 Project Skill 是否使用中文。

## 实现边界

- 删除中文静态分析器及其执行脚本。
- 删除 `check:chinese` npm script，并让构建只负责编译。
- 删除静态分析器的数据流、作用域和构建产物测试。
- 保留一项轻量契约测试，验证内置 Driver Skill 包含中文输出提示。
- 调整 Foundation Task 8/9 计划，删除中文扫描门禁要求。
- 已有中文 CLI、内置 Skill 和文档继续保持中文，不为此增加自动静态分析。

## 验收

- 仓库和发布包不再包含中文静态分析器或检查脚本。
- `npm run build` 不再运行中文扫描。
- 内置 Driver Skill 的四类安装产物都包含相同的中文输出提示。
- lint、typecheck、完整测试、build 和 pack 通过。

## 非目标

- 不检查用户输入、Issue 标题或外部文档语言。
- 不检查用户安装的 Global/Project Skill 文案。
- 不实现 TypeScript 跨函数文案追踪。
- 不改变 Application Protocol、Schema ID、类型名、URI 或错误码。
