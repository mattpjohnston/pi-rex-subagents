import { stdin, stdout } from "node:process";

let buf = Buffer.alloc(0);
stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return;
    const header = buf.subarray(0, end).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match?.[1]) return;
    const length = Number(match[1]);
    const start = end + 4;
    if (buf.length < start + length) return;
    const message = JSON.parse(buf.subarray(start, start + length).toString("utf8"));
    buf = buf.subarray(start + length);
    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "harness", version: "0" },
        },
      });
    } else if (message.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "ping",
              description: "Return pong. Does not touch files.",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        },
      });
    } else if (message.id !== undefined) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "pong" }] },
      });
    }
  }
});

function send(message) {
  const body = JSON.stringify(message);
  stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}
