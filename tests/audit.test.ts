import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import { AuditLogger } from "../src/audit";
import { OperatorStateDb } from "../src/state/operator-db";

test("writes audit events to the operator SQLite state database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "operator-agent-audit-"));
  const stateDb = new OperatorStateDb(join(dir, "operator.sqlite"));
  const auditLogger = new AuditLogger(stateDb);

  await auditLogger.log({
    event: "pi_prompt_completed",
    runId: "run-1",
    sessionKey: "private:123",
    chatId: 123,
    userId: 456,
    messageId: 789,
    surface: "private",
    response: "done",
  });

  const events = stateDb.listAuditEvents();
  expect(events).toHaveLength(1);
  expect(events[0]?.event).toBe("pi_prompt_completed");
  expect(events[0]?.runId).toBe("run-1");
  expect(events[0]?.sessionKey).toBe("private:123");

  const payload = JSON.parse(events[0]!.payloadJson);
  expect(payload.response).toBe("done");
  expect(typeof payload.timestamp).toBe("string");

  stateDb.close();
});

test("tracks artifacts, active investigations, cases, and evidence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "operator-agent-case-"));
  const stateDb = new OperatorStateDb(join(dir, "operator.sqlite"));

  stateDb.upsertTelegramSession({
    sessionKey: "private:case",
    surface: "private",
    chatId: 321,
    updatedAt: 1_000,
  });
  stateDb.startRun({
    id: "run-case",
    sessionKey: "private:case",
    prompt: "Investigate user@example.com",
    startedAt: 1_100,
  });
  stateDb.setActiveInvestigation({
    sessionKey: "private:case",
    subject: "user@example.com",
    updatedAt: 1_200,
  });
  stateDb.createCase({
    id: "case-1",
    subject: "user@example.com",
    sessionKey: "private:case",
    status: "open",
    summary: "Signup failed.",
    createdAt: 1_300,
    updatedAt: 1_300,
  });
  stateDb.setActiveInvestigation({
    sessionKey: "private:case",
    subject: "user@example.com",
    caseId: "case-1",
    updatedAt: 1_400,
  });
  stateDb.addCaseEvent({
    id: "case-event-1",
    caseId: "case-1",
    runId: "run-case",
    kind: "run_completed",
    text: "Found a billing error.",
    metadataJson: "{}",
    createdAt: 1_500,
  });
  stateDb.insertArtifact({
    id: "artifact-1",
    runId: "run-case",
    caseId: "case-1",
    path: "/tmp/export.csv",
    fileName: "export.csv",
    kind: "document",
    status: "queued",
    createdAt: 1_600,
  });
  stateDb.markRunArtifactsSent("run-case", 1_700);
  stateDb.addEvidenceItem({
    id: "evidence-1",
    caseId: "case-1",
    runId: "run-case",
    source: "postgres",
    querySummary: "Looked up user account state",
    resultSummary: "billing_error",
    createdAt: 1_800,
  });

  expect(stateDb.getActiveInvestigation("private:case")).toMatchObject({
    subject: "user@example.com",
    caseId: "case-1",
  });
  expect(stateDb.getCase("case-1")).toMatchObject({
    subject: "user@example.com",
    summary: "Signup failed.",
  });
  expect(stateDb.listCasesForSession("private:case")).toHaveLength(1);
  expect(stateDb.listArtifactsForRun("run-case")).toMatchObject([
    {
      id: "artifact-1",
      status: "sent",
      sentAt: 1_700,
    },
  ]);
  expect(stateDb.checkIntegrity()).toEqual(["ok"]);

  stateDb.close();
});

test("tracks Telegram sessions and run lifecycle in SQLite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "operator-agent-state-"));
  const stateDb = new OperatorStateDb(join(dir, "operator.sqlite"));

  stateDb.upsertTelegramSession({
    sessionKey: "private:123",
    surface: "private",
    chatId: 123,
    chatType: "private",
    userId: 456,
    username: "operator",
    updatedAt: 1_000,
  });
  stateDb.startRun({
    id: "run-1",
    sessionKey: "private:123",
    prompt: "What happened to user 123?",
    startedAt: 1_100,
  });
  stateDb.completeRun({
    id: "run-1",
    response: "They hit a billing error.",
    completedAt: 1_500,
    durationMs: 400,
    attachmentCount: 2,
  });
  stateDb.startRun({
    id: "run-2",
    sessionKey: "private:123",
    prompt: "Did reply delivery work?",
    startedAt: 1_600,
  });
  stateDb.failRun({
    id: "run-2",
    error: "Telegram failed",
    completedAt: 1_700,
    durationMs: 100,
  });

  expect(stateDb.getTelegramSession("private:123")).toMatchObject({
    sessionKey: "private:123",
    surface: "private",
    chatId: 123,
    userId: 456,
    username: "operator",
    lastRunId: "run-2",
  });
  expect(stateDb.getRun("run-1")).toMatchObject({
    id: "run-1",
    sessionKey: "private:123",
    status: "completed",
    response: "They hit a billing error.",
    durationMs: 400,
    attachmentCount: 2,
  });
  expect(stateDb.getRun("run-2")).toMatchObject({
    id: "run-2",
    sessionKey: "private:123",
    status: "failed",
    error: "Telegram failed",
    durationMs: 100,
  });

  stateDb.close();
});
