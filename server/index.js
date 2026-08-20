import { createApplication } from "./app.js";

const port = Number(process.env.PORT || 8080);
const host = "0.0.0.0";
const { server } = await createApplication();

server.listen(port, host, () => {
  console.log(`SEVEN ROOTS web + API listening on http://${host}:${port}`);
});

const shutdown = (signal) => {
  console.log(`${signal} received; closing server.`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
