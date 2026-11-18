/**
 * session-delete — Host half.
 *
 * Registers one exact, owner-authenticated HTTP route under the Web carrier's
 * `/api` prefix. The browser half (lib/client.js) posts a Session id here; the
 * route removes the Session from every durable place the Harness keeps it in:
 *
 *   1. the workspace registry (archive set, pin set, workspace accounting),
 *   2. the session projection cache,
 *   3. the session log directory on disk (`$DSH_HOME/sessions/<project>/<id>`).
 *
 * A Session is routinely still resident in this process after the user leaves
 * it: once opened, the Session Controller resumes an Agent whose lifecycle is
 * owned by the controller fiber and therefore lasts until the process exits.
 * Such an idle Session can be deleted here: this plugin flushes it, detaches it
 * from the Session store (which makes its persistence writer close and
 * announces `session/disposed` so Clients drop the row), and then removes the
 * log artifacts. A Session with a running turn is refused — the same "stop the
 * work first" rule the archive flow applies — because tearing down a live
 * driver mid-turn is the Session Controller's job, not a sidebar action's.
 */

import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROUTE = "/api/session-delete";
const PING_ROUTE = "/api/session-delete/ping";
const STATUS_ROUTE = "/api/session-delete/status";
const SESSION_ID = /^session-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SCAN_DEPTH = 4;
/** Let the fire-and-forget persistence writer finish closing before removing its files. */
const WRITER_CLOSE_GRACE_MS = 150;

/** Process-local diagnostics: proof that a browser page loaded this plugin. */
const heartbeat = { loads: 0, lastLoadAt: null };

export const name = "session-delete";

/**
 * Mount the delete route on the active Web carrier.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
	ctx.inject(["connection"], (scope) => {
		const connection = scope.get("connection");
		if (typeof connection?.fetch?.register !== "function") {
			scope.logger?.warn?.("session-delete: connection.fetch.register is unavailable; delete route not installed");
			return;
		}
		scope.effect(() => {
			const disposers = [
				connection.fetch.register({
					path: ROUTE,
					methods: ["POST"],
					requestBody: "buffered",
					fetch: (request) => handleDelete(scope, request)
				}),
				connection.fetch.register({
					path: PING_ROUTE,
					methods: ["POST"],
					requestBody: "buffered",
					fetch: async () => {
						heartbeat.loads += 1;
						heartbeat.lastLoadAt = Date.now();
						return json({ ok: true });
					}
				}),
				connection.fetch.register({
					path: STATUS_ROUTE,
					methods: ["GET"],
					requestBody: "buffered",
					fetch: async () => json({ ok: true, ...heartbeat, liveSessions: liveSessions(scope) })
				})
			];
			return () => {
				for (const dispose of disposers.reverse()) {
					try {
						dispose();
					} catch {
						/* already withdrawn */
					}
				}
			};
		}, "session-delete: routes");
	});
}

/**
 * Build one JSON success response.
 * @param body - JSON-serializable body.
 * @returns the response.
 */
function json(body) {
	return Response.json(body, { headers: { "cache-control": "no-store" } });
}

/**
 * Answer one delete request.
 * @param ctx - Host scope that read the services.
 * @param request - buffered WHATWG request carrying `{ sessionId }`.
 * @returns the JSON response.
 */
async function handleDelete(ctx, request) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return failure(400, "bad-request", "请求体不是合法 JSON");
	}
	const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId.trim() : "";
	if (!SESSION_ID.test(sessionId)) return failure(400, "bad-request", "缺少合法的 sessionId");
	try {
		const outcome = await deleteSession(ctx, sessionId);
		return Response.json({ ok: true, ...outcome }, { headers: { "cache-control": "no-store" } });
	} catch (error) {
		const status = typeof error?.status === "number" ? error.status : 500;
		return failure(status, error?.code ?? "delete-failed", error instanceof Error ? error.message : String(error));
	}
}

/**
 * Remove one Session, cold or idle-resident.
 * @param ctx - Host scope that read the services.
 * @param sessionId - Session identity to delete.
 * @returns counts and the workspace paths that detached the Session.
 */
async function deleteSession(ctx, sessionId) {
	const sessions = ctx.get("sessions");
	const agents = ctx.get("agents");
	const live = typeof sessions?.get === "function" ? sessions.get(sessionId) : undefined;
	const agent = typeof agents?.get === "function" ? agents.get(sessionId) : undefined;
	await refuseRunningSession(ctx, sessionId, agent);

	const registry = ctx.get("workspaceRegistry");
	const logDirs = await locateSessionDirs(ctx, sessionId);
	let known = false;
	try {
		known = typeof registry?.sessionKnown === "function" ? await registry.sessionKnown(sessionId) : false;
	} catch {
		known = false;
	}
	if (!known && logDirs.length === 0) throw fail(404, "session-not-found", "找不到该会话，它可能已经被删除。");

	// Stop whatever the Session still owns implicitly (scheduled reminders,
	// background jobs, idle descendants) before its log goes away.
	try {
		await ctx.parallel("workspace/session-stop", { sessionId });
	} catch (error) {
		ctx.logger?.warn?.(`session-delete: stopping providers for '${sessionId}' failed: ${String(error)}`);
	}

	const detached = [];
	if (registry !== undefined) {
		// Archive and pin sets are registry-global: clear both before the
		// accounting slot so a reload never surfaces a half-deleted row.
		try {
			await registry.unarchiveSession(sessionId);
		} catch (error) {
			ctx.logger?.warn?.(`session-delete: unarchive '${sessionId}' failed: ${String(error)}`);
		}
		try {
			await registry.unpinSession(sessionId);
		} catch (error) {
			ctx.logger?.warn?.(`session-delete: unpin '${sessionId}' failed: ${String(error)}`);
		}
		for (const entity of registry.list()) {
			try {
				if (!entity.sessionIds.includes(sessionId)) continue;
				await entity.detachSession(sessionId);
				detached.push(entity.path);
			} catch (error) {
				ctx.logger?.warn?.(`session-delete: detach '${sessionId}' from '${entity.path}' failed: ${String(error)}`);
			}
		}
	}

	// Projection rows are keyed by Session id; a deleted log must not leave a
	// cached fold behind (a later fork/reuse would read stale state).
	try {
		const storage = ctx.get("storageDomain");
		const table = storage?.get?.("session_projcache")?.table?.("sessions");
		if (table !== undefined && typeof table.delete === "function") await table.delete(sessionId);
	} catch (error) {
		ctx.logger?.warn?.(`session-delete: projection cache cleanup for '${sessionId}' failed: ${String(error)}`);
	}

	// A resumed Session keeps a writer the persistence backend closes on
	// `session/disposed`. Flush first so nothing is left buffered, then detach
	// it from the store (the event Clients observe as the row's removal), give
	// the writer a moment to close, and only then remove the artifacts.
	let releasedLiveSession = false;
	if (live !== undefined) {
		try {
			if (typeof sessions.flush === "function") await sessions.flush(live);
		} catch (error) {
			ctx.logger?.warn?.(`session-delete: flush '${sessionId}' failed: ${String(error)}`);
		}
		try {
			const entry = sessions.liveEntryFor(live);
			sessions.detachEntered(entry);
			releasedLiveSession = true;
		} catch (error) {
			ctx.logger?.warn?.(`session-delete: release '${sessionId}' failed: ${String(error)}`);
			throw fail(500, "session-release-failed", `无法释放仍在内存中的会话：${error instanceof Error ? error.message : String(error)}`);
		}
		await sleep(WRITER_CLOSE_GRACE_MS);
	}

	// Log artifacts go last: everything durable above is already rewritten, and
	// a failed removal stays visible as an error instead of a ghost row.
	for (const dir of logDirs) await rm(dir, { recursive: true, force: true });

	// A resident Session announces its removal through `session/disposed`.
	// A cold Session has no store entry, so announce the list removal here;
	// the Client drops the row without a page reload.
	if (!releasedLiveSession) {
		try {
			ctx.emit("api-session/removed", sessionId);
		} catch (error) {
			ctx.logger?.warn?.(`session-delete: removal announcement for '${sessionId}' failed: ${String(error)}`);
		}
	}

	return { sessionId, removedDirs: logDirs.length, detachedWorkspaces: detached, releasedLiveSession };
}

/**
 * Refuse a Session with a running turn; idle resident Sessions are deletable.
 * @param ctx - Host scope that read the services.
 * @param sessionId - Session identity to test.
 * @param agent - live Agent for the Session, when present.
 */
async function refuseRunningSession(ctx, sessionId, agent) {
	if (agent !== undefined && agent.status === "running") {
		throw fail(409, "session-active", "该会话正在运行任务，请先停止后再删除。");
	}
	let activity = [];
	try {
		const reported = await ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]));
		if (Array.isArray(reported)) activity = reported;
	} catch {
		activity = [];
	}
	const turn = activity.find((entry) => entry?.kind === "turn");
	if (turn !== undefined) throw fail(409, "session-active", "该会话还有进行中的回合，请先停止后再删除。");
}

/**
 * Find the Session's log directory (or directories) under the Harness home.
 * The layout is `<home>/sessions/<project-dir>/<session-id>`, and the project
 * directory spelling is derived from the recorded cwd, so the id is the stable
 * key to look for rather than recomputing that spelling.
 * @param ctx - Host scope that read the services.
 * @param sessionId - Session identity to find.
 * @returns absolute log directories.
 */
async function locateSessionDirs(ctx, sessionId) {
	const roots = new Set();
	const homePath = ctx.get("dshHomePath");
	if (typeof homePath === "function") {
		try {
			roots.add(homePath("sessions"));
		} catch {
			/* fall through to the environment and default roots */
		}
	}
	const configured = process.env.DSH_HOME?.trim();
	if (configured !== undefined && configured !== "") roots.add(join(configured, "sessions"));
	roots.add(join(homedir(), ".dsh", "sessions"));
	const found = [];
	for (const root of roots) await scan(root, sessionId, 0, found);
	return [...new Set(found)];
}

/**
 * Depth-limited scan for a directory named after the Session.
 * @param dir - directory to read.
 * @param sessionId - directory basename to match.
 * @param depth - current depth.
 * @param found - accumulator of absolute matches.
 */
async function scan(dir, sessionId, depth, found) {
	if (depth > MAX_SCAN_DEPTH) return;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const full = join(dir, entry.name);
		if (entry.name === sessionId) {
			found.push(full);
			continue;
		}
		await scan(full, sessionId, depth + 1, found);
	}
}

/**
 * Live Sessions and their Agent status, for diagnostics.
 * @param ctx - Host scope that read the services.
 * @returns up to 50 `{ sessionId, status }` rows.
 */
function liveSessions(ctx) {
	const sessions = ctx.get("sessions");
	const agents = ctx.get("agents");
	let sessionsList = [];
	try {
		sessionsList = typeof sessions?.list === "function" ? sessions.list() : [];
	} catch {
		sessionsList = [];
	}
	return sessionsList.slice(0, 50).map((session) => {
		let status = "unknown";
		try {
			status = agents?.get?.(session.id)?.status ?? "unknown";
		} catch {
			status = "unknown";
		}
		return { sessionId: session.id, status };
	});
}

/**
 * Build a tagged error the handler turns into a status/code pair.
 * @param status - HTTP status.
 * @param code - stable error code.
 * @param message - user-facing message.
 * @returns the tagged error.
 */
function fail(status, code, message) {
	const error = new Error(message);
	error.status = status;
	error.code = code;
	return error;
}

/**
 * Build one JSON failure response.
 * @param status - HTTP status.
 * @param code - stable error code.
 * @param message - user-facing message.
 * @returns the response.
 */
function failure(status, code, message) {
	return Response.json({ ok: false, error: { code, message } }, {
		status,
		headers: { "cache-control": "no-store" }
	});
}
