import { describe, expect, it, vi } from "vitest";

vi.mock("../../db/mongoose.ts", () => ({ connectMongoose: vi.fn() }));
vi.mock("../../../models/workspace-document.ts", () => ({
  WorkspaceDocument: { findOne: vi.fn() },
}));
vi.mock("../../onlyoffice/env.ts", () => ({
  onlyOfficeEnabled: vi.fn(() => true),
  onlyOfficeEnv: vi.fn(() => ({ internalUrl: "http://onlyoffice" })),
}));
vi.mock("../../onlyoffice/tokens.ts", () => ({
  signOnlyOfficeConfig: vi.fn(async () => "signed-token"),
}));

const { WorkspaceDocument } = await import("../../../models/workspace-document.ts");
const { forcesaveAndWait } = await import("./forcesave.ts");

function mockDocument(
  overrides: Record<string, unknown> = {},
): { revisionOnPoll?: number } {
  const base = {
    storageRevision: 3,
    activeEditorKey: "key-1",
    activeUserIds: ["user-1"],
    deletedAt: null,
    ...overrides,
  };
  const state: { revisionOnPoll?: number } = {};
  let calls = 0;
  // First findOne = the initial document load (old revision); later calls are
  // the revision polls, which see the callback-committed bump.
  vi.mocked(WorkspaceDocument.findOne).mockImplementation(
    () =>
      ({
        lean: async () => {
          calls += 1;
          return calls > 1 && state.revisionOnPoll != null
            ? { ...base, storageRevision: state.revisionOnPoll }
            : base;
        },
      }) as never,
  );
  return state;
}

function mockDsResponse(error: number) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ error }) })),
  );
}

describe("forcesaveAndWait", () => {
  it("skips the command entirely when nobody has the document open", async () => {
    mockDocument({ activeUserIds: [] });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await forcesaveAndWait({ documentId: "d1" });
    expect(result).toEqual({ outcome: "fresh", storageRevision: 3 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // DS error 4 = "nothing changed since the last save", 1 = "no active
  // session for this key" — both mean the committed version already IS the
  // latest, and must never be treated as failures.
  it("maps DS error 4 (no changes) to fresh", async () => {
    mockDocument();
    mockDsResponse(4);
    expect((await forcesaveAndWait({ documentId: "d1" })).outcome).toBe("fresh");
  });

  it("maps DS error 1 (no session) to fresh", async () => {
    mockDocument();
    mockDsResponse(1);
    expect((await forcesaveAndWait({ documentId: "d1" })).outcome).toBe("fresh");
  });

  it("maps other DS errors to the timeout fallback", async () => {
    mockDocument();
    mockDsResponse(3);
    expect((await forcesaveAndWait({ documentId: "d1" })).outcome).toBe("timeout");
  });

  it("times out to the last committed version when no new revision lands", async () => {
    mockDocument();
    mockDsResponse(0);
    const result = await forcesaveAndWait({ documentId: "d1", timeoutMs: 1 });
    expect(result).toEqual({ outcome: "timeout", storageRevision: 3 });
  });

  it("resolves saved once the callback bumps storageRevision", async () => {
    const state = mockDocument();
    mockDsResponse(0);
    state.revisionOnPoll = 4;
    const result = await forcesaveAndWait({ documentId: "d1", timeoutMs: 5_000 });
    expect(result).toEqual({ outcome: "saved", storageRevision: 4 });
  });
});
