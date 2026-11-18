/**
 * Browser-half smoke test: execute lib/client.js inside a VM with a stub
 * module loader / require surface and assert the plugin registers its slot
 * entries and pings the Host heartbeat.
 *
 * Run with: node --test test/client.test.mjs
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

/**
 * Load the browser bundle and return its registration surface.
 * @returns exports, slot registrations, and the fetch calls the bundle made.
 */
async function loadBundle() {
	const code = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
	const registrations = [];
	const fetched = [];
	let factory;
	const sandbox = {
		window: { __ModuleLoader__: { load: (row) => { factory = row.factory; } } },
		fetch: async (url, init) => {
			fetched.push({ url, method: init?.method });
			return { ok: true, json: async () => ({ ok: true }) };
		},
		setTimeout,
		clearTimeout,
		console
	};
	vm.runInNewContext(code, sandbox, { filename: "lib/client.js" });
	assert.equal(typeof factory, "function", "bundle must register a module factory");
	const React = {
		createElement: (type, props, ...children) => ({ type, props, children }),
		useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
		useEffect: () => {},
		Fragment: Symbol("Fragment")
	};
	const primitives = new Proxy({}, { get: () => () => null });
	const bundle = factory((specifier) => {
		if (specifier === "react") return React;
		if (specifier === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
		throw new Error(`unexpected require(${specifier})`);
	});
	const slots = {
		inject: (_name, callback) => callback(),
		register: (options, component) => {
			assert.equal(typeof component, "function", `slot ${options.name} must register a component`);
			registrations.push(options);
			return () => {};
		}
	};
	bundle.apply({ slots });
	return { bundle, registrations, fetched };
}

test("registers the delete menu entry and the confirmation overlay", async () => {
	const { bundle, registrations } = await loadBundle();
	assert.deepEqual(Array.from(bundle.inject), ["slots"]);
	const menu = registrations.find((row) => row.name === "sidebar.workspaces.session.menu.item");
	assert.ok(menu !== undefined, "must register into the session menu slot");
	assert.equal(menu.id, "session-delete");
	assert.equal(menu.order, 440);
	const overlay = registrations.find((row) => row.name === "shell.overlay");
	assert.ok(overlay !== undefined, "must register the confirmation dialog into shell.overlay");
	assert.equal(overlay.id, "session-delete-confirm");
	const mark = registrations.find((row) => row.name === "sidebar.session.row.trailing");
	assert.ok(mark !== undefined, "must register the selection mark into the row trailing seat");
	assert.equal(mark.id, "session-delete-selection");
});

test("pings the Host heartbeat when applied", async () => {
	const { fetched } = await loadBundle();
	assert.ok(
		fetched.some((call) => call.url === "api/session-delete/ping" && call.method === "POST"),
		"apply() must POST the heartbeat once"
	);
});
