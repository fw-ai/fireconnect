import { createServer } from "node:http";
import process from "node:process";

// Standalone test double for the gateway's GET /verifyApiKey, run as its OWN
// process by test/global-setup.mjs. It must be a separate process (not an
// in-test-process server) because several specs drive the CLI with
// `spawnSync`, which blocks the test process's event loop — an in-process
// server could not answer the child's verify request and the child would hang.
const server = createServer((req, res) => {
  if (req.url === "/verifyApiKey") {
    res.writeHead(200, {
      "x-fireworks-developer-email": "test@example.com",
      "x-fireworks-account-id": "acct-test",
    });
    res.end();
    return;
  }
  if (/^\/v1\/accounts\/[^/]+\/featureFlags$/.test(req.url ?? "")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ featureFlags: [] }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(0, "127.0.0.1", () => {
  process.stdout.write(`URL=http://127.0.0.1:${server.address().port}\n`);
});
