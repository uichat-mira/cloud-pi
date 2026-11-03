/**
 * Route table and error mapping for the versioned management API.
 *
 * Routing is deliberately small and explicit: no framework, no middleware
 * stack, no plugin system. A request either matches one `/v1` route or it does
 * not; a matched path with an unsupported method is a stable 405. Errors are
 * mapped to the frozen `API_ERROR` classes and never include a stack trace,
 * absolute path or raw internal message for unexpected failures.
 */
import { RunStoreError } from "../research/index.mjs";
import { SchedulerError } from "../scheduler/index.mjs";
import { API_ERROR, ApiError, apiErrorRecord } from "./contracts.mjs";

function notFound(message = "route not found") {
  return new ApiError(API_ERROR.NOT_FOUND, message);
}

const ROUTES = [
  { name: "health", method: "GET", pattern: ["v1", "health"], run: (c) => c.health() },
  { name: "status", method: "GET", pattern: ["v1", "status"], run: (c) => c.status() },
  { name: "schedules.list", method: "GET", pattern: ["v1", "schedules"], run: (c) => c.listSchedules() },
  {
    name: "schedules.create",
    method: "POST",
    pattern: ["v1", "schedules"],
    successStatus: 201,
    run: (c, { body }) => c.createSchedule(body),
  },
  {
    name: "schedules.get",
    method: "GET",
    pattern: ["v1", "schedules", ":scheduleId"],
    run: (c, { params }) => c.getSchedule(params.scheduleId),
  },
  {
    name: "schedules.update",
    method: "PATCH",
    pattern: ["v1", "schedules", ":scheduleId"],
    run: (c, { params, body }) => c.updateSchedule(params.scheduleId, body),
  },
  {
    name: "schedules.delete",
    method: "DELETE",
    pattern: ["v1", "schedules", ":scheduleId"],
    run: (c, { params }) => c.deleteSchedule(params.scheduleId),
  },
  {
    name: "schedules.pause",
    method: "POST",
    pattern: ["v1", "schedules", ":scheduleId", "pause"],
    run: (c, { params }) => c.pause(params.scheduleId),
  },
  {
    name: "schedules.enable",
    method: "POST",
    pattern: ["v1", "schedules", ":scheduleId", "enable"],
    run: (c, { params }) => c.enable(params.scheduleId),
  },
  {
    name: "schedules.runNow",
    method: "POST",
    pattern: ["v1", "schedules", ":scheduleId", "run-now"],
    run: (c, { params }) => c.runNow(params.scheduleId),
  },
  {
    name: "schedules.cancel",
    method: "POST",
    pattern: ["v1", "schedules", ":scheduleId", "cancel"],
    run: (c, { params }) => c.cancel(params.scheduleId),
  },
  {
    name: "runs.list",
    method: "GET",
    pattern: ["v1", "runs"],
    query: ["limit", "scheduleId"],
    run: (c, { query }) => c.listRuns(query),
  },
  {
    name: "runs.get",
    method: "GET",
    pattern: ["v1", "runs", ":runId"],
    run: (c, { params }) => c.getRun(params.runId),
  },
  {
    name: "runs.report",
    method: "GET",
    pattern: ["v1", "runs", ":runId", "report"],
    run: (c, { params }) => c.getRunReport(params.runId),
  },
  {
    // Conditional closure: no delivery endpoint exists because the current dev
    // baseline has no AGT-033 delivery contract. This route exists only to
    // return a stable, documented 404 instead of aliasing a nonexistent state.
    name: "runs.delivery",
    method: "GET",
    pattern: ["v1", "runs", ":runId", "delivery"],
    run: (c) => c.deliveryNotAvailable(),
  },
];

function decodeSegments(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) {
    throw new ApiError(API_ERROR.INVALID_REQUEST, "malformed request path");
  }
  const raw = pathname.split("/").filter((part) => part.length > 0);
  try {
    return raw.map((part) => decodeURIComponent(part));
  } catch {
    throw new ApiError(API_ERROR.INVALID_REQUEST, "malformed URL encoding in request path");
  }
}

function matchPattern(pattern, segments) {
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index];
    const actual = segments[index];
    if (expected.startsWith(":")) {
      if (!actual) return null;
      params[expected.slice(1)] = actual;
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

function assertQueryAllowed(route, query) {
  const allowed = new Set(route.query ?? []);
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) {
      throw new ApiError(API_ERROR.INVALID_REQUEST, `unsupported query parameter: ${key}`);
    }
  }
}

/**
 * Map a thrown value onto the stable API error contract. Only classified
 * messages are returned; unexpected errors become a generic `internal_error`
 * with no path, stack or secret-bearing text.
 */
export function mapApiError(error) {
  if (error instanceof ApiError) return error;

  if (error instanceof SchedulerError) {
    switch (error.code) {
      case "invalid_request":
        return new ApiError(API_ERROR.INVALID_REQUEST, error.message, { cause: error });
      case "not_found":
        return new ApiError(API_ERROR.NOT_FOUND, error.message, { cause: error });
      case "conflict":
      case "interrupted":
        return new ApiError(API_ERROR.CONFLICT, error.message, { cause: error });
      case "scheduler_busy":
        return new ApiError(
          API_ERROR.BUSY,
          "scheduler is busy; retry after the active run settles",
          { cause: error },
        );
      default:
        break;
    }
  }

  if (error instanceof RunStoreError) {
    switch (error.code) {
      case "not_found":
        return new ApiError(API_ERROR.NOT_FOUND, error.message, { cause: error });
      case "invalid_run_id":
        return new ApiError(API_ERROR.INVALID_REQUEST, "invalid research run id", { cause: error });
      case "invalid_request":
        return new ApiError(API_ERROR.INVALID_REQUEST, error.message, { cause: error });
      default:
        break;
    }
  }

  return new ApiError(API_ERROR.INTERNAL_ERROR, "internal error", { cause: error });
}

/**
 * @param {{ controller: object }} options
 */
export function createApiRouter({ controller }) {
  /**
   * @param {{ method: string, pathname: string, query?: Record<string,string>, body?: unknown }} request
   */
  async function dispatch({ method, pathname, query = {}, body }) {
    let routeName = "unmatched";
    try {
      const segments = decodeSegments(pathname);
      const candidates = ROUTES.map((route) => ({ route, params: matchPattern(route.pattern, segments) })).filter(
        (entry) => entry.params !== null,
      );
      if (candidates.length === 0) throw notFound();

      const upperMethod = String(method ?? "").toUpperCase();
      const matched = candidates.find((entry) => entry.route.method === upperMethod);
      if (!matched) {
        routeName = candidates[0].route.name;
        throw new ApiError(API_ERROR.METHOD_NOT_ALLOWED, `method ${upperMethod} is not allowed for this route`, {
          headers: { allow: candidates.map((entry) => entry.route.method).join(", ") },
        });
      }

      routeName = matched.route.name;
      assertQueryAllowed(matched.route, query);
      const data = await matched.route.run(controller, { params: matched.params, query, body });
      const headers = { ...(matched.route.headers ?? {}) };
      if (matched.route.successStatus === 201 && data?.schedule?.scheduleId) {
        headers.location = `/v1/schedules/${data.schedule.scheduleId}`;
      }
      return {
        status: matched.route.successStatus ?? 200,
        route: routeName,
        body: { ok: true, data },
        headers,
      };
    } catch (error) {
      const apiError = mapApiError(error);
      if (apiError.code === API_ERROR.INTERNAL_ERROR) {
        // Diagnostic without content: the class/name is enough to correlate a
        // log line with the code path; the message may contain host paths.
        controller.logger?.warn?.(`api: internal error (${error?.name ?? "Error"})`);
      }
      return {
        status: apiError.status,
        route: routeName,
        body: { ok: false, error: apiErrorRecord(apiError.code, apiError.message) },
        headers: apiError.headers,
      };
    }
  }

  return { dispatch, routes: ROUTES };
}
