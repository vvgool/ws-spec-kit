---
name: tdd-implementation
description: 测试驱动实现。用于 write-tests/implement：先 red，再最小 green。钉在公开 seam。
---

# 测试驱动实现

先 red，再 green。测公开 seam，不测私有结构。

## write-tests

1. **钉一张任务**
   只取当前 `tasks` 中未完成的第一张。完成：知道这条红测失败时证明什么。

2. **写红测**
   Given / When / Then；期望值来自规格或字面量，不从实现反推。完成：跑项目 Test Gate 时因**断言**失败，不是缺模块或语法错。

3. **交 `red-test-result`**
   完成：写明测了哪条行为、失败种类是 assertion。

## implement

1. **保住红测**
   不删、不放宽、不改断言含义。完成：红测文件身份仍是 verify-red 绑过的那批。

2. **最小 green**
   只写让这条红测通过的代码。完成：同一 Test Gate 退出码为 0，且红测仍在。

3. **交 `implementation-result`**
   完成：列出改动的 seam，没有顺手做下一张任务。

## 规则

- 一次一条。下一条是下一轮 red。
- Mock 是最后手段。能用真实对象、内存 fake 或 Test Gate 就不要 mock。
- 缺完整 Test Gate、红测不是 assertion、或路径越界：停止并报告阻塞。
