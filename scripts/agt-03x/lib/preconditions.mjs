#!/usr/bin/env node
/**
 * Scenario A–D 的共同前置清单（与 acceptance-matrix §0「前置清单」一一对应）。
 *
 * 这份清单只回答「能不能开始跑」，不证明任何判据通过。任何一项 `unmet` 都
 * 必须让场景脚本返回 `blocker`（exit 3），不得降级为 pass 或「不适用」。
 *
 * 其中 P3 是一次**真实运维动作**（t20 风险）：必须由维护者用本人 Cloud
 * Account 完成设备绑定登录，拿到设备绑定的 Cloud Session（`mcs_v1.*`），
 * Cloud Pi 才能用它换短期 Guanlan 令牌。代码无法替代这一步。
 *
 * 环境变量名是 harness 侧的契约（产品侧只定义了 `CLOUD_PI_MODEL_*`，
 * 见 `src/config.mjs`）；t8/t9 定稿后如需改名，只改这个文件。
 */
const NONPROD_MARKERS = Object.freeze(["dev", "nonprod", "staging", "localhost", "127.0.0.1"]);

function present(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

export const PRECONDITIONS = Object.freeze([
  {
    id: "P1",
    title: "企业微信机器人已创建（API 模式 + 长连接），WECOM_BOT_ID/SECRET 已注入",
    env: ["WECOM_BOT_ID", "WECOM_SECRET"],
    owner: "维护者（管理员配置）+ t6",
  },
  {
    id: "P2",
    title: "非生产 Cloud Auth 实例可访问（签发 URL + 公网 JWKS URL，仅公布公钥），且不指向生产",
    env: ["CLOUD_AUTH_ISSUER_URL", "CLOUD_AUTH_JWKS_URL", "CLOUD_AUTH_ENV"],
    owner: "维护者 + t8",
  },
  {
    id: "P3",
    title: "测试 Cloud Account 已存在，且已完成设备绑定登录（mcs_v1.* 设备会话有效）",
    env: ["CLOUD_PI_SESSION_TOKEN"],
    owner: "维护者（真实运维动作）；过期需重新登录",
  },
  {
    id: "P4",
    title: "Guanlan 隔离环境已部署：Worker URL + migrations 迁到 0005（含 guanlan_registration_receipts）+ MIRA_GUANLAN_REGISTRATION_SECRET 已设置",
    env: ["GUANLAN_MCP_URL", "MIRA_GUANLAN_REGISTRATION_SECRET"],
    owner: "t18 / guanlan-dev（GLN-015）",
  },
  {
    id: "P5",
    title:
      "该账号在 Guanlan 有 consumer 行（由 GLN-015 真实投递建立；仅显式 seed 时接受）+ ≥1 已批准源与新闻行",
    env: ["AGTX_P5_CONSUMER"],
    owner: "guanlan-dev（GLN-015）/ 维护者",
  },
  {
    id: "P6",
    title: "模型网关可用（CLOUD_PI_MODEL_*）",
    env: ["CLOUD_PI_MODEL_BASE_URL", "CLOUD_PI_MODEL_API_KEY", "CLOUD_PI_MODEL_ID"],
    owner: "维护者（本机 .env 已有）",
  },
  {
    id: "P7",
    title:
      "Guanlan 注册密钥两侧逐字节一致（Cloud Auth MIRA_GUANLAN_REGISTRATION_SECRET == 接收端同名密钥，无尾随换行/空白）；维护者以人工确认声明",
    // 无法在不泄漏密钥的前提下由本机比对两个服务的配置，因此这里只接受一条
    // 人工声明；未声明即 blocker，绝不默认「已一致」。
    env: ["AGTX_P7_SECRET_MATCH"],
    owner: "维护者（两侧同一份 secret；接收端对带空白值直接 503）",
  },
  {
    id: "P8",
    title: "非生产 Cloud Auth 公网 JWKS 可达（仅公钥，https），Guanlan Worker 能取到并缓存 300s",
    env: ["CLOUD_AUTH_PUBLIC_JWKS_URL"],
    owner: "维护者 + t8 / guanlan-dev（GLN-014）",
  },
]);

/** Which preconditions a scenario needs before it may produce a real verdict. */
export const SCENARIO_REQUIREMENTS = Object.freeze({
  A: ["P1", "P3", "P6"],
  B: ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"],
  C: [],
  D: ["P1"],
});

/**
 * Evaluate every precondition. Never reads a secret value, only its presence;
 * `reason` explains an `unmet` result without echoing the value.
 */
export function evaluatePreconditions(env = process.env) {
  return PRECONDITIONS.map((item) => {
    const missing = item.env.filter((name) => !present(env, name));
    const unmet = { id: item.id, title: item.title, owner: item.owner, status: "unmet", missing, reason: null, note: null };

    if (item.id === "P2" && missing.length === 0) {
      const declared = env.CLOUD_AUTH_ENV.trim().toLowerCase();
      const looksProd = declared === "prod" || declared === "production";
      const issuerLooksProd = /prod/i.test(env.CLOUD_AUTH_ISSUER_URL);
      if (looksProd || issuerLooksProd) {
        return { ...unmet, reason: "CLOUD_AUTH_ENV/issuer looks like production; a non-prod instance is required" };
      }
      if (!NONPROD_MARKERS.some((marker) => declared.includes(marker) || env.CLOUD_AUTH_ISSUER_URL.includes(marker))) {
        return { ...unmet, reason: "non-prod instance is not declared (set CLOUD_AUTH_ENV=nonprod|dev|staging)" };
      }
    }

    if (item.id === "P3" && missing.length === 0) {
      if (!env.CLOUD_PI_SESSION_TOKEN.trim().startsWith("mcs_v1.")) {
        return { ...unmet, reason: "session token does not look device-bound (expected mcs_v1.* prefix)" };
      }
    }

    if (item.id === "P4" && missing.length === 0) {
      // The receiver enforces >=32 characters (ADR: GLN-015 §7); a shorter value
      // would make every delivery fail closed with 503, so treat it as unmet.
      if (env.MIRA_GUANLAN_REGISTRATION_SECRET.trim().length < 32) {
        return { ...unmet, reason: "MIRA_GUANLAN_REGISTRATION_SECRET is shorter than the 32-character minimum" };
      }
    }

    if (item.id === "P7" && missing.length === 0) {
      const declared = env.AGTX_P7_SECRET_MATCH.trim().toLowerCase();
      if (!["byte-identical", "byte_identical", "confirmed"].includes(declared)) {
        return { ...unmet, reason: "AGTX_P7_SECRET_MATCH must be byte-identical (manual attestation by the maintainer)" };
      }
      return {
        ...unmet,
        status: "met",
        note: "maintainer attested a byte-identical secret (a local comparison would need the secret itself)",
      };
    }

    if (item.id === "P8" && missing.length === 0) {
      const jwks = env.CLOUD_AUTH_PUBLIC_JWKS_URL.trim();
      if (!jwks.startsWith("https://")) {
        return { ...unmet, reason: "CLOUD_AUTH_PUBLIC_JWKS_URL must be an https URL reachable from the Guanlan Worker" };
      }
      if (/prod/i.test(jwks)) {
        return { ...unmet, reason: "CLOUD_AUTH_PUBLIC_JWKS_URL looks like a production host; a non-prod endpoint is required" };
      }
    }

    if (item.id === "P5" && missing.length === 0) {
      const mode = env.AGTX_P5_CONSUMER.trim().toLowerCase();
      if (!["registered", "seed"].includes(mode)) {
        return { ...unmet, reason: "AGTX_P5_CONSUMER must be registered|seed" };
      }
      return {
        ...unmet,
        status: "met",
        note:
          mode === "seed"
            ? "seed 数据，非 A2 注册链能力（证据必须原样标注）"
            : "created by a real GLN-015 delivery (P4 ready)",
      };
    }

    if (missing.length > 0) return { ...unmet, reason: `missing env: ${missing.join(", ")}` };
    return { ...unmet, status: "met" };
  });
}

/** Subset needed by a scenario, as `unmet` entries only. */
export function unmetFor(scenario, env = process.env) {
  const required = SCENARIO_REQUIREMENTS[scenario] ?? [];
  return evaluatePreconditions(env).filter((item) => required.includes(item.id) && item.status !== "met");
}
