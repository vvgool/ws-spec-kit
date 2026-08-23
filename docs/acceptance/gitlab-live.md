# GitLab 真实 Connector 验收记录

## 当前状态

- Provider：GitLab CLI (`glab`)
- `command -v`：缺失
- 验收状态：**NO-GO，未运行**

本轮没有执行 `glab`、认证探测、网络访问或远程写入。缺少 GitLab CLI 时不得改用未建模的 HTTP Provider，也不得绕过精确写入授权。

## 真实验收前置条件

安装并经批准后，仍必须先获得并脱敏记录：已验证认证、专用非生产 Issue/Project 稳定目标、针对该动作与内容摘要的明确写入授权、幂等键、写后回读摘要、未知结果时先对账再重试的证据，以及不含 Token、Cookie、路径或敏感正文的审计回执。

本地 GitLab fixture 仅覆盖 Connector 契约和恢复语义，不能提升为真实 GitLab PASS。
