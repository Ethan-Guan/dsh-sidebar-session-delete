/**
 * Host-half test: drive `apply()` with a stub Cordis scope and assert the
 * delete route's durable effects without touching a real DSH home.
 *
 * Run with: node --test test/host.test.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { apply, name } from "../lib/index.js";

/**
 * Build a stub host scope that captures the registered routes.
 * @param options - service overrides.
 * @returns the captured routes plus the calls the handler made.
 */
function harness(options = {}) {
	const calls = { archive: [], detach: [], projection: [], warnings: [], events: [], flush: 0, sessionDetach: 0, stops: 0 };
	const entity = {
		path: "/tmp/project",
		sessionIds: options.attachToWorkspace === false ? [] : [options.sessionId],
		detachSession: async (sessionId) => calls.detach.push(sessionId)
	};
	const registry = {
		sessionKnown: async () => options.known !== false,
		list: () => [entity],
		unarchiveSession: async (sessionId) => calls.archive.push(["unarchive", sessionId]),
		unpinSession: async (sessionId) => calls.archive.push(["unpin", sessionId])
	};
	const routes = new Map();
	const services = {
		connection: { fetch: { register: (registered) => { routes.set(registered.path, registered); return () => {}; } } },
		sessions: {
			get: () => options.live,
			list: () => options.live === undefined ? [] : [options.live],
			flush: async () => { calls.flush += 1; },
			liveEntryFor: () => ({ id: options.sessionId }),
			detachEntered: () => { calls.sessionDetach += 1; }
		},
		agents: { get: (sessionId) => (options.agents !== undefined ? options.agents[sessionId] : options.agent) },
		workspaceRegistry: registry,
		storageDomain: { get: () => ({ table: () => ({ delete: async (sessionId) => calls.projection.push(sessionId) }) }) },
		dshHomePath: (...segments) => join(options.home, ...segments),
		...options.services
	};
	const scope = {
		get: (serviceName) => services[serviceName],
		effect: (factory) => factory(),
		waterfall: async () => options.activity ?? [],
		parallel: async () => { calls.stops += 1; },
		emit: (event, payload) => calls.events.push([event, payload]),
		logger: { warn: (message) => calls.warnings.push(String(message)) }
	};
	const ctx = {
		inject: (_deps, callback) => callback(scope),
		get: (serviceName) => services[serviceName],
		waterfall: scope.waterfall,
		parallel: scope.parallel,
		emit: scope.emit,
		logger: scope.logger
	};
	apply(ctx);
	const route = routes.get("/api/session-delete");
	assert.ok(route !== undefined, "apply() must register the delete route");
	const batch = routes.get("/api/session-delete/batch");
	assert.ok(batch !== undefined, "apply() must register the batch delete route");
	return { route, batch, routes, calls };
}

/**
 * POST one batch delete request to the captured route.
 * @param route - captured exact Fetch route.
 * @param body - request payload.
 * @returns the JSON response body and status.
 */
async function postBatch(route, body) {
	const request = new Request("http://127.0.0.1:1/api/session-delete/batch", {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body)
	});
	const response = await route.fetch(request);
	return { status: response.status, body: await response.json() };
}

/**
 * POST one delete request to the captured route.
 * @param route - captured exact Fetch route.
 * @param body - request payload.
 * @returns the JSON response body and status.
 */
async function post(route, body) {
	const request = new Request("http://127.0.0.1:1/api/session-delete", {
		method: "POST",
		body: typeof body === "string" ? body : JSON.stringify(body)
	});
	const response = await route.fetch(request);
	return { status: response.status, body: await response.json() };
}

/**
 * Create one throwaway Session log directory under a temporary home.
 * @param home - temporary DSH home.
 * @param sessionId - Session identity.
 * @returns the session directory.
 */
async function makeSessionDir(home, sessionId) {
	const dir = join(home, "sessions", "--project--", sessionId);
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "session.log"), "{}");
	return dir;
}

test("plugin exports its name", () => {
	assert.equal(name, "session-delete");
});

test("deletes a cold session from every durable place", async () => {
	const home = await mkdtemp(join(tmpdir(), "session-delete-test-"));
	const sessionId = "session-11111111-2222-3333-4444-555555555555";
	const logDir = await makeSessionDir(home, sessionId);
	try {
		const { route, calls } = harness({ home, sessionId, live: undefined, attachToWorkspace: true });
		const result = await post(route, { sessionId });
		assert.equal(result.status, 200);
		assert.equal(result.body.ok, true);
		assert.equal(result.body.removedDirs, 1);
		assert.equal(result.body.releasedLiveSession, false);
		assert.deepEqual(calls.archive, [["unarchive", sessionId], ["unpin", sessionId]]);
		assert.deepEqual(calls.detach, [sessionId]);
		assert.deepEqual(calls.projection, [sessionId]);
		assert.equal(calls.flush, 0);
		assert.equal(calls.sessionDetach, 0);
		assert.deepEqual(calls.events, [["api-session/removed", sessionId]]);
		await assert.rejects(stat(logDir), /ENOENT/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("deletes an idle resident session by flushing and detaching it", async () => {
	const home = await mkdtemp(join(tmpdir(), "session-delete-test-"));
	const sessionId = "session-33333333-4444-5555-6666-777777777777";
	const logDir = await makeSessionDir(home, sessionId);
	try {
		const { route, calls } = harness({
			home,
			sessionId,
			live: { id: sessionId },
			agent: { status: "idle" },
			attachToWorkspace: true
		});
		const result = await post(route, { sessionId });
		assert.equal(result.status, 200);
		assert.equal(result.body.ok, true);
		assert.equal(result.body.releasedLiveSession, true);
		assert.equal(calls.flush, 1);
		assert.equal(calls.sessionDetach, 1);
		assert.equal(calls.stops, 1);
		assert.deepEqual(calls.projection, [sessionId]);
		assert.deepEqual(calls.events, [], "a resident Session announces itself through session/disposed");
		await assert.rejects(stat(logDir), /ENOENT/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("refuses a session whose agent is running", async () => {
	const home = await mkdtemp(join(tmpdir(), "session-delete-test-"));
	const sessionId = "session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	const logDir = await makeSessionDir(home, sessionId);
	try {
		const { route, calls } = harness({ home, sessionId, live: { id: sessionId }, agent: { status: "running" } });
		const result = await post(route, { sessionId });
		assert.equal(result.status, 409);
		assert.equal(result.body.error.code, "session-active");
		assert.equal(calls.flush, 0);
		assert.equal(calls.sessionDetach, 0);
		assert.ok((await stat(logDir)).isDirectory(), "a refused delete must keep the log");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("refuses a session with an open turn", async () => {
	const home = await mkdtemp(join(tmpdir(), "session-delete-test-"));
	const sessionId = "session-bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
	await makeSessionDir(home, sessionId);
	try {
		const { route } = harness({
			home,
			sessionId,
			live: { id: sessionId },
			agent: { status: "idle" },
			activity: [{ kind: "turn" }]
		});
		const result = await post(route, { sessionId });
		assert.equal(result.status, 409);
		assert.match(result.body.error.message, /进行中的回合/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("reports an unknown session", async () => {
	const home = await mkdtemp(join(tmpdir(), "session-delete-test-"));
	const sessionId = "session-cccccccc-dddd-eeee-ffff-000000000000";
	try {
		const { route } = harness({ home, sessionId, known: false, attachToWorkspace: false });
		const result = await post(route, { sessionId });
		assert.equal(result.status, 404);
		assert.equal(result.body.error.code, "session-not-found");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("rejects malformed input", async () => {
	const home = await mkdtemp(join(tmpdir(), "session-delete-test-"));
	try {
		const { route } = harness({ home, sessionId: "session-dddddddd-eeee-ffff-0000-111111111111" });
		assert.equal((await post(route, "not json")).status, 400);
		assert.equal((await post(route, {})).status, 400);
		assert.equal((await post(route, { sessionId: "../etc" })).status, 400);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("reports browser-half heartbeats and live sessions", async () => {
	const home = await mkdtemp(join(tmpdir(), "session-delete-test-"));
	const sessionId = "session-eeeeeeee-ffff-0000-1111-222222222222";
	try {
		const { routes } = harness({ home, sessionId, live: { id: sessionId }, agent: { status: "idle" } });
		const ping = routes.get("/api/session-delete/ping");
		const status = routes.get("/api/session-delete/status");
		assert.ok(ping !== undefined && status !== undefined, "ping and status routes must be registered");
		await ping.fetch(new Request("http://127.0.0.1:1/api/session-delete/ping", { method: "POST" }));
		const response = await status.fetch(new Request("http://127.0.0.1:1/api/session-delete/status"));
		const body = await response.json();
		assert.equal(body.ok, true);
		assert.equal(body.loads, 1);
		assert.equal(typeof body.lastLoadAt, "number");
		assert.deepEqual(body.liveSessions, [{ sessionId, status: "idle" }]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("batch-deletes several cold sessions and reports each outcome", async () => {
	const home = await mkdtemp(join(tmpdir(), "session-delete-test-"));
	const first = "session-11111111-aaaa-bbbb-cccc-111111111111";
	const second = "session-22222222-aaaa-bbbb-cccc-222222222222";
	const firstDir = await makeSessionDir(home, first);
	const secondDir = await makeSessionDir(home, second);
	try {
		const { batch, calls } = harness({ home, sessionId: first, known: true, attachToWorkspace: true });
		const result = await postBatch(batch, { sessionIds: [first, second] });
		assert.equal(result.status, 200);
		assert.equal(result.body.ok, true);
		assert.equal(result.body.deleted, 2);
		assert.equal(result.body.failed, 0);
		assert.deepEqual(result.body.results.map((row) => [row.sessionId, row.ok]), [[first, true], [second, true]]);
		assert.deepEqual(calls.events, [["api-session/removed", first], ["api-session/removed", second]]);
		await assert.rejects(stat(firstDir), /ENOENT/);
		await assert.rejects(stat(secondDir), /ENOENT/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("batch delete keeps deleting after one running session is refused", async () => {
	const home = await mkdtemp(join(tmpdir(), "session-delete-test-"));
	const deletable = "session-33333333-aaaa-bbbb-cccc-333333333333";
	const running = "session-44444444-aaaa-bbbb-cccc-444444444444";
	await makeSessionDir(home, deletable);
	const runningDir = await makeSessionDir(home, running);
	try {
		const { batch } = harness({
			home,
			sessionId: deletable,
			live: undefined,
			agents: { [running]: { status: "running" } }
		});
		const result = await postBatch(batch, { sessionIds: [deletable, running] });
		assert.equal(result.status, 200);
		assert.equal(result.body.ok, true);
		assert.equal(result.body.deleted, 1);
		assert.equal(result.body.failed, 1);
		const refused = result.body.results.find((row) => row.sessionId === running);
		assert.equal(refused.ok, false);
		assert.equal(refused.error.code, "session-active");
		assert.ok((await stat(runningDir)).isDirectory(), "a refused session keeps its log");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("batch delete validates its input and deduplicates ids", async () => {
	const home = await mkdtemp(join(tmpdir(), "session-delete-test-"));
	const sessionId = "session-55555555-aaaa-bbbb-cccc-555555555555";
	await makeSessionDir(home, sessionId);
	try {
		const { batch } = harness({ home, sessionId });
		assert.equal((await postBatch(batch, "not json")).status, 400);
		assert.equal((await postBatch(batch, {})).status, 400);
		assert.equal((await postBatch(batch, { sessionIds: [] })).status, 400);
		assert.equal((await postBatch(batch, { sessionIds: ["../etc"] })).status, 400);
		assert.equal((await postBatch(batch, { sessionIds: "nope" })).status, 400);
		const deduped = await postBatch(batch, { sessionIds: [sessionId, sessionId] });
		assert.equal(deduped.status, 200);
		assert.equal(deduped.body.results.length, 1);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
