export default {
  name: "Test Plugin",
  version: "1.0.0",
  creator: "Roxy",
  description: "A simple test plugin that logs a message",
  apiVersion: 1,

  start(ctx) {
    console.log(`[${this.name}] v${this.version} by ${this.creator} started`);
    console.log("Hello from the plugin system!");
  },

  stop(ctx) {
    console.log(`[${this.name}] stopped`);
  }
};
