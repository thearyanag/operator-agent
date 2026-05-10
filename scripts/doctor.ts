import { join } from "node:path";
import { OperatorStateDb } from "../src/state/operator-db";

const operatorStateDbPath = Bun.argv[2] || Bun.env.OPERATOR_STATE_DB_PATH || join(process.cwd(), ".operator", "state", "operator.sqlite");
const stateDb = new OperatorStateDb(operatorStateDbPath);

try {
  const integrity = stateDb.checkIntegrity();
  const runningRuns = stateDb.countRunningRuns();
  const ok = integrity.length === 1 && integrity[0] === "ok";

  console.log(`Operator state DB: ${operatorStateDbPath}`);
  console.log(`SQLite integrity: ${integrity.join(", ")}`);
  console.log(`Running runs: ${runningRuns}`);

  if (!ok) {
    process.exitCode = 1;
  }
} finally {
  stateDb.close();
}
