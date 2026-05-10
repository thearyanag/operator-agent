import { expect, test } from "bun:test";
import { PiBridge } from "../src/pi/bridge";

test("does not reuse a stale assistant response when a prompt produces no fresh assistant text", async () => {
  const messages: any[] = [
    {
      role: "assistant",
      content: "stale response that should not be returned",
    },
  ];
  const bridge = new PiBridge({
    cwd: "/tmp",
    sessionRootDir: "/tmp/sessions",
    attachmentRoots: [],
    maxAttachmentBytes: 1_000,
    authStorage: undefined as any,
    modelRegistry: undefined as any,
    resourceLoader: undefined as any,
    onEmptyResponse: ({ newMessages }) => {
      expect(newMessages).toHaveLength(1);
    },
  });

  (bridge as any).getSession = async () => ({
    messages,
    subscribe: () => () => {},
    prompt: async () => {
      messages.push({
        role: "toolResult",
        content: "tool failed",
      });
    },
  });

  const result = await bridge.prompt("private:1", "new prompt");

  expect(result.text).toBe("Pi completed the request but did not return any text.");
});

test("throws provider error when PI records an empty assistant error message", async () => {
  const messages: any[] = [
    {
      role: "assistant",
      content: "stale response that should not be returned",
    },
  ];
  const bridge = new PiBridge({
    cwd: "/tmp",
    sessionRootDir: "/tmp/sessions",
    attachmentRoots: [],
    maxAttachmentBytes: 1_000,
    authStorage: undefined as any,
    modelRegistry: undefined as any,
    resourceLoader: undefined as any,
  });

  (bridge as any).getSession = async () => ({
    messages,
    subscribe: () => () => {},
    prompt: async () => {
      messages.push({
        role: "assistant",
        content: [],
        stopReason: "error",
        errorMessage:
          '403 {"type":"error","error":{"type":"permission_error","message":"OAuth authentication is currently not allowed for this organization."}}',
      });
    },
  });

  await expect(bridge.prompt("private:1", "new prompt")).rejects.toThrow(
    /403 OAuth authentication is currently not allowed/,
  );
});
