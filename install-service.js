const Service = require("node-windows").Service;
const path    = require("path");

const svc = new Service({
  name:        "KMT Tally Agent",
  description: "Kothari Multitrade — syncs inventory between the admin system and TallyPrime",
  script:      path.join(__dirname, "agent.js"),
  scriptOptions: "--silent",
  nodeOptions:   [],
  env: [{ name: "NODE_ENV", value: "production" }],
});

svc.on("install", () => {
  svc.start();
  console.log("Service installed and started.");
});

svc.on("error", (e) => console.error("Service error:", e));

svc.install();
