import { describe, expect, test } from "bun:test"
import type { PermissionReviewSnapshot } from "@opencode-ai/plugin"
import { isAdvisoryAllowCandidate } from "../../src/permission/advisory-gate"
import { isObviousRiskCandidate, obviousRiskRewriteFeedback } from "../../src/permission/obvious-risk-gate"
import {
  isExternalDirectoryRiskAllowCandidate,
  isGenericRiskAllowCandidate,
  isGenericRiskCandidate,
  resolveReviewAction,
} from "../../src/permission/generic-review-action"
import { buildPermissionReviewSnapshot } from "../../src/permission/reviewer-input"

const snapshot = {
  version: "1",
  context_safe_for_gate: true,
  action: {
    identity: "bash",
    permission: "bash",
    origin: "tool",
    cwd: "/tmp/project",
    cwd_status: "exact",
    patterns: [],
    metadata: {},
    arguments: { command: "git status" },
    complete: true,
    omitted_items: 0,
    omitted_bytes: 0,
  },
  trusted: {
    items: [{ source: "human", trusted: true, text: "run git status" }],
    complete: true,
    omitted_items: 0,
    omitted_bytes: 0,
  },
  untrusted: { items: [], complete: false, omitted_items: 1, omitted_bytes: 10 },
  complete: false,
} satisfies PermissionReviewSnapshot

describe("permission review advisory gate", () => {
  test("accepts only a settled low-risk explicit lossless allow", () => {
    expect(
      isAdvisoryAllowCandidate({
        settled: true,
        assessment: { outcome: "allow", risk_level: "low", user_authorization: "explicit" },
        snapshot,
      }),
    ).toBe(true)
  })

  test("keeps every weaker or incomplete case on the human route", () => {
    const base = { outcome: "allow" as const, risk_level: "low" as const, user_authorization: "explicit" as const }
    const cases = [
      { settled: false },
      { assessment: { ...base, outcome: "ask" as const } },
      { assessment: { ...base, risk_level: "medium" as const } },
      { assessment: { ...base, user_authorization: "implicit" as const } },
      { snapshot: { ...snapshot, context_safe_for_gate: false } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, complete: false } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, omitted_bytes: 1 } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, cwd_status: "unknown" as const } } },
      { snapshot: { ...snapshot, trusted: { ...snapshot.trusted, complete: false } } },
      { snapshot: { ...snapshot, trusted: { ...snapshot.trusted, omitted_items: 1 } } },
      { snapshot: { ...snapshot, trusted: { ...snapshot.trusted, items: [] } } },
    ]
    for (const change of cases) {
      const settled = "settled" in change && typeof change.settled === "boolean" ? change.settled : true
      const assessment = "assessment" in change && change.assessment ? change.assessment : base
      const candidateSnapshot = "snapshot" in change && change.snapshot ? change.snapshot : snapshot
      expect(
        isAdvisoryAllowCandidate({
          settled,
          assessment,
          snapshot: candidateSnapshot,
        }),
      ).toBe(false)
    }
  })
})

describe("obvious-risk-only-v1 authoritative gate", () => {
  const assessment = {
    outcome: "allow" as const,
    reason_code: "routine_or_low_impact" as const,
    safer_alternative: "none" as const,
  }

  test("accepts settled lossless Bash tool actions despite bounded untrusted context", () => {
    expect(isObviousRiskCandidate({ settled: true, permission: "bash", assessment, snapshot })).toBe(true)
  })

  test("keeps non-Bash, unsettled, lossy, unknown-cwd, and malformed semantic cases human", () => {
    const cases = [
      { settled: false },
      { permission: "edit" },
      { snapshot: { ...snapshot, action: { ...snapshot.action, identity: "write" } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, origin: "doom_loop" as const } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, complete: false } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, omitted_items: 1 } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, omitted_bytes: 1 } } },
      { snapshot: { ...snapshot, action: { ...snapshot.action, cwd: undefined, cwd_status: "unknown" as const } } },
      {
        assessment: {
          outcome: "allow" as const,
          reason_code: "destructive_or_irreversible" as const,
          safer_alternative: "none" as const,
        },
      },
    ]
    for (const change of cases) {
      expect(
        isObviousRiskCandidate({
          settled: "settled" in change && change.settled === false ? false : true,
          permission: "permission" in change && change.permission ? change.permission : "bash",
          assessment: "assessment" in change && change.assessment ? change.assessment : assessment,
          snapshot: "snapshot" in change && change.snapshot ? change.snapshot : snapshot,
        }),
      ).toBe(false)
    }
  })

  test("maps alternatives to fixed local feedback only", () => {
    expect(obviousRiskRewriteFeedback("narrow_target")).toBe("Narrow the action to the smallest necessary target.")
    expect(obviousRiskRewriteFeedback("request_specific_authorisation")).toBeUndefined()
    expect(obviousRiskRewriteFeedback("none")).toBeUndefined()
  })
})

describe("generic built-in risk allow gate", () => {
  const assessment = {
    outcome: "allow" as const,
    reason_code: "routine_or_low_impact" as const,
    safer_alternative: "none" as const,
  }
  const globSnapshot = {
    ...snapshot,
    action: {
      ...snapshot.action,
      identity: "glob",
      permission: "glob",
      arguments: { pattern: "*.md" },
    },
  } satisfies PermissionReviewSnapshot

  test("constructs complete actions only for trusted allowlisted built-ins", () => {
    expect(
      resolveReviewAction({
        builtin: true,
        identity: "glob",
        arguments: { pattern: "*.md" },
        directory: "/tmp/project",
        requested: {
          identity: "glob",
          arguments: { pattern: "*.md" },
          cwd: "/tmp/project",
          complete: true,
        },
      }),
    ).toEqual({
      identity: "glob",
      arguments: { pattern: "*.md" },
      cwd: "/tmp/project",
      complete: true,
    })
    expect(
      resolveReviewAction({
        builtin: true,
        identity: "grep",
        arguments: { pattern: "TODO" },
        directory: "/tmp/project",
        requested: {
          identity: "grep",
          arguments: { pattern: "TODO" },
          cwd: "/tmp/project",
          complete: true,
        },
      }),
    ).toEqual({
      identity: "grep",
      arguments: { pattern: "TODO" },
      cwd: "/tmp/project",
      complete: false,
    })
    expect(
      resolveReviewAction({
        builtin: true,
        identity: "glob",
        arguments: { pattern: "*.md" },
        directory: "/tmp/project",
      }).complete,
    ).toBe(false)
    expect(
      resolveReviewAction({
        builtin: true,
        identity: "websearch",
        arguments: { query: "example" },
        directory: "/tmp/project",
      }),
    ).toEqual({
      identity: "websearch",
      arguments: { query: "example" },
      cwd: null,
      complete: true,
    })
    expect(
      resolveReviewAction({
        builtin: true,
        identity: "write",
        arguments: { filePath: "/tmp/file", content: "changed" },
        directory: "/tmp/project",
      }),
    ).toEqual({
      identity: "write",
      arguments: {
        contract: "registered-builtin-invocation-v1",
        effects_bound: false,
        invocation: { filePath: "/tmp/file", content: "changed" },
      },
      cwd: "/tmp/project",
      complete: true,
    })
  })

  test("keeps symlink-following read actions incomplete and human-gated", () => {
    const action = { identity: "read", arguments: { filePath: "README.md" } }
    expect(
      resolveReviewAction({
        builtin: true,
        identity: action.identity,
        arguments: action.arguments,
        directory: "/tmp/project",
      }),
    ).toEqual({ ...action, complete: false })
    expect(
      isGenericRiskAllowCandidate({
        settled: true,
        permission: action.identity,
        assessment,
        snapshot: {
          ...globSnapshot,
          action: {
            ...globSnapshot.action,
            identity: action.identity,
            permission: action.identity,
            arguments: action.arguments,
          },
        },
      }),
    ).toBe(false)
  })

  test("constructs lower-assurance exact invocation contracts for registered built-ins", () => {
    const cases = [
      ["apply_patch", "edit", "/tmp/project", { patchText: "*** Begin Patch" }],
      ["edit", "edit", "/tmp/project", { filePath: "a.ts", oldString: "a", newString: "b" }],
      ["lsp", "lsp", "/tmp/project", { operation: "hover", filePath: "a.ts", line: 1, character: 1 }],
      ["skill", "skill", "/tmp/project", { name: "example" }],
      ["task", "task", "/tmp/project", { description: "Inspect", prompt: "Inspect this", subagent_type: "Cat" }],
      ["todowrite", "todowrite", null, { todos: [] }],
      ["webfetch", "webfetch", null, { url: "https://example.com" }],
      ["write", "edit", "/tmp/project", { filePath: "a.ts", content: "value" }],
    ] as const
    for (const [identity, permission, cwd, invocation] of cases) {
      const action = resolveReviewAction({ builtin: true, identity, arguments: invocation, directory: "/tmp/project" })
      expect(action).toEqual({
        identity,
        arguments: {
          contract: "registered-builtin-invocation-v1",
          effects_bound: false,
          invocation,
        },
        cwd,
        complete: true,
      })
      const built = buildPermissionReviewSnapshot({
        permission,
        origin: "tool",
        patterns: ["*"],
        metadata: {},
        action,
        trusted: [{ source: "human", text: "Perform the requested routine operation" }],
        untrusted: [],
        contextSafeForGate: true,
      })
      expect(isGenericRiskAllowCandidate({ settled: true, permission, assessment, snapshot: built })).toBe(true)
    }
  })

  test("never upgrades explicit incomplete, custom, lossy, or mismatched fallback actions", () => {
    const invocation = { filePath: "a.ts", content: "value" }
    const requested = {
      identity: "write",
      arguments: invocation,
      cwd: "/tmp/project",
      complete: false,
    } as const
    expect(
      resolveReviewAction({
        builtin: true,
        identity: "write",
        arguments: invocation,
        directory: "/tmp/project",
        requested,
      }).complete,
    ).toBe(false)
    expect(
      resolveReviewAction({
        builtin: false,
        identity: "write",
        arguments: invocation,
        directory: "/tmp/project",
      }).complete,
    ).toBe(false)
    expect(
      resolveReviewAction({
        builtin: true,
        identity: "custom",
        arguments: invocation,
        directory: "/tmp/project",
      }).complete,
    ).toBe(false)

    const action = resolveReviewAction({
      builtin: true,
      identity: "write",
      arguments: invocation,
      directory: "/tmp/project",
    })
    const built = buildPermissionReviewSnapshot({
      permission: "edit",
      origin: "tool",
      patterns: ["*"],
      metadata: {},
      action,
      trusted: [{ source: "human", text: "Write the file" }],
      untrusted: [],
      contextSafeForGate: true,
    })
    for (const snapshot of [
      { ...built, action: { ...built.action, permission: "read" } },
      { ...built, action: { ...built.action, omitted_items: 1 } },
      { ...built, action: { ...built.action, omitted_bytes: 1 } },
      { ...built, action: { ...built.action, complete: false } },
    ]) {
      expect(isGenericRiskAllowCandidate({ settled: true, permission: "edit", assessment, snapshot })).toBe(false)
    }
  })

  test("makes an eligible generic rewrite candidate without treating it as an allow", () => {
    const action = resolveReviewAction({
      builtin: true,
      identity: "webfetch",
      arguments: { url: "https://example.com/install.sh" },
      directory: "/tmp/project",
    })
    const built = buildPermissionReviewSnapshot({
      permission: "webfetch",
      origin: "tool",
      patterns: ["*"],
      metadata: {},
      action,
      trusted: [{ source: "human", text: "Inspect the installer safely" }],
      untrusted: [],
      contextSafeForGate: true,
    })
    const rewrite = {
      outcome: "rewrite" as const,
      reason_code: "untrusted_code_or_remote_payload" as const,
      safer_alternative: "inspect_read_only" as const,
    }
    expect(
      isGenericRiskCandidate({ settled: true, permission: "webfetch", assessment: rewrite, snapshot: built }),
    ).toBe(true)
    expect(
      isGenericRiskAllowCandidate({ settled: true, permission: "webfetch", assessment: rewrite, snapshot: built }),
    ).toBe(false)
  })

  test("allows only complete registered read, grep, and Bash external-directory actions", () => {
    for (const [identity, invocation] of [
      ["read", { filePath: "/tmp/external/a.ts", offset: 1, limit: 20 }],
      ["grep", { pattern: "TODO", path: "/tmp/external" }],
    ] as const) {
      const action = resolveReviewAction({
        builtin: true,
        permission: "external_directory",
        permissionMetadata: { tool: identity },
        identity,
        arguments: invocation,
        directory: "/tmp/project",
      })
      const built = buildPermissionReviewSnapshot({
        permission: "external_directory",
        origin: "tool",
        patterns: ["/tmp/external/*"],
        metadata: {},
        action,
        trusted: [{ source: "human", text: "Inspect the external source checkout" }],
        untrusted: [],
        contextSafeForGate: true,
      })
      expect(
        isExternalDirectoryRiskAllowCandidate({
          settled: true,
          permission: "external_directory",
          assessment,
          snapshot: built,
        }),
      ).toBe(true)
      expect(
        isGenericRiskCandidate({ settled: true, permission: "external_directory", assessment, snapshot: built }),
      ).toBe(false)

      const inherited = Object.create({ tool: identity }) as Record<string, unknown>
      const accessor = Object.defineProperty({}, "tool", { get: () => identity }) as Record<string, unknown>
      for (const permissionMetadata of [undefined, {}, { tool: "other" }, { tool: 1 }, inherited, accessor]) {
        expect(
          resolveReviewAction({
            builtin: true,
            permission: "external_directory",
            permissionMetadata,
            identity,
            arguments: invocation,
            directory: "/tmp/project",
          }),
        ).toEqual({ identity, arguments: invocation, complete: false })
        expect(
          resolveReviewAction({
            builtin: true,
            permission: "external_directory",
            permissionMetadata,
            identity,
            arguments: invocation,
            directory: "/tmp/project",
            requested: action,
          }),
        ).toEqual({ identity, arguments: invocation, complete: false })
      }
    }

    const bashAction = {
      identity: "bash",
      arguments: { command: "git status", timeout: 30_000, workdir: "/tmp/project", shell: "/bin/bash" },
      cwd: "/tmp/project",
      complete: true,
    }
    const bash = buildPermissionReviewSnapshot({
      permission: "external_directory",
      origin: "tool",
      patterns: ["/tmp/external/*"],
      metadata: {},
      action: bashAction,
      trusted: [{ source: "human", text: "Inspect the external source checkout" }],
      untrusted: [],
      contextSafeForGate: true,
    })
    expect(
      isExternalDirectoryRiskAllowCandidate({
        settled: true,
        permission: "external_directory",
        assessment,
        snapshot: bash,
      }),
    ).toBe(true)
    for (const candidate of [
      { ...bash, action: { ...bash.action, identity: "write" } },
      { ...bash, action: { ...bash.action, complete: false } },
      { ...bash, action: { ...bash.action, omitted_items: 1 } },
      { ...bash, action: { ...bash.action, cwd: "relative/project" } },
      { ...bash, trusted: { ...bash.trusted, complete: false } },
    ]) {
      expect(
        isExternalDirectoryRiskAllowCandidate({
          settled: true,
          permission: "external_directory",
          assessment,
          snapshot: candidate,
        }),
      ).toBe(false)
    }
  })

  test("keeps unattested glob and grep explicit paths incomplete and human-gated", () => {
    for (const identity of ["glob", "grep"]) {
      for (const path of [".", "link-to-external"]) {
        const argumentsValue = { pattern: "*", path }
        expect(
          resolveReviewAction({
            builtin: true,
            identity,
            arguments: argumentsValue,
            directory: "/tmp/project",
          }),
        ).toEqual({ identity, arguments: argumentsValue, complete: false })
        expect(
          isGenericRiskAllowCandidate({
            settled: true,
            permission: identity,
            assessment,
            snapshot: {
              ...globSnapshot,
              action: {
                ...globSnapshot.action,
                identity,
                permission: identity,
                arguments: argumentsValue,
                complete: false,
              },
            },
          }),
        ).toBe(false)
      }
    }
  })

  test("keeps search actions human-authorised even when attested at the exact session directory", () => {
    for (const identity of ["glob", "grep"]) {
      const argumentsValue = { pattern: "*", path: "/tmp/project" }
      const action = resolveReviewAction({
        builtin: true,
        identity,
        arguments: argumentsValue,
        directory: "/tmp/project",
        requested: { identity, arguments: argumentsValue, cwd: "/tmp/project", complete: true },
      })
      expect(action.complete).toBe(identity === "glob")
      const exact = buildPermissionReviewSnapshot({
        permission: identity,
        origin: "tool",
        patterns: ["*"],
        metadata: {},
        action,
        trusted: [{ source: "human", text: "Search this project" }],
        untrusted: [],
        contextSafeForGate: true,
      })
      expect(
        isGenericRiskAllowCandidate({
          settled: true,
          permission: identity,
          assessment,
          snapshot: exact,
        }),
      ).toBe(false)
      const child = resolveReviewAction({
        builtin: true,
        identity,
        arguments: argumentsValue,
        directory: "/tmp/project",
        requested: { identity, arguments: argumentsValue, cwd: "/tmp/project/child", complete: true },
      })
      const childSnapshot = buildPermissionReviewSnapshot({
        permission: identity,
        origin: "tool",
        patterns: ["*"],
        metadata: {},
        action: child,
        trusted: [{ source: "human", text: "Search this project" }],
        untrusted: [],
        contextSafeForGate: true,
      })
      expect(
        isGenericRiskAllowCandidate({
          settled: true,
          permission: identity,
          assessment,
          snapshot: childSnapshot,
        }),
      ).toBe(false)
      expect(
        resolveReviewAction({
          builtin: true,
          identity,
          arguments: argumentsValue,
          directory: "/tmp/project",
          requested: {
            identity,
            arguments: { pattern: "different", path: "/tmp/project" },
            cwd: "/tmp/project",
            complete: true,
          },
        }).complete,
      ).toBe(identity === "glob")
    }
  })

  test("accepts only a truthful built-in pinned project text action", () => {
    const input = { filePath: "/tmp/project/src/page.php", offset: 10, limit: 20 }
    const action = {
      identity: "read",
      arguments: {
        ...input,
        target: "src/page.php",
        mode: "pinned-project-text-v4",
        bindingId: "1".repeat(32),
        instructionFilesAbsent: true,
        instructionWatch: "linux-inotify-v1",
        effects: [],
      },
      cwd: "/tmp/project",
      complete: true,
    }
    expect(
      resolveReviewAction({
        builtin: true,
        identity: "read",
        arguments: input,
        directory: "/tmp/project",
        requested: action,
      }),
    ).toBe(action)
    expect(
      isGenericRiskAllowCandidate({
        settled: true,
        permission: "read",
        assessment,
        snapshot: {
          ...globSnapshot,
          action: {
            ...globSnapshot.action,
            ...action,
            permission: "read",
            cwd_status: "exact",
          },
        },
      }),
    ).toBe(true)
    for (const invalid of [
      { ...action, arguments: { ...action.arguments, target: "../secret.php" } },
      { ...action, arguments: { ...action.arguments, effects: ["lsp"] } },
      { ...action, arguments: { ...action.arguments, limit: 21 } },
      { ...action, arguments: { ...action.arguments, mode: "pinned-project-text-v1" } },
      { ...action, arguments: { ...action.arguments, bindingId: "not-an-id" } },
      { ...action, arguments: { ...action.arguments, instructionWatch: "none" } },
    ]) {
      expect(
        resolveReviewAction({
          builtin: true,
          identity: "read",
          arguments: input,
          directory: "/tmp/project",
          requested: invalid,
        }).complete,
      ).toBe(false)
    }
    expect(
      resolveReviewAction({
        builtin: false,
        identity: "read",
        arguments: input,
        directory: "/tmp/project",
        requested: action,
      }).complete,
    ).toBe(false)
    let accessed = false
    const accessor = { ...action.arguments }
    Object.defineProperty(accessor, "target", {
      enumerable: true,
      get() {
        accessed = true
        return "src/page.php"
      },
    })
    for (const argumentsValue of [accessor, new Proxy(action.arguments, {})]) {
      expect(
        resolveReviewAction({
          builtin: true,
          identity: "read",
          arguments: input,
          directory: "/tmp/project",
          requested: { ...action, arguments: argumentsValue },
        }).complete,
      ).toBe(false)
    }
    expect(accessed).toBe(false)
  })

  test("rejects external-directory aliases and MCP list façades", () => {
    for (const identity of ["glob", "grep"]) {
      expect(
        isGenericRiskAllowCandidate({
          settled: true,
          permission: "external_directory",
          assessment,
          snapshot: {
            ...globSnapshot,
            action: { ...globSnapshot.action, identity, permission: "external_directory" },
          },
        }),
      ).toBe(false)
    }
    for (const identity of ["list_mcp_resources", "list_mcp_resource_templates"]) {
      expect(
        isGenericRiskAllowCandidate({
          settled: true,
          permission: "read",
          assessment,
          snapshot: {
            ...globSnapshot,
            action: {
              ...globSnapshot.action,
              identity,
              permission: "read",
              arguments: {},
              cwd: undefined,
              cwd_status: "not_applicable",
            },
          },
        }),
      ).toBe(false)
    }
  })

  test("accepts only an exact server and URI for the stable MCP resource read", () => {
    const action = {
      identity: "read_mcp_resource",
      arguments: { server: "docs", uri: "resource://guide" },
      cwd: null,
      complete: true,
    }
    expect(
      resolveReviewAction({
        builtin: true,
        identity: "read_mcp_resource",
        arguments: action.arguments,
        directory: "/tmp/project",
        requested: action,
      }),
    ).toBe(action)
    expect(
      isGenericRiskAllowCandidate({
        settled: true,
        permission: "read",
        assessment,
        snapshot: {
          ...globSnapshot,
          action: {
            ...globSnapshot.action,
            ...action,
            permission: "read",
            origin: "tool",
            cwd: undefined,
            cwd_status: "not_applicable",
            omitted_items: 0,
            omitted_bytes: 0,
          },
        },
      }),
    ).toBe(true)
    expect(
      resolveReviewAction({
        builtin: true,
        identity: "read_mcp_resource",
        arguments: { ...action.arguments, extra: true },
        directory: "/tmp/project",
      }).complete,
    ).toBe(false)
  })

  test("custom tools cannot spoof provenance with a built-in name or excess action", () => {
    expect(
      resolveReviewAction({
        builtin: false,
        identity: "glob",
        arguments: { pattern: "*", path: "link-to-external" },
        directory: "/tmp/project",
        requested: {
          identity: "glob",
          arguments: { pattern: "*" },
          cwd: "/tmp/project",
          complete: true,
        },
      }),
    ).toEqual({ identity: "glob", arguments: { pattern: "*", path: "link-to-external" }, complete: false })
    const grepArguments = { pattern: "PUBLISHED-TTL", path: "/tmp/project" }
    expect(
      resolveReviewAction({
        builtin: false,
        identity: "grep",
        arguments: grepArguments,
        directory: "/tmp/project",
        requested: {
          identity: "grep",
          cwd: "/tmp/project",
          complete: true,
          arguments: {
            ...grepArguments,
            literals: ["PUBLISHED-TTL"],
            mode: "pinned-project-literal-grep-v4",
            executor: "literal-utf8-lf-lines-v1",
            bindingId: "0".repeat(32),
            fileCount: 1,
            totalBytes: 1,
            limits: { files: 4096, fileBytes: 8388608, totalBytes: 134217728, depth: 64 },
            effects: [],
          },
        },
      }),
    ).toEqual({ identity: "grep", arguments: grepArguments, complete: false })
  })

  test("preserves explicit actions only for trusted built-ins", () => {
    const action = {
      identity: "bash",
      arguments: { command: "git status" },
      cwd: "/tmp/project",
      complete: true,
    }
    expect(
      resolveReviewAction({
        builtin: true,
        identity: "bash",
        arguments: {},
        directory: "/tmp/project",
        requested: action,
      }),
    ).toBe(action)
    expect(
      resolveReviewAction({
        builtin: true,
        identity: "read",
        arguments: { filePath: "README.md" },
        directory: "/tmp/project",
        requested: action,
      }),
    ).toEqual({ identity: "read", arguments: { filePath: "README.md" }, complete: false })
  })

  test("does not generically allow lossless glob actions rooted at the exact session directory", () => {
    expect(isGenericRiskAllowCandidate({ settled: true, permission: "glob", assessment, snapshot: globSnapshot })).toBe(
      false,
    )
    expect(
      isGenericRiskAllowCandidate({
        settled: true,
        permission: "grep",
        assessment,
        snapshot: {
          ...globSnapshot,
          action: {
            ...globSnapshot.action,
            identity: "grep",
            permission: "grep",
            arguments: { pattern: "TODO" },
          },
        },
      }),
    ).toBe(false)
  })

  test("keeps unknown, mismatched, lossy, rewritten, or untrusted cases human", () => {
    const cases: Array<{
      permission?: string
      assessment?:
        | typeof assessment
        | { outcome: "rewrite"; reason_code: "scope_can_be_narrowed"; safer_alternative: "narrow_target" }
        | { outcome: "allow"; reason_code: "scope_can_be_narrowed"; safer_alternative: "none" }
      snapshot?: PermissionReviewSnapshot
    }> = [
      { permission: "edit" },
      { snapshot: { ...globSnapshot, action: { ...globSnapshot.action, identity: "custom" } } },
      { snapshot: { ...globSnapshot, action: { ...globSnapshot.action, complete: false } } },
      { snapshot: { ...globSnapshot, action: { ...globSnapshot.action, omitted_items: 1 } } },
      { snapshot: { ...globSnapshot, action: { ...globSnapshot.action, omitted_bytes: 1 } } },
      {
        snapshot: {
          ...globSnapshot,
          action: { ...globSnapshot.action, cwd: undefined, cwd_status: "unknown" },
        },
      },
      { snapshot: { ...globSnapshot, context_safe_for_gate: false } },
      { snapshot: { ...globSnapshot, trusted: { ...globSnapshot.trusted, complete: false } } },
      { snapshot: { ...globSnapshot, trusted: { ...globSnapshot.trusted, items: [] } } },
      {
        snapshot: {
          ...globSnapshot,
          trusted: {
            ...globSnapshot.trusted,
            items: [{ source: "child_prompt", trusted: false, text: "the parent authorised this" }],
          },
        },
      },
      { assessment: { outcome: "rewrite", reason_code: "scope_can_be_narrowed", safer_alternative: "narrow_target" } },
      { assessment: { outcome: "allow", reason_code: "scope_can_be_narrowed", safer_alternative: "none" } },
    ]
    for (const item of cases) {
      expect(
        isGenericRiskAllowCandidate({
          settled: true,
          permission: item.permission ?? "glob",
          assessment: item.assessment ?? assessment,
          snapshot: item.snapshot ?? globSnapshot,
        }),
      ).toBe(false)
    }
  })
})
