/**
 * Deterministic collaborators for AGT-037 tests.
 *
 * Only the external boundaries are faked: the lock file, the API socket, the
 * platform SDKs and the model runtime. The scheduler/delivery/run store used by
 * the trace test are the real modules.
 */

/** Fake app dependencies that record every lifecycle call in `steps`. */
export function fakeAppDeps({ steps = [], failAt, settle = "immediate", draining = true } = {}) {
  const scheduler = {
    started: false,
    stopped: false,
    async start() {
      steps.push("scheduler.start");
      if (failAt === "scheduler.start") throw new Error("tick failed to start");
      this.started = true;
      return this;
    },
    async stop() {
      steps.push("scheduler.stop");
      this.stopped = true;
      return this;
    },
    async settle() {
      steps.push("scheduler.settle");
      if (settle === "hang") return new Promise(() => {});
      return this;
    },
    cancelAll() {
      steps.push("scheduler.cancelAll");
      return 1;
    },
    listSchedules() {
      return [];
    },
    getSchedule() {
      return null;
    },
  };
  const coordinator = {
    limits: { reconcilePerSchedule: 1 },
    async deliverTrigger() {
      return null;
    },
    async getRunDelivery() {
      return null;
    },
  };
  const delivering = { scheduler, coordinator, getRunDelivery: async () => null };
  const lock = {
    acquired: false,
    released: false,
    file: "<fake-lock>",
    acquire() {
      steps.push("lock.acquire");
      if (failAt === "lock.acquire") {
        const error = new Error("another Cloud Agent instance is already running for this state directory");
        error.code = "instance_locked";
        throw error;
      }
      this.acquired = true;
      return { file: this.file, recoveredStale: false };
    },
    release() {
      steps.push("lock.release");
      this.released = true;
    },
  };
  const api = {
    address: { url: "http://127.0.0.1:8787/v1", host: "127.0.0.1", port: 8787 },
    async start() {
      steps.push("api.start");
      if (failAt === "api.start") throw new Error("port in use");
      return this.address;
    },
    async stop() {
      steps.push("api.stop");
      return { stopped: true };
    },
  };
  const makeChannel = (name) => ({
    summary: { channel: name },
    describe: () => ({ config: { channel: name } }),
    async stop() {
      steps.push(`${name}.stop`);
      return { drained: draining };
    },
  });
  return {
    steps,
    lock,
    api,
    scheduler,
    delivering,
    coordinator,
    createLock: () => lock,
    createChatRunRecorder: ({ rootDir }) => ({
      rootDir,
      async record() {
        return null;
      },
    }),
    createDeliveringScheduler: async () => {
      steps.push("delivery.create");
      return delivering;
    },
    createManagementApi: () => {
      steps.push("api.create");
      return api;
    },
    loadResearchDeps: async ({ runsDir }) => {
      steps.push("research.load");
      return { runtimePort: { portVersion: 1 }, toolLayer: { tools: [] }, rootDir: runsDir };
    },
    generateRunId: () => "r-20261104T010000-abcdef",
    startFeishu: async () => {
      steps.push("feishu.start");
      if (failAt === "feishu.start") throw new Error("feishu socket refused");
      return { ...makeChannel("feishu"), transport: { async send() {} } };
    },
    startWecom: async () => {
      steps.push("wecom.start");
      if (failAt === "wecom.start") throw new Error("wecom auth failed");
      return makeChannel("wecom");
    },
  };
}
