---
name: wsspeckit-driver
wsspeckit-driver-version: 13
wsspeckit-driver-content-digest: sha256:c7016f1e819af357d9135bb671fabd9b38606730cc93506c3e8c324e2e2bccbc
description: 使用 WSSpecKit 驱动软件交付 Workflow；新任务、已有任务或用户明确要求时调用。
---

# WSSpecKit Driver

## Workflow 决策

仅当需求明确为纯文档或无代码变更时选择 `builtin://workflows/documentation-delivery`；其余默认选择 `builtin://workflows/feature-delivery`。用户可以在创建前覆盖选择，但创建时必须传递明确的 `workflowRef`；Work Item 创建后不得自动切换 Workflow。

## 新任务与恢复

新任务执行 `wspec start --prompt "<用户需求>" --workflow "<workflowRef>" --profile "<profile>" --provider "codex"`。从 JSON 输出读取 `result.workItemId` 和 `result.workflowRef`；后续所有命令都使用这个 `workItemId`，并确认 `workflowRef` 未变化。

已有任务或 Host 重启后的恢复先执行 inspect，再按 nextAction 路由：先运行 `wspec inspect "<workItemId>"`，从 `result.workflowRef` 确认原 Workflow，仅当 nextAction.kind 为 acquire 或 await_approval 时再运行 `wspec acquire "<workItemId>" --actor "<actor>"`。不要重新 start，也不要按项目当前默认值替换原 `workflowRef`。

inspect 的 result.nextAction.kind 为 revalidate-red 或 retry-test-gate 时，以 result.nextAction.reason 作为原因执行 `wspec recover <workItemId> --actor <actor> --reason <reason>`，恢复不会批准审批或重发外部请求。recover 返回 acquire 后继续领取；返回 blocked、reconcile 或再次要求恢复时停止并展示原因，禁止无变化循环重试。completed 则停止。

## acquire / submit 循环

每次 acquire 都读取 `result.action` 并按下列分支处理：

- `execute`：读取 `result.workPackage.stepId`、`result.workPackage.attemptId`、`result.workPackage.lease.token` 和完整 `requiredOutputs`。先把 Work Package 中系统提供的 `requirement-source` 引用放入 `artifactRefs`；再按 `requiredOutputs` 顺序逐项处理其余输出。从 `result.workPackage.artifactAuthoring.draftRoots[1]` 获取当前任务授权的 `draftRoot`，不得根据任务 ID 猜测目录。每项正文写入 `<draftRoot>/<outputId>.md`，执行 `wspec artifact create --work-item "<workItemId>" --step "<stepId>" --attempt "<attemptId>" --lease-token "<leaseToken>" --artifact-type "<artifactType>" --output "<outputId>" --content-file "<draftRoot>/<outputId>.md"`，并把每次 JSON stdout 的 `result` 追加到 `artifactRefs`。所有必需输出完成后才生成 SubmitResult；submit JSON 的 `artifacts` 只携带累积的 ArtifactRef，正文、`contentFile`、绝对路径和 Lease token 都不得写入 `<resultPath>`。随后执行 `wspec submit "<workItemId>" --step "<stepId>" --attempt "<attemptId>" --lease "<leaseToken>" --result "<resultPath>" --actor "<actor>"`。submit 也返回 `result.action`：若为 `execute`，它已经携带并 claim 新 Work Package，必须从 artifact 循环处理，不得再次 acquire；其余分支按下文停止。不得复用旧 attemptId 或 leaseToken。
- `await_approval`：读取并向用户展示 `result.approval`，尚未获得明确决定时等待用户。普通步骤（`approval.kind: step`）的用户明确批准可直接转录为 `kind: approval`、`decision: approved`，加入 `confirmation: { source: conversation, userMessage: 用户确认原话 }`，绑定当前 `workItemId`、`requestId`、`expectedDigest: result.approval.digest`，以当前 Agent 的 `actor` 执行 `wspec decide`，无需用户再操作终端。已有对当前版本的明确确认时直接执行，不重复询问。确认记录标记为 `agent_transcribed`，表示 Agent 转录，不是独立验证的用户身份；仅保存这次确认原话，不复制整段会话。只在用户确认明确对应当前审批版本时转录；模糊回应或方案变更后重新展示待审批内容并澄清。`external_action`、`workflow_trust` 及需要人工决定的外部恢复仍要求 TTY：展示审批时就说明执行方式；遇到 `WSSPEC_INTERACTIVE_TTY_REQUIRED` 后不要原样反复重试，也不要自行创建 TTY 代替用户确认。用户明确提出修改要求时，将原话作为 `feedback`，先由 WSSpecKit 本地真实 TTY 提交 `confirm_rejection` 决定；收到 `rejection_confirmed` 后，把返回的一次性 `rejectionToken` 与同一份 `feedback` 写入 `rejected` 决定并执行 `wspec decide --input "<decisionPath>" --actor "<actor>"`。不得在拒绝决定成功前修改审批绑定的 Artifact。若决定后返回 `execute` 且 `resumeSubmission` 不为 `true`，按新 Work Package 重新执行 Artifact authoring；修订时读取 `workPackage.revisionRequest.feedback`。仅当 `resumeSubmission: true` 时，才使用原样未改的 `<resultPath>` 直接重新 submit。若 Host 会话已中断，再从 inspect / acquire 恢复。
- `blocked`：读取并展示 `result.problems`。若 code 为 `WSSPEC_APPROVAL_EXPIRED`，明确说明本次批准未生效，按 inspect -> acquire 恢复，并使用新 Work Package 重新执行 Artifact authoring 和 submit；重新展示产物请求确认，不能复用旧审批或旧结果。这条路径不需要用户手动解除阻塞，不要重复提交旧 decide。其他 blocked 停止当前循环并展示原因，问题解决后从 inspect 按 nextAction 恢复；不要把 acquire 建议当作问题已修复，也不要原样反复重试。租约或证据错误从 inspect 恢复，并遵守 recover 的一次尝试边界。
- `completed`：读取 `result.summary`，报告完成并停止，不再 acquire 或 submit。

以下 fenced JSON 是 Host 和自动验收共同消费的命令/状态机合同；`${...}` 变量必须来自用户选择、Host 身份或前一条命令声明的 capture，不能自行猜测：

```json
{
  "kind": "wsspeckit-driver-contract",
  "version": 1,
  "workflowSelection": {
    "feature": "builtin://workflows/feature-delivery",
    "documentation": "builtin://workflows/documentation-delivery"
  },
  "entrypoints": {
    "new": "start",
    "recovery": "inspect"
  },
  "operations": {
    "start": {
      "argv": [
        "wspec",
        "start",
        "--prompt",
        "${prompt}",
        "--workflow",
        "${workflowRef}",
        "--profile",
        "${profile}",
        "--provider",
        "codex"
      ],
      "capture": {
        "workItemId": "result.workItemId",
        "workflowRef": "result.workflowRef"
      },
      "next": "inspect"
    },
    "inspect": {
      "argv": [
        "wspec",
        "inspect",
        "${workItemId}"
      ],
      "capture": {
        "workflowRef": "result.workflowRef",
        "recoveryReason": "result.nextAction.reason"
      },
      "branch": {
        "field": "result.nextAction.kind",
        "cases": {
          "acquire": {
            "next": "acquire"
          },
          "revalidate-red": {
            "next": "recover"
          },
          "retry-test-gate": {
            "next": "recover"
          },
          "await_approval": {
            "next": "acquire"
          },
          "reconcile": {
            "next": "blocked"
          },
          "blocked": {
            "next": "blocked"
          },
          "completed": {
            "next": "completed"
          }
        }
      }
    },
    "recover": {
      "argv": [
        "wspec",
        "recover",
        "${workItemId}",
        "--actor",
        "${actor}",
        "--reason",
        "${recoveryReason}"
      ],
      "branch": {
        "field": "result.nextAction.kind",
        "cases": {
          "acquire": {
            "next": "acquire"
          },
          "revalidate-red": {
            "next": "blocked"
          },
          "retry-test-gate": {
            "next": "blocked"
          },
          "await_approval": {
            "next": "acquire"
          },
          "reconcile": {
            "next": "blocked"
          },
          "blocked": {
            "next": "blocked"
          },
          "completed": {
            "next": "completed"
          }
        }
      }
    },
    "acquire": {
      "argv": [
        "wspec",
        "acquire",
        "${workItemId}",
        "--actor",
        "${actor}"
      ],
      "branch": {
        "field": "result.action",
        "cases": {
          "execute": {
            "next": "artifact",
            "capture": {
              "workPackage": "result.workPackage",
              "stepId": "result.workPackage.stepId",
              "attemptId": "result.workPackage.attemptId",
              "leaseToken": "result.workPackage.lease.token",
              "requiredOutputs": "result.workPackage.requiredOutputs",
              "draftRoot": "result.workPackage.artifactAuthoring.draftRoots.1"
            },
            "initialize": {
              "target": "artifactRefs",
              "source": "result.workPackage.artifacts",
              "filter": {
                "field": "artifactType",
                "equals": "requirement-source",
                "requiredBy": "requiredOutputs"
              }
            }
          },
          "await_approval": {
            "next": "await_approval"
          },
          "blocked": {
            "next": "blocked"
          },
          "completed": {
            "next": "completed"
          }
        }
      }
    },
    "artifact": {
      "argv": [
        "wspec",
        "artifact",
        "create",
        "--work-item",
        "${workItemId}",
        "--step",
        "${stepId}",
        "--attempt",
        "${attemptId}",
        "--lease-token",
        "${leaseToken}",
        "--artifact-type",
        "${artifactType}",
        "--output",
        "${outputId}",
        "--content-file",
        "${contentFile}"
      ],
      "capture": {
        "artifactRef": "result"
      },
      "forEach": {
        "source": "requiredOutputs",
        "item": "requiredOutput",
        "filter": {
          "field": "artifactType",
          "notEquals": "requirement-source"
        },
        "bindings": {
          "artifactType": "requiredOutput.artifactType",
          "outputId": "requiredOutput.outputId",
          "contentFile": "${draftRoot}/${outputId}.md"
        },
        "collect": {
          "target": "artifactRefs",
          "value": "result"
        }
      },
      "next": "submit"
    },
    "submit": {
      "argv": [
        "wspec",
        "submit",
        "${workItemId}",
        "--step",
        "${stepId}",
        "--attempt",
        "${attemptId}",
        "--lease",
        "${leaseToken}",
        "--result",
        "${resultPath}",
        "--actor",
        "${actor}"
      ],
      "resultBindings": {
        "artifacts": "artifactRefs"
      },
      "branch": {
        "field": "result.action",
        "cases": {
          "execute": {
            "next": "artifact",
            "capture": {
              "workPackage": "result.workPackage",
              "stepId": "result.workPackage.stepId",
              "attemptId": "result.workPackage.attemptId",
              "leaseToken": "result.workPackage.lease.token",
              "requiredOutputs": "result.workPackage.requiredOutputs",
              "draftRoot": "result.workPackage.artifactAuthoring.draftRoots.1"
            },
            "initialize": {
              "target": "artifactRefs",
              "source": "result.workPackage.artifacts",
              "filter": {
                "field": "artifactType",
                "equals": "requirement-source",
                "requiredBy": "requiredOutputs"
              }
            }
          },
          "await_approval": {
            "next": "decide",
            "capture": {
              "approval": "result.approval"
            },
            "humanGate": {
              "required": true,
              "approval": "result.approval"
            }
          },
          "blocked": {
            "next": "blocked"
          },
          "completed": {
            "next": "completed"
          }
        }
      }
    },
    "decide": {
      "argv": [
        "wspec",
        "decide",
        "--input",
        "${decisionPath}",
        "--actor",
        "${actor}"
      ],
      "branch": {
        "field": "result.action",
        "cases": {
          "execute": {
            "capture": {
              "workPackage": "result.workPackage",
              "stepId": "result.workPackage.stepId",
              "attemptId": "result.workPackage.attemptId",
              "leaseToken": "result.workPackage.lease.token",
              "requiredOutputs": "result.workPackage.requiredOutputs",
              "draftRoot": "result.workPackage.artifactAuthoring.draftRoots.1"
            },
            "routeByValue": {
              "field": "result.resumeSubmission",
              "cases": {
                "true": {
                  "next": "submit"
                }
              },
              "default": {
                "next": "artifact",
                "initialize": {
                  "target": "artifactRefs",
                  "source": "result.workPackage.artifacts",
                  "filter": {
                    "field": "artifactType",
                    "equals": "requirement-source",
                    "requiredBy": "requiredOutputs"
                  }
                }
              }
            }
          },
          "await_approval": {
            "next": "await_approval"
          },
          "blocked": {
            "next": "blocked",
            "routeByValue": {
              "field": "result.problems.0.code",
              "cases": {
                "WSSPEC_APPROVAL_EXPIRED": {
                  "next": "inspect"
                }
              },
              "default": {
                "next": "blocked"
              }
            }
          },
          "completed": {
            "next": "completed"
          },
          "rejection_confirmed": {
            "next": "decide",
            "capture": {
              "rejectionToken": "result.rejectionConfirmation.token"
            }
          }
        }
      }
    }
  },
  "terminals": {
    "await_approval": {
      "stop": true
    },
    "blocked": {
      "stop": true
    },
    "completed": {
      "stop": true
    }
  }
}
```

面向用户的说明、文档和交互文案默认使用中文；协议字段、类型名、URI、命令名和错误码保持英文。

Driver 不得调用模型 API，不得缓存或管理对话、Token、记忆或隐藏推理，不得把 Artifact 正文放入协议 JSON。Artifact 只通过协议中的引用读取，模型上下文由当前 Agent Host 自主管理。

安装只写入本 Skill 文件，不会启动后台 Runner。Driver 使用 WSSpecKit Application Protocol 驱动当前 Agent，不冒充 Codex、Claude、Cursor 或其他真实 Agent Host。

手动调用示例：`wspec start --provider codex --prompt "更新 README" --workflow builtin://workflows/documentation-delivery --profile quick`。
